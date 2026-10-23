---
name: heyhoney
description: Push HTML pages, designs, prototypes, reports or any folder of web files to the user's private heyhoney host ({{URL}}) behind a secret link that expires on its own (30 days if never opened, 7 days after first open), and manage everything already hosted there - list/index sites, mint fresh links for an existing site, revoke links, update or take down a site. Use whenever the user says heyhoney, "push this up", "give me a secret link", "share this privately", "host this", "send this to <person>", "make a new link for <site>", "what's on heyhoney", "kill that link", or wants something made with an AI assistant (here, or exported from Claude, ChatGPT, Gemini or Meta AI) viewable by someone else without a login. Prefer it over public share links (claude.ai Artifacts, ChatGPT or Gemini canvas shares) when they mention heyhoney or a private/secret link.
---

# heyhoney

The user's private alternative to Artifacts, served from `{{URL}}`.

- Tool (CLI + Worker): `{{HEYHONEY}}`
- Sites (the content archive, its own **private** git repo): `{{SITES_REPO}}`, one folder per site under `{{SITES}}`
- CLI: `node {{HEYHONEY}}/bin/heyhoney.mjs <command>` (written `hh` below). It drives wrangler, which is
  already logged in, so nothing else needs credentials.

(Installed by `hh install-skill`, which fills in these paths. Edit `skill/SKILL.md` in the tool repo, not this copy.)

## Model

- A **site** is permanent: a folder `<slug>/` under the sites dir with `site.json` (`name`, `description`,
  optional `entry`), mirrored to R2. The sites repo is the archive; its `INDEX.md` is the catalog.
- A **link** is a disposable grant to one site: `{{URL}}/s/<token>/`. It dies 30 days after minting if nobody
  opens it, or 7 days after its first open. Expired or revoked links 404; the site stays, and you mint a new
  link when access is wanted again. Many links per site are fine; one per recipient, labelled with who it is
  for, is best.
- Only the token's hash is stored. **The URL is printed once, at mint time.** Give it to the user right away.
  If they lose it, mint another; never try to recover one.
- Every mint prints **two links**: `send:` (the one for the recipient) and `stealth:` (the same URL plus
  `?stealth=<link id>`, for the owner). Opening the stealth one never starts the clock or adds a view, so the
  user, or you, can check the page without burning the recipient's link. **Always give the user both,
  clearly marked**, so they never send the stealth one by mistake (a recipient using it would be invisible
  in `hh links`). For older links, the stealth URL is the link plus `?stealth=<id>`, with the id from `hh links`.

## Pushing something new

1. Get the content into a file or folder. If you just designed it in the conversation, write it to the scratchpad
   first. A single `.html` becomes `index.html`. A folder keeps its layout and serves `index.html` (or `--entry`).
   Anything an HTML page references by relative path must be in the same folder, so push the folder, not just
   the page, and leave out drafts and previews. CDN links (cdnjs, jsdelivr, unpkg, Google Fonts) work as normal.
   If the user hands you HTML exported from a chat app (ChatGPT or Gemini Canvas, a claude.ai Artifact, Meta AI),
   push it the same way. heyhoney is meant to be the one place all their AI-made pages live, whichever
   assistant made them. You haven't reviewed that code, though, so treat it as untrusted under **Sandbox** below.
2. Choose a short kebab-case slug that says what it is (`kitchen-moodboard`, `deck-q4-pitch`). Run `hh list`
   first. If the slug exists, this is an update (see below), not a new site.
3. One shot:
   ```
   hh push <file|dir> <slug> --name "Human title" --desc "One line: what it is and why it exists" --label "who it's for"
   ```
   `--desc` is what makes the index useful months from now; always write one.
   Read the publish output. A `⚠ ... sandbox blocks` block means the page uses something that won't work
   sandboxed. Deal with it before handing over the link (see **Sandbox** below).
4. Commit the **sites** repo (never the tool repo, which is public):
   `git -C {{SITES_REPO}} add -A && git -C {{SITES_REPO}} commit -m "Add <slug>" && git -C {{SITES_REPO}} push`.
   Never commit a link URL (not in commit messages, `site.json`, or any file).
5. Reply with both links, each on its own line and labelled: **Send** (the URL for the recipient) and
   **Stealth (just for you; opens don't count)**. Add who it is labelled for, when it expires, and the pin,
   if any. Do this for every link you mint, from `push` or `link`.

## Everything else

| Want | Run |
|---|---|
| What's hosted, publish state, live links | `hh list` (add `--json` to read it programmatically) |
| A fresh link for an existing site | `hh link <slug> "label"` (prints send + stealth; give the user both) |
| Every link and whether it was opened | `hh links [slug]` |
| Update a site, keep its links | `hh add <file|dir> <slug>` then `hh publish <slug>`, then commit the sites repo |
| Edit files in place | edit `{{SITES}}/<slug>/...` directly, then `hh publish <slug>`, then commit |
| A link that also needs a code | `hh link <slug> "label" --pin` (or `--pin=4821` to choose; works on `push` too) |
| Kill one link / every link to a site | `hh revoke <link-id>` / `hh revoke <slug>` |
| Turn a site's sandbox off / back on | `hh sandbox <slug> off` / `hh sandbox <slug> on` (live at once, links kept) |
| Make a site self-destruct / keep it | `hh ephemeral <slug> on` / `off` (or `--ephemeral` on `push`/`add`) |
| Clean up local copies of self-destructed sites | `hh prune`, then commit the sites repo |
| Take a site offline entirely | `hh unpublish <slug>` (the local copy stays; `git rm` it too if they want it gone) |

`hh list` states: `published` (Cloudflare matches the folder), `stale` (folder changed since the last publish,
so run `publish`), `draft` (never published), `orphan` (on Cloudflare but the folder is gone, so `unpublish`
it or restore it).

`publish` uploads only changed files, deletes files removed from the folder, and leaves links untouched, so an
update reaches everyone who already has a link.

## Pins

Default to a plain link: the whole point is "hey honey, look at this" with no friction. Add `--pin` when the
user asks for a code or passcode, or when the content is something they'd mind being forwarded (money,
health, private documents, anything with an address in it). The pin is printed once, next to the URL. Show both,
and tell the user to send the pin another way than the link. Ten wrong codes revoke the link; `hh links` shows
wrong tries. If a recipient locks themselves out, mint a fresh pinned link.

## Ephemeral sites and video

Sites are kept by default. An **ephemeral** site self-destructs instead: the day after its last link expires or
is revoked, the Worker deletes its files and its catalog entry. It also never enters git, because it lives in
`{{SITES_REPO}}/ephemeral/<slug>/`, which is ignored, so a fresh clone can't bring it back.

Use `--ephemeral` when:
- the user says temporary, one-off, self-destruct, "just for tonight", or similar;
- the site carries big media (video, audio, anything over about 20 MB), unless they say they want to keep it.
  Tell them you made it ephemeral and that `hh ephemeral <slug> off` keeps it.

Video and audio (`.mp4 .mov .webm .mkv .m4v .mp3 .m4a .wav .flac .ogg`) are git-ignored even on kept sites. They
live on disk and in R2, not in git history, so re-exporting a video doesn't grow the repo. `publish` won't
delete live media that's missing from the folder (a fresh clone has none). Pass `--drop-media` to delete it on
purpose. Files over 300 MB can't be uploaded through wrangler, so re-encode them first.

For video in a page: bundle the file and use the **video page template below**, never a bare `<video>` tag.
A plain player can't go full screen on an iPhone from inside the sandboxed frame (a recipient couldn't, on an iPhone). The
template adds a big **Full screen** button that tries, in order:
1. the standard Fullscreen API (desktop, Android, iPad);
2. the iPhone's own video player (`webkitEnterFullscreen`);
3. if neither opens within half a second, a "theater" mode that fills the page, with a × to close and a
   "turn your phone sideways" hint in portrait.

It also keeps an "open the video on its own" link. Start playback only from the user's click. YouTube embeds
don't load in the sandbox. For a long or large master, ship a 1080p copy under 300 MB with a keyframe every
second, so seeking is quick. Pick a poster frame that's sharp and shows the cast (not motion-blurred). Change
the title, blurb, file names and accent colour (`--accent`), and keep the rest as it is.

```html
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>TITLE</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@400;500;800&display=swap">
<style>
  :root { --bg:#0e0e12; --fg:#f2f2f0; --accent:#FFC94D; --mut:#9a9aa6; color-scheme: dark }
  html,body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.55 Inter, system-ui, sans-serif }
  main { max-width: 1100px; margin: 0 auto; padding: 28px 16px 40px; }
  h1 { font: 400 clamp(40px, 8vw, 72px)/1 Anton, Impact, sans-serif; margin: 0 0 6px; letter-spacing: .02em; color: var(--accent) }
  p.by { margin: 0 0 18px; color: var(--mut) }
  .stage { position: relative }
  video { width: 100%; height: auto; display: block; border-radius: 8px; background: #000; box-shadow: 0 0 0 1px #26262e }
  .bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 14px }
  button.fs { font: 800 17px/1 Inter, sans-serif; color: #111; background: var(--accent); border: 0; border-radius: 10px;
    padding: 14px 20px; cursor: pointer; display: inline-flex; gap: 10px; align-items: center }
  button.fs svg { width: 20px; height: 20px }
  a.own { color: var(--mut); font-size: 14px }
  p.note { color: var(--mut); font-size: 14px; margin-top: 14px }
  /* theater: the fallback when the phone won't hand the video to its own full-screen player */
  body.theater { overflow: hidden }
  body.theater .stage { position: fixed; inset: 0; z-index: 10; background: #000; display: flex; align-items: center; justify-content: center }
  body.theater video { width: 100vw; height: 100vh; height: 100dvh; object-fit: contain; border-radius: 0; box-shadow: none }
  .close { display: none; position: absolute; top: max(12px, env(safe-area-inset-top)); right: max(12px, env(safe-area-inset-right)); z-index: 11;
    width: 44px; height: 44px; border-radius: 22px; border: 0; background: rgba(255,255,255,0.18); color: #fff; font: 800 22px/44px Inter, sans-serif; cursor: pointer }
  .hint { display: none; position: absolute; left: 16px; right: 70px; top: max(22px, calc(env(safe-area-inset-top) + 10px)); color: #ccc; font-size: 14px; pointer-events: none }
  body.theater .close { display: block }
  @media (orientation: portrait) { body.theater .hint { display: block } }
</style></head>
<body><main>
  <h1>TITLE</h1>
  <p class="by">ONE-LINE BLURB.</p>
  <div class="stage">
    <video id="v" src="video.mp4" poster="poster.jpg" controls playsinline preload="metadata"></video>
    <button class="close" id="close" aria-label="Exit full screen">×</button>
    <div class="hint">Turn your phone sideways for a bigger picture</div>
  </div>
  <div class="bar">
    <button class="fs" id="fs" type="button">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>
      Full screen
    </button>
    <a class="own" href="video.mp4" target="_blank" rel="noopener">or open the video on its own</a>
  </div>
  <p class="note">Press play and turn the sound up.</p>
</main>
<script>
  const v = document.getElementById('v');
  const theater = (on) => { document.body.classList.toggle('theater', on); if (on) v.play().catch(() => {}); };
  document.getElementById('close').addEventListener('click', () => theater(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') theater(false); });
  document.getElementById('fs').addEventListener('click', () => {
    const req = v.requestFullscreen || v.webkitRequestFullscreen;   // 1. the standard Fullscreen API
    if (req && document.fullscreenEnabled !== false) {
      try { const p = req.call(v); if (p && p.catch) p.catch(() => tryIphone()); return; } catch (e) { /* fall through */ }
    }
    tryIphone();
  });
  function tryIphone() {   // 2. the iPhone's own player; 3. if it doesn't open in half a second, fill the page
    let opened = false;
    v.addEventListener('webkitbeginfullscreen', () => { opened = true; }, { once: true });
    try { v.play().catch(() => {}); if (v.webkitEnterFullscreen) v.webkitEnterFullscreen(); } catch (e) { /* fall through */ }
    setTimeout(() => { if (!opened && !document.fullscreenElement) theater(true); }, 500);
  }
</script>
</body></html>
```

To add the button to a video site that is already live, rebuild its `index.html` from the template, keeping
its title, blurb and file names. Then run `hh publish <slug>`: the links people already have keep working.

`hh list` shows `[ephemeral]`, and `gone` for an ephemeral site that has self-destructed (`publish` brings it
back while the local copy exists; `prune` deletes the local copy).

## Sandbox

Every site is **sandboxed by default**. Its page runs inside a frame with a throwaway (`null`) origin. Its
scripts can't read or set cookies for {{URL}} or its parent domain, and can't reach other heyhoney pages or
anything else on the domain. Leave it on. Most pages AI assistants make (charts, dashboards, mockups, 3D, CDN
libraries, `fetch()` of their own data files, forms, `alert`, downloads) work fine sandboxed.

What breaks in the sandbox (throws, or quietly does nothing):
- `localStorage`, `sessionStorage`, `IndexedDB`, `document.cookie` (remembering settings, saved state, drafts)
- service workers, the Cache API (offline/PWA)
- camera, microphone, location, notifications, passkeys and saved logins
- navigating or reading the top window without a click (`top.location = ...`, `parent.document`)

`publish` scans the site for these and prints a `⚠` list. When it does, in this order:
1. **If you wrote the page, fix the page.** This is almost always right. Wrap storage in `try/catch` with an
   in-memory fallback, so the page works and simply doesn't remember between visits. Re-run `publish`.
2. **If the feature is the point** (an app that must save the user's work in the browser, an offline PWA,
   something using the camera), say so to the user *before* turning the sandbox off. Tell them in plain words:
   *"This page needs <feature>, which only works with the sandbox off. With it off, the page's code runs
   directly on {{URL}}, so it could read or set cookies for your whole domain and open any other heyhoney page
   whose link it knows. That's fine for code we wrote together; don't do it for HTML from someone else."*
   Only after they say yes: `hh sandbox <slug> off` (or `--no-sandbox` on `push`/`add`).
3. **Never turn the sandbox off for HTML the user didn't make with you** (downloaded, pasted from elsewhere, a
   template from the web). If it needs the sandbox off, tell them it can't be hosted safely here.

`hh list` marks unsandboxed sites `[unsandboxed]` and `INDEX.md` has a Sandboxed column. If the user later
asks whether anything risky is hosted, that's where to look.

## Gotchas

- Link unfurlers (Slack, iMessage, Discord and the like) get a blank "A private link" stub and do not start the
  7-day clock, so it's safe to paste links into chat. Corporate mail scanners that use real browsers can still
  count as the first open.
- To check a live link yourself, open its stealth URL (`?stealth=<link id>`). The response header
  `x-heyhoney-view: stealth, not counted` confirms it wasn't counted. A fetch with a
  `sec-fetch-mode: no-cors` header also doesn't count: it looks like a sub-resource load, not an open.
- Don't put secrets or credentials in a site. Anyone holding the link can read every file in it.
- The tool repo is public. Site content, slugs, labels and links belong only in the sites repo.
- `--local` on any command targets `wrangler dev` state at localhost:8787 for testing the Worker itself.
- Changing the Worker (`src/index.ts`): run `npx tsc --noEmit`, test with `npm run dev` plus `--local` pushes,
  then `npx wrangler deploy` from the tool repo.
