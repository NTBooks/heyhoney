#!/usr/bin/env node
// heyhoney CLI. Sites live in <sites dir>/<slug>/ (keep that folder in its own private repo; it is the
// archive); this mirrors them to R2 + D1 through wrangler and mints secret links. Run `node bin/heyhoney.mjs help`.

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) (flags[key] = next), i++;
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
  return { dir, meta: { name: meta.name ?? slug, description: meta.description ?? "", entry }, files };
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
  await sql(`INSERT INTO sites (slug, name, description, entry, files, created_at, updated_at)
    VALUES (${q(slug)}, ${q(site.meta.name)}, ${q(site.meta.description)}, ${q(site.meta.entry)}, ${q(JSON.stringify(site.files))}, ${now}, ${now})
    ON CONFLICT(slug) DO UPDATE SET name = excluded.name, description = excluded.description, entry = excluded.entry,
      files = excluded.files, updated_at = excluded.updated_at`);

  // Delete only after the row stops naming them, so a live link never points at a missing file.
  await pool(removed, LOCAL ? 1 : 4, async (rel) => {
    await wrangler(["r2", "object", "delete", `${BUCKET}/${slug}/${rel}`, where]);
    process.stdout.write(`  ✕ ${rel}\n`);
  });
  console.log(`Published ${slug}: ${changed.length} uploaded, ${removed.length} removed, ${Object.keys(site.files).length - changed.length} unchanged.`);
}

async function link(slug, label = "") {
  if (!slug) die("usage: link <slug> [label]");
  const [site] = await sql(`SELECT slug FROM sites WHERE slug = ${q(slug)}`);
  if (!site) die(`"${slug}" is not published yet. Run: publish ${slug}`);
  const token = randomBytes(24).toString("base64url");
  const id = randomBytes(4).toString("hex");
  const now = Date.now();
  const expires = now + UNOPENED_TTL_DAYS * DAY;
  await sql(`INSERT INTO links (id, token_hash, site_slug, label, created_at, expires_at)
    VALUES (${q(id)}, ${q(createHash("sha256").update(token).digest("hex"))}, ${q(slug)}, ${q(label)}, ${now}, ${expires})`);
  const url = `${BASE_URL}/s/${token}/`;
  if (flags.json) console.log(JSON.stringify({ id, slug, label, url, expires_if_unopened: new Date(expires).toISOString() }));
  else {
    console.log(`\n  ${url}\n`);
    console.log(`  link ${id} for ${slug}${label ? ` (${label})` : ""}: dies ${fmt(expires)} if unopened, or 7 days after first open.`);
    console.log(`  This is the only time the URL is shown; heyhoney stores just its hash.\n`);
  }
  return url;
}

function linkState(l, now = Date.now()) {
  if (l.revoked_at) return "revoked";
  if (now >= l.expires_at) return "expired";
  return l.first_access_at ? "opened" : "unopened";
}

async function links(slug) {
  const rows = await sql(`SELECT * FROM links ${slug ? `WHERE site_slug = ${q(slug)}` : ""} ORDER BY created_at DESC`);
  if (flags.json) return console.log(JSON.stringify(rows.map((l) => ({ ...l, state: linkState(l) })), null, 2));
  if (!rows.length) return console.log("No links.");
  for (const l of rows) {
    const st = linkState(l);
    const when = st === "unopened" || st === "opened" ? `until ${fmt(l.expires_at)}` : "";
    console.log(`${l.id}  ${l.site_slug.padEnd(24)} ${st.padEnd(9)} ${String(l.views).padStart(3)} views  ${when.padEnd(24)} ${l.label}`);
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
  const remote = Object.fromEntries((await sql(`SELECT slug, updated_at, files FROM sites`)).map((r) => [r.slug, r]));
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
    else if (r) state = JSON.stringify(readSite(slug).files) === r.files ? "published" : "stale";
    return { slug, name: l?.name ?? "", description: l?.description ?? "", state,
      updated_at: r ? new Date(r.updated_at).toISOString() : null,
      live_links: liveBy[slug]?.n ?? 0, live_until: liveBy[slug] ? new Date(liveBy[slug].until).toISOString() : null };
  });
  if (flags.json) return console.log(JSON.stringify(out, null, 2));
  if (!out.length) return console.log("No sites yet.");
  for (const s of out) {
    const lk = s.live_links ? `${s.live_links} live link(s) to ${fmt(Date.parse(s.live_until))}` : "no live links";
    console.log(`${s.slug.padEnd(28)} ${s.state.padEnd(10)} ${lk.padEnd(36)} ${s.name}`);
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
    return `| [${slug}](${path.basename(SITES)}/${slug}/${s.meta.entry}) | ${s.meta.name} | ${s.meta.description.replace(/\|/g, "\\|")} | ${Object.keys(s.files).length} |`;
  });
  fs.writeFileSync(path.join(SITES, "..", "INDEX.md"),
    `# Sites\n\nGenerated by \`heyhoney add\`. Live link state is not here (it changes on its own); run \`heyhoney list\`.\n\n` +
    `| Slug | Name | Description | Files |\n|---|---|---|---|\n${rows.join("\n")}\n`);
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

  push <file|dir> <slug> [--name N] [--desc D] [--label L]   add + publish + link, the usual one-shot
  add <file|dir> <slug> [--name N] [--desc D] [--entry F]    copy into <sites>/<slug>/ (lone .html becomes index.html)
  publish <slug> [--force]                                   mirror <sites>/<slug>/ to Cloudflare (changed files only)
  link <slug> [label] [--json]                               mint a new secret link (30d unopened / 7d after first open)
  links [slug] [--json]                                      every link and its state
  revoke <link-id | slug>                                    kill one link, or every link to a site
  list [--json]                                              the index: sites, publish state, live links
  unpublish <slug>                                           delete from Cloudflare (local copy stays)
  index                                                      rewrite INDEX.md
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
    default: console.log(HELP);
  }
} catch (e) {
  die(e.message);
}
