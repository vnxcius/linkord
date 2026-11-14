-- REC (1.3): clips and VODs shared from the desktop app (clips.rs). Anyone with the link watches them at /clip/<slug>;
-- the file is uploads/clips/<slug>.mp4 (+ .jpg, its picture).
CREATE TABLE clips (
    id          BIGINT PRIMARY KEY,
    -- 12 random characters: the public link. Ids are guessable, links must not be.
    slug        TEXT NOT NULL UNIQUE,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- 'clip' or 'vod' (a whole recording, or a long part of one).
    kind        TEXT NOT NULL DEFAULT 'clip',
    title       TEXT NOT NULL DEFAULT '',
    game        TEXT NOT NULL DEFAULT '',
    duration_ms BIGINT NOT NULL DEFAULT 0,
    width       INT NOT NULL DEFAULT 0,
    height      INT NOT NULL DEFAULT 0,
    size        BIGINT NOT NULL,
    -- Different viewers per day, the owner left out.
    views       BIGINT NOT NULL DEFAULT 0,
    -- Shown in the recent clips widget on the owner's profile.
    on_profile  BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX clips_user ON clips(user_id, created_at DESC);

-- Uploads in progress: the file grows in data/clip-uploads/<id>.part, 50 MB at a time (Cloudflare caps a request at
-- 100 MB), and survives restarts and handovers. Abandoned ones are swept after a day.
CREATE TABLE clip_uploads (
    id          TEXT PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    size        BIGINT NOT NULL,
    received    BIGINT NOT NULL DEFAULT 0,
    meta        JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Who watched what, to count each viewer once a day: a hash of their address and the day with a server secret, never
-- the address itself.
CREATE TABLE clip_views (
    clip_id     BIGINT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    viewer      BYTEA NOT NULL,
    day         DATE NOT NULL DEFAULT CURRENT_DATE,
    PRIMARY KEY (clip_id, viewer, day)
);

ALTER TABLE users ADD COLUMN show_clips BOOLEAN NOT NULL DEFAULT true;
