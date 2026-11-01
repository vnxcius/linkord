-- Favorite games found on Wikipedia (games Discord's list doesn't have: older and console games) keep their box
-- art here; game_id is then "wiki:<English Wikipedia page title>".
ALTER TABLE favorite_games ADD COLUMN art TEXT;
