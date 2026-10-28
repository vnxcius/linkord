-- Account stats under Settings -> My Account: time spent in voice, plus an index for counting a
-- user's reactions (messages_author exists since 0002).
ALTER TABLE users ADD COLUMN voice_seconds BIGINT NOT NULL DEFAULT 0;
CREATE INDEX reactions_user ON reactions(user_id);
