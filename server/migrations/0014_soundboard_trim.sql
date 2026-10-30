-- Soundboard sounds are cut from the uploaded file: keep that original (source) and the cut, so a sound can be
-- trimmed again later. url is the cut that plays.
ALTER TABLE soundboard_sounds
    ADD COLUMN source TEXT,
    ADD COLUMN trim_start REAL NOT NULL DEFAULT 0,
    ADD COLUMN trim_end REAL;
