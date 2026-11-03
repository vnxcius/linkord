-- Settings -> Sessions: which device each login is, and a handle to end one that isn't its token.
ALTER TABLE sessions
    ADD COLUMN id TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    ADD COLUMN client TEXT,
    ADD COLUMN user_agent TEXT,
    ADD COLUMN last_seen_at TIMESTAMPTZ;

CREATE UNIQUE INDEX sessions_id ON sessions (id);
