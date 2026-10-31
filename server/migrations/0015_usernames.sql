-- Usernames can be changed in Linkord. username_set: the user picked theirs, so signing in no longer copies the
-- Discord username over it. needs_username: a new account whose Discord username was taken got a stand-in name
-- and must pick its own before using the app.
ALTER TABLE users
    ADD COLUMN username_set BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN needs_username BOOLEAN NOT NULL DEFAULT false;
