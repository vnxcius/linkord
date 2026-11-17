-- DM receipts (receipts.rs): how far each recipient's devices have received a DM or group DM. Read positions stay
-- in read_states; a read message counts as delivered too.
CREATE TABLE delivered_states (
    user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id         BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_delivered_id  BIGINT NOT NULL,
    PRIMARY KEY (user_id, channel_id)
);

-- When each position moved (Message info: "Delivered 14:02, Read 14:05"). Positions only move forward, so a
-- message's time is the first mark at or past it. `read` marks count as delivered too.
CREATE TABLE receipt_marks (
    channel_id  BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    read        BOOLEAN NOT NULL,
    message_id  BIGINT NOT NULL,
    at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX receipt_marks_lookup ON receipt_marks (channel_id, user_id, message_id);
