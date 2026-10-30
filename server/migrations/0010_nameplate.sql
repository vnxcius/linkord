-- Member-list card background (like Discord's nameplates): either a default from the server's nameplates
-- folder (/nameplates/<file>) or the user's own upload (/uploads/nameplates/<user>/...).
ALTER TABLE users ADD COLUMN nameplate TEXT;
