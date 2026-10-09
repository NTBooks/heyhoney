---
slopscore: 2
spec: https://slopscore.org/spec
ai_generated: entirely
human_touch: light
content_rating: everyone
contains: []
category: [devtools, cli, infra]
status: works-on-my-machine
tagline: Your own private Claude Artifacts. Secret links on your domain that expire 7 days after the first open.
built_with: [claude-code, claude]
models: [claude-opus-5.5]
interface: [cli, web, plugin]
platforms: [cloudflare]
frameworks: [wrangler, typescript, nodejs]
audience: [me, developers, agents]
data: [none]
needs: ["Cloudflare account (free tier works)", "a domain on Cloudflare"]
domain: private sharing, self-hosting, Claude Code skills
tags:
  - cloudflare-workers
  - r2
  - d1
  - claude-code-skill
  - secret-links
  - expiring-links
  - self-hosted
  - artifacts
slopbucket: [devtools, claude-skills, self-hosted]
images:
  - slopscore-1.png
  - slopscore-2.png
  - slopscore-3.png
  - slopscore-4.png
maintainers: [NTBooks]
---

Claude makes me a lot of HTML. Dashboards, mockups, one-off reports. Artifacts are great until I want to show
one to somebody who isn't me, and then it's either public or it's stuck behind my login.

So this is the boring version I actually wanted. Claude pushes the page to a Worker on my own domain and hands
back a secret link. Nobody logs in. The link dies on its own: a month if nobody opens it, a week after
somebody does. The page itself stays put, so when I want to show it again Claude just mints another link with
the new person's name on it.

The files sit in a private R2 bucket and the Worker only serves what a live token unlocks. There's no upload
endpoint at all; the CLI uses my own wrangler login, so there is nothing on the internet to guess a password
for. Slack and iMessage previews get a blank card, so pasting a link into chat doesn't burn it.

What it isn't: real access control. Whoever has the link has the page, which is the deal with every secret
link. For the odd thing I'd mind being forwarded there's an optional six-digit code, sent separately, and ten
wrong guesses kill the link. Still no logins.

tl;dr: Artifacts, but mine, and they clean up after themselves.
