-- 1.0: new accounts get the guided tour, accounts that already exist get the "Version 1.0 is here!" dialog
-- instead (both read user_settings: tour_done, release_seen).
INSERT INTO user_settings (user_id, data)
SELECT id, '{"tour_done": true}'::jsonb FROM users
ON CONFLICT (user_id) DO UPDATE SET data = user_settings.data || '{"tour_done": true}'::jsonb;
