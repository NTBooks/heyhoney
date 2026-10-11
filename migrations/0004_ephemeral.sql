-- Ephemeral sites self-destruct: once a day the Worker deletes any ephemeral site that has no live link left
-- (every link expired or revoked) and hasn't been republished in the last day, files and all.
ALTER TABLE sites ADD COLUMN ephemeral INTEGER NOT NULL DEFAULT 0;
