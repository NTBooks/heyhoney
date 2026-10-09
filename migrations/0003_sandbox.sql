-- Per-site isolation. 1 (the default): the site runs in a sandboxed frame with an opaque origin, so its
-- scripts cannot read or set cookies on the parent domain or reach other heyhoney pages.
-- 0: served directly, same-origin, for sites that need storage, cookies or service workers.
ALTER TABLE sites ADD COLUMN sandbox INTEGER NOT NULL DEFAULT 1;
