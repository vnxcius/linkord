-- Removing someone for good: a server's own ban list, and accounts the operator suspended (no sign-in, no sessions).
CREATE TABLE guild_bans (
    guild_id   BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    banned_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (guild_id, user_id)
);

ALTER TABLE users ADD COLUMN suspended_at TIMESTAMPTZ;

-- Usernames are unique among live accounts; two simultaneous requests could get past the check. Any such duplicate
-- keeps a stand-in and picks a new name, like a new account whose name is taken.
UPDATE users u SET username = left(u.username, 20) || '_' || right(u.id::text, 8), needs_username = TRUE, username_set = FALSE
WHERE u.deleted_at IS NULL AND EXISTS (
    SELECT 1 FROM users o WHERE o.username = u.username AND o.deleted_at IS NULL AND o.id < u.id
);
CREATE UNIQUE INDEX users_username_live ON users (username) WHERE deleted_at IS NULL;
