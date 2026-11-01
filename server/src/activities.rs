//! Activities shown with someone's presence, like Discord's: "Listening to Spotify" (spotify.rs),
//! "Playing <game>", which the desktop app detects from running processes and reports here, and the custom
//! status (emoji + text, saved in custom_statuses so it survives restarts).
//!
//! Game detection uses Discord's public list of detectable applications (executable names per game), fetched
//! once a day, trimmed to Windows games and cached under the data dir; the desktop app downloads it from
//! `/api/activities/detectable` and matches it against its own process list.

use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant, SystemTime};

use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use axum::{Json, Router};
use chrono::Utc;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::auth::AuthUser;
use crate::error::{bad, ApiResult};
use crate::gateway::broadcast_presence;
use crate::id::Id;
use crate::models::User;
use crate::state::AppState;

/// Activity types, as Discord numbers them.
pub const PLAYING: i64 = 0;
pub const LISTENING: i64 = 2;
pub const CUSTOM: i64 = 4;

/// A game activity disappears unless the app refreshes it (it does every minute), so a crashed app or a
/// PC that went to sleep doesn't leave "Playing" up forever.
const GAME_TTL: Duration = Duration::from_secs(150);
const LIST_MAX_AGE: Duration = Duration::from_secs(24 * 3600);
const LIST_FILE: &str = "detectable.json";
/// Every game Discord knows (not only detectable Windows ones), for picking favorite games.
const CATALOG_FILE: &str = "games-catalog-v2.json";

fn kind_of(a: &Value) -> i64 {
    a["type"].as_i64().unwrap_or(-1)
}

/// Replaces the user's activity of this type (None removes it). Returns whether anything changed.
pub fn put_activity(st: &AppState, user: Id, kind: i64, activity: Option<Value>) -> bool {
    let mut list = st.activities.entry(user).or_default();
    let before = list.clone();
    list.retain(|a| kind_of(a) != kind);
    if let Some(a) = activity {
        // Games come first, like Discord's "Playing" over "Listening to".
        if kind == PLAYING {
            list.insert(0, a);
        } else {
            list.push(a);
        }
    }
    let changed = *list != before;
    let empty = list.is_empty();
    drop(list);
    if empty {
        st.activities.remove_if(&user, |_, l| l.is_empty());
    }
    changed
}

pub fn activity_of(st: &AppState, user: Id, kind: i64) -> Option<Value> {
    st.activities.get(&user).and_then(|l| l.iter().find(|a| kind_of(a) == kind).cloned())
}

/// Tells everyone who can see the user's presence about their current activities.
pub async fn announce(st: &AppState, user: Id) {
    if let Ok(u) = User::get(&st.db, user).await {
        let _ = broadcast_presence(st, &u).await;
    }
}

// ---------- detectable games ----------

/// Discord's detectable list, trimmed: `[[id, name, icon_hash, [executable, ...]], ...]` (Windows only).
pub struct GameList {
    pub json: Arc<str>,
    pub etag: String,
    /// id -> (name, icon hash), to give reported games their real name and icon.
    pub by_id: std::collections::HashMap<String, (String, String)>,
}

/// A game people can pick as a favorite: Discord's application id, name, other names, and its art.
#[derive(Clone, Serialize, Deserialize)]
pub struct CatalogGame {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub icon: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub cover: String,
    /// Steam app id: its library poster is sharper than Discord's cover.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub steam: Option<String>,
    /// Discord's genres/themes ("Action", "Open world"...).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub themes: Vec<String>,
}

impl CatalogGame {
    /// As clients get it: name plus art URLs (poster = Steam's 2:3 library art, cover = Discord's 3:4 one).
    pub fn json(&self) -> Value {
        let cdn = |hash: &str, q: &str| (!hash.is_empty()).then(|| format!("https://cdn.discordapp.com/app-icons/{}/{hash}.png?{q}", self.id));
        json!({
            "id": self.id,
            "name": self.name,
            "icon": cdn(&self.icon, "size=64"),
            "cover": cdn(&self.cover, "size=512&keep_aspect_ratio=true"),
            "poster": self.steam.as_ref().map(|s| format!("https://cdn.cloudflare.steamstatic.com/steam/apps/{s}/library_600x900.jpg")),
        })
    }
}

pub struct Catalog {
    games: Vec<CatalogGame>,
    /// Lowercase name and aliases per game, for search.
    keys: Vec<Vec<String>>,
    by_id: std::collections::HashMap<String, usize>,
}

impl Catalog {
    fn new(games: Vec<CatalogGame>) -> Catalog {
        let keys = games.iter().map(|g| std::iter::once(&g.name).chain(&g.aliases).map(|n| n.to_lowercase()).collect()).collect();
        let by_id = games.iter().enumerate().map(|(i, g)| (g.id.clone(), i)).collect();
        Catalog { games, keys, by_id }
    }

    pub fn get(&self, id: &str) -> Option<&CatalogGame> {
        self.by_id.get(id).map(|i| &self.games[*i])
    }

    /// Best matches first: the exact name, then names starting with the query, then a word starting with it, then
    /// anywhere; shorter names first within each (the base game before its DLC and editions).
    pub fn search(&self, query: &str, limit: usize) -> Vec<&CatalogGame> {
        let q = query.trim().to_lowercase();
        if q.is_empty() {
            return vec![];
        }
        let rank = |k: &str| -> Option<u8> {
            if k == q {
                Some(0)
            } else if k.starts_with(&q) {
                Some(1)
            } else if k.split(|c: char| !c.is_alphanumeric()).any(|w| w.starts_with(&q)) {
                Some(2)
            } else if k.contains(&q) {
                Some(3)
            } else {
                None
            }
        };
        let mut hits: Vec<(u8, usize, usize)> = self
            .keys
            .iter()
            .enumerate()
            .filter_map(|(i, keys)| keys.iter().filter_map(|k| rank(k)).min().map(|r| (r, self.games[i].name.len(), i)))
            .collect();
        hits.sort();
        hits.into_iter().take(limit).map(|(_, _, i)| &self.games[i]).collect()
    }
}

/// Every game in Discord's list, with its art (the favorite games picker searches it).
fn catalog_of(raw: &Value) -> Vec<CatalogGame> {
    let s = |v: &Value| v.as_str().unwrap_or("").to_string();
    raw.as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|app| {
            let name = s(&app["name"]);
            let id = s(&app["id"]);
            if name.is_empty() || id.is_empty() {
                return None;
            }
            let aliases = app["aliases"]
                .as_array()
                .map(|a| a.iter().filter_map(|x| x.as_str()).filter(|x| !x.eq_ignore_ascii_case(&name)).map(str::to_string).collect())
                .unwrap_or_default();
            let steam = app["third_party_skus"]
                .as_array()
                .and_then(|l| l.iter().find(|x| x["distributor"] == "steam"))
                .map(|x| s(&x["id"]))
                .filter(|x| !x.is_empty() && x.chars().all(|c| c.is_ascii_digit()));
            let themes = app["themes"].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).map(str::to_string).collect()).unwrap_or_default();
            Some(CatalogGame { id, name, aliases, icon: s(&app["icon_hash"]), cover: s(&app["cover_image_hash"]), steam, themes })
        })
        .collect()
}

#[derive(Default)]
pub struct Games {
    pub list: RwLock<Option<Arc<GameList>>>,
    pub catalog: RwLock<Option<Arc<Catalog>>>,
    /// Game card details per "steam:<app>:<lang>" / "wiki:<game id>:<lang>" (None = nothing found), and when
    /// they were fetched.
    pub steam: DashMap<String, (Instant, Option<Value>)>,
    /// Users with a game activity -> when it expires.
    pub expires: DashMap<Id, Instant>,
    /// Each user's last "Playing" report: the game and when, so the time between reports counts (stats.rs).
    pub last_report: DashMap<Id, (String, Instant)>,
}

/// Keeps Windows executables (minus launchers and argument-matched ones, which need a command line).
fn trim(raw: &Value) -> Value {
    let apps = raw.as_array().map(Vec::as_slice).unwrap_or_default();
    Value::Array(
        apps.iter()
            .filter_map(|app| {
                let exes: Vec<&str> = app["executables"]
                    .as_array()?
                    .iter()
                    .filter(|e| e["os"] == "win32" && !e["is_launcher"].as_bool().unwrap_or(false) && e.get("arguments").is_none_or(Value::is_null))
                    .filter_map(|e| e["name"].as_str())
                    .collect();
                if exes.is_empty() {
                    return None;
                }
                Some(json!([app["id"], app["name"], app["icon_hash"].as_str().unwrap_or(""), exes]))
            })
            .collect(),
    )
}

fn parse(trimmed: &str) -> Option<GameList> {
    let v: Value = serde_json::from_str(trimmed).ok()?;
    let by_id = v
        .as_array()?
        .iter()
        .filter_map(|g| Some((g[0].as_str()?.to_string(), (g[1].as_str()?.to_string(), g[2].as_str().unwrap_or("").to_string()))))
        .collect();
    let etag = format!("\"{:x}\"", fnv1a(trimmed.as_bytes()));
    Some(GameList { json: trimmed.into(), etag, by_id })
}

/// Cheap content hash for the ETag (FNV-1a, 64-bit).
fn fnv1a(data: &[u8]) -> u64 {
    data.iter().fold(0xcbf29ce484222325u64, |h, b| (h ^ *b as u64).wrapping_mul(0x100000001b3))
}

/// Discord's list, as (the trimmed detectable list, the catalog).
async fn fetch_list(st: &AppState) -> anyhow::Result<(String, Vec<CatalogGame>)> {
    let raw: Value = st.http.get(&st.cfg.detectable_url).timeout(Duration::from_secs(60)).send().await?.error_for_status()?.json().await?;
    Ok((serde_json::to_string(&trim(&raw))?, catalog_of(&raw)))
}

/// Background task: loads the cached list, and refreshes it from Discord once a day.
pub async fn keep_list(st: AppState) {
    let path = st.cfg.data_dir.join(LIST_FILE);
    let catalog_path = st.cfg.data_dir.join(CATALOG_FILE);
    if let Ok(cached) = tokio::fs::read_to_string(&path).await {
        if let Some(list) = parse(&cached) {
            *st.games.list.write().unwrap() = Some(Arc::new(list));
        }
    }
    if let Some(games) = tokio::fs::read_to_string(&catalog_path).await.ok().and_then(|c| serde_json::from_str::<Vec<CatalogGame>>(&c).ok()) {
        *st.games.catalog.write().unwrap() = Some(Arc::new(Catalog::new(games)));
    }
    // Failed fetches retry soon (Discord briefly unreachable), backing off to the hourly check.
    let mut retry = Duration::from_secs(5);
    loop {
        let age = tokio::fs::metadata(&path).await.and_then(|m| m.modified()).ok().and_then(|t| SystemTime::now().duration_since(t).ok());
        let mut wait = Duration::from_secs(3600);
        // Servers from before the catalog existed fetch once to make it.
        let no_catalog = st.games.catalog.read().unwrap().is_none();
        if age.is_none_or(|a| a > LIST_MAX_AGE) || no_catalog {
            match fetch_list(&st).await.map(|(t, c)| parse(&t).map(|l| (t, l, c))) {
                Ok(Some((trimmed, list, games))) => {
                    tracing::info!("detectable games: {} entries, catalog: {}", list.by_id.len(), games.len());
                    *st.games.list.write().unwrap() = Some(Arc::new(list));
                    let _ = tokio::fs::write(&path, trimmed).await;
                    if let Ok(json) = serde_json::to_string(&games) {
                        let _ = tokio::fs::write(&catalog_path, json).await;
                    }
                    *st.games.catalog.write().unwrap() = Some(Arc::new(Catalog::new(games)));
                    retry = Duration::from_secs(5);
                }
                failed => {
                    if let Err(e) = failed {
                        tracing::warn!("detectable games: {e}");
                    }
                    wait = retry;
                    retry = (retry * 2).min(Duration::from_secs(3600));
                }
            }
        }
        tokio::time::sleep(wait).await;
    }
}

async fn detectable(State(st): State<AppState>, headers: HeaderMap) -> Response {
    let Some(list) = st.games.list.read().unwrap().clone() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    if headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) == Some(list.etag.as_str()) {
        return StatusCode::NOT_MODIFIED.into_response();
    }
    (
        [(header::CONTENT_TYPE, "application/json"), (header::CACHE_CONTROL, "public, max-age=3600"), (header::ETAG, list.etag.as_str())],
        list.json.to_string(),
    )
        .into_response()
}

// ---------- playing ----------

#[derive(Deserialize)]
struct Playing {
    /// Discord application id from the detectable list; absent for games the user added themselves.
    application_id: Option<String>,
    name: String,
    /// Unix ms when the game started.
    started_at: Option<i64>,
}

async fn set_playing(State(st): State<AppState>, AuthUser(me): AuthUser, Json(body): Json<Playing>) -> ApiResult<StatusCode> {
    let now = Utc::now().timestamp_millis();
    let start = body.started_at.unwrap_or(now).clamp(now - 7 * 24 * 3600 * 1000, now);
    let known = body.application_id.as_ref().and_then(|id| st.games.list.read().unwrap().as_ref().and_then(|l| l.by_id.get(id).cloned()).map(|g| (id.clone(), g)));
    let activity = match known {
        Some((id, (name, icon))) => json!({
            "type": PLAYING,
            "name": name,
            "application_id": id,
            "icon": (!icon.is_empty()).then(|| format!("https://cdn.discordapp.com/app-icons/{id}/{icon}.png?size=128")),
            "timestamps": { "start": start },
        }),
        None => {
            let name = body.name.trim();
            if name.is_empty() || name.chars().count() > 128 {
                return Err(bad("Game name must be 1-128 characters"));
            }
            json!({ "type": PLAYING, "name": name, "timestamps": { "start": start } })
        }
    };
    st.games.expires.insert(me, Instant::now() + GAME_TTL);
    // Time since the last report of the same game counts as played (reports come every minute; a longer gap is a
    // pause, closed app or sleeping PC, and doesn't count).
    let game = activity["name"].as_str().unwrap_or_default().to_string();
    let icon = activity["icon"].as_str().map(str::to_string);
    let previous = st.games.last_report.insert(me, (game.clone(), Instant::now()));
    if let Some((_, at)) = previous.filter(|(last, at)| *last == game && at.elapsed() <= GAME_TTL) {
        crate::stats::game_time(&st, me, &game, icon.as_deref(), at.elapsed().as_secs() as i64).await;
    } else {
        crate::stats::bump(&st, me, "games_started");
    }
    if put_activity(&st, me, PLAYING, Some(activity)) {
        announce(&st, me).await;
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn clear_playing(State(st): State<AppState>, AuthUser(me): AuthUser) -> StatusCode {
    st.games.expires.remove(&me);
    // The game closed: the stretch since its last report counts too.
    if let Some((_, (game, at))) = st.games.last_report.remove(&me).filter(|(_, (_, at))| at.elapsed() <= GAME_TTL) {
        crate::stats::game_time(&st, me, &game, None, at.elapsed().as_secs() as i64).await;
    }
    if put_activity(&st, me, PLAYING, None) {
        announce(&st, me).await;
    }
    StatusCode::NO_CONTENT
}

/// Background task: drops games the app stopped refreshing.
pub async fn sweep_games(st: AppState) {
    loop {
        tokio::time::sleep(Duration::from_secs(15)).await;
        let now = Instant::now();
        let expired: Vec<Id> = st.games.expires.iter().filter(|e| *e.value() <= now).map(|e| *e.key()).collect();
        for user in expired {
            st.games.expires.remove_if(&user, |_, t| *t <= now);
            if put_activity(&st, user, PLAYING, None) {
                announce(&st, user).await;
            }
        }
    }
}

// ---------- custom status ----------

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
pub struct StatusEmoji {
    /// A server emoji; absent for a Unicode emoji.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    id: Option<Id>,
    name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    animated: Option<bool>,
}

#[derive(Deserialize)]
struct SetCustom {
    text: Option<String>,
    emoji: Option<StatusEmoji>,
    /// Unix ms when it clears itself; absent = never.
    expires_at: Option<i64>,
}

const CUSTOM_TEXT_MAX: usize = 128;

/// The activity everyone sees: `{"type": 4, "name": "Custom Status", "state": text, "emoji": ..., "expires_at": ms}`.
fn custom_activity(text: Option<&str>, emoji: Option<&StatusEmoji>, expires_at: Option<i64>) -> Value {
    let mut a = json!({ "type": CUSTOM, "name": "Custom Status" });
    if let Some(t) = text {
        a["state"] = json!(t);
    }
    if let Some(e) = emoji {
        a["emoji"] = json!(e);
    }
    if let Some(at) = expires_at {
        a["expires_at"] = json!(at);
    }
    a
}

/// The user's own custom status for READY (shown to them even while invisible).
pub fn own_custom_status(st: &AppState, user: Id) -> Option<Value> {
    activity_of(st, user, CUSTOM)
}

/// Tells everyone, and the user's other sessions (they see their own status even while invisible).
async fn announce_custom(st: &AppState, user: Id) {
    st.hub.send(&[user], "CUSTOM_STATUS_UPDATE", &json!({ "custom_status": own_custom_status(st, user) }));
    announce(st, user).await;
}

async fn set_custom(State(st): State<AppState>, AuthUser(me): AuthUser, Json(body): Json<SetCustom>) -> ApiResult<Json<Value>> {
    let text = body.text.as_deref().map(str::trim).filter(|t| !t.is_empty()).map(str::to_string);
    if text.as_ref().is_some_and(|t| t.chars().count() > CUSTOM_TEXT_MAX) {
        return Err(bad("Custom status must be at most 128 characters"));
    }
    let mut emoji = body.emoji.filter(|e| !e.name.trim().is_empty());
    if let Some(e) = &mut emoji {
        match e.id {
            // Server emoji: any that still exists, with its real name.
            Some(id) => {
                let row: Option<(String, bool)> = sqlx::query_as("SELECT name, animated FROM emojis WHERE id = $1").bind(id).fetch_optional(&st.db).await?;
                let (name, animated) = row.ok_or_else(|| bad("Unknown emoji"))?;
                e.name = name;
                e.animated = Some(animated);
            }
            None if e.name.chars().count() > 32 => return Err(bad("Unknown emoji")),
            None => e.animated = None,
        }
    }
    let now = Utc::now().timestamp_millis();
    let expires_at = body.expires_at.filter(|&at| at > now);
    if text.is_none() && emoji.is_none() || body.expires_at.is_some() && expires_at.is_none() {
        clear_custom_status(&st, me).await?;
        return Ok(Json(Value::Null));
    }
    sqlx::query(
        "INSERT INTO custom_statuses (user_id, text, emoji, expires_at) VALUES ($1, $2, $3, to_timestamp($4::float8 / 1000))
         ON CONFLICT (user_id) DO UPDATE SET text = $2, emoji = $3, expires_at = to_timestamp($4::float8 / 1000)",
    )
    .bind(me)
    .bind(&text)
    .bind(emoji.as_ref().map(|e| json!(e)))
    .bind(expires_at)
    .execute(&st.db)
    .await?;
    let activity = custom_activity(text.as_deref(), emoji.as_ref(), expires_at);
    crate::stats::bump(&st, me, "statuses_set");
    if put_activity(&st, me, CUSTOM, Some(activity.clone())) {
        announce_custom(&st, me).await;
    }
    Ok(Json(activity))
}

async fn clear_custom_status(st: &AppState, user: Id) -> ApiResult<()> {
    sqlx::query("DELETE FROM custom_statuses WHERE user_id = $1").bind(user).execute(&st.db).await?;
    if put_activity(st, user, CUSTOM, None) {
        announce_custom(st, user).await;
    }
    Ok(())
}

async fn clear_custom(State(st): State<AppState>, AuthUser(me): AuthUser) -> ApiResult<StatusCode> {
    clear_custom_status(&st, me).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Background task: loads saved custom statuses, then clears the ones that expire.
pub async fn keep_custom_statuses(st: AppState) {
    let rows: Result<Vec<(Id, Option<String>, Option<Value>, Option<i64>)>, _> = sqlx::query_as(
        "SELECT user_id, text, emoji, (extract(epoch FROM expires_at) * 1000)::bigint FROM custom_statuses WHERE expires_at IS NULL OR expires_at > now()",
    )
    .fetch_all(&st.db)
    .await;
    match rows {
        Ok(rows) => {
            for (user, text, emoji, expires_at) in rows {
                let emoji: Option<StatusEmoji> = emoji.and_then(|e| serde_json::from_value(e).ok());
                put_activity(&st, user, CUSTOM, Some(custom_activity(text.as_deref(), emoji.as_ref(), expires_at)));
            }
        }
        Err(e) => tracing::error!("loading custom statuses: {e}"),
    }
    loop {
        tokio::time::sleep(Duration::from_secs(15)).await;
        let now = Utc::now().timestamp_millis();
        let expired: Vec<Id> = st
            .activities
            .iter()
            .filter(|e| e.value().iter().any(|a| kind_of(a) == CUSTOM && a["expires_at"].as_i64().is_some_and(|at| at <= now)))
            .map(|e| *e.key())
            .collect();
        for user in expired {
            if let Err(e) = clear_custom_status(&st, user).await {
                tracing::warn!("clearing an expired custom status: {e:?}");
            }
        }
    }
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/activities/detectable", get(detectable))
        .route("/activities/playing", put(set_playing).delete(clear_playing))
        .route("/activities/custom", put(set_custom).delete(clear_custom))
        .route("/games/search", get(search_games))
        .route("/games/search/wikipedia", get(search_wikipedia_games))
        .route("/games/{id}", get(game_info))
}

/// How long Steam store details are kept (failures: an hour).
const STEAM_TTL: Duration = Duration::from_secs(24 * 3600);

/// Steam's store text has HTML entities.
fn unescape(s: &str) -> String {
    s.replace("&quot;", "\"").replace("&#39;", "'").replace("&apos;", "'").replace("&lt;", "<").replace("&gt;", ">").replace("&nbsp;", " ").replace("&amp;", "&")
}

/// The parts of Steam's store page a game card shows.
fn steam_summary(data: &Value) -> Value {
    let strs = |v: &Value| -> Vec<String> { v.as_array().map(|a| a.iter().filter_map(|x| x.as_str()).map(unescape).collect()).unwrap_or_default() };
    let genres: Vec<String> = data["genres"].as_array().map(|a| a.iter().filter_map(|g| g["description"].as_str()).map(unescape).collect()).unwrap_or_default();
    let shots: Vec<Value> = data["screenshots"]
        .as_array()
        .map(|a| a.iter().take(6).map(|x| json!({ "thumb": x["path_thumbnail"], "full": x["path_full"] })).collect())
        .unwrap_or_default();
    json!({
        "description": data["short_description"].as_str().map(unescape),
        "developers": strs(&data["developers"]),
        "publishers": strs(&data["publishers"]),
        "release_date": data["release_date"]["date"].as_str().filter(|d| !d.is_empty()),
        "coming_soon": data["release_date"]["coming_soon"].as_bool().unwrap_or(false),
        "genres": genres,
        "free": data["is_free"].as_bool().unwrap_or(false),
        "website": data["website"].as_str().filter(|w| w.starts_with("http")),
        "header": data["header_image"],
        "background": data["background_raw"].as_str().or(data["background"].as_str()),
        "screenshots": shots,
        "metacritic": data["metacritic"]["score"],
    })
}

/// A cached lookup (a day; misses an hour).
fn cached(st: &AppState, key: &str) -> Option<Option<Value>> {
    let hit = st.games.steam.get(key)?;
    let ttl = if hit.1.is_some() { STEAM_TTL } else { Duration::from_secs(3600) };
    (hit.0.elapsed() < ttl).then(|| hit.1.clone())
}

async fn steam_details(st: &AppState, app: &str, lang: &str) -> Option<Value> {
    let key = format!("steam:{app}:{lang}");
    if let Some(hit) = cached(st, &key) {
        return hit;
    }
    let url = format!("https://store.steampowered.com/api/appdetails?appids={app}&l={lang}&cc=us");
    let res = st.http.get(url).timeout(Duration::from_secs(10)).send().await.ok()?;
    let body: Value = res.error_for_status().ok()?.json().await.ok()?;
    let data = &body[app];
    let out = (data["success"] == true).then(|| {
        let mut s = steam_summary(&data["data"]);
        s["source"] = json!("steam");
        s
    });
    st.games.steam.insert(key, (Instant::now(), out.clone()));
    out
}

// ---------- Wikipedia / Wikidata (games that aren't on Steam: Nintendo, Riot, consoles...) ----------

/// Wikimedia asks API clients to say who they are.
const WIKI_AGENT: &str = "Linkord/1.0 (self-hosted chat app; game cards)";

async fn wiki_get(st: &AppState, url: &str) -> Option<Value> {
    let res = st.http.get(url).header(reqwest::header::USER_AGENT, WIKI_AGENT).timeout(Duration::from_secs(10)).send().await.ok()?;
    res.error_for_status().ok()?.json().await.ok()
}

/// Whether a Wikipedia page is about a video game, from its short description ("2017 video game", "jogo
/// eletrônico de 2017..."), so a game named like a common word doesn't get the wrong article.
fn is_game_page(summary: &Value) -> bool {
    let d = summary["description"].as_str().unwrap_or("").to_lowercase();
    summary["type"] == "standard" && ["video game", "videogame", "jogo eletrônico", "jogo de vídeo", "game"].iter().any(|w| d.contains(w))
}

/// Page titles to try for a game: "Name (video game)" first (the base name may be a disambiguation or something
/// else), then the name itself; trademark signs dropped.
fn wiki_titles(name: &str, wiki: &str) -> Vec<String> {
    let clean: String = name.replace(['™', '®', '©'], "").split_whitespace().collect::<Vec<_>>().join(" ");
    let suffix = if wiki == "pt" { "jogo eletrônico" } else { "video game" };
    [format!("{clean} ({suffix})"), clean].into_iter().map(|t| t.replace(' ', "_")).collect()
}

/// The Wikipedia summary of a game's page, in `wiki` ("en", "pt").
async fn wiki_summary(st: &AppState, name: &str, wiki: &str) -> Option<Value> {
    for title in wiki_titles(name, wiki) {
        let url = format!("https://{wiki}.wikipedia.org/api/rest_v1/page/summary/{}", urlencoding::encode(&title));
        if let Some(s) = wiki_get(st, &url).await.filter(is_game_page) {
            return Some(s);
        }
    }
    None
}

/// Developer, publisher, release date and genres from Wikidata (labels in the app's language, else English).
async fn wikidata_facts(st: &AppState, item: &str, lang: &str) -> Value {
    let ids = |claims: &Value, prop: &str| -> Vec<String> {
        claims[prop].as_array().map(|a| a.iter().filter_map(|c| c["mainsnak"]["datavalue"]["value"]["id"].as_str()).map(str::to_string).collect()).unwrap_or_default()
    };
    let url = format!("https://www.wikidata.org/w/api.php?action=wbgetentities&ids={item}&props=claims&format=json");
    let Some(entity) = wiki_get(st, &url).await else { return json!({}) };
    let claims = &entity["entities"][item]["claims"];
    let (devs, pubs, genres) = (ids(claims, "P178"), ids(claims, "P123"), ids(claims, "P136"));
    // The earliest publication date ("+2017-03-03T00:00:00Z", precision 9 = year, 10 = month, 11 = day).
    let date = claims["P577"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| {
            let v = &c["mainsnak"]["datavalue"]["value"];
            Some((v["time"].as_str()?.trim_start_matches('+').to_string(), v["precision"].as_i64().unwrap_or(9)))
        })
        .min();
    let all: Vec<&String> = devs.iter().chain(&pubs).chain(genres.iter().take(6)).collect();
    let mut labels = std::collections::HashMap::new();
    if !all.is_empty() {
        let list = all.iter().map(|s| s.as_str()).collect::<Vec<_>>().join("|");
        let url = format!("https://www.wikidata.org/w/api.php?action=wbgetentities&ids={list}&props=labels&languages={lang}|en&format=json");
        if let Some(v) = wiki_get(st, &url).await {
            for id in &all {
                let l = &v["entities"][id.as_str()]["labels"];
                if let Some(text) = l[lang]["value"].as_str().or(l["en"]["value"].as_str()) {
                    labels.insert(id.to_string(), text.to_string());
                }
            }
        }
    }
    let named = |l: &[String]| -> Vec<String> { l.iter().filter_map(|i| labels.get(i).cloned()).collect() };
    json!({
        "developers": named(&devs),
        "publishers": named(&pubs),
        "genres": named(&genres.iter().take(6).cloned().collect::<Vec<_>>()),
        "release_date": date.map(|(t, precision)| format_wikidata_date(&t, precision, lang)),
    })
}

/// "2017-03-03T00:00:00Z" as "Mar 3, 2017" / "3 de mar. de 2017"; year or month only when that's all it says.
fn format_wikidata_date(t: &str, precision: i64, lang: &str) -> String {
    let date = chrono::NaiveDate::parse_from_str(&t[..10.min(t.len())], "%Y-%m-%d").ok();
    let year = &t[..4.min(t.len())];
    let pt = ["jan.", "fev.", "mar.", "abr.", "mai.", "jun.", "jul.", "ago.", "set.", "out.", "nov.", "dez."];
    match (date, precision) {
        (Some(d), 11..) if lang == "pt" => format!("{} de {} de {}", chrono::Datelike::day(&d), pt[chrono::Datelike::month0(&d) as usize], year),
        (Some(d), 11..) => d.format("%b %-d, %Y").to_string(),
        (Some(d), 10) if lang == "pt" => format!("{} de {}", pt[chrono::Datelike::month0(&d) as usize], year),
        (Some(d), 10) => d.format("%b %Y").to_string(),
        _ => year.to_string(),
    }
}

/// The summary of an exact English Wikipedia page (games found on Wikipedia), cached; None unless it's a game.
pub async fn wiki_page(st: &AppState, title: &str) -> Option<Value> {
    let key = format!("wikipage:{title}");
    if let Some(hit) = cached(st, &key) {
        return hit;
    }
    let url = format!("https://en.wikipedia.org/api/rest_v1/page/summary/{}", urlencoding::encode(title));
    let out = wiki_get(st, &url).await.filter(is_game_page);
    st.games.steam.insert(key, (Instant::now(), out.clone()));
    out
}

/// The same page on Portuguese Wikipedia, through Wikidata's links between languages.
async fn wiki_page_pt(st: &AppState, item: &str) -> Option<Value> {
    let url = format!("https://www.wikidata.org/w/api.php?action=wbgetentities&ids={item}&props=sitelinks&sitefilter=ptwiki&format=json");
    let title = wiki_get(st, &url).await?["entities"][item]["sitelinks"]["ptwiki"]["title"].as_str()?.replace(' ', "_");
    let url = format!("https://pt.wikipedia.org/api/rest_v1/page/summary/{}", urlencoding::encode(&title));
    wiki_get(st, &url).await.filter(|s| s["type"] == "standard")
}

/// A game card's details from Wikipedia (+ Wikidata): what it's about, who makes it, when it came out. `title`:
/// the exact English page (games found on Wikipedia); otherwise the page is looked up by the game's name.
async fn wiki_details(st: &AppState, id: &str, name: &str, title: Option<&str>, lang: &str) -> Option<Value> {
    let wiki = if lang == "pt-BR" { "pt" } else { "en" };
    let key = format!("wiki:{id}:{wiki}");
    if let Some(hit) = cached(st, &key) {
        return hit;
    }
    let summary = match title {
        Some(t) => match wiki_page(st, t).await {
            Some(en) if wiki == "pt" => match en["wikibase_item"].as_str() {
                Some(item) => wiki_page_pt(st, item).await.or(Some(en)),
                None => Some(en),
            },
            other => other,
        },
        None => match wiki_summary(st, name, wiki).await {
            Some(s) => Some(s),
            None if wiki != "en" => wiki_summary(st, name, "en").await,
            None => None,
        },
    };
    let out = match summary {
        Some(s) => {
            let mut facts = match s["wikibase_item"].as_str() {
                Some(item) => wikidata_facts(st, item, wiki).await,
                None => json!({}),
            };
            facts["description"] = s["extract"].clone();
            facts["header"] = s["originalimage"]["source"].clone();
            facts["source"] = json!("wikipedia");
            facts["source_url"] = s["content_urls"]["desktop"]["page"].clone();
            Some(facts)
        }
        None => None,
    };
    st.games.steam.insert(key, (Instant::now(), out.clone()));
    out
}

#[derive(Deserialize)]
struct InfoQuery {
    /// The app's language (pt-BR gets Steam's Brazilian Portuguese text).
    lang: Option<String>,
}

/// A game card: catalog info, Steam's store details when it's on Steam, and the people you know who have it among
/// their favorite games.
async fn game_info(
    State(st): State<AppState>,
    AuthUser(me): AuthUser,
    axum::extract::Path(id): axum::extract::Path<String>,
    axum::extract::Query(q): axum::extract::Query<InfoQuery>,
) -> ApiResult<Json<Value>> {
    if let Some(title) = id.strip_prefix(WIKI_PREFIX) {
        return wiki_game_info(&st, me, &id, title, q.lang.as_deref().unwrap_or("en")).await;
    }
    let game = st.games.catalog.read().unwrap().as_ref().and_then(|c| c.get(&id).cloned()).ok_or(crate::error::ApiError::NotFound)?;
    let mut out = game.json();
    out["aliases"] = json!(game.aliases);
    out["themes"] = json!(game.themes);
    let lang = q.lang.as_deref().unwrap_or("en");
    let mut details = None;
    if let Some(app) = &game.steam {
        out["store_url"] = json!(format!("https://store.steampowered.com/app/{app}"));
        if st.cfg.game_info {
            details = steam_details(&st, app, if lang == "pt-BR" { "brazilian" } else { "english" }).await;
        }
    }
    // Not on Steam (Nintendo, Riot, console games...), or Steam had nothing: Wikipedia.
    if st.cfg.game_info && details.as_ref().is_none_or(|d| d["description"].as_str().is_none_or(str::is_empty)) {
        if let Some(wiki) = wiki_details(&st, &game.id, &game.name, None, lang).await {
            details = Some(match details {
                // Steam's facts with Wikipedia's description.
                Some(mut d) => {
                    d["description"] = wiki["description"].clone();
                    d["source_url"] = wiki["source_url"].clone();
                    d["description_source"] = json!("wikipedia");
                    d
                }
                None => wiki,
            });
        }
    }
    out["details"] = details.unwrap_or(Value::Null);
    out["fans"] = json!(fans_of(&st, me, &id).await?);
    Ok(Json(out))
}

/// People you know (servers, DMs, friends; you too) who have this game among their favorites.
async fn fans_of(st: &AppState, me: Id, id: &str) -> ApiResult<Vec<User>> {
    let known = crate::gateway::related_users(&st.db, me).await?;
    let fans: Vec<Id> = sqlx::query_scalar(
        "SELECT f.user_id FROM favorite_games f JOIN users u ON u.id = f.user_id
         WHERE f.game_id = $1 AND f.user_id = ANY($2) AND u.deleted_at IS NULL ORDER BY f.position, f.user_id LIMIT 24",
    )
    .bind(id)
    .bind(&known)
    .fetch_all(&st.db)
    .await?;
    User::get_many(&st.db, &fans).await
}

// ---------- games found on Wikipedia ----------

/// Ids of favorite games found on Wikipedia: "wiki:" + the English page title (underscores).
pub const WIKI_PREFIX: &str = "wiki:";

/// A Wikipedia page title as a game name: "Name (2026 video game)" -> "Name (2026)", "Name (video game)" -> "Name".
pub fn wiki_game_name(title: &str) -> String {
    let t = title.replace('_', " ");
    if let Some(start) = t.rfind(" (") {
        let inner = t[start + 2..].trim_end_matches(')');
        if let Some(year) = inner.strip_suffix(" video game").filter(|y| y.len() == 4 && y.chars().all(|c| c.is_ascii_digit())) {
            return format!("{} ({year})", &t[..start]);
        }
        if inner == "video game" {
            return t[..start].to_string();
        }
    }
    t
}

/// A favorite game from Wikipedia as clients get it (box art as the cover).
pub fn wiki_game_json(title: &str, summary: &Value) -> Value {
    json!({
        "id": format!("{WIKI_PREFIX}{title}"),
        "name": wiki_game_name(title),
        "cover": summary["originalimage"]["source"].as_str().or(summary["thumbnail"]["source"].as_str()),
        "description": summary["description"],
    })
}

/// The picker's "More games": Wikipedia pages about video games matching the query (with their box art), for games
/// Discord's list doesn't have.
async fn search_wikipedia_games(State(st): State<AppState>, AuthUser(me): AuthUser, axum::extract::Query(p): axum::extract::Query<GameSearch>) -> ApiResult<Json<Vec<Value>>> {
    let q = p.q.trim();
    if !st.cfg.game_info || q.chars().count() < 3 {
        return Ok(Json(vec![]));
    }
    st.limits.check(format!("wikisearch:{me}"), 20.0, 1.0)?;
    let key = format!("wikisearch:{}", q.to_lowercase());
    let titles: Vec<String> = match cached(&st, &key) {
        Some(hit) => hit.and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default(),
        None => {
            let url = format!("https://en.wikipedia.org/w/rest.php/v1/search/page?q={}&limit=12", urlencoding::encode(q));
            let found: Vec<String> = wiki_get(&st, &url)
                .await
                .and_then(|v| v["pages"].as_array().cloned())
                .unwrap_or_default()
                .iter()
                .filter(|p| p["description"].as_str().is_some_and(|d| d.to_lowercase().contains("video game")))
                .filter_map(|p| p["key"].as_str().map(str::to_string))
                .take(6)
                .collect();
            st.games.steam.insert(key, (Instant::now(), Some(json!(found))));
            found
        }
    };
    let pages = futures_util::future::join_all(titles.iter().map(|t| wiki_page(&st, t))).await;
    Ok(Json(titles.iter().zip(pages).filter_map(|(t, s)| s.map(|s| wiki_game_json(t, &s))).collect()))
}

/// A game card for a game found on Wikipedia.
async fn wiki_game_info(st: &AppState, me: Id, id: &str, title: &str, lang: &str) -> ApiResult<Json<Value>> {
    let page = if st.cfg.game_info { wiki_page(st, title).await } else { None };
    let mut out = match &page {
        Some(s) => wiki_game_json(title, s),
        None => json!({ "id": id, "name": wiki_game_name(title) }),
    };
    if st.cfg.game_info {
        out["details"] = wiki_details(st, id, &wiki_game_name(title), Some(title), lang).await.unwrap_or(Value::Null);
    }
    out["fans"] = json!(fans_of(st, me, id).await?);
    Ok(Json(out))
}

#[derive(Deserialize)]
struct GameSearch {
    q: String,
}

/// The favorite games picker: up to 20 games from the catalog matching the query.
async fn search_games(State(st): State<AppState>, AuthUser(_): AuthUser, axum::extract::Query(p): axum::extract::Query<GameSearch>) -> ApiResult<Json<Vec<Value>>> {
    let Some(catalog) = st.games.catalog.read().unwrap().clone() else { return Ok(Json(vec![])) };
    Ok(Json(catalog.search(&p.q, 20).into_iter().map(CatalogGame::json).collect()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_to_windows_games() {
        let raw = json!([
            { "id": "1", "name": "Game", "icon_hash": "abc", "executables": [
                { "os": "win32", "name": "win64/game.exe", "is_launcher": false },
                { "os": "win32", "name": "launcher.exe", "is_launcher": true },
                { "os": "win32", "name": ">javaw.exe", "is_launcher": false, "arguments": "net.minecraft" },
                { "os": "darwin", "name": "game.app", "is_launcher": false },
            ]},
            { "id": "2", "name": "Mac only", "icon_hash": null, "executables": [{ "os": "darwin", "name": "x.app", "is_launcher": false }] },
        ]);
        assert_eq!(trim(&raw), json!([["1", "Game", "abc", ["win64/game.exe"]]]));
        let list = parse(&trim(&raw).to_string()).unwrap();
        assert_eq!(list.by_id.get("1"), Some(&("Game".to_string(), "abc".to_string())));
    }

    #[test]
    fn catalog_search_ranks_exact_then_prefix_then_words() {
        let raw = json!([
            { "id": "1", "name": "Counter-Strike 2", "aliases": [], "icon_hash": "i", "cover_image_hash": "c", "executables": [],
              "third_party_skus": [{ "distributor": "steam", "id": "730" }] },
            { "id": "2", "name": "Minecraft", "aliases": ["Minecraft Launcher"], "icon_hash": "", "cover_image_hash": "", "executables": [],
              "third_party_skus": [{ "distributor": "xbox", "id": "X" }] },
            { "id": "3", "name": "Minecraft Dungeons", "aliases": [], "icon_hash": "", "cover_image_hash": "", "executables": [], "third_party_skus": [] },
            { "id": "4", "name": "Strike Force", "aliases": [], "icon_hash": "", "cover_image_hash": "", "executables": [], "third_party_skus": [] },
        ]);
        let c = Catalog::new(catalog_of(&raw));
        let names = |q: &str| c.search(q, 20).into_iter().map(|g| g.name.as_str()).collect::<Vec<_>>();
        assert_eq!(names("minecraft"), ["Minecraft", "Minecraft Dungeons"]);
        assert_eq!(names("strike"), ["Strike Force", "Counter-Strike 2"]);
        assert_eq!(names("launcher"), ["Minecraft"]);
        let cs = c.get("1").unwrap().json();
        assert_eq!(cs["poster"], "https://cdn.cloudflare.steamstatic.com/steam/apps/730/library_600x900.jpg");
        assert_eq!(cs["cover"], "https://cdn.discordapp.com/app-icons/1/c.png?size=512&keep_aspect_ratio=true");
        assert!(c.get("2").unwrap().json()["poster"].is_null());
    }

    #[test]
    fn steam_store_text_is_unescaped_and_trimmed_to_what_cards_show() {
        let data = json!({
            "short_description": "Tom &amp; Jerry&#39;s &quot;game&quot;",
            "developers": ["Valve"], "publishers": ["Valve"],
            "release_date": { "coming_soon": false, "date": "21 Aug, 2012" },
            "genres": [{ "id": "1", "description": "Action" }],
            "screenshots": [{ "path_thumbnail": "t.jpg", "path_full": "f.jpg" }],
            "is_free": true, "website": "javascript:alert(1)", "background_raw": "bg.jpg",
        });
        let s = steam_summary(&data);
        assert_eq!(s["description"], "Tom & Jerry's \"game\"");
        assert_eq!(s["genres"], json!(["Action"]));
        assert_eq!(s["release_date"], "21 Aug, 2012");
        assert_eq!(s["screenshots"][0]["full"], "f.jpg");
        assert!(s["website"].is_null(), "only http(s) links");
        assert_eq!(s["background"], "bg.jpg");
    }

    #[test]
    fn wikipedia_pages_must_be_about_games() {
        assert!(is_game_page(&json!({ "type": "standard", "description": "2017 video game" })));
        assert!(is_game_page(&json!({ "type": "standard", "description": "jogo eletrônico de 2017 desenvolvido pela Nintendo" })));
        assert!(!is_game_page(&json!({ "type": "standard", "description": "Species of bird" })));
        assert!(!is_game_page(&json!({ "type": "disambiguation", "description": "video game" })));
        assert_eq!(
            wiki_titles("VALORANT™", "en"),
            ["VALORANT_(video_game)", "VALORANT"],
        );
        assert_eq!(wiki_titles("Celeste", "pt")[0], "Celeste_(jogo_eletrônico)");
    }

    #[test]
    fn wikipedia_titles_become_game_names() {
        assert_eq!(wiki_game_name("The_Legend_of_Zelda:_Ocarina_of_Time"), "The Legend of Zelda: Ocarina of Time");
        assert_eq!(wiki_game_name("The_Legend_of_Zelda:_Ocarina_of_Time_(2026_video_game)"), "The Legend of Zelda: Ocarina of Time (2026)");
        assert_eq!(wiki_game_name("Celeste_(video_game)"), "Celeste");
        assert_eq!(wiki_game_name("Water_Temple_(Ocarina_of_Time)"), "Water Temple (Ocarina of Time)");
    }

    #[test]
    fn wikidata_dates_keep_their_precision() {
        assert_eq!(format_wikidata_date("2017-03-03T00:00:00Z", 11, "en"), "Mar 3, 2017");
        assert_eq!(format_wikidata_date("2017-03-03T00:00:00Z", 11, "pt"), "3 de mar. de 2017");
        assert_eq!(format_wikidata_date("2017-03-00T00:00:00Z", 10, "en"), "2017");
        assert_eq!(format_wikidata_date("2017-00-00T00:00:00Z", 9, "en"), "2017");
    }
}
