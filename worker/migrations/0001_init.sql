CREATE TABLE videos (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('uploading', 'ready')),
  mime_type   TEXT NOT NULL,
  video_key   TEXT NOT NULL,
  upload_id   TEXT,
  size_bytes  INTEGER,
  duration_ms INTEGER,
  has_thumb   INTEGER NOT NULL DEFAULT 0,
  views       INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE INDEX videos_created_at ON videos (created_at DESC);
