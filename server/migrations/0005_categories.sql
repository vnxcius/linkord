-- Channel categories (kind 4): text and voice channels point at one through parent_id (threads keep
-- pointing at their text channel). Existing servers get Discord's default "Text Channels" and
-- "Voice Channels" categories so their sidebars look the same as before.
-- Ids are snowflakes for "now" with sequence numbers from 3,000,000 up, which the server's own
-- generator never reaches, so they can't collide with ids made in the same millisecond.
WITH base AS (
    SELECT (floor(extract(epoch FROM clock_timestamp()) * 1000)::BIGINT - 1767225600000) << 22 AS t
), wanted AS (
    SELECT g.id AS guild_id, k.kind, k.name, k.pos, row_number() OVER (ORDER BY g.id, k.kind) AS n
    FROM guilds g
    CROSS JOIN (VALUES (0::SMALLINT, 'Text Channels', 0), (2::SMALLINT, 'Voice Channels', 1)) AS k(kind, name, pos)
    WHERE EXISTS (SELECT 1 FROM channels c WHERE c.guild_id = g.id AND c.kind = k.kind)
)
INSERT INTO channels (id, guild_id, kind, name, position)
SELECT base.t | (3000000 + wanted.n), wanted.guild_id, 4, wanted.name, wanted.pos FROM wanted, base;

UPDATE channels c SET parent_id = cat.id
FROM channels cat
WHERE cat.guild_id = c.guild_id AND cat.kind = 4 AND c.parent_id IS NULL
  AND ((c.kind = 0 AND cat.name = 'Text Channels') OR (c.kind = 2 AND cat.name = 'Voice Channels'));
