// heyhoney: private sites behind secret, self-expiring links.
//
//   GET  /s/<token>/<path>        open the site (the site's entry at the root)
//   POST /s/<token>/<path>        check the link's pin, if it has one, and set its unlock cookie
//   GET  /s/<token>/~<key>/<path> a sandboxed site's files, loaded by the frame the page above wraps them in
//
// Sandboxed sites (the default) never run at the top level of this origin. The top level is a tiny page
// of ours holding an <iframe sandbox> without allow-same-origin, so the site's scripts get an opaque
// origin: no cookies or storage on this domain or its parent, no reaching other heyhoney pages. The
// frame's URL carries the link's unlock key (pinned links) instead of relying on cookies, which an
// opaque origin does not send. Sites published with sandbox off are served directly, same-origin.
//
// Everything else is a blank page. Uploads never come through here: the CLI writes R2 and D1 with
// wrangler, so this Worker has no write surface and no admin secret.

interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  OPENED_TTL_DAYS: string;
  PRUNE_AFTER_DAYS: string;
}

interface LinkRow {
  id: string;
  site_slug: string;
  first_access_at: number | null;
  expires_at: number;
  revoked_at: number | null;
  pin_hash: string | null;
  unlock_key: string | null;
  pin_failures: number;
  entry: string;
  name: string;
  sandbox: number;
}

const DAY = 86_400_000;
// Wrong pins allowed before the link is revoked. A 6-digit pin has a million values; ten guesses is nothing.
const MAX_PIN_FAILURES = 10;

// Link unfurlers and scanners. They get a contentless stub and do not start the 7-day clock,
// so pasting a link into Slack or iMessage neither leaks a preview nor burns the link.
const BOT_UA =
  /bot|crawl|spider|slurp|facebookexternalhit|facebot|embedly|preview|whatsapp|telegram|discord|slack|linkedin|skype|vkshare|pinterest|tumblr|bitly|quora|outbrain|nuzzel|mastodon|bluesky|curl|wget|python-|go-http|okhttp|java\/|headless|lighthouse/i;

const BASE_HEADERS: Record<string, string> = {
  "cache-control": "private, no-store",
  "x-robots-tag": "noindex, nofollow, noarchive",
  // The token is in the path; never hand it to a CDN or analytics script via Referer.
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

// What a sandboxed site may still do. Deliberately absent: allow-same-origin (the whole point) and
// allow-top-navigation (a site could otherwise swap our page for a lookalike without a click).
const SANDBOX =
  "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads " +
  "allow-pointer-lock allow-presentation allow-top-navigation-by-user-activation";

// Our own pages (wrapper, pin form, notices) run no script and cannot be framed by anyone.
const OWN_HEADERS = {
  ...BASE_HEADERS,
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

// A sandboxed site's files. The CSP sandbox applies even if a file is opened directly in a tab, SVGs
// included. Its fetches arrive from an opaque origin, so they need CORS; the token is the secret anyway.
const FRAME_HEADERS = {
  ...BASE_HEADERS,
  "content-security-policy": `sandbox ${SANDBOX}; frame-ancestors 'self'`,
  "access-control-allow-origin": "*",
};

// An unsandboxed site's files: same origin, but still nobody else may frame them.
const DIRECT_HEADERS = { ...BASE_HEADERS, "content-security-policy": "frame-ancestors 'self'" };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!["GET", "HEAD", "POST"].includes(request.method)) return page(405, "Nope.");
    if (url.pathname === "/robots.txt") return text("User-agent: *\nDisallow: /\n");

    const m = url.pathname.match(/^\/s\/([A-Za-z0-9_-]{20,64})(\/.*)?$/);
    if (!m) return page(404, "Nothing here.");
    const [, token, rest] = m;

    const link = await env.DB.prepare(
      `SELECT l.id, l.site_slug, l.first_access_at, l.expires_at, l.revoked_at,
              l.pin_hash, l.unlock_key, l.pin_failures, s.entry, s.name, s.sandbox
         FROM links l JOIN sites s ON s.slug = l.site_slug
        WHERE l.token_hash = ?`,
    )
      .bind(await sha256(token))
      .first<LinkRow>();

    const now = Date.now();
    if (!link || link.revoked_at || now >= link.expires_at) {
      return page(404, "This link has expired or never existed.", "Ask whoever sent it for a fresh one.");
    }

    // Relative URLs inside the site only resolve if the root ends in a slash.
    if (!rest) return Response.redirect(`${url.origin}/s/${token}/${url.search}`, 302);

    const ua = request.headers.get("user-agent") ?? "";
    if (BOT_UA.test(ua)) return page(200, "heyhoney", "A private link.");

    const sandboxed = link.sandbox !== 0;

    // Inside the frame. The key segment is the link's unlock key when it has a pin, empty otherwise.
    const frame = sandboxed ? rest.match(/^\/~([A-Za-z0-9_-]*)(\/.*)?$/) : null;
    if (frame) {
      if (request.method === "POST") return page(405, "Nope.");
      const want = link.pin_hash ? link.unlock_key ?? "" : "";
      if (!safeEqual(frame[1], want)) return page(403, "Open the link itself, not this frame.");
      return serveFile(request, env, link, frame[2] ?? "/", FRAME_HEADERS);
    }

    // The top level: pin gate first.
    if (link.pin_hash) {
      if (request.method === "POST") return unlock(request, env, link, token, url, now);
      if (!unlocked(request, link)) return pinPage(401);
    } else if (request.method === "POST") {
      return page(405, "Nope.");
    }

    // A real person opening the site (a top-level GET of its entry, not a HEAD) counts as an access.
    const isEntry = rest === "/" || rest === `/${link.entry}`;
    if (isEntry && request.method === "GET") {
      const mode = request.headers.get("sec-fetch-mode");
      if (!mode || mode === "navigate") await recordView(env, link, now);
    }

    if (sandboxed) return frameWrapper(link, `/s/${token}/~${link.pin_hash ? link.unlock_key : ""}${rest}${url.search}`, request.method);
    return serveFile(request, env, link, rest, DIRECT_HEADERS);
  },

  // Daily: drop link rows that died long ago. Sites are never removed here; they outlive their links.
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const cutoff = Date.now() - Number(env.PRUNE_AFTER_DAYS) * DAY;
    await env.DB.prepare(
      `DELETE FROM links WHERE expires_at < ?1 OR (revoked_at IS NOT NULL AND revoked_at < ?1)`,
    )
      .bind(cutoff)
      .run();
  },
} satisfies ExportedHandler<Env>;

async function serveFile(request: Request, env: Env, link: LinkRow, rawPath: string, base: Record<string, string>): Promise<Response> {
  let path: string;
  try {
    path = decodeURIComponent(rawPath.slice(1));
  } catch {
    return page(400, "Bad path.");
  }
  if (path === "" || path.endsWith("/")) path += path === "" ? link.entry : "index.html";
  if (path.split("/").some((seg) => seg === ".." || seg === ".")) return page(400, "Bad path.");

  const obj = await env.FILES.get(`${link.site_slug}/${path}`, {
    range: request.headers,
    onlyIf: request.headers,
  });
  if (!obj) return page(404, "No such file in this site.");

  const headers = new Headers(base);
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("accept-ranges", "bytes");
  if (!("body" in obj)) return new Response(null, { status: 304, headers });

  let status = 200;
  if (request.headers.has("range") && obj.range && "offset" in obj.range) {
    const start = obj.range.offset ?? 0;
    const end = start + (obj.range.length ?? obj.size - start) - 1;
    headers.set("content-range", `bytes ${start}-${end}/${obj.size}`);
    status = 206;
  }
  return new Response(request.method === "HEAD" ? null : obj.body, { status, headers });
}

// The top level of a sandboxed site: one full-window frame. Its URL differs from ours (the ~ segment),
// which browsers require, and is never shown in the address bar, so copying the address never copies
// a pinned link's unlock key.
function frameWrapper(link: LinkRow, src: string, method: string): Response {
  const name = esc(link.name);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${name}</title>
<style>:root{color-scheme:light dark}html,body{margin:0;height:100%}
iframe{position:fixed;inset:0;width:100%;height:100%;border:0;display:block}</style></head>
<body><iframe src="${esc(src)}" title="${name}" sandbox="${SANDBOX}"
allow="fullscreen; clipboard-write; autoplay; picture-in-picture"></iframe></body></html>`;
  return new Response(method === "HEAD" ? null : html, {
    headers: { ...OWN_HEADERS, "content-type": "text/html; charset=utf-8" },
  });
}

// Check a submitted pin. Right: set the unlock cookie for this link's path only and send the browser
// back to where it was. Wrong: count it, and revoke the link once it has eaten MAX_PIN_FAILURES.
async function unlock(request: Request, env: Env, link: LinkRow, token: string, url: URL, now: number): Promise<Response> {
  const form = await request.formData().catch(() => null);
  const pin = String(form?.get("pin") ?? "").trim();
  if (pin && safeEqual(await sha256(`${link.id}:${pin}`), link.pin_hash!)) {
    const maxAge = Math.max(60, Math.ceil((link.expires_at - now) / 1000) + Number(env.OPENED_TTL_DAYS) * 86_400);
    return new Response(null, {
      status: 303,
      headers: {
        ...BASE_HEADERS,
        location: url.pathname + url.search,
        "set-cookie": `hh=${link.unlock_key}; Path=/s/${token}/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`,
      },
    });
  }
  const failures = link.pin_failures + 1;
  await env.DB.prepare(
    `UPDATE links SET pin_failures = pin_failures + 1,
            revoked_at = CASE WHEN pin_failures + 1 >= ?2 THEN ?3 ELSE revoked_at END
      WHERE id = ?1`,
  )
    .bind(link.id, MAX_PIN_FAILURES, now)
    .run();
  if (failures >= MAX_PIN_FAILURES) {
    return page(403, "Too many wrong codes.", "This link is closed now. Ask whoever sent it for a fresh one.");
  }
  const left = MAX_PIN_FAILURES - failures;
  return pinPage(401, `That's not it. ${left} ${left === 1 ? "try" : "tries"} left.`);
}

function unlocked(request: Request, link: LinkRow): boolean {
  const cookie = request.headers.get("cookie") ?? "";
  const m = cookie.match(/(?:^|;\s*)hh=([A-Za-z0-9_-]+)/);
  return !!(m && link.unlock_key && safeEqual(m[1], link.unlock_key));
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function recordView(env: Env, link: LinkRow, now: number): Promise<void> {
  if (link.first_access_at === null) {
    // First open: the clock switches from "30 days unopened" to "7 days from now". The guard on
    // first_access_at makes two simultaneous first opens agree on one start time.
    const expires = now + Number(env.OPENED_TTL_DAYS) * DAY;
    await env.DB.prepare(
      `UPDATE links SET first_access_at = ?1, expires_at = ?2, views = views + 1
        WHERE id = ?3 AND first_access_at IS NULL`,
    )
      .bind(now, expires, link.id)
      .run();
  } else {
    await env.DB.prepare(`UPDATE links SET views = views + 1 WHERE id = ?`).bind(link.id).run();
  }
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function text(body: string): Response {
  return new Response(body, { headers: { ...BASE_HEADERS, "content-type": "text/plain; charset=utf-8" } });
}

function page(status: number, title: string, sub = ""): Response {
  return notice(status, title, `<h1>${title}</h1>${sub ? `<p>${sub}</p>` : ""}`);
}

// The form posts back to the same URL, so whatever path the recipient opened is where they land.
function pinPage(status: number, error = ""): Response {
  return notice(status, "heyhoney", `<h1>This one has a code.</h1>
<p>Whoever sent you the link has it.</p>
<form method="post" autocomplete="off">
<input name="pin" inputmode="numeric" autocomplete="one-time-code" aria-label="Code" placeholder="••••••" required autofocus>
<button>Open</button></form>${error ? `<p class="err" role="alert">${error}</p>` : ""}`);
}

function notice(status: number, title: string, body: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<meta property="og:title" content="${title}"><title>${title}</title>
<style>
:root{color-scheme:light dark;--bg:#fbf7ef;--fg:#2b2418;--mute:#8a7a5c;--honey:#e0a526;--line:#dccfb4;--field:#fff;--bad:#b4452f}
@media (prefers-color-scheme:dark){:root{--bg:#17140f;--fg:#efe6d4;--mute:#a59473;--line:#3a3226;--field:#211c15;--bad:#e8806c}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);
font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:0 16px}
main{text-align:center;max-width:28rem}
.hex{width:44px;height:50px;margin:0 auto 18px;background:var(--honey);
clip-path:polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%)}
h1{font-size:1.25rem;font-weight:600;margin:0 0 6px}p{margin:0;color:var(--mute)}
form{display:flex;gap:8px;justify-content:center;margin:22px 0 0}
input{width:9.5rem;font:600 1.25rem/1 ui-monospace,Consolas,monospace;letter-spacing:.2em;text-align:center;padding:12px;
border:1px solid var(--line);border-radius:10px;background:var(--field);color:var(--fg)}
input:focus{outline:2px solid var(--honey);outline-offset:1px}input::placeholder{color:var(--line)}
button{font:600 1rem system-ui,sans-serif;padding:0 20px;border:0;border-radius:10px;background:var(--honey);color:#2b2418;cursor:pointer}
.err{margin-top:14px;color:var(--bad)}
</style></head><body><main><div class="hex"></div>${body}</main></body></html>`;
  return new Response(html, { status, headers: { ...OWN_HEADERS, "content-type": "text/html; charset=utf-8" } });
}
