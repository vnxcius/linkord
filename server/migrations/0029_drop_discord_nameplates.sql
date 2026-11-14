-- Pottira rebrand: the default nameplates were Discord's shop nameplates and are gone from the nameplates folder.
-- Anyone wearing one goes back to no nameplate (their own uploads, /uploads/nameplates/..., stay).
UPDATE users SET nameplate = NULL WHERE nameplate LIKE '/nameplates/%';
