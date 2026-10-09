// heyhoney: private sites behind secret, self-expiring links.
//
//   GET /s/<token>/<path>   serve <path> of the site the token grants (the site's entry at the root)
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
  entry: string;
}

const DAY = 86_400_000;

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") return page(405, "Nope.");
    if (url.pathname === "/robots.txt") return text("User-agent: *\nDisallow: /\n");

    const m = url.pathname.match(/^\/s\/([A-Za-z0-9_-]{20,64})(\/.*)?$/);
    if (!m) return page(404, "Nothing here.");
    const [, token, rest] = m;

    const link = await env.DB.prepare(
      `SELECT l.id, l.site_slug, l.first_access_at, l.expires_at, l.revoked_at, s.entry
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

    let path: string;
    try {
      path = decodeURIComponent(rest.slice(1));
    } catch {
      return page(400, "Bad path.");
    }
    const isEntry = path === "" || path === link.entry;
    if (path === "" || path.endsWith("/")) path += path === "" ? link.entry : "index.html";
    if (path.split("/").some((seg) => seg === ".." || seg === ".")) return page(400, "Bad path.");

    // A real person opening the site (not a sub-resource, not a HEAD) counts as an access.
    if (isEntry && request.method === "GET") {
      const mode = request.headers.get("sec-fetch-mode");
      if (!mode || mode === "navigate") await recordView(env, link, now);
    }

    const obj = await env.FILES.get(`${link.site_slug}/${path}`, {
      range: request.headers,
      onlyIf: request.headers,
    });
    if (!obj) return page(404, "No such file in this site.");

    const headers = new Headers(BASE_HEADERS);
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

function text(body: string): Response {
  return new Response(body, { headers: { ...BASE_HEADERS, "content-type": "text/plain; charset=utf-8" } });
}

function page(status: number, title: string, sub = ""): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<meta property="og:title" content="${title}"><title>${title}</title>
<style>
:root{color-scheme:light dark;--bg:#fbf7ef;--fg:#2b2418;--mute:#8a7a5c;--honey:#e0a526}
@media (prefers-color-scheme:dark){:root{--bg:#17140f;--fg:#efe6d4;--mute:#a59473}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);
font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:0 16px}
main{text-align:center;max-width:28rem}
.hex{width:44px;height:50px;margin:0 auto 18px;background:var(--honey);
clip-path:polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%)}
h1{font-size:1.25rem;font-weight:600;margin:0 0 6px}p{margin:0;color:var(--mute)}
</style></head><body><main><div class="hex"></div><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ""}</main></body></html>`;
  return new Response(html, { status, headers: { ...BASE_HEADERS, "content-type": "text/html; charset=utf-8" } });
}
