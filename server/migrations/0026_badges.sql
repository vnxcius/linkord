-- Profile badges (badges.rs). One row per badge someone has: milestones keep their highest tier (0 = Bronze ...
-- 4 = Diamond; single badges stay 0) and earned_at is when that tier was reached. Badges are never taken away, except
-- 'admin', which follows LINKORD_ADMINS. hidden/position are the owner's choices in Settings -> Badges (position NULL =
-- the catalog's order, after the ones placed by hand).
CREATE TABLE user_badges (
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    badge      TEXT NOT NULL,
    tier       SMALLINT NOT NULL DEFAULT 0,
    earned_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    hidden     BOOLEAN NOT NULL DEFAULT false,
    position   INTEGER,
    PRIMARY KEY (user_id, badge)
);

-- Early Member: every account that existed when 1.0 came out (migration 17 is 1.0's), dated when they joined.
INSERT INTO user_badges (user_id, badge, earned_at)
SELECT u.id, 'early', u.created_at FROM users u
WHERE NOT u.bot AND u.deleted_at IS NULL
  AND u.created_at < (SELECT installed_on FROM _sqlx_migrations WHERE version = 17);
