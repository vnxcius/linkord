-- Roles & permissions. The @everyone role shares its id with the guild.
CREATE TABLE roles (
    id           BIGINT PRIMARY KEY,
    guild_id     BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    color        INTEGER,
    permissions  BIGINT NOT NULL DEFAULT 0,
    position     INTEGER NOT NULL DEFAULT 0,
    hoist        BOOLEAN NOT NULL DEFAULT false,
    mentionable  BOOLEAN NOT NULL DEFAULT false,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX roles_guild ON roles(guild_id);

CREATE TABLE member_roles (
    guild_id  BIGINT NOT NULL,
    user_id   BIGINT NOT NULL,
    role_id   BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (guild_id, user_id, role_id),
    FOREIGN KEY (guild_id, user_id) REFERENCES members(guild_id, user_id) ON DELETE CASCADE
);

-- Backfill @everyone for existing guilds with the default member permissions.
-- CREATE_INVITE | ADD_REACTIONS | SEND_MESSAGES | ATTACH_FILES | CONNECT | SPEAK | CHANGE_NICKNAME | CREATE_THREADS
INSERT INTO roles (id, guild_id, name, permissions, position)
SELECT id, id, '@everyone', 1 | 64 | 2048 | 32768 | 1048576 | 2097152 | 67108864 | 34359738368, 0 FROM guilds;

-- Custom emoji. Images live at /uploads/emojis/<id>.<png|gif>.
CREATE TABLE emojis (
    id          BIGINT PRIMARY KEY,
    guild_id    BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    animated    BOOLEAN NOT NULL DEFAULT false,
    creator_id  BIGINT NOT NULL REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX emojis_guild ON emojis(guild_id);

-- Friends and blocks. kind: 1 = friend, 2 = blocked, 3 = incoming request, 4 = outgoing request
CREATE TABLE relationships (
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        SMALLINT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, target_id)
);
CREATE INDEX relationships_target ON relationships(target_id);

-- Synced per-user settings (mutes, favorite GIFs, ...), free-form JSON validated by the server.
CREATE TABLE user_settings (
    user_id  BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data     JSONB NOT NULL DEFAULT '{}'
);

ALTER TABLE users ADD COLUMN upload_bytes BIGINT NOT NULL DEFAULT 0;

-- Group DMs (kind 3) and threads (kind 11) have an owner; threads also point at their starter message.
ALTER TABLE channels
    ADD COLUMN owner_id BIGINT REFERENCES users(id),
    ADD COLUMN thread_message_id BIGINT,
    ADD COLUMN archived BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE messages
    ADD COLUMN pinned_at TIMESTAMPTZ,
    ADD COLUMN embeds JSONB NOT NULL DEFAULT '[]',
    ADD COLUMN mention_everyone BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN thread_id BIGINT;
CREATE INDEX messages_pinned ON messages(channel_id) WHERE pinned_at IS NOT NULL;
CREATE INDEX messages_fts ON messages USING GIN (to_tsvector('simple', content));
CREATE INDEX messages_author ON messages(author_id);
