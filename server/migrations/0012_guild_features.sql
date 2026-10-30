-- System messages, like Discord's message types: 0 = normal, 6 = "pinned a message" (reply_to = the pinned
-- message), 7 = "joined the server".
ALTER TABLE messages ADD COLUMN type SMALLINT NOT NULL DEFAULT 0;

ALTER TABLE guilds
    -- Where "joined the server" messages go (NULL = the first text channel) and whether they're posted.
    ADD COLUMN system_channel_id BIGINT REFERENCES channels(id) ON DELETE SET NULL,
    ADD COLUMN join_messages BOOLEAN NOT NULL DEFAULT true,
    -- Picture at the top of the channel list, behind the server name.
    ADD COLUMN banner TEXT,
    -- Voice channel people are moved to after afk_timeout seconds without talking (NULL = off).
    ADD COLUMN afk_channel_id BIGINT REFERENCES channels(id) ON DELETE SET NULL,
    ADD COLUMN afk_timeout INTEGER NOT NULL DEFAULT 300;
