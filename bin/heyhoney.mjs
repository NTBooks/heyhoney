#!/usr/bin/env node
// heyhoney CLI. Sites live in <sites dir>/<slug>/ (keep that folder in its own private repo; it is the
// archive); this mirrors them to R2 + D1 through wrangler and mints secret links. Run `node bin/heyhoney.mjs help`.

import { execFile } from "node:child_process";
import { createHash, randomBytes, randomInt } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");

// Deployment facts come from wrangler.jsonc so there is one place to change them.
const WCONF = JSON.parse(
  fs.readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8")
    .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str ?? "")
    .replace(/,(\s*[}\]])/g, "$1"),
);
const BUCKET = WCONF.r2_buckets[0].bucket_name;
const DB = WCONF.d1_databases[0].database_name;
const PROD_URL = `https://${WCONF.routes[0].pattern.replace(/\/\*?$/, "")}`;
const LOCAL_URL = "http://localhost:8787";

// Where the sites live: $HEYHONEY_SITES, else "sites" in heyhoney.local.json (git-ignored), else ./sites.
const LOCAL_CONF = path.join(ROOT, "heyhoney.local.json");
const SITES = path.resolve(ROOT, process.env.HEYHONEY_SITES
  ?? (fs.existsSync(LOCAL_CONF) ? JSON.parse(fs.readFileSync(LOCAL_CONF, "utf8")).sites : undefined)
  ?? "sites");
const UNOPENED_TTL_DAYS = 30; // the Worker owns the other half: OPENED_TTL_DAYS in wrangler.jsonc
const DAY = 86_400_000;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

const TYPES = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8", ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon",
  ".pdf": "application/pdf", ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg",
  ".wav": "audio/wav", ".ogg": "audio/ogg", ".woff": "font/woff", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".otf": "font/otf", ".wasm": "application/wasm", ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json", ".zip": "application/zip",
};

// ---- args -------------------------------------------------------------------------------------

const argv = process.argv.slice(2);
// --key value, --key=value, or a bare switch. Switches never swallow the next word, so
// `link deck --pin sam` is a pinned link labelled "sam"; a chosen pin is `--pin=4821`.
const SWITCHES = new Set(["pin", "local", "json", "force", "sandbox", "no-sandbox"]);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const eq = a.indexOf("=");
    if (eq > 2) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!SWITCHES.has(key) && next !== undefined && !next.startsWith("--")) (flags[key] = next), i++;
    else flags[key] = true;
  } else pos.push(a);
}
const LOCAL = !!flags.local;
const BASE_URL = LOCAL ? LOCAL_URL : PROD_URL;
const where = LOCAL ? "--local" : "--remote";

// ---- wrangler ---------------------------------------------------------------------------------

function wrangler(args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [WRANGLER, ...args], { cwd: ROOT, maxBuffer: 64 << 20, env: { ...process.env, CI: "1" } },
      (err, stdout, stderr) => (err ? reject(new Error(`wrangler ${args.slice(0, 3).join(" ")} failed:\n${stderr || stdout || err.message}`)) : resolve(stdout)));
  });
}

async function sql(command) {
  const out = await wrangler(["d1", "execute", DB, where, "--json", "-y", "--command", command]);
  const parsed = JSON.parse(out.slice(out.indexOf("[")));
  return parsed.flatMap((r) => r.results ?? []);
}

const q = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

async function pool(items, n, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

// ---- local site files -------------------------------------------------------------------------

function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full, base);
    if (e.name === "site.json" && dir === base) return [];
    return [path.relative(base, full).split(path.sep).join("/")];
  });
}

function readSite(slug) {
  const dir = path.join(SITES, slug);
  const metaPath = path.join(dir, "site.json");
  if (!fs.existsSync(metaPath)) die(`No site "${slug}" (expected ${metaPath}).`);
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  const files = {};
  for (const rel of walk(dir)) files[rel] = createHash("sha256").update(fs.readFileSync(path.join(dir, rel))).digest("hex");
  const entry = meta.entry ?? (files["index.html"] ? "index.html" : Object.keys(files)[0]);
  if (!entry || !files[entry]) die(`Site "${slug}" has no entry file (${entry ?? "nothing to serve"}).`);
  return { dir, meta: { name: meta.name ?? slug, description: meta.description ?? "", entry, sandbox: meta.sandbox !== false }, files };
}

function allSites() {
  if (!fs.existsSync(SITES)) return [];
  return fs.readdirSync(SITES).filter((s) => fs.existsSync(path.join(SITES, s, "site.json"))).sort();
}

// ---- commands ---------------------------------------------------------------------------------

// Copy a file or folder into sites/<slug>/ and write its site.json. A lone HTML file becomes index.html.
function add(src, slug) {
  if (!src || !slug) die("usage: add <file|dir> <slug> [--name N] [--desc D]");
  if (!SLUG.test(slug)) die(`Slug must match ${SLUG}.`);
  const from = path.resolve(src);
  if (!fs.existsSync(from)) die(`Not found: ${src}`);
  const dir = path.join(SITES, slug);
  const metaPath = path.join(dir, "site.json");
  const old = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, "utf8")) : {};

  // Replace content wholesale so files deleted upstream are deleted here too.
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  let entry;
  if (fs.statSync(from).isDirectory()) {
    fs.cpSync(from, dir, { recursive: true, filter: (p) => !/(^|[\\/])(\.git|node_modules)([\\/]|$)/.test(p) });
    fs.rmSync(path.join(dir, "site.json"), { force: true });
    entry = flags.entry ?? old.entry;
  } else {
    const ext = path.extname(from).toLowerCase();
    const name = ext === ".html" || ext === ".htm" ? "index.html" : path.basename(from);
    fs.copyFileSync(from, path.join(dir, name));
    entry = name;
  }
  const meta = {
    name: typeof flags.name === "string" ? flags.name : old.name ?? slug,
    description: typeof flags.desc === "string" ? flags.desc : old.description ?? "",
    ...(entry && entry !== "index.html" ? { entry } : {}),
    // Sandboxed unless told otherwise; an existing site keeps its setting across re-adds.
    ...((flags["no-sandbox"] ? false : flags.sandbox ? true : old.sandbox) === false ? { sandbox: false } : {}),
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
  writeIndex();
  const n = walk(dir).length;
  console.log(`Added ${path.basename(SITES)}/${slug}/ (${n} file${n === 1 ? "" : "s"}).`);
}

// Mirror sites/<slug>/ to R2 (changed files only) and upsert its D1 row.
async function publish(slug) {
  if (!slug) die("usage: publish <slug>");
  const site = readSite(slug);
  const [row] = await sql(`SELECT files FROM sites WHERE slug = ${q(slug)}`);
  const remote = row ? JSON.parse(row.files) : {};
  const changed = Object.keys(site.files).filter((p) => remote[p] !== site.files[p] || flags.force);
  const removed = Object.keys(remote).filter((p) => !(p in site.files));

  await pool(changed, LOCAL ? 1 : 4, async (rel) => {
    const type = TYPES[path.extname(rel).toLowerCase()] ?? "application/octet-stream";
    await wrangler(["r2", "object", "put", `${BUCKET}/${slug}/${rel}`, where, "--file", path.join(site.dir, rel), "--content-type", type]);
    process.stdout.write(`  ↑ ${rel}\n`);
  });

  const now = Date.now();
  await sql(`INSERT INTO sites (slug, name, description, entry, files, sandbox, created_at, updated_at)
    VALUES (${q(slug)}, ${q(site.meta.name)}, ${q(site.meta.description)}, ${q(site.meta.entry)}, ${q(JSON.stringify(site.files))},
      ${site.meta.sandbox ? 1 : 0}, ${now}, ${now})
    ON CONFLICT(slug) DO UPDATE SET name = excluded.name, description = excluded.description, entry = excluded.entry,
      files = excluded.files, sandbox = excluded.sandbox, updated_at = excluded.updated_at`);

  // Delete only after the row stops naming them, so a live link never points at a missing file.
  await pool(removed, LOCAL ? 1 : 4, async (rel) => {
    await wrangler(["r2", "object", "delete", `${BUCKET}/${slug}/${rel}`, where]);
    process.stdout.write(`  ✕ ${rel}\n`);
  });
  console.log(`Published ${slug}: ${changed.length} uploaded, ${removed.length} removed, ${Object.keys(site.files).length - changed.length} unchanged.`);
  sandboxReport(slug, site);
}

// Things a sandboxed page cannot do: its frame has an opaque origin, so these throw or silently fail.
const SANDBOX_BLOCKERS = [
  [/\blocalStorage\b/, "localStorage"],
  [/\bsessionStorage\b/, "sessionStorage"],
  [/\bindexedDB\b/, "IndexedDB"],
  [/document\.cookie/, "document.cookie"],
  [/\bserviceWorker\b/, "service workers"],
  [/\bcaches\.(?:open|match|keys|has|delete)\b/, "the Cache API"],
  [/\b(?:window\.)?top\.location\b|\bparent\.(?:document|location)\b/, "navigating or reading the top window"],
  [/\bgetUserMedia\b|\bgeolocation\b/, "camera, microphone or location"],
  [/\bNotification\.requestPermission\b/, "notifications"],
  [/\bnavigator\.credentials\b|\bPublicKeyCredential\b/, "passkeys or saved logins"],
];

// After a publish: warn when a sandboxed site uses something the sandbox blocks, or remind that a
// site runs unsandboxed. Claude reads this output; the skill says what to do about it.
function sandboxReport(slug, site) {
  if (!site.meta.sandbox) {
    console.log(`\n  ⚠ ${slug} is NOT sandboxed: its scripts run on ${new URL(PROD_URL).host} itself and can read and set`);
    console.log(`    cookies for the parent domain and reach any heyhoney page whose link they know. Only for code you trust.`);
    return;
  }
  const hits = new Map();
  for (const rel of Object.keys(site.files)) {
    if (!/\.(?:html?|m?js)$/i.test(rel)) continue;
    const src = fs.readFileSync(path.join(site.dir, rel), "utf8");
    for (const [re, what] of SANDBOX_BLOCKERS) if (re.test(src)) hits.set(what, [...(hits.get(what) ?? []), rel]);
  }
  if (!hits.size) return;
  console.log(`\n  ⚠ ${slug} is sandboxed but uses things the sandbox blocks:`);
  for (const [what, files] of hits) console.log(`    - ${what}  (${files.join(", ")})`);
  console.log(`    Guarded with try/catch they just stay off; unguarded they throw. Fix the page, or if it truly needs`);
  console.log(`    them: hh sandbox ${slug} off (read the warning that prints first).`);
}

// Turn a site's sandbox on or off: site.json, plus the live row if it is published.
async function setSandbox(slug, value) {
  if (!slug || !["on", "off"].includes(value)) die("usage: sandbox <slug> on|off");
  const metaPath = path.join(SITES, slug, "site.json");
  if (!fs.existsSync(metaPath)) die(`No site "${slug}".`);
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  if (value === "on") delete meta.sandbox;
  else meta.sandbox = false;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
  writeIndex();
  const [row] = await sql(`SELECT slug FROM sites WHERE slug = ${q(slug)}`);
  if (row) await sql(`UPDATE sites SET sandbox = ${value === "on" ? 1 : 0} WHERE slug = ${q(slug)}`);
  console.log(`Sandbox ${value} for ${slug}${row ? " (live now; existing links included)" : ""}.`);
  sandboxReport(slug, readSite(slug));
}

async function link(slug, label = "") {
  if (!slug) die("usage: link <slug> [label]");
  const [site] = await sql(`SELECT slug FROM sites WHERE slug = ${q(slug)}`);
  if (!site) die(`"${slug}" is not published yet. Run: publish ${slug}`);
  const token = randomBytes(24).toString("base64url");
  const id = randomBytes(4).toString("hex");
  const now = Date.now();
  const expires = now + UNOPENED_TTL_DAYS * DAY;
  const sha = (s) => createHash("sha256").update(s).digest("hex");

  // --pin makes a 6-digit code; --pin=<code> uses that one. The Worker only ever sees its hash.
  let pin = null;
  if (flags.pin === true) pin = String(randomInt(0, 1_000_000)).padStart(6, "0");
  else if (typeof flags.pin === "string") {
    pin = flags.pin.trim();
    if (!/^\S{4,32}$/.test(pin)) die("A pin is 4 to 32 characters with no spaces.");
  }
  const pinHash = pin ? sha(`${id}:${pin}`) : null;
  const unlockKey = pin ? randomBytes(24).toString("base64url") : null;

  await sql(`INSERT INTO links (id, token_hash, site_slug, label, created_at, expires_at, pin_hash, unlock_key)
    VALUES (${q(id)}, ${q(sha(token))}, ${q(slug)}, ${q(label)}, ${now}, ${expires}, ${q(pinHash)}, ${q(unlockKey)})`);
  const url = `${BASE_URL}/s/${token}/`;
  if (flags.json) console.log(JSON.stringify({ id, slug, label, url, ...(pin ? { pin } : {}), expires_if_unopened: new Date(expires).toISOString() }));
  else {
    console.log(`\n  ${url}\n`);
    if (pin) console.log(`  pin  ${pin}   send it separately from the link (another app, or say it out loud)\n`);
    console.log(`  link ${id} for ${slug}${label ? ` (${label})` : ""}: dies ${fmt(expires)} if unopened, or 7 days after first open.`);
    console.log(`  This is the only time the URL${pin ? " and pin are" : " is"} shown; heyhoney stores just hashes.\n`);
  }
  return url;
}

function linkState(l, now = Date.now()) {
  if (l.revoked_at) return "revoked";
  if (now >= l.expires_at) return "expired";
  return l.first_access_at ? "opened" : "unopened";
}

async function links(slug) {
  const rows = await sql(`SELECT id, site_slug, label, created_at, first_access_at, expires_at, revoked_at, views,
    pin_hash IS NOT NULL AS pinned, pin_failures FROM links ${slug ? `WHERE site_slug = ${q(slug)}` : ""} ORDER BY created_at DESC`);
  if (flags.json) return console.log(JSON.stringify(rows.map((l) => ({ ...l, state: linkState(l) })), null, 2));
  if (!rows.length) return console.log("No links.");
  for (const l of rows) {
    const st = linkState(l);
    const when = st === "unopened" || st === "opened" ? `until ${fmt(l.expires_at)}` : "";
    const pin = l.pinned ? (l.pin_failures ? `pin, ${l.pin_failures} wrong` : "pin") : "";
    console.log(`${l.id}  ${l.site_slug.padEnd(24)} ${st.padEnd(9)} ${String(l.views).padStart(3)} views  ${when.padEnd(24)} ${pin.padEnd(13)} ${l.label}`);
  }
}

async function revoke(target) {
  if (!target) die("usage: revoke <link-id | slug>");
  const now = Date.now();
  const where_ = `(id = ${q(target)} OR site_slug = ${q(target)})`;
  const live = await sql(`SELECT id FROM links WHERE ${where_} AND revoked_at IS NULL AND expires_at > ${now}`);
  await sql(`UPDATE links SET revoked_at = ${now} WHERE ${where_} AND revoked_at IS NULL`);
  console.log(`Revoked ${live.length} live link(s).`);
}

// The index: every site in the repo, whether it is published, and its live links.
async function list() {
  const local = allSites().map((slug) => ({ slug, ...readSite(slug).meta }));
  const remote = Object.fromEntries((await sql(`SELECT slug, updated_at, files, sandbox FROM sites`)).map((r) => [r.slug, r]));
  const now = Date.now();
  const live = await sql(`SELECT site_slug, COUNT(*) AS n, MAX(expires_at) AS until FROM links
    WHERE revoked_at IS NULL AND expires_at > ${now} GROUP BY site_slug`);
  const liveBy = Object.fromEntries(live.map((r) => [r.site_slug, r]));
  const slugs = [...new Set([...local.map((s) => s.slug), ...Object.keys(remote)])].sort();

  const out = slugs.map((slug) => {
    const l = local.find((s) => s.slug === slug);
    const r = remote[slug];
    let state = "draft";
    if (r && !l) state = "orphan"; // in R2/D1 but deleted from the repo
    else if (r) state = JSON.stringify(readSite(slug).files) === r.files && Number(l.sandbox) === r.sandbox ? "published" : "stale";
    return { slug, name: l?.name ?? "", description: l?.description ?? "", state, sandbox: l ? l.sandbox : r.sandbox === 1,
      updated_at: r ? new Date(r.updated_at).toISOString() : null,
      live_links: liveBy[slug]?.n ?? 0, live_until: liveBy[slug] ? new Date(liveBy[slug].until).toISOString() : null };
  });
  if (flags.json) return console.log(JSON.stringify(out, null, 2));
  if (!out.length) return console.log("No sites yet.");
  for (const s of out) {
    const lk = s.live_links ? `${s.live_links} live link(s) to ${fmt(Date.parse(s.live_until))}` : "no live links";
    console.log(`${s.slug.padEnd(28)} ${s.state.padEnd(10)} ${lk.padEnd(36)} ${s.name}${s.sandbox ? "" : "  [unsandboxed]"}`);
  }
}

// Take a site down: delete its R2 objects and D1 rows (its links die with it). Repo files stay.
async function unpublish(slug) {
  if (!slug) die("usage: unpublish <slug>");
  const [row] = await sql(`SELECT files FROM sites WHERE slug = ${q(slug)}`);
  if (!row) die(`"${slug}" is not published.`);
  await sql(`DELETE FROM links WHERE site_slug = ${q(slug)}; DELETE FROM sites WHERE slug = ${q(slug)}`);
  await pool(Object.keys(JSON.parse(row.files)), LOCAL ? 1 : 4, (rel) => wrangler(["r2", "object", "delete", `${BUCKET}/${slug}/${rel}`, where]));
  console.log(`Unpublished ${slug}; its links are dead. ${path.join(SITES, slug)} is untouched.`);
}

// INDEX.md, next to the sites folder: a human- and Claude-readable catalog of every site, regenerated on add.
function writeIndex() {
  const rows = allSites().map((slug) => {
    const s = readSite(slug);
    return `| [${slug}](${path.basename(SITES)}/${slug}/${s.meta.entry}) | ${s.meta.name} | ${s.meta.description.replace(/\|/g, "\\|")} | ${Object.keys(s.files).length} | ${s.meta.sandbox ? "yes" : "**no**"} |`;
  });
  fs.writeFileSync(path.join(SITES, "..", "INDEX.md"),
    `# Sites\n\nGenerated by \`heyhoney add\`. Live link state is not here (it changes on its own); run \`heyhoney list\`.\n\n` +
    `| Slug | Name | Description | Files | Sandboxed |\n|---|---|---|---|---|\n${rows.join("\n")}\n`);
}

// Copy skill/SKILL.md into ~/.claude/skills/heyhoney/ with this machine's paths and host filled in.
function installSkill() {
  const fill = { HEYHONEY: ROOT, SITES, SITES_REPO: path.resolve(SITES, ".."), URL: PROD_URL };
  const body = fs.readFileSync(path.join(ROOT, "skill", "SKILL.md"), "utf8")
    .replace(/\{\{(\w+)\}\}/g, (m, k) => (k in fill ? fill[k].split(path.sep).join("/") : m));
  const dest = path.join(os.homedir(), ".claude", "skills", "heyhoney", "SKILL.md");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, body);
  console.log(`Installed ${dest}`);
}

// ---- main -------------------------------------------------------------------------------------

function fmt(ms) {
  return new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function die(msg) {
  console.error(msg);
  process.exit(1);
}

const HELP = `heyhoney: private sites behind secret, self-expiring links  (add --local to target wrangler dev)

  push <file|dir> <slug> [--name N] [--desc D] [--label L] [--pin]   add + publish + link, the usual one-shot
  add <file|dir> <slug> [--name N] [--desc D] [--entry F] [--no-sandbox]
                                                             copy into <sites>/<slug>/ (lone .html becomes index.html)
  publish <slug> [--force]                                   mirror <sites>/<slug>/ to Cloudflare (changed files only)
  link <slug> [label] [--pin | --pin=CODE] [--json]          mint a new secret link (30d unopened / 7d after first open);
                                                             --pin adds a code to type (10 wrong tries kill the link)
  links [slug] [--json]                                      every link and its state
  revoke <link-id | slug>                                    kill one link, or every link to a site
  list [--json]                                              the index: sites, publish state, live links
  unpublish <slug>                                           delete from Cloudflare (local copy stays)
  index                                                      rewrite INDEX.md
  sandbox <slug> on|off                                      isolate the site's scripts (default on; off only for trusted code)
  install-skill                                              install the Claude Code skill, filled in for this machine

  sites: ${SITES}
  host:  ${PROD_URL}`;

const [cmd, a, b] = pos;
try {
  switch (cmd) {
    case "push":
      add(a, b);
      await publish(b);
      await link(b, typeof flags.label === "string" ? flags.label : "");
      break;
    case "add": add(a, b); break;
    case "publish": await publish(a); break;
    case "link": await link(a, b ?? (typeof flags.label === "string" ? flags.label : "")); break;
    case "links": await links(a); break;
    case "revoke": await revoke(a); break;
    case "list": await list(); break;
    case "unpublish": await unpublish(a); break;
    case "index": writeIndex(); console.log("INDEX.md rewritten."); break;
    case "install-skill": installSkill(); break;
    case "sandbox": await setSandbox(a, b); break;
    default: console.log(HELP);
  }
} catch (e) {
  die(e.message);
}
