//! Profile badges (Settings -> Badges, owner 2026-11-12). Stored in `user_badges` (migration 0026): once earned a
//! badge stays, except Pottira Admin, which follows POTTIRA_ADMINS.
//!
//! - Milestones have 5 tiers (0 Bronze .. 4 Diamond) and keep the highest one reached: account age, games, time
//!   played, streaming, calls, watch together, soundboard, snowballs. Thresholds: [`LADDERS`] (the client's
//!   lib/badges.ts has the same numbers to label them).
//! - Single badges: admin, early (accounts from before 1.0, given by the migration), owner (owns a server),
//!   christmas_<year> (used Pottira during that Christmas season), and the ones an admin gives from the monitor
//!   ([`MANUAL`], through internal.rs).
//!
//! [`sweeper`] checks everyone connected once a minute; a new badge or tier reaches its owner as BADGE_EARNED (for the
//! "New badge" card) plus BADGES_UPDATE (the full list, as GET /users/@me/badges returns it). Others see a profile's
//! badges in GET /users/{id}/profile and GET /users/{id}/badges: only the shown ones, without the numbers behind them.

use std::collections::HashMap;
use std::time::Duration;

use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Json, Router};
use chrono::{DateTime, Datelike, Utc};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::AuthUser;
use crate::error::{bad, ApiResult};
use crate::id::Id;
use crate::models::User;
use crate::state::AppState;

const HOUR: i64 = 3600;

/// A milestone: where its number comes from and the 5 tiers' thresholds (in the source's unit).
struct Ladder {
    id: &'static str,
    source: Source,
    thresholds: [i64; 5],
}

#[derive(Clone, Copy)]
enum Source {
    /// Days since the account was made.
    AccountDays,
    /// Different games the desktop app reported (user_games).
    Games,
    /// users.voice_seconds.
    VoiceSeconds,
    /// A user_stats counter.
    Stat(&'static str),
}

const LADDERS: &[Ladder] = &[
    Ladder { id: "member", source: Source::AccountDays, thresholds: [30, 90, 180, 365, 730] },
    Ladder { id: "calls", source: Source::VoiceSeconds, thresholds: [10 * HOUR, 50 * HOUR, 100 * HOUR, 500 * HOUR, 1000 * HOUR] },
    Ladder { id: "played", source: Source::Stat("game_seconds"), thresholds: [10 * HOUR, 50 * HOUR, 100 * HOUR, 500 * HOUR, 1000 * HOUR] },
    Ladder { id: "games", source: Source::Games, thresholds: [5, 10, 25, 50, 100] },
    Ladder { id: "live", source: Source::Stat("stream_seconds"), thresholds: [HOUR, 10 * HOUR, 50 * HOUR, 100 * HOUR, 250 * HOUR] },
    Ladder { id: "watch", source: Source::Stat("watch_together_seconds"), thresholds: [HOUR, 10 * HOUR, 25 * HOUR, 50 * HOUR, 100 * HOUR] },
    Ladder { id: "sounds", source: Source::Stat("sounds_played"), thresholds: [10, 100, 500, 1000, 5000] },
    Ladder { id: "snowball", source: Source::Stat("snowballs_thrown"), thresholds: [1, 10, 50, 100, 500] },
    // REC (2.0): clips shared, others' views of them (clips.rs), hours recorded (POST /users/@me/rec/recorded).
    Ladder { id: "clips", source: Source::Stat("clips_shared"), thresholds: [1, 10, 50, 150, 500] },
    Ladder { id: "views", source: Source::Stat("clip_views"), thresholds: [25, 250, 1000, 5000, 25000] },
    Ladder { id: "recorded", source: Source::Stat("rec_seconds"), thresholds: [10 * HOUR, 50 * HOUR, 100 * HOUR, 500 * HOUR, 1000 * HOUR] },
];

/// Single badges an event gives (never taken away): `premiere` (a clip of yours watched together by 3+ people, watch.rs),
/// `pentakill` (a League pentakill REC caught, checked against Riot's match, league.rs).
pub const EARNED: [&str; 2] = ["premiere", "pentakill"];

/// Gives someone a single badge (if they didn't have it) and tells their apps.
pub async fn grant(st: &AppState, user: Id, badge: &str) {
    let new: Vec<(String, i16)> = sqlx::query_as(
        "INSERT INTO user_badges (user_id, badge, tier) VALUES ($1, $2, 0) ON CONFLICT (user_id, badge) DO NOTHING RETURNING badge, tier",
    )
    .bind(user)
    .bind(badge)
    .fetch_all(&st.db)
    .await
    .unwrap_or_default();
    if !new.is_empty() {
        announce(st, user, &new).await;
    }
}

/// Badges only an admin gives (monitor -> Accounts).
pub const MANUAL: [&str; 4] = ["bug_hunter", "tester", "contributor", "helper"];

/// The order badges take until their owner arranges them.
fn rank(badge: &str) -> usize {
    const FIRST: [&str; 3] = ["admin", "early", "owner"];
    if let Some(i) = FIRST.iter().position(|b| *b == badge) {
        return i;
    }
    if let Some(i) = LADDERS.iter().position(|l| l.id == badge) {
        return 10 + i;
    }
    if badge.starts_with("christmas_") {
        return 30;
    }
    if let Some(i) = MANUAL.iter().position(|b| *b == badge) {
        return 40 + i;
    }
    if let Some(i) = EARNED.iter().position(|b| *b == badge) {
        return 35 + i;
    }
    99
}

/// The Christmas season a moment belongs to (Nov 1 - Jan 6, like the theme's greeting), by the year of its December.
fn christmas_season(now: DateTime<Utc>) -> Option<i32> {
    match now.month() {
        11 | 12 => Some(now.year()),
        1 if now.day() <= 6 => Some(now.year() - 1),
        _ => None,
    }
}

fn tier_of(ladder: &Ladder, value: i64) -> Option<i16> {
    ladder.thresholds.iter().rposition(|t| value >= *t).map(|i| i as i16)
}

/// Each milestone's current number for someone.
async fn values(st: &AppState, user: Id) -> ApiResult<Vec<(&'static Ladder, i64)>> {
    let (days, voice, games): (i64, i64, i64) = sqlx::query_as(
        "SELECT (EXTRACT(EPOCH FROM now() - created_at) / 86400)::bigint, voice_seconds,
                (SELECT count(*) FROM user_games WHERE user_id = $1)::bigint
         FROM users WHERE id = $1",
    )
    .bind(user)
    .fetch_one(&st.db)
    .await?;
    let keys: Vec<String> = LADDERS.iter().filter_map(|l| if let Source::Stat(k) = l.source { Some(k.to_string()) } else { None }).collect();
    let stats: HashMap<String, i64> = sqlx::query_as::<_, (String, i64)>("SELECT key, value FROM user_stats WHERE user_id = $1 AND key = ANY($2)")
        .bind(user)
        .bind(keys)
        .fetch_all(&st.db)
        .await?
        .into_iter()
        .collect();
    Ok(LADDERS
        .iter()
        .map(|l| {
            let v = match l.source {
                Source::AccountDays => days,
                Source::Games => games,
                Source::VoiceSeconds => voice,
                Source::Stat(k) => stats.get(k).copied().unwrap_or(0),
            };
            (l, v)
        })
        .collect())
}

/// Gives someone every badge and tier they've reached. Returns the new ones (badge, tier).
pub async fn check(st: &AppState, user: Id) -> ApiResult<Vec<(String, i16)>> {
    let row: Option<(bool, bool)> = sqlx::query_as("SELECT bot, deleted_at IS NOT NULL FROM users WHERE id = $1").bind(user).fetch_optional(&st.db).await?;
    let Some((false, false)) = row else { return Ok(vec![]) };
    let mut due: Vec<(String, i16)> = values(st, user).await?.into_iter().filter_map(|(l, v)| tier_of(l, v).map(|t| (l.id.to_string(), t))).collect();
    let owns: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM guilds WHERE owner_id = $1)").bind(user).fetch_one(&st.db).await?;
    if owns {
        due.push(("owner".into(), 0));
    }
    if let Some(year) = christmas_season(Utc::now()) {
        due.push((format!("christmas_{year}"), 0));
    }
    let admin = crate::auth::is_admin(st, user).await;
    if admin {
        due.push(("admin".into(), 0));
    }
    let (ids, tiers): (Vec<String>, Vec<i16>) = due.into_iter().unzip();
    // Only a higher tier replaces a row (and only one process wins it during a handover).
    let new: Vec<(String, i16)> = sqlx::query_as(
        "INSERT INTO user_badges (user_id, badge, tier) SELECT $1, b, t FROM UNNEST($2::text[], $3::smallint[]) AS x(b, t)
         ON CONFLICT (user_id, badge) DO UPDATE SET tier = EXCLUDED.tier, earned_at = now() WHERE user_badges.tier < EXCLUDED.tier
         RETURNING badge, tier",
    )
    .bind(user)
    .bind(&ids)
    .bind(&tiers)
    .fetch_all(&st.db)
    .await?;
    let mut changed = !new.is_empty();
    if !admin {
        changed |= sqlx::query("DELETE FROM user_badges WHERE user_id = $1 AND badge = 'admin'").bind(user).execute(&st.db).await?.rows_affected() > 0;
    }
    if changed {
        announce(st, user, &new).await;
    }
    Ok(new)
}

/// Tells someone's apps their badges changed (and which are new, for the card).
async fn announce(st: &AppState, user: Id, new: &[(String, i16)]) {
    if !new.is_empty() {
        let list: Vec<Value> = new.iter().map(|(b, t)| json!({ "id": b, "tier": t })).collect();
        tracing::info!(user = %user, count = new.len(), "badges: earned");
        st.hub.send(&[user], "BADGE_EARNED", &json!({ "badges": list }));
    }
    if let Ok(mine) = own(st, user).await {
        st.hub.send(&[user], "BADGES_UPDATE", &mine);
    }
}

/// Everyone connected, once a minute (account age and the season move without anything happening).
pub async fn sweeper(st: AppState) {
    let mut tick = tokio::time::interval(Duration::from_secs(60));
    loop {
        tick.tick().await;
        if crate::handover::retired() {
            return;
        }
        if crate::handover::paused() {
            continue;
        }
        for user in st.hub.users() {
            if let Err(e) = check(&st, user).await {
                tracing::warn!(user = %user, error = %e, "badges: check failed");
            }
        }
    }
}

#[derive(sqlx::FromRow)]
struct Row {
    badge: String,
    tier: i16,
    earned_at: DateTime<Utc>,
    hidden: bool,
    position: Option<i32>,
}

async fn rows(st: &AppState, user: Id) -> ApiResult<Vec<Row>> {
    let mut rows: Vec<Row> = sqlx::query_as("SELECT badge, tier, earned_at, hidden, position FROM user_badges WHERE user_id = $1")
        .bind(user)
        .fetch_all(&st.db)
        .await?;
    rows.sort_by(|a, b| {
        (a.position.unwrap_or(i32::MAX), rank(&a.badge), &a.badge).cmp(&(b.position.unwrap_or(i32::MAX), rank(&b.badge), &b.badge))
    });
    Ok(rows)
}

/// The badges others see on someone's profile, in their order.
pub async fn shown(st: &AppState, user: Id) -> ApiResult<Vec<Value>> {
    Ok(rows(st, user)
        .await?
        .into_iter()
        .filter(|r| !r.hidden)
        .map(|r| json!({ "id": r.badge, "tier": r.tier, "earned_at": r.earned_at }))
        .collect())
}

/// Your own badges (hidden ones too) and how far each milestone is from its next tier.
async fn own(st: &AppState, user: Id) -> ApiResult<Value> {
    let rows = rows(st, user).await?;
    let tiers: HashMap<&str, i16> = rows.iter().map(|r| (r.badge.as_str(), r.tier)).collect();
    let progress: Vec<Value> = values(st, user)
        .await?
        .into_iter()
        .map(|(l, v)| {
            let tier = tiers.get(l.id).copied();
            let next = tier.map_or(Some(0), |t| (t < 4).then_some(t + 1));
            json!({
                "id": l.id, "tier": tier, "value": v,
                "next": next, "target": next.map(|n| l.thresholds[n as usize]),
            })
        })
        .collect();
    let badges: Vec<Value> =
        rows.iter().map(|r| json!({ "id": r.badge, "tier": r.tier, "earned_at": r.earned_at, "hidden": r.hidden })).collect();
    Ok(json!({ "badges": badges, "progress": progress }))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/users/@me/badges", get(mine).put(arrange))
        .route("/users/{id}/badges", get(theirs))
        .route("/users/@me/rec/recorded", axum::routing::post(recorded))
}

#[derive(Deserialize)]
struct Recorded {
    seconds: i64,
}

/// REC: time recorded, reported by the desktop app when a recording ends (the `recorded` badge). Never more than the
/// time played: a report only counts up to what game time hasn't been matched by recordings yet.
async fn recorded(State(st): State<AppState>, AuthUser(me): AuthUser, Json(body): Json<Recorded>) -> ApiResult<Json<Value>> {
    st.limits.check(format!("rec-recorded:{me}"), 20.0, 20.0 / 3600.0)?;
    let (played, done): (i64, i64) = sqlx::query_as(
        "SELECT COALESCE((SELECT value FROM user_stats WHERE user_id = $1 AND key = 'game_seconds'), 0),
                COALESCE((SELECT value FROM user_stats WHERE user_id = $1 AND key = 'rec_seconds'), 0)",
    )
    .bind(me)
    .fetch_one(&st.db)
    .await?;
    let counted = body.seconds.clamp(0, 12 * HOUR).min((played - done).max(0));
    crate::stats::add(&st, me, "rec_seconds", counted).await;
    if counted > 0 {
        let _ = check(&st, me).await;
    }
    Ok(Json(json!({ "counted": counted })))
}

async fn mine(State(st): State<AppState>, AuthUser(me): AuthUser) -> ApiResult<Json<Value>> {
    // Up to date when Settings -> Badges opens, not at the next sweep.
    check(&st, me).await?;
    Ok(Json(own(&st, me).await?))
}

async fn theirs(State(st): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<Id>) -> ApiResult<Json<Vec<Value>>> {
    let user = User::get(&st.db, id).await?;
    if !crate::api::users::knows(&st, me, &user).await? {
        return Ok(Json(vec![]));
    }
    Ok(Json(shown(&st, id).await?))
}

#[derive(Deserialize)]
struct Arrange {
    /// Every badge in the order to show them (ones left out keep the catalog's order after these).
    order: Vec<String>,
    hidden: Vec<String>,
}

/// Settings -> Badges: order and which ones are shown.
async fn arrange(State(st): State<AppState>, AuthUser(me): AuthUser, Json(b): Json<Arrange>) -> ApiResult<Json<Value>> {
    if b.order.len() > 200 || b.hidden.len() > 200 {
        return Err(bad("too many badges"));
    }
    let mut tx = st.db.begin().await?;
    sqlx::query(
        "UPDATE user_badges SET hidden = badge = ANY($2),
             position = (SELECT i::int FROM UNNEST($3::text[]) WITH ORDINALITY AS o(b, i) WHERE o.b = user_badges.badge)
         WHERE user_id = $1",
    )
    .bind(me)
    .bind(&b.hidden)
    .bind(&b.order)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    let mine = own(&st, me).await?;
    st.hub.send(&[me], "BADGES_UPDATE", &mine);
    Ok(Json(mine))
}

/// The monitor giving or taking away one of [`MANUAL`] (internal.rs).
pub async fn set_manual(st: &AppState, user: Id, badge: &str, given: bool) -> ApiResult<bool> {
    if !MANUAL.contains(&badge) {
        return Err(bad("unknown badge"));
    }
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM users WHERE id = $1 AND NOT bot AND deleted_at IS NULL)").bind(user).fetch_one(&st.db).await?;
    if !exists {
        return Ok(false);
    }
    if given {
        let added = sqlx::query("INSERT INTO user_badges (user_id, badge) VALUES ($1, $2) ON CONFLICT DO NOTHING").bind(user).bind(badge).execute(&st.db).await?.rows_affected() > 0;
        if added {
            announce(st, user, &[(badge.to_string(), 0)]).await;
        }
    } else if sqlx::query("DELETE FROM user_badges WHERE user_id = $1 AND badge = $2").bind(user).bind(badge).execute(&st.db).await?.rows_affected() > 0 {
        announce(st, user, &[]).await;
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn tiers_follow_thresholds() {
        let calls = LADDERS.iter().find(|l| l.id == "calls").unwrap();
        assert_eq!(tier_of(calls, 0), None);
        assert_eq!(tier_of(calls, 10 * HOUR - 1), None);
        assert_eq!(tier_of(calls, 10 * HOUR), Some(0));
        assert_eq!(tier_of(calls, 612 * HOUR), Some(3));
        assert_eq!(tier_of(calls, 5000 * HOUR), Some(4));
    }

    #[test]
    fn christmas_season_spans_new_year() {
        let at = |y, m, d| Utc.with_ymd_and_hms(y, m, d, 12, 0, 0).unwrap();
        assert_eq!(christmas_season(at(2026, 10, 31)), None);
        assert_eq!(christmas_season(at(2026, 11, 1)), Some(2026));
        assert_eq!(christmas_season(at(2027, 1, 6)), Some(2026));
        assert_eq!(christmas_season(at(2027, 1, 7)), None);
    }

    #[test]
    fn default_order() {
        let mut v = vec!["helper", "christmas_2026", "calls", "member", "owner", "early", "admin"];
        v.sort_by_key(|b| rank(b));
        assert_eq!(v, ["admin", "early", "owner", "member", "calls", "christmas_2026", "helper"]);
    }
}
