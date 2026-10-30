-- The last pictures a user uploaded as their avatar (not banners), so they can switch back without
-- uploading again. Capped at api::users::AVATAR_HISTORY; pruned files give their bytes back to the quota.
CREATE TABLE avatar_history (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    url        TEXT NOT NULL,
    size       BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, url)
);
CREATE INDEX avatar_history_user ON avatar_history(user_id, created_at DESC);
