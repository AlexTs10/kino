-- Accounts: email magic-link sign-in, one session table for browser cookies and extension tokens.

CREATE TABLE users (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

-- Only SHA-256 hashes of the secrets are stored.
CREATE TABLE login_tokens (
  hash       TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX login_tokens_email ON login_tokens (email, created_at);

CREATE TABLE sessions (
  hash       TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

-- NULL = a video from before accounts. OWNER_EMAIL claims these on first sign-in.
ALTER TABLE videos ADD COLUMN user_id TEXT;
CREATE INDEX videos_user ON videos (user_id, created_at DESC);
