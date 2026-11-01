-- Private notes about other people: only the person who wrote one ever sees it.
CREATE TABLE user_notes (
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    note       TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, target_id)
);

-- Server profiles: a picture, banner and about me used only in that server (null = the account's own).
ALTER TABLE members ADD COLUMN avatar TEXT;
ALTER TABLE members ADD COLUMN banner TEXT;
ALTER TABLE members ADD COLUMN bio TEXT;

-- Profile links: up to 5 [{label, url}], in the user's order.
ALTER TABLE users ADD COLUMN links JSONB NOT NULL DEFAULT '[]';
-- Birthday: 'MM-DD', or 'YYYY-MM-DD' when the user also shows the year.
ALTER TABLE users ADD COLUMN birthday TEXT;
-- Profile widgets: the stats card is opt-in, the Kass songs card opt-out.
ALTER TABLE users ADD COLUMN show_stats BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN show_top_songs BOOLEAN NOT NULL DEFAULT true;

-- Songs Kass played for each person (counted once a song played for a while: skips right away don't count).
CREATE TABLE kass_plays (
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- lower-case title: the same song asked for twice adds up.
    key         TEXT NOT NULL,
    title       TEXT NOT NULL,
    url         TEXT NOT NULL,
    uploader    TEXT,
    thumbnail   TEXT,
    plays       INT NOT NULL DEFAULT 0,
    last_played TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, key)
);

-- Profile song: a short clip (cut from `source`, like soundboard sounds) people can play from your full profile.
CREATE TABLE profile_songs (
    user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    url        TEXT NOT NULL,
    source     TEXT NOT NULL,
    title      TEXT NOT NULL,
    volume     REAL NOT NULL DEFAULT 1,
    trim_start REAL NOT NULL DEFAULT 0,
    trim_end   REAL NOT NULL
);
