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
5. Reply with the URL on its own line, who it is labelled for, and when it expires (and the pin, if any).

## Everything else

| Want | Run |
|---|---|
| What's hosted, publish state, live links | `hh list` (add `--json` to read it programmatically) |
| A fresh link for an existing site | `hh link <slug> "label"` |
| Every link and whether it was opened | `hh links [slug]` |
| Update a site, keep its links | `hh add <file|dir> <slug>` then `hh publish <slug>`, then commit the sites repo |
| Edit files in place | edit `{{SITES}}/<slug>/...` directly, then `hh publish <slug>`, then commit |
| A link that also needs a code | `hh link <slug> "label" --pin` (or `--pin=4821` to choose; works on `push` too) |
| Kill one link / every link to a site | `hh revoke <link-id>` / `hh revoke <slug>` |
| Turn a site's sandbox off / back on | `hh sandbox <slug> off` / `hh sandbox <slug> on` (live at once, links kept) |
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
- To check a live site without starting its clock, fetch with a `sec-fetch-mode: no-cors` header. That counts
  as a sub-resource load, not an open.
- Don't put secrets or credentials in a site. Anyone holding the link can read every file in it.
- The tool repo is public. Site content, slugs, labels and links belong only in the sites repo.
- `--local` on any command targets `wrangler dev` state at localhost:8787 for testing the Worker itself.
- Changing the Worker (`src/index.ts`): run `npx tsc --noEmit`, test with `npm run dev` plus `--local` pushes,
  then `npx wrangler deploy` from the tool repo.
