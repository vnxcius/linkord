-- Per-channel permission overwrites, like Discord's: for a role (kind 0; @everyone's id is the server's) or a
-- member (kind 1). Threads use their parent's. A channel in a category is "synced" when its overwrites equal the
-- category's (computed, not stored).
CREATE TABLE channel_overwrites (
    channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    target_id  BIGINT NOT NULL,
    kind       SMALLINT NOT NULL,
    allow      BIGINT NOT NULL DEFAULT 0,
    deny       BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, target_id)
);
CREATE INDEX channel_overwrites_target ON channel_overwrites (target_id);

-- New permissions everyone already had implicitly: View Channel (1<<10), Read Message History (1<<16),
-- Video (1<<9) and Use Soundboard (1<<42). Move Members (1<<24) stays off: only admins or roles given it.
UPDATE roles SET permissions = permissions | 1024 | 65536 | 512 | 4398046511104 WHERE id = guild_id;
