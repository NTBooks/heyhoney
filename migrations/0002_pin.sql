-- Optional per-link passcode. pin_hash = sha256("<link id>:<pin>"); NULL means no pin.
-- unlock_key is a random secret the Worker sets as a cookie (scoped to the link's path) once the pin is
-- right, so the recipient types it once per browser. Too many wrong pins revoke the link.
ALTER TABLE links ADD COLUMN pin_hash TEXT;
ALTER TABLE links ADD COLUMN unlock_key TEXT;
ALTER TABLE links ADD COLUMN pin_failures INTEGER NOT NULL DEFAULT 0;
