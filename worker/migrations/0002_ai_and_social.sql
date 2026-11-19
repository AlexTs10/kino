-- AI (transcript, title, summary, chapters), trim, comments, reactions, settings.

ALTER TABLE videos ADD COLUMN title_source TEXT NOT NULL DEFAULT 'auto'; -- 'auto' (AI may replace it) | 'user'
ALTER TABLE videos ADD COLUMN ai_status TEXT NOT NULL DEFAULT 'none';    -- none | queued | transcribing | summarizing | done | error
ALTER TABLE videos ADD COLUMN ai_error TEXT;
ALTER TABLE videos ADD COLUMN summary TEXT;
ALTER TABLE videos ADD COLUMN chapters TEXT;                             -- JSON: [{ "start": seconds, "title": "..." }]
ALTER TABLE videos ADD COLUMN language TEXT;
ALTER TABLE videos ADD COLUMN transcript_text TEXT;                      -- plain text, for search
ALTER TABLE videos ADD COLUMN trim_start_ms INTEGER;
ALTER TABLE videos ADD COLUMN trim_end_ms INTEGER;

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  t_ms INTEGER,
  is_owner INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX comments_video ON comments (video_id, created_at);

CREATE TABLE reactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  t_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX reactions_video ON reactions (video_id);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
