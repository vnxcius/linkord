-- Discord account shown under Settings -> Connections, and soft-deleted accounts. A deleted account
-- keeps its row (messages still need an author) but loses its profile and its Discord link:
-- discord_id becomes 'deleted:<id>', so signing in with that Discord account creates a new user.
ALTER TABLE users
    ADD COLUMN discord_username TEXT,
    ADD COLUMN deleted_at TIMESTAMPTZ;
UPDATE users SET discord_username = username WHERE discord_id NOT LIKE 'dev:%';
