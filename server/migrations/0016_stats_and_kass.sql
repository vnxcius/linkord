-- Kass is in every server unless it removes him (kicking him clears this; Server Settings adds him back).
ALTER TABLE guilds ADD COLUMN music_bot BOOLEAN NOT NULL DEFAULT true;
-- Settings -> Kass: whether servers you create start with him.
ALTER TABLE users ADD COLUMN kass_new_servers BOOLEAN NOT NULL DEFAULT true;

-- Counters measured as things happen (stats.rs): time streaming, sounds played, songs queued... Anything that can
-- be counted from other tables (messages, reactions) is counted there instead.
CREATE TABLE user_stats (
    user_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key      TEXT NOT NULL,
    value    BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, key)
);

-- Time in each game the desktop app reported ("Playing <game>").
CREATE TABLE user_games (
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    icon         TEXT,
    seconds      BIGINT NOT NULL DEFAULT 0,
    last_played  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, name)
);
