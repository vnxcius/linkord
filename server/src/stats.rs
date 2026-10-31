//! Account stats measured as they happen (Settings -> Stats): time streaming or on camera, sounds played, songs
//! queued, videos shared... in `user_stats`, plus time per game in `user_games`. Counting never fails a request:
//! errors are dropped.

use crate::id::Id;
use crate::state::AppState;

pub async fn add(st: &AppState, user: Id, key: &str, by: i64) {
    if by <= 0 {
        return;
    }
    let _ = sqlx::query(
        "INSERT INTO user_stats (user_id, key, value) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, key) DO UPDATE SET value = user_stats.value + EXCLUDED.value",
    )
    .bind(user)
    .bind(key)
    .bind(by)
    .execute(&st.db)
    .await;
}

/// Keeps the largest value seen (longest call...).
pub async fn max(st: &AppState, user: Id, key: &str, value: i64) {
    let _ = sqlx::query(
        "INSERT INTO user_stats (user_id, key, value) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, key) DO UPDATE SET value = GREATEST(user_stats.value, EXCLUDED.value)",
    )
    .bind(user)
    .bind(key)
    .bind(value)
    .execute(&st.db)
    .await;
}

/// One more of something, in the background.
pub fn bump(st: &AppState, user: Id, key: &'static str) {
    bump_by(st, user, key, 1);
}

pub fn bump_by(st: &AppState, user: Id, key: &'static str, by: i64) {
    let st = st.clone();
    tokio::spawn(async move { add(&st, user, key, by).await });
}

/// Time playing a game (the desktop app reports it every minute or so).
pub async fn game_time(st: &AppState, user: Id, name: &str, icon: Option<&str>, seconds: i64) {
    if seconds <= 0 {
        return;
    }
    let _ = sqlx::query(
        "INSERT INTO user_games (user_id, name, icon, seconds, last_played) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (user_id, name) DO UPDATE SET seconds = user_games.seconds + EXCLUDED.seconds,
             icon = COALESCE(EXCLUDED.icon, user_games.icon), last_played = now()",
    )
    .bind(user)
    .bind(name)
    .bind(icon)
    .bind(seconds)
    .execute(&st.db)
    .await;
    add(st, user, "game_seconds", seconds).await;
}
