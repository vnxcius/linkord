-- League of Legends (league.rs): the Riot account someone linked for the profile widget, and whether others see it.
-- puuid is the one Riot's API gives this server's key (PUUIDs are encrypted per API key, so the League client's own
-- PUUID can't be used); platform is where the account plays (always 'br1': every account is on BR).
CREATE TABLE league_accounts (
    user_id     BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    puuid       TEXT NOT NULL,
    game_name   TEXT NOT NULL,
    tag_line    TEXT NOT NULL,
    platform    TEXT NOT NULL,
    linked_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN show_league BOOLEAN NOT NULL DEFAULT false;
