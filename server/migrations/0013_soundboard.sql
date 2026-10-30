-- A server's soundboard sounds (the default ones are files in LINKORD_SOUNDS_DIR). Files live under /uploads/sounds.
CREATE TABLE soundboard_sounds (
    id          BIGINT PRIMARY KEY,
    guild_id    BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    emoji       TEXT,
    -- 0..1, how loud the sound plays for everyone (each listener has their own volume on top).
    volume      REAL NOT NULL DEFAULT 1,
    url         TEXT NOT NULL,
    creator_id  BIGINT NOT NULL REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX soundboard_sounds_guild ON soundboard_sounds(guild_id);
