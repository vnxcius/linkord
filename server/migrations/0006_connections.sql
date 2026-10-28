-- Linked third-party accounts (Spotify for now), like Discord's Connections. Tokens stay server-side;
-- the server polls what's playing and shows it as the user's activity.
CREATE TABLE connections (
    user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind             TEXT NOT NULL,
    account_id       TEXT NOT NULL,
    account_name     TEXT NOT NULL,
    access_token     TEXT NOT NULL,
    refresh_token    TEXT NOT NULL,
    expires_at       TIMESTAMPTZ NOT NULL,
    -- "Display on profile" and "Display Spotify as your status" (Discord's two toggles).
    show_on_profile  BOOLEAN NOT NULL DEFAULT true,
    show_activity    BOOLEAN NOT NULL DEFAULT true,
    -- The provider rejected our refresh token: the user has to connect again.
    revoked          BOOLEAN NOT NULL DEFAULT false,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, kind)
);
