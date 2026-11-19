-- Password and expiry per link, real trim (cut the file), viewer insights.

ALTER TABLE videos ADD COLUMN password_hash TEXT;          -- "salt:hash" (PBKDF2-SHA256). NULL = no password
ALTER TABLE videos ADD COLUMN expires_at INTEGER;          -- ms since epoch. NULL = the link never expires
ALTER TABLE videos ADD COLUMN edit_key TEXT;               -- cut: R2 key of the new file while it uploads
ALTER TABLE videos ADD COLUMN edit_upload_id TEXT;
ALTER TABLE videos ADD COLUMN audio_shift_ms INTEGER NOT NULL DEFAULT 0; -- cut: the audio parts start this much before the file

-- One row per viewer (a random id in the viewer's browser) and video.
CREATE TABLE watches (
  video_id   TEXT NOT NULL,
  viewer     TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  seconds    INTEGER NOT NULL DEFAULT 0,  -- different seconds of the video that this viewer played
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (video_id, viewer)
);
