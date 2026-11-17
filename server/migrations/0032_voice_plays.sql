-- Voice messages played in DMs (receipts.rs), WhatsApp-style: the author's tick turns read once everyone listened.
CREATE TABLE voice_plays (
    message_id  BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    channel_id  BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, user_id)
);
