-- Bot accounts (Link, the music bot in music.rs): no login, shown with a BOT tag, always online.
ALTER TABLE users ADD COLUMN bot BOOLEAN NOT NULL DEFAULT false;
-- A bot's answer to a slash command: {"name": "play", "user_id": "..."} ("<user> used /play" above it).
ALTER TABLE messages ADD COLUMN interaction JSONB;
