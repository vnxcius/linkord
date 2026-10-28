-- Custom status ("emoji + a few words"), like Discord's. Shown in place of the activity line; cleared at
-- expires_at if set (a sweep removes it, so it never lingers).
CREATE TABLE custom_statuses (
    user_id     BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    text        TEXT,
    -- {"name": "🎮"} or a server emoji {"id": "...", "name": "pog", "animated": false}
    emoji       JSONB,
    expires_at  TIMESTAMPTZ
);
