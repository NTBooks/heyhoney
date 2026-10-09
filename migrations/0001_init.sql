-- A site is permanent content: the files under sites/<slug>/ in the repo, mirrored to R2 at <slug>/<path>.
CREATE TABLE sites (
  slug        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  entry       TEXT NOT NULL,              -- file served at the link root, e.g. index.html
  files       TEXT NOT NULL,              -- JSON {path: sha256} of what is in R2
  created_at  INTEGER NOT NULL,           -- ms epoch
  updated_at  INTEGER NOT NULL
);

-- A link is a disposable grant of access to one site. Only the SHA-256 of the token is stored,
-- so reading this table never yields a working URL.
CREATE TABLE links (
  id              TEXT PRIMARY KEY,       -- short public id, for revoking and listing
  token_hash      TEXT NOT NULL UNIQUE,
  site_slug       TEXT NOT NULL REFERENCES sites(slug) ON DELETE CASCADE,
  label           TEXT NOT NULL DEFAULT '',  -- who it was for
  created_at      INTEGER NOT NULL,
  first_access_at INTEGER,
  expires_at      INTEGER NOT NULL,       -- created + 30d until first open, then first open + 7d
  revoked_at      INTEGER,
  views           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX links_site ON links(site_slug);
CREATE INDEX links_expires ON links(expires_at);
