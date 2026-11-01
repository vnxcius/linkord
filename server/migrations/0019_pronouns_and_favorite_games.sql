-- Pronouns on the profile (up to 40 characters, like Discord's).
ALTER TABLE users ADD COLUMN pronouns TEXT NOT NULL DEFAULT '';

-- Profile widgets: the user's favorite games (up to 20, in their order). game_id = the Discord application id from
-- the game catalog (activities.rs); null for games typed by hand. The name is kept so the list survives the game
-- leaving the catalog.
CREATE TABLE favorite_games (
    user_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    position SMALLINT NOT NULL,
    game_id  TEXT,
    name     TEXT NOT NULL,
    PRIMARY KEY (user_id, position)
);
