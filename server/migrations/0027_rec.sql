-- REC (1.3): people who don't want their voice in other people's recordings. Everyone's client reads it from the
-- user object and leaves their voice out of the recording mix (the recorder's app enforces it).
ALTER TABLE users ADD COLUMN rec_opt_out BOOLEAN NOT NULL DEFAULT false;
