-- Web Push subscriptions (push.rs): a browser or installed web app on a phone that gets notifications while Linkord
-- isn't open. Each belongs to the login that made it, so signing out (or the session ending) removes it.
CREATE TABLE push_subscriptions (
    endpoint    TEXT PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session     BYTEA NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
    p256dh      BYTEA NOT NULL,
    auth        BYTEA NOT NULL,
    -- 'pt-BR' or 'en': the few words the server writes itself ("Sent an attachment", "is calling you").
    lang        TEXT NOT NULL DEFAULT 'en',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_ok_at  TIMESTAMPTZ
);
CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);
