//! League of Legends (owner, 2026-11-12), two parts:
//!
//! - Rich presence: the desktop app reads the League client's local API (app/src-tauri/src/league.rs) and sends
//!   what it's doing with its "Playing" report (in lobby with 2 of 5, in queue, champion select, in game as Ahri...).
//!   `rich` checks those fields and adds the champion's name and icon; the activity carries them as `league`.
//! - The profile widget: someone links their Riot ID (Settings -> Profile), the server looks the account up with
//!   Riot's API (RIOT_API_KEY in server/.env, a personal key: 100 requests per 2 minutes, 20 per second) and serves
//!   level, ranks, top masteries and recent matches at GET /users/{id}/league, cached for 10 minutes. Shown to others
//!   only with users.show_league on.
//!
//! Champion names come from CommunityDragon's champion summary (fetched daily, cached in data/champions.json); icons
//! are CommunityDragon URLs by id, so nothing needs a Data Dragon version.
//!
//! Saving requests (owner, 2026-11-12):
//! - Pictures: GET /league/art/<CommunityDragon path> keeps a copy of each picture in data/league-art and lets browsers
//!   keep it for 30 days. Only a few kinds of path are allowed (`art_path`). Activities and the widget still name the
//!   CommunityDragon URLs, so older clients keep working; clients rewrite them to this route (lib/league.ts art).
//!   Every champion icon is fetched ahead of time, once, so presence and widgets draw them at once.
//! - Riot: a widget older than 10 minutes asks only for the match list; if no game was played since, the rest is
//!   kept (for up to 6 hours). Matches never change and Riot IDs rarely do: both are kept. All of it survives
//!   restarts (data/league-cache.json, saved at most once a minute). The widget's Update button
//!   (?refresh=true) rebuilds it all, once a minute per profile.
//!
//! Lobby invites through Linkord: someone asks to join from your League card (POST /league/join with their
//! summoner id, read from their own League client), you get LEAGUE_JOIN_REQUEST and your app has your client invite
//! them. Or you invite someone (POST /league/invite: LEAGUE_INVITE), and when they accept, their join request comes
//! back marked `auto`, so your app invites them without asking you again. Once the host's client has sent the
//! invite, the host's app says so (POST /league/invited, only for someone who asked in the last 2 minutes) and the
//! joiner gets LEAGUE_INVITED with the host's summoner, so their app accepts that invite in their League client by
//! itself: joining takes no click in League.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime};

use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::api::relationships::blocked_between;
use crate::auth::AuthUser;
use crate::error::{bad, ApiError, ApiResult};
use crate::id::Id;
use crate::models::User;
use crate::state::AppState;

const CDRAGON: &str =
    "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1";
const CHAMPIONS_FILE: &str = "champions.json";
/// A widget this old asks Riot whether a game was played since.
const PROFILE_TTL: Duration = Duration::from_secs(600);
/// With no new game, the rest of a widget is kept this long (level, ranks and masteries only move with games).
const PROFILE_KEEP_MS: i64 = 6 * 3600 * 1000;
/// The Update button rebuilds a widget at most this often.
const REFRESH_EVERY_MS: i64 = 60 * 1000;
/// Riot IDs rarely change.
const ACCOUNT_KEEP_MS: i64 = 24 * 3600 * 1000;
const CACHE_FILE: &str = "league-cache.json";
const ART_DIR: &str = "league-art";
const CDRAGON_ROOT: &str = "https://raw.communitydragon.org/latest/";
/// Riot's Data Dragon CDN: the same champion icons, profile icons and splashes, answered in a tenth of a second where
/// raw.communitydragon.org has taken 20 s a file (owner, 2026-11-14: icons loading slowly or not at all). Pictures
/// come from it first; CommunityDragon is the fallback and the only source of ranked emblems.
const DDRAGON: &str = "https://ddragon.leagueoflegends.com";
/// CommunityDragon's game-data folder, where the paths /league/art serves live.
const ART_GAME: &str = "plugins/rcp-be-lol-game-data/global/default/v1/";
/// An invite from Linkord stays good this long (the person may need to open League first).
const INVITE_TTL: Duration = Duration::from_secs(600);
/// How long a join request waits for the host's client to send the invite (prompts last a minute, plus slack).
const JOIN_TTL: Duration = Duration::from_secs(120);
const RECENT_MATCHES: usize = 6;
/// Riot's personal key allows 100 per 2 minutes and 20 per second; stay a little under both.
const PER_2MIN: usize = 95;
const PER_SEC: usize = 18;

#[derive(Default)]
pub struct League {
    /// Champion id -> name.
    champions: RwLock<HashMap<i64, String>>,
    /// Data Dragon's game version and champion keys (None until known: pictures then come from CommunityDragon).
    dragon: RwLock<Option<Dragon>>,
    /// When the last requests to Riot went out (the last 2 minutes).
    sent: Mutex<VecDeque<Instant>>,
    /// Riot said 429: nothing goes out before this.
    blocked_until: Mutex<Option<Instant>>,
    /// Widget per user.
    profiles: DashMap<Id, Cached>,
    /// "<match id>|<puuid>" -> that player's line of a finished match (matches never change).
    matches: DashMap<String, Value>,
    /// puuid -> (fetched at, unix ms; account-v1 answer).
    accounts: DashMap<String, (i64, Value)>,
    /// Something above changed since data/league-cache.json was written.
    dirty: AtomicBool,
    /// (host, invited) -> when the host invited them through Linkord.
    invites: DashMap<(Id, Id), Instant>,
    /// (host, joiner) -> when the joiner asked to join the host's lobby (POST /league/invited needs one).
    joins: DashMap<(Id, Id), Instant>,
    /// Pictures CommunityDragon doesn't have: not asked for again for an hour.
    art_missing: DashMap<String, Instant>,
}

/// What Data Dragon's picture URLs need: the game version and each champion's key ("MonkeyKing" for Wukong).
#[derive(Clone, Debug, PartialEq)]
struct Dragon {
    version: String,
    keys: HashMap<i64, String>,
}

/// A built widget: when it was built and last checked against the match list (unix ms), and that list.
#[derive(Clone, Serialize, Deserialize)]
struct Cached {
    built: i64,
    checked: i64,
    ids: Vec<String>,
    value: Value,
}

/// What data/league-cache.json holds.
#[derive(Serialize, Deserialize, Default)]
struct Saved {
    #[serde(default)]
    profiles: Vec<(Id, Cached)>,
    #[serde(default)]
    matches: Vec<(String, Value)>,
    #[serde(default)]
    accounts: Vec<(String, (i64, Value))>,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn touch(st: &AppState) {
    st.league.dirty.store(true, Ordering::Relaxed);
}

pub fn enabled(st: &AppState) -> bool {
    !st.cfg.riot_api_key.is_empty()
}

/// Every account is on the Brazilian server (owner, 2026-11-12): its platform and the regional cluster
/// (account-v1, match-v5) it belongs to.
const PLATFORM: &str = "br1";
const REGION: &str = "americas";

fn host(st: &AppState, region: &str) -> String {
    match &st.cfg.riot_api_url {
        Some(base) => format!("{base}/{region}"),
        None => format!("https://{region}.api.riotgames.com"),
    }
}

pub fn champion_icon(id: i64) -> String {
    format!("{CDRAGON}/champion-icons/{id}.png")
}

fn profile_icon(id: i64) -> String {
    format!("{CDRAGON}/profile-icons/{id}.jpg")
}

pub fn champion_name(st: &AppState, id: i64) -> Option<String> {
    st.league.champions.read().unwrap().get(&id).cloned()
}

// ---------- Riot API ----------

/// Waits for room under the rate limits (up to 5 s), so a burst of profile opens doesn't get the key a 429.
async fn slot(st: &AppState) -> anyhow::Result<()> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let wait = {
            let now = Instant::now();
            let blocked = *st.league.blocked_until.lock().unwrap();
            if let Some(until) = blocked.filter(|u| *u > now) {
                until - now
            } else {
                let mut sent = st.league.sent.lock().unwrap();
                while sent
                    .front()
                    .is_some_and(|t| now.duration_since(*t) >= Duration::from_secs(120))
                {
                    sent.pop_front();
                }
                let last_sec = sent
                    .iter()
                    .rev()
                    .take_while(|t| now.duration_since(**t) < Duration::from_secs(1))
                    .count();
                if sent.len() < PER_2MIN && last_sec < PER_SEC {
                    sent.push_back(now);
                    return Ok(());
                }
                if sent.len() >= PER_2MIN {
                    (*sent.front().unwrap() + Duration::from_secs(120))
                        .saturating_duration_since(now)
                } else {
                    Duration::from_millis(100)
                }
            }
        };
        if Instant::now() + wait > deadline {
            anyhow::bail!("Riot API rate limit");
        }
        tokio::time::sleep(wait).await;
    }
}

/// GET from Riot's API: Ok(None) = 404 (no such account, no matches...).
async fn riot(st: &AppState, url: &str) -> anyhow::Result<Option<Value>> {
    slot(st).await?;
    let res = st
        .http
        .get(url)
        .header("X-Riot-Token", &st.cfg.riot_api_key)
        .timeout(Duration::from_secs(10))
        .send()
        .await?;
    match res.status().as_u16() {
        200 => Ok(Some(res.json().await?)),
        404 => Ok(None),
        429 => {
            let secs = res
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok()?.parse::<u64>().ok())
                .unwrap_or(10);
            *st.league.blocked_until.lock().unwrap() =
                Some(Instant::now() + Duration::from_secs(secs.min(120)));
            anyhow::bail!("Riot API: 429, retry in {secs} s")
        }
        401 | 403 => {
            tracing::warn!(
                "Riot API refused the key ({}): RIOT_API_KEY expired or wrong?",
                res.status()
            );
            anyhow::bail!("Riot API: {}", res.status())
        }
        s => anyhow::bail!("Riot API: {s}"),
    }
}

fn unreachable_err(e: anyhow::Error) -> ApiError {
    tracing::warn!("league: {e}");
    bad("couldn't reach Riot right now, try again in a minute")
}

// ---------- champions ----------

/// The champion list as saved in data/champions.json: names, Data Dragon keys and its version.
#[derive(Debug, PartialEq)]
struct Champions {
    names: HashMap<i64, String>,
    dragon: Option<Dragon>,
}

/// Reads champions.json: ours ({version, champions: [{id, name, alias}]}) or the older CommunityDragon summary (an array
/// of {id, name, alias}: no version, so pictures wait for the next refresh). The alias is Data Dragon's key.
fn parse_champions(raw: &str) -> Option<Champions> {
    let v: Value = serde_json::from_str(raw).ok()?;
    let (list, version) = match &v {
        Value::Array(list) => (list, None),
        Value::Object(_) => (v["champions"].as_array()?, v["version"].as_str().map(str::to_string)),
        _ => return None,
    };
    let mut names = HashMap::new();
    let mut keys = HashMap::new();
    for c in list {
        let Some(id) = c["id"].as_i64().filter(|id| *id > 0) else { continue };
        if let Some(name) = c["name"].as_str() {
            names.insert(id, name.to_string());
        }
        if let Some(alias) = c["alias"].as_str().filter(|a| !a.is_empty() && a.bytes().all(|b| b.is_ascii_alphanumeric())) {
            keys.insert(id, alias.to_string());
        }
    }
    let dragon = version.filter(|v| !v.is_empty() && !keys.is_empty()).map(|version| Dragon { version, keys });
    Some(Champions { names, dragon })
}

/// Data Dragon's newest version and its champion.json, as our champions.json.
async fn fetch_dragon_champions(st: &AppState) -> anyhow::Result<String> {
    let versions: Vec<String> = st
        .http
        .get(format!("{DDRAGON}/api/versions.json"))
        .timeout(Duration::from_secs(10))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let version = versions.into_iter().next().ok_or_else(|| anyhow::anyhow!("Data Dragon listed no versions"))?;
    let data: Value = st
        .http
        .get(format!("{DDRAGON}/cdn/{version}/data/en_US/champion.json"))
        .timeout(Duration::from_secs(20))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let champions: Vec<Value> = data["data"]
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("Data Dragon's champion.json had no champions"))?
        .values()
        .filter_map(|c| {
            Some(json!({ "id": c["key"].as_str()?.parse::<i64>().ok()?, "name": c["name"].as_str()?, "alias": c["id"].as_str()? }))
        })
        .collect();
    Ok(json!({ "version": version, "champions": champions }).to_string())
}

/// CommunityDragon's champion summary (the fallback: no version, so pictures stay on CommunityDragon).
async fn fetch_cdragon_champions(st: &AppState) -> anyhow::Result<String> {
    Ok(st
        .http
        .get(format!("{CDRAGON}/champion-summary.json"))
        .timeout(Duration::from_secs(30))
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?)
}

fn use_champions(st: &AppState, champions: Champions) {
    *st.league.champions.write().unwrap() = champions.names;
    if champions.dragon.is_some() {
        *st.league.dragon.write().unwrap() = champions.dragon;
    }
}

/// Background task: loads the saved champion list, and refreshes it once a day (and at once when the saved one has no
/// Data Dragon version), from Data Dragon, else CommunityDragon.
pub async fn keep_champions(st: AppState) {
    let path = st.cfg.data_dir.join(CHAMPIONS_FILE);
    let mut versioned = false;
    if let Some(saved) = tokio::fs::read_to_string(&path).await.ok().as_deref().and_then(parse_champions) {
        versioned = saved.dragon.is_some();
        use_champions(&st, saved);
    }
    if !st.cfg.game_info {
        return;
    }
    tokio::spawn(prefetch_icons(st.clone()));
    loop {
        let age = tokio::fs::metadata(&path)
            .await
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok());
        let mut wait = Duration::from_secs(3600);
        if !versioned || age.is_none_or(|a| a > Duration::from_secs(24 * 3600)) {
            let fetched = match fetch_dragon_champions(&st).await {
                Ok(raw) => Ok(raw),
                Err(e) => {
                    tracing::warn!("league: Data Dragon champions: {e:#}");
                    fetch_cdragon_champions(&st).await
                }
            };
            match fetched.map(|raw| parse_champions(&raw).map(|c| (raw, c))) {
                Ok(Some((raw, champions))) if !champions.names.is_empty() => {
                    versioned = champions.dragon.is_some();
                    use_champions(&st, champions);
                    let _ = tokio::fs::write(&path, raw).await;
                    tokio::spawn(prefetch_icons(st.clone()));
                }
                Ok(_) => tracing::warn!("league: champion list had no champions"),
                Err(e) => {
                    tracing::warn!("league: champion list: {e:#}");
                    wait = Duration::from_secs(300);
                }
            }
            // A list without a version (CommunityDragon's) is asked for again soon, not tomorrow.
            if !versioned {
                wait = wait.min(Duration::from_secs(1800));
            }
        }
        tokio::time::sleep(wait).await;
    }
}

// ---------- rich presence ----------

/// What the desktop app reports about the League client, with its "Playing" report.
#[derive(Deserialize)]
pub struct Rich {
    /// client | lobby | queue | champ_select | in_game | post_game
    phase: String,
    queue_id: Option<i64>,
    /// The client's own name for the queue (in its language), for queues the app doesn't name itself.
    queue: Option<String>,
    /// CLASSIC, ARAM, CHERRY (Arena), TFT, PRACTICETOOL...
    mode: Option<String>,
    party_size: Option<i64>,
    party_max: Option<i64>,
    /// Unix ms when this phase started (time in lobby, in queue, in game).
    since: Option<i64>,
    champion_id: Option<i64>,
}

impl Rich {
    pub fn is_tft(&self) -> bool {
        self.mode.as_deref() == Some("TFT")
    }

    /// In a match (loading screen included). Only this counts as time played: the client, lobby, queue, champion
    /// select and the end-of-game screen don't (owner, 2026-11-12).
    pub fn in_match(&self) -> bool {
        self.phase == "in_game"
    }
}

const PHASES: &[&str] = &[
    "client",
    "lobby",
    "queue",
    "champ_select",
    "in_game",
    "post_game",
];

/// The `league` part of a game activity, as everyone sees it; None when the report makes no sense.
pub fn rich(st: &AppState, r: &Rich, now: i64) -> Option<Value> {
    if !PHASES.contains(&r.phase.as_str()) {
        return None;
    }
    let short = |s: &Option<String>, max: usize| {
        s.as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.chars().take(max).collect::<String>())
    };
    let mut out = json!({ "phase": r.phase });
    if let Some(q) = r.queue_id.filter(|q| (-1..100_000).contains(q)) {
        out["queue_id"] = q.into();
    }
    if let Some(q) = short(&r.queue, 64) {
        out["queue"] = q.into();
    }
    if let Some(m) =
        short(&r.mode, 32).filter(|m| m.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
    {
        out["mode"] = m.into();
    }
    if let (Some(size), Some(max)) = (r.party_size, r.party_max) {
        if (1..=16).contains(&max) && (1..=max).contains(&size) {
            out["party"] = json!({ "size": size, "max": max });
        }
    }
    if let Some(since) = r.since {
        out["since"] = since.clamp(now - 24 * 3600 * 1000, now).into();
    }
    if let Some(id) = r.champion_id.filter(|id| *id > 0 && *id < 100_000) {
        if let Some(name) = champion_name(st, id) {
            out["champion"] = json!({ "id": id, "name": name, "icon": champion_icon(id) });
        }
    }
    Some(out)
}

// ---------- linking ----------

#[derive(Deserialize)]
struct Link {
    /// "Name#TAG".
    riot_id: String,
}

/// Name and tag of a Riot ID, loosely checked (Riot: names 3-16 characters, tags 3-5 letters or digits).
fn parse_riot_id(s: &str) -> Option<(String, String)> {
    let (name, tag) = s.trim().rsplit_once('#')?;
    let (name, tag) = (name.trim(), tag.trim());
    let ok = (1..=16).contains(&name.chars().count())
        && (2..=5).contains(&tag.chars().count())
        && tag.chars().all(char::is_alphanumeric);
    ok.then(|| (name.to_string(), tag.to_string()))
}

async fn account(State(st): State<AppState>, AuthUser(me): AuthUser) -> ApiResult<Json<Value>> {
    let row: Option<(String, String, String)> = sqlx::query_as(
        "SELECT game_name, tag_line, platform FROM league_accounts WHERE user_id = $1",
    )
    .bind(me)
    .fetch_optional(&st.db)
    .await?;
    let show: bool = sqlx::query_scalar("SELECT show_league FROM users WHERE id = $1")
        .bind(me)
        .fetch_one(&st.db)
        .await?;
    Ok(Json(json!({
        "enabled": enabled(&st),
        "account": row.map(|(n, t, p)| json!({ "game_name": n, "tag_line": t, "platform": p })),
        "show": show,
    })))
}

async fn link(
    State(st): State<AppState>,
    AuthUser(me): AuthUser,
    Json(body): Json<Link>,
) -> ApiResult<Json<Value>> {
    if !enabled(&st) {
        return Err(bad("League profiles aren't set up on this server"));
    }
    let (name, tag) =
        parse_riot_id(&body.riot_id).ok_or_else(|| bad("a Riot ID looks like Name#TAG"))?;
    st.limits
        .check(format!("league-link:{me}"), 5.0, 1.0 / 60.0)?;
    let url = format!(
        "{}/riot/account/v1/accounts/by-riot-id/{}/{}",
        host(&st, REGION),
        urlencoding::encode(&name),
        urlencoding::encode(&tag)
    );
    let acc = riot(&st, &url)
        .await
        .map_err(unreachable_err)?
        .ok_or_else(|| bad("no Riot account has that Riot ID"))?;
    let puuid = acc["puuid"]
        .as_str()
        .ok_or_else(|| bad("no Riot account has that Riot ID"))?
        .to_string();
    let platform = PLATFORM;
    let (name, tag) = (
        acc["gameName"].as_str().unwrap_or(&name).to_string(),
        acc["tagLine"].as_str().unwrap_or(&tag).to_string(),
    );
    sqlx::query(
        "INSERT INTO league_accounts (user_id, puuid, game_name, tag_line, platform) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id) DO UPDATE SET puuid = $2, game_name = $3, tag_line = $4, platform = $5, linked_at = now()",
    )
    .bind(me)
    .bind(&puuid)
    .bind(&name)
    .bind(&tag)
    .bind(&platform)
    .execute(&st.db)
    .await?;
    st.league.profiles.remove(&me);
    touch(&st);
    tracing::info!(user = %me, platform, "linked a League account");
    Ok(Json(
        json!({ "game_name": name, "tag_line": tag, "platform": platform }),
    ))
}

async fn unlink(State(st): State<AppState>, AuthUser(me): AuthUser) -> ApiResult<StatusCode> {
    sqlx::query("DELETE FROM league_accounts WHERE user_id = $1")
        .bind(me)
        .execute(&st.db)
        .await?;
    st.league.profiles.remove(&me);
    touch(&st);
    Ok(StatusCode::NO_CONTENT)
}

/// The linked Riot ID for the full profile (users.rs profile), when the widget is to be shown.
pub async fn linked(st: &AppState, user: Id) -> ApiResult<Option<Value>> {
    let row: Option<(String, String, String)> = sqlx::query_as(
        "SELECT game_name, tag_line, platform FROM league_accounts WHERE user_id = $1",
    )
    .bind(user)
    .fetch_optional(&st.db)
    .await?;
    Ok(row.map(|(n, t, p)| json!({ "game_name": n, "tag_line": t, "platform": p })))
}

// ---------- the widget ----------

/// One player's line of a match.
fn match_line(st: &AppState, m: &Value, puuid: &str) -> Option<Value> {
    let info = &m["info"];
    let p = info["participants"]
        .as_array()?
        .iter()
        .find(|p| p["puuid"] == puuid)?;
    let champion = p["championId"].as_i64().unwrap_or(0);
    let cs = p["totalMinionsKilled"].as_i64().unwrap_or(0)
        + p["neutralMinionsKilled"].as_i64().unwrap_or(0);
    Some(json!({
        "id": m["metadata"]["matchId"],
        "champion_id": champion,
        "champion": champion_name(st, champion).or_else(|| p["championName"].as_str().map(str::to_string)),
        "icon": champion_icon(champion),
        "win": p["win"].as_bool().unwrap_or(false),
        "remake": p["gameEndedInEarlySurrender"].as_bool().unwrap_or(false),
        "kills": p["kills"], "deaths": p["deaths"], "assists": p["assists"],
        "cs": cs,
        "placement": p["placement"].as_i64().filter(|n| *n > 0 && info["gameMode"] == "CHERRY"),
        "queue_id": info["queueId"],
        "mode": info["gameMode"],
        "duration": info["gameDuration"],
        "ended_at": info["gameEndTimestamp"],
    }))
}

/// The account's recent match ids (one request: what decides whether the rest needs asking again).
async fn match_ids(st: &AppState, puuid: &str) -> anyhow::Result<Vec<String>> {
    let rh = host(st, REGION);
    let url = format!("{rh}/lol/match/v5/matches/by-puuid/{puuid}/ids?count={RECENT_MATCHES}");
    Ok(riot(st, &url)
        .await?
        .unwrap_or_default()
        .as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default())
}

/// account-v1 by puuid (the current Riot ID), kept for a day unless `fresh`.
async fn account_of(st: &AppState, puuid: &str, fresh: bool) -> anyhow::Result<Value> {
    if let Some(e) = st.league.accounts.get(puuid) {
        if !fresh && now_ms() - e.0 < ACCOUNT_KEEP_MS {
            return Ok(e.1.clone());
        }
    }
    let rh = host(st, REGION);
    let v = riot(st, &format!("{rh}/riot/account/v1/accounts/by-puuid/{puuid}"))
        .await?
        .unwrap_or_default();
    if v["gameName"].is_string() {
        st.league.accounts.insert(puuid.to_string(), (now_ms(), v.clone()));
        touch(st);
    }
    Ok(v)
}

async fn build(
    st: &AppState,
    puuid: &str,
    platform: &str,
    ids: &[String],
    fresh: bool,
) -> anyhow::Result<Value> {
    let (ph, rh) = (host(st, platform), host(st, REGION));
    let summoner_url = format!("{ph}/lol/summoner/v4/summoners/by-puuid/{puuid}");
    let entries_url = format!("{ph}/lol/league/v4/entries/by-puuid/{puuid}");
    let top_url =
        format!("{ph}/lol/champion-mastery/v4/champion-masteries/by-puuid/{puuid}/top?count=5");
    let score_url = format!("{ph}/lol/champion-mastery/v4/scores/by-puuid/{puuid}");
    let (account, summoner, entries, top, score) = tokio::join!(
        account_of(st, puuid, fresh),
        riot(st, &summoner_url),
        riot(st, &entries_url),
        riot(st, &top_url),
        riot(st, &score_url),
    );
    let (account, summoner) = (account?, summoner?.unwrap_or_default());
    let mut ranked: Vec<Value> = entries?
        .unwrap_or_default()
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter(|e| matches!(e["queueType"].as_str(), Some("RANKED_SOLO_5x5" | "RANKED_FLEX_SR")))
        .map(|e| {
            json!({
                "queue": e["queueType"], "tier": e["tier"], "rank": e["rank"], "lp": e["leaguePoints"],
                "wins": e["wins"], "losses": e["losses"], "hot_streak": e["hotStreak"],
            })
        })
        .collect();
    ranked.sort_by_key(|e| e["queue"] != "RANKED_SOLO_5x5");
    let masteries: Vec<Value> = top?
        .unwrap_or_default()
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|m| {
            let id = m["championId"].as_i64()?;
            Some(json!({
                "champion_id": id, "champion": champion_name(st, id), "icon": champion_icon(id),
                "level": m["championLevel"], "points": m["championPoints"], "last_played": m["lastPlayTime"],
            }))
        })
        .collect();
    let fetch = ids
        .iter()
        .filter(|id| !st.league.matches.contains_key(&format!("{id}|{puuid}")))
        .map(|id| {
            let url = format!("{rh}/lol/match/v5/matches/{id}");
            async move { (id, riot(st, &url).await) }
        });
    for (id, m) in futures_util::future::join_all(fetch).await {
        // A match that failed to load is left out this time and tried again on the next refresh.
        if let Some(line) = m.ok().flatten().and_then(|m| match_line(st, &m, puuid)) {
            st.league.matches.insert(format!("{id}|{puuid}"), line);
            touch(st);
        }
    }
    if st.league.matches.len() > 5000 {
        // Keep the lines some widget still shows.
        let mut keep: HashSet<String> = HashSet::new();
        for p in st.league.profiles.iter() {
            if let Some(owner) = p.value.get("puuid").and_then(Value::as_str) {
                keep.extend(p.ids.iter().map(|id| format!("{id}|{owner}")));
            }
        }
        keep.extend(ids.iter().map(|id| format!("{id}|{puuid}")));
        st.league.matches.retain(|k, _| keep.contains(k));
    }
    let matches: Vec<Value> = ids
        .iter()
        .filter_map(|id| {
            st.league
                .matches
                .get(&format!("{id}|{puuid}"))
                .map(|l| l.clone())
        })
        .collect();
    Ok(json!({
        "game_name": account["gameName"], "tag_line": account["tagLine"], "platform": platform,
        "level": summoner["summonerLevel"],
        "icon": summoner["profileIconId"].as_i64().map(profile_icon),
        "ranked": ranked,
        "mastery_score": score?.unwrap_or_default(),
        "masteries": masteries,
        "matches": matches,
        "updated_at": now_ms(),
    }))
}

#[derive(Deserialize, Default)]
struct WidgetQuery {
    /// The Update button: ask Riot for everything again (once a minute per profile).
    #[serde(default)]
    refresh: bool,
}

/// GET /users/{id}/league: the widget, for whoever may see it (the person shows it, or it's yours).
async fn widget(
    State(st): State<AppState>,
    AuthUser(me): AuthUser,
    Path(id): Path<Id>,
    Query(q): Query<WidgetQuery>,
) -> ApiResult<Json<Value>> {
    if !enabled(&st) {
        return Err(ApiError::NotFound);
    }
    let user = User::get(&st.db, id).await?;
    let show: bool = sqlx::query_scalar("SELECT show_league FROM users WHERE id = $1")
        .bind(id)
        .fetch_one(&st.db)
        .await?;
    if !(me == id || show && crate::api::users::knows(&st, me, &user).await?) {
        return Err(ApiError::NotFound);
    }
    let row: Option<(String, String, String, String)> = sqlx::query_as(
        "SELECT puuid, game_name, tag_line, platform FROM league_accounts WHERE user_id = $1",
    )
    .bind(id)
    .fetch_optional(&st.db)
    .await?;
    let (puuid, name, tag, platform) = row.ok_or(ApiError::NotFound)?;
    // A cache entry for another account (relinked) doesn't count.
    let cached = st
        .league
        .profiles
        .get(&id)
        .map(|e| e.clone())
        .filter(|c| c.value["puuid"] == puuid.as_str());
    let now = now_ms();
    // Update pressed again right after a rebuild: what we have is that fresh.
    let refresh = q.refresh && cached.as_ref().is_none_or(|c| now - c.built >= REFRESH_EVERY_MS);
    if refresh {
        // Each one costs ~6 requests of the key's 100 per 2 minutes.
        st.limits.check(format!("league-refresh:{me}"), 4.0, 1.0 / 30.0)?;
    }
    if let Some(c) = cached.as_ref().filter(|_| !refresh) {
        if q.refresh || now - c.checked < PROFILE_TTL.as_millis() as i64 {
            return Ok(Json(public(&c.value)));
        }
    }
    let built = async {
        let ids = match_ids(&st, &puuid).await?;
        // No game since: nothing else can have moved.
        if let Some(c) = cached
            .as_ref()
            .filter(|c| !refresh && c.ids == ids && now - c.built < PROFILE_KEEP_MS)
        {
            let mut c = c.clone();
            c.checked = now;
            st.league.profiles.insert(id, c.clone());
            touch(&st);
            return anyhow::Ok(c.value);
        }
        let mut v = build(&st, &puuid, &platform, &ids, refresh).await?;
        v["puuid"] = puuid.clone().into();
        st.league.profiles.insert(
            id,
            Cached {
                built: now,
                checked: now,
                ids,
                value: v.clone(),
            },
        );
        touch(&st);
        anyhow::Ok(v)
    }
    .await;
    match built {
        Ok(v) => {
            // Someone changed their Riot ID in Riot's client: keep the stored one current.
            if let (Some(n), Some(t)) = (v["game_name"].as_str(), v["tag_line"].as_str()) {
                if n != name || t != tag {
                    sqlx::query("UPDATE league_accounts SET game_name = $2, tag_line = $3 WHERE user_id = $1").bind(id).bind(n).bind(t).execute(&st.db).await?;
                }
            }
            Ok(Json(public(&v)))
        }
        // Riot unreachable or the limit reached: what we had is better than nothing.
        Err(e) => match cached {
            Some(c) => {
                tracing::warn!("league: serving a stale profile: {e}");
                Ok(Json(public(&c.value)))
            }
            None => Err(unreachable_err(e)),
        },
    }
}

/// The widget as clients get it: without the puuid it's cached under (per API key, and nobody's business).
fn public(v: &Value) -> Value {
    let mut v = v.clone();
    if let Some(o) = v.as_object_mut() {
        o.remove("puuid");
    }
    v
}

// ---------- the cache on disk ----------

/// Background task: loads data/league-cache.json, then writes it at most once a minute while something changed.
pub async fn keep_cache(st: AppState) {
    let path = st.cfg.data_dir.join(CACHE_FILE);
    if let Ok(raw) = tokio::fs::read(&path).await {
        match serde_json::from_slice::<Saved>(&raw) {
            Ok(saved) => {
                for (k, v) in saved.profiles {
                    st.league.profiles.entry(k).or_insert(v);
                }
                for (k, v) in saved.matches {
                    st.league.matches.entry(k).or_insert(v);
                }
                for (k, v) in saved.accounts {
                    st.league.accounts.entry(k).or_insert(v);
                }
            }
            Err(e) => tracing::warn!("league: {CACHE_FILE} unreadable, starting empty: {e}"),
        }
    }
    loop {
        tokio::time::sleep(Duration::from_secs(60)).await;
        if !st.league.dirty.swap(false, Ordering::Relaxed) {
            continue;
        }
        let saved = Saved {
            profiles: st.league.profiles.iter().map(|e| (*e.key(), e.value().clone())).collect(),
            matches: st.league.matches.iter().map(|e| (e.key().clone(), e.value().clone())).collect(),
            accounts: st.league.accounts.iter().map(|e| (e.key().clone(), e.value().clone())).collect(),
        };
        let Ok(raw) = serde_json::to_vec(&saved) else {
            continue;
        };
        let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
        let written = async {
            tokio::fs::write(&tmp, raw).await?;
            tokio::fs::rename(&tmp, &path).await
        }
        .await;
        if let Err(e) = written {
            tracing::warn!("league: saving {CACHE_FILE}: {e}");
            let _ = tokio::fs::remove_file(&tmp).await;
            touch(&st);
        }
    }
}

// ---------- pictures ----------

const TIERS: &[&str] = &[
    "iron", "bronze", "silver", "gold", "platinum", "emerald", "diamond", "master", "grandmaster", "challenger",
];

fn digits(s: &str) -> bool {
    !s.is_empty() && s.len() <= 9 && s.bytes().all(|b| b.is_ascii_digit())
}

/// The CommunityDragon pictures /league/art serves (paths under raw.communitydragon.org/latest/); anything else is
/// refused, so it can't be made to fetch other files.
fn art_path(path: &str) -> bool {
    const GAME: &str = ART_GAME;
    const EMBLEM: &str = "plugins/rcp-fe-lol-static-assets/global/default/images/ranked-emblem/emblem-";
    if let Some(rest) = path.strip_prefix(GAME) {
        let parts: Vec<&str> = rest.split('/').collect();
        return match parts.as_slice() {
            ["champion-icons", f] => f.strip_suffix(".png").is_some_and(digits),
            ["profile-icons", f] => f.strip_suffix(".jpg").is_some_and(digits),
            ["champion-splashes", id, f] => digits(id) && f.strip_suffix(".jpg").is_some_and(digits),
            _ => false,
        };
    }
    path.strip_prefix(EMBLEM)
        .and_then(|f| f.strip_suffix(".png"))
        .is_some_and(|t| TIERS.contains(&t))
}

fn art_file(st: &AppState, path: &str) -> std::path::PathBuf {
    st.cfg.data_dir.join(ART_DIR).join(path.replace('/', "_"))
}

/// Data Dragon's copy of a CommunityDragon picture path, when it has one and its version and keys are known.
fn dragon_url(dragon: &Dragon, path: &str) -> Option<String> {
    let rest = path.strip_prefix(ART_GAME)?;
    let number = |f: &str, ext: &str| f.strip_suffix(ext).filter(|n| digits(n)).and_then(|n| n.parse::<i64>().ok());
    let v = &dragon.version;
    match rest.split('/').collect::<Vec<_>>().as_slice() {
        ["champion-icons", f] => {
            let key = dragon.keys.get(&number(f, ".png")?)?;
            Some(format!("{DDRAGON}/cdn/{v}/img/champion/{key}.png"))
        }
        ["profile-icons", f] => Some(format!("{DDRAGON}/cdn/{v}/img/profileicon/{}.png", number(f, ".jpg")?)),
        // Skin ids are champion id * 1000 + the skin's number.
        ["champion-splashes", id, f] => {
            let champion: i64 = id.parse().ok()?;
            let skin = number(f, ".jpg")? - champion * 1000;
            let key = dragon.keys.get(&champion)?;
            (0..1000).contains(&skin).then(|| format!("{DDRAGON}/cdn/img/champion/splash/{key}_{skin}.jpg"))
        }
        _ => None,
    }
}

/// Where a picture comes from, in order: Data Dragon (fast) when it has it, then CommunityDragon.
fn art_sources(st: &AppState, path: &str) -> Vec<(String, Duration)> {
    let dragon = st.league.dragon.read().unwrap().as_ref().and_then(|d| dragon_url(d, path));
    dragon
        .map(|url| (url, Duration::from_secs(8)))
        .into_iter()
        .chain([(format!("{CDRAGON_ROOT}{path}"), Duration::from_secs(20))])
        .collect()
}

/// One picture: Ok(None) = that site doesn't have it.
async fn download_art(st: &AppState, url: &str, timeout: Duration) -> anyhow::Result<Option<Vec<u8>>> {
    let res = st.http.get(url).timeout(timeout).send().await?;
    if res.status() == StatusCode::NOT_FOUND || res.status() == StatusCode::FORBIDDEN {
        return Ok(None);
    }
    let res = res.error_for_status()?;
    let is_image = res
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("image/"));
    const MAX: u64 = 12 * 1024 * 1024;
    if !is_image || res.content_length().is_some_and(|n| n > MAX) {
        anyhow::bail!("{url} sent something else");
    }
    let bytes = res.bytes().await?;
    if bytes.len() as u64 > MAX {
        anyhow::bail!("{url} is too big");
    }
    Ok(Some(bytes.to_vec()))
}

/// Fetches a picture into data/league-art (if it isn't there yet). Ok(false) = no source has it.
async fn fetch_art(st: &AppState, path: &str) -> anyhow::Result<bool> {
    let file = art_file(st, path);
    if tokio::fs::try_exists(&file).await.unwrap_or(false) {
        return Ok(true);
    }
    if st
        .league
        .art_missing
        .get(path)
        .is_some_and(|t| t.elapsed() < Duration::from_secs(3600))
    {
        return Ok(false);
    }
    let mut failed: Option<anyhow::Error> = None;
    let mut bytes = None;
    for (url, timeout) in art_sources(st, path) {
        match download_art(st, &url, timeout).await {
            Ok(Some(b)) => {
                bytes = Some(b);
                break;
            }
            Ok(None) => {}
            Err(e) => failed = Some(e.context(url)),
        }
    }
    let Some(bytes) = bytes else {
        return match failed {
            Some(e) => Err(e),
            None => {
                st.league.art_missing.insert(path.to_string(), Instant::now());
                Ok(false)
            }
        };
    };
    if let Some(dir) = file.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    // Two requests for the same picture may race: each writes its own file, the rename makes it whole.
    let tmp = file.with_extension(format!("{}.{}.tmp", std::process::id(), Id::new()));
    tokio::fs::write(&tmp, &bytes).await?;
    if let Err(e) = tokio::fs::rename(&tmp, &file).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(e.into());
    }
    Ok(true)
}

/// A picture's type from its first bytes (Data Dragon's profile icons are PNG where CommunityDragon's path says .jpg).
fn image_type(bytes: &[u8], path: &str) -> &'static str {
    if bytes.starts_with(b"\x89PNG") {
        "image/png"
    } else if bytes.starts_with(&[0xFF, 0xD8]) {
        "image/jpeg"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else if path.ends_with(".png") {
        "image/png"
    } else {
        "image/jpeg"
    }
}

/// GET /league/art/{*path}: a League picture from our copy (fetched once), kept by browsers for 30 days.
async fn art(State(st): State<AppState>, Path(path): Path<String>) -> Response {
    if !art_path(&path) {
        return StatusCode::NOT_FOUND.into_response();
    }
    match fetch_art(&st, &path).await {
        Ok(true) => {}
        Ok(false) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => {
            tracing::warn!("league: picture: {e:#}");
            // Better the original than nothing: the fastest source we know of.
            let (url, _) = art_sources(&st, &path).swap_remove(0);
            return (StatusCode::FOUND, [(header::LOCATION, url)]).into_response();
        }
    }
    let Ok(bytes) = tokio::fs::read(art_file(&st, &path)).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let kind = image_type(&bytes, &path);
    (
        [
            (header::CONTENT_TYPE, kind),
            (header::CACHE_CONTROL, "public, max-age=2592000, immutable"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        bytes,
    )
        .into_response()
}

/// Every champion's icon into data/league-art, slowly, once (new champions as they appear).
async fn prefetch_icons(st: AppState) {
    static RUNNING: AtomicBool = AtomicBool::new(false);
    if RUNNING.swap(true, Ordering::AcqRel) {
        return;
    }
    let ids: Vec<i64> = st.league.champions.read().unwrap().keys().copied().collect();
    let mut fetched = 0;
    for id in ids {
        let path = format!("plugins/rcp-be-lol-game-data/global/default/v1/champion-icons/{id}.png");
        if tokio::fs::try_exists(art_file(&st, &path)).await.unwrap_or(false) {
            continue;
        }
        match fetch_art(&st, &path).await {
            Ok(_) => fetched += 1,
            Err(e) => {
                tracing::warn!("league: champion icons: {e:#}");
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if fetched > 0 {
        tracing::info!(fetched, "league: champion icons saved");
    }
    RUNNING.store(false, Ordering::Release);
}

// ---------- lobby invites ----------

/// Their League activity, when they're in a lobby (where invites can happen).
fn lobby_of(st: &AppState, user: Id) -> Option<Value> {
    let a = crate::activities::activity_of(st, user, crate::activities::PLAYING)?;
    (a["league"]["phase"] == "lobby").then(|| a["league"].clone())
}

/// Both may deal with each other: they know each other and neither blocked the other.
async fn may_reach(st: &AppState, me: Id, other: Id) -> ApiResult<()> {
    let user = User::get(&st.db, other).await?;
    if me == other
        || user.bot
        || !crate::api::users::knows(st, me, &user).await?
        || blocked_between(&st.db, me, other).await?
    {
        return Err(ApiError::NotFound);
    }
    Ok(())
}

#[derive(Deserialize)]
struct JoinBody {
    /// Whose lobby.
    user_id: Id,
    /// Yours, from your League client (it invites by summoner id).
    summoner_id: i64,
    puuid: Option<String>,
    /// Joining from their invite message in a chat: approved already, like an invite sent to you.
    message_id: Option<Id>,
}

/// POST /league/join: ask someone in a lobby to invite you (their app has their League client do it).
async fn join(
    State(st): State<AppState>,
    AuthUser(me): AuthUser,
    Json(b): Json<JoinBody>,
) -> ApiResult<StatusCode> {
    may_reach(&st, me, b.user_id).await?;
    if b.summoner_id <= 0 {
        return Err(bad("open League of Legends to join"));
    }
    let puuid = b.puuid.filter(|p| {
        p.len() <= 100 && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    });
    let lobby = lobby_of(&st, b.user_id).ok_or_else(|| bad("they're not in a League lobby right now"))?;
    let full = lobby["party"]["size"]
        .as_i64()
        .zip(lobby["party"]["max"].as_i64())
        .is_some_and(|(size, max)| size >= max);
    if full {
        return Err(bad("their lobby is full"));
    }
    st.limits.check(format!("league-join:{me}"), 4.0, 1.0 / 15.0)?;
    let invited = st
        .league
        .invites
        .remove(&(b.user_id, me))
        .is_some_and(|(_, at)| at.elapsed() < INVITE_TTL);
    let auto = invited
        || match b.message_id {
            Some(mid) => from_invite_message(&st, me, b.user_id, mid).await?,
            None => false,
        };
    st.league.joins.retain(|_, at| at.elapsed() < JOIN_TTL);
    st.league.joins.insert((b.user_id, me), Instant::now());
    st.hub.send(
        &[b.user_id],
        "LEAGUE_JOIN_REQUEST",
        &json!({ "user_id": me, "summoner_id": b.summoner_id, "puuid": puuid, "auto": auto }),
    );
    tracing::info!(user = %me, host = %b.user_id, auto, "league: asked to join a lobby");
    Ok(StatusCode::NO_CONTENT)
}

/// The message is `host`'s lobby invite, in a channel `me` can read, from the last few hours.
async fn from_invite_message(st: &AppState, me: Id, host: Id, mid: Id) -> ApiResult<bool> {
    let row: Option<(Id, Id, i16, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
        "SELECT channel_id, author_id, type, created_at FROM messages WHERE id = $1",
    )
    .bind(mid)
    .fetch_optional(&st.db)
    .await?;
    let Some((channel, author, kind, at)) = row else {
        return Ok(false);
    };
    if author != host
        || kind != crate::models::message_type::LEAGUE_INVITE
        || chrono::Utc::now() - at > chrono::Duration::hours(6)
    {
        return Ok(false);
    }
    let a = crate::api::channels::channel_for(st, channel, me).await?;
    Ok(a.perms.has(crate::perms::READ_MESSAGE_HISTORY))
}

#[derive(Deserialize)]
struct InvitedBody {
    /// Who your League client just invited.
    user_id: Id,
    /// Yours, from your League client: their app accepts only an invite from this summoner.
    summoner_id: i64,
    puuid: Option<String>,
}

/// POST /league/invited: your League client invited someone who asked to join; their app then accepts it by itself.
async fn invited(
    State(st): State<AppState>,
    AuthUser(me): AuthUser,
    Json(b): Json<InvitedBody>,
) -> ApiResult<StatusCode> {
    if b.summoner_id <= 0 {
        return Err(bad("open League of Legends to join"));
    }
    let asked = st
        .league
        .joins
        .remove(&(me, b.user_id))
        .is_some_and(|(_, at)| at.elapsed() < JOIN_TTL);
    if !asked {
        return Err(ApiError::NotFound);
    }
    let puuid = b.puuid.filter(|p| {
        p.len() <= 100 && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    });
    st.hub.send(
        &[b.user_id],
        "LEAGUE_INVITED",
        &json!({ "user_id": me, "summoner_id": b.summoner_id, "puuid": puuid }),
    );
    tracing::info!(user = %me, to = %b.user_id, "league: sent a lobby invite");
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct ChatInviteBody {
    channel_id: Id,
}

/// POST /league/invite/chat: "join my lobby" as a message in a chat (the composer's League button), Discord's
/// activity invite. Anyone who can read it joins with one click.
async fn chat_invite(
    State(st): State<AppState>,
    AuthUser(me): AuthUser,
    Json(b): Json<ChatInviteBody>,
) -> ApiResult<Json<crate::models::Message>> {
    let lobby = lobby_of(&st, me).ok_or_else(|| bad("open a lobby in League of Legends first"))?;
    let msg = crate::api::messages::post_league_invite(&st, b.channel_id, me, lobby).await?;
    tracing::info!(user = %me, channel = %b.channel_id, "league: invited a chat to a lobby");
    Ok(Json(msg))
}

#[derive(Deserialize)]
struct InviteBody {
    user_id: Id,
}

/// POST /league/invite: invite someone to your lobby; accepting sends their join request back, already approved.
async fn invite(
    State(st): State<AppState>,
    AuthUser(me): AuthUser,
    Json(b): Json<InviteBody>,
) -> ApiResult<StatusCode> {
    may_reach(&st, me, b.user_id).await?;
    let lobby = lobby_of(&st, me).ok_or_else(|| bad("open a lobby in League of Legends first"))?;
    st.limits.check(format!("league-invite:{me}"), 10.0, 1.0 / 6.0)?;
    st.league.invites.retain(|_, at| at.elapsed() < INVITE_TTL);
    st.league.invites.insert((me, b.user_id), Instant::now());
    st.hub.send(&[b.user_id], "LEAGUE_INVITE", &json!({ "user_id": me, "league": lobby }));
    tracing::info!(user = %me, to = %b.user_id, "league: invited someone to a lobby");
    Ok(StatusCode::NO_CONTENT)
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/league/account", get(account).put(link).delete(unlink))
        .route("/users/{id}/league", get(widget))
        .route("/league/art/{*path}", get(art))
        .route("/league/join", post(join))
        .route("/league/invite", post(invite))
        .route("/league/invited", post(invited))
        .route("/league/invite/chat", post(chat_invite))
        .route("/league/pentakill", post(pentakill))
}

// ---------- REC: the pentakill badge ----------

#[derive(Deserialize)]
struct PentakillBody {
    /// The match's game id, from the League client while it was played (the Riot match is BR1_<id>).
    game_id: i64,
}

/// Did this player get a pentakill in this match (Riot's own data, so the app can't make one up)?
fn had_pentakill(m: &Value, puuid: &str) -> bool {
    m["info"]["participants"].as_array().is_some_and(|ps| {
        ps.iter().any(|p| p["puuid"] == puuid && p["pentaKills"].as_i64().unwrap_or(0) > 0)
    })
}

/// POST /league/pentakill: REC caught a pentakill; the badge once Riot's match agrees. The match only exists once it
/// ended (and a little after), so "pending" = ask again later (the app keeps the claim until it gets an answer).
async fn pentakill(
    State(st): State<AppState>,
    AuthUser(me): AuthUser,
    Json(b): Json<PentakillBody>,
) -> ApiResult<Json<Value>> {
    if !enabled(&st) {
        return Err(bad("League profiles aren't set up on this server"));
    }
    if b.game_id <= 0 {
        return Err(bad("that isn't a League match"));
    }
    st.limits.check(format!("pentakill:{me}"), 5.0, 5.0 / 600.0)?;
    let puuid: Option<String> = sqlx::query_scalar("SELECT puuid FROM league_accounts WHERE user_id = $1")
        .bind(me)
        .fetch_optional(&st.db)
        .await?;
    let Some(puuid) = puuid else {
        return Ok(Json(json!({ "status": "no_account" })));
    };
    let url = format!("{}/lol/match/v5/matches/{}_{}", host(&st, REGION), PLATFORM.to_ascii_uppercase(), b.game_id);
    let status = match riot(&st, &url).await.map_err(unreachable_err)? {
        None => "pending",
        Some(m) if had_pentakill(&m, &puuid) => {
            crate::badges::grant(&st, me, "pentakill").await;
            "granted"
        }
        Some(_) => "no",
    };
    tracing::info!(user = %me, status, "league: pentakill claim");
    Ok(Json(json!({ "status": status })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pentakills_come_from_the_match() {
        let m = json!({ "info": { "participants": [
            { "puuid": "a", "pentaKills": 0 },
            { "puuid": "b", "pentaKills": 1 },
        ] } });
        assert!(had_pentakill(&m, "b"));
        assert!(!had_pentakill(&m, "a"));
        assert!(!had_pentakill(&m, "c"));
        assert!(!had_pentakill(&json!({}), "b"));
    }

    #[test]
    fn riot_ids() {
        assert_eq!(
            parse_riot_id("vini#saimo"),
            Some(("vini".into(), "saimo".into()))
        );
        assert_eq!(
            parse_riot_id("  Some Name #BR1 "),
            Some(("Some Name".into(), "BR1".into()))
        );
        assert_eq!(parse_riot_id("a#b#TAG"), Some(("a#b".into(), "TAG".into())));
        assert_eq!(parse_riot_id("noTag"), None);
        assert_eq!(parse_riot_id("#BR1"), None);
        assert_eq!(parse_riot_id("name#t!g"), None);
    }

    #[test]
    fn champion_lists_old_and_new() {
        let old = r#"[{"id": -1, "name": "None", "alias": "None"}, {"id": 62, "name": "Wukong", "alias": "MonkeyKing"}]"#;
        let c = parse_champions(old).unwrap();
        assert_eq!(c.names.get(&62).map(String::as_str), Some("Wukong"));
        assert!(c.dragon.is_none(), "no version in CommunityDragon's summary");
        let new = r#"{"version": "15.22.1", "champions": [{"id": 62, "name": "Wukong", "alias": "MonkeyKing"}, {"id": 1, "name": "Annie", "alias": "../x"}]}"#;
        let c = parse_champions(new).unwrap();
        let d = c.dragon.unwrap();
        assert_eq!(d.version, "15.22.1");
        assert_eq!(d.keys.get(&62).map(String::as_str), Some("MonkeyKing"));
        assert!(!d.keys.contains_key(&1), "only plain keys go into URLs");
        assert_eq!(c.names.get(&1).map(String::as_str), Some("Annie"));
    }

    #[test]
    fn data_dragon_urls() {
        let d = Dragon { version: "15.22.1".into(), keys: HashMap::from([(62, "MonkeyKing".to_string())]) };
        let g = ART_GAME;
        assert_eq!(
            dragon_url(&d, &format!("{g}champion-icons/62.png")).as_deref(),
            Some("https://ddragon.leagueoflegends.com/cdn/15.22.1/img/champion/MonkeyKing.png")
        );
        assert_eq!(
            dragon_url(&d, &format!("{g}profile-icons/29.jpg")).as_deref(),
            Some("https://ddragon.leagueoflegends.com/cdn/15.22.1/img/profileicon/29.png")
        );
        assert_eq!(
            dragon_url(&d, &format!("{g}champion-splashes/62/62005.jpg")).as_deref(),
            Some("https://ddragon.leagueoflegends.com/cdn/img/champion/splash/MonkeyKing_5.jpg")
        );
        assert_eq!(dragon_url(&d, &format!("{g}champion-icons/266.png")), None, "unknown key: CommunityDragon");
        assert_eq!(dragon_url(&d, &format!("{g}champion-splashes/62/266000.jpg")), None);
        assert_eq!(dragon_url(&d, "plugins/rcp-fe-lol-static-assets/global/default/images/ranked-emblem/emblem-gold.png"), None);
        assert_eq!(image_type(b"\x89PNG\r\n", "x.jpg"), "image/png");
        assert_eq!(image_type(&[0xFF, 0xD8, 0xFF], "x.png"), "image/jpeg");
    }

    #[test]
    fn art_paths() {
        let g = "plugins/rcp-be-lol-game-data/global/default/v1/";
        assert!(art_path(&format!("{g}champion-icons/266.png")));
        assert!(art_path(&format!("{g}profile-icons/29.jpg")));
        assert!(art_path(&format!("{g}champion-splashes/266/266000.jpg")));
        assert!(art_path(
            "plugins/rcp-fe-lol-static-assets/global/default/images/ranked-emblem/emblem-gold.png"
        ));
        assert!(!art_path(&format!("{g}champion-icons/../../x.png")));
        assert!(!art_path(&format!("{g}champion-icons/266.json")));
        assert!(!art_path(&format!("{g}champion-summary.json")));
        assert!(!art_path(&format!("{g}champion-splashes/266/a.jpg")));
        assert!(!art_path(
            "plugins/rcp-fe-lol-static-assets/global/default/images/ranked-emblem/emblem-x.png"
        ));
        assert!(!art_path("https://example.com/a.png"));
    }
}
