use axum::extract::{Multipart, Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::auth::AuthUser;
use crate::api::{dms, guilds, relationships};
use crate::error::{bad, ApiResult};
use crate::models::kind;
use crate::gateway::{broadcast_presence, related_users};
use crate::id::Id;
use crate::models::User;
use crate::state::AppState;
use crate::{uploads, voice};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/users/@me", get(me).patch(update_me).delete(delete_me))
        .route("/users/@me/connections", get(connections))
        .route("/users/@me/stats", get(stats))
        .route(
            "/users/@me/avatar",
            post(|st, me, mp| upload_image(st, me, mp, "avatar"))
                .put(restore_avatar)
                .delete(|st, me| clear_image(st, me, "avatar")),
        )
        .route("/users/@me/avatars", get(avatar_history).delete(forget_avatar))
        .route("/users/@me/favorite-games", axum::routing::put(set_favorite_games))
        .route(
            "/users/@me/nameplate",
            post(|st, me, mp| upload_image(st, me, mp, "nameplate")).put(choose_nameplate).delete(|st, me| clear_image(st, me, "nameplate")),
        )
        .route("/nameplates", get(default_nameplates))
        .route("/users/@me/banner", post(|st, me, mp| upload_image(st, me, mp, "banner")).delete(|st, me| clear_image(st, me, "banner")))
        .route("/users/@me/profile-song", post(upload_song).patch(update_song).delete(remove_song))
        .route("/users/{id}", get(get_user))
        .route("/users/{id}/profile", get(profile))
        .route("/users/{id}/note", axum::routing::put(set_note))
}

async fn me(State(st): State<AppState>, AuthUser(me): AuthUser) -> ApiResult<Json<serde_json::Value>> {
    let u = User::get(&st.db, me).await?;
    Ok(Json(serde_json::to_value(u.me()).unwrap()))
}

async fn get_user(State(st): State<AppState>, AuthUser(_): AuthUser, Path(id): Path<Id>) -> ApiResult<Json<User>> {
    Ok(Json(User::get(&st.db, id).await?))
}

/// The full profile modal: the user plus what you have in common (mutual friends and servers).
async fn profile(State(st): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<Id>) -> ApiResult<Json<serde_json::Value>> {
    let user = User::get(&st.db, id).await?;
    let friend = crate::api::relationships::FRIEND;
    let mutual_friends: Vec<Id> = sqlx::query_scalar(
        "SELECT a.target_id FROM relationships a JOIN relationships b ON b.target_id = a.target_id
         WHERE a.user_id = $1 AND b.user_id = $2 AND a.kind = $3 AND b.kind = $3 AND a.target_id <> $1 AND a.target_id <> $2",
    )
    .bind(me)
    .bind(id)
    .bind(friend)
    .fetch_all(&st.db)
    .await?;
    let mutual_guilds: Vec<Id> = sqlx::query_scalar(
        "SELECT a.guild_id FROM members a JOIN members b ON b.guild_id = a.guild_id WHERE a.user_id = $1 AND b.user_id = $2",
    )
    .bind(me)
    .bind(id)
    .fetch_all(&st.db)
    .await?;
    let created_at: chrono::DateTime<chrono::Utc> = sqlx::query_scalar("SELECT created_at FROM users WHERE id = $1").bind(id).fetch_one(&st.db).await?;
    let mut friends = Vec::with_capacity(mutual_friends.len());
    for f in mutual_friends {
        friends.push(User::get(&st.db, f).await?);
    }
    let connections = crate::spotify::public(&st, id).await?;
    let favorite_games = favorite_games(&st, id).await?;
    let (links, show_stats, show_top_songs): (sqlx::types::Json<Vec<Link>>, bool, bool) =
        sqlx::query_as("SELECT links, show_stats, show_top_songs FROM users WHERE id = $1").bind(id).fetch_one(&st.db).await?;
    let note: Option<String> =
        sqlx::query_scalar("SELECT note FROM user_notes WHERE user_id = $1 AND target_id = $2").bind(me).bind(id).fetch_optional(&st.db).await?;
    let own = me == id;
    let mut out = serde_json::json!({
        "user": user, "mutual_friends": friends, "mutual_guilds": mutual_guilds, "created_at": created_at, "connections": connections,
        "favorite_games": favorite_games, "links": links.0, "note": note.unwrap_or_default(), "song": profile_song(&st, id, own).await?,
    });
    // Widgets: others see them when the person turned them on; you always see yours (with whether they're shown).
    if show_top_songs || own {
        out["top_songs"] = top_songs(&st, id).await?.into();
    }
    if show_stats || own {
        out["stats"] = public_stats(&st, id).await?;
    }
    if own {
        out["show_stats"] = show_stats.into();
        out["show_top_songs"] = show_top_songs.into();
    }
    Ok(Json(out))
}

// ---------- notes ----------

const MAX_NOTE: usize = 256;

#[derive(Deserialize)]
struct NoteBody {
    note: String,
}

/// Your private note about someone (shown only to you, on their profile). Empty deletes it.
async fn set_note(State(st): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<Id>, Json(body): Json<NoteBody>) -> ApiResult<Json<serde_json::Value>> {
    if id == me {
        return Err(bad("you can't write a note about yourself"));
    }
    User::get(&st.db, id).await?;
    let note = body.note.trim();
    if note.chars().count() > MAX_NOTE {
        return Err(bad("notes can be at most 256 characters"));
    }
    if note.is_empty() {
        sqlx::query("DELETE FROM user_notes WHERE user_id = $1 AND target_id = $2").bind(me).bind(id).execute(&st.db).await?;
    } else {
        sqlx::query(
            "INSERT INTO user_notes (user_id, target_id, note) VALUES ($1, $2, $3)
             ON CONFLICT (user_id, target_id) DO UPDATE SET note = EXCLUDED.note, updated_at = now()",
        )
        .bind(me)
        .bind(id)
        .bind(note)
        .execute(&st.db)
        .await?;
    }
    // Your other sessions update their copy.
    st.hub.send(&[me], "USER_NOTE_UPDATE", &json!({ "id": id, "note": note }));
    Ok(Json(json!({ "note": note })))
}

// ---------- links and birthday ----------

const MAX_LINKS: usize = 5;

#[derive(Serialize, Deserialize, Clone)]
pub struct Link {
    #[serde(default)]
    label: String,
    url: String,
}

/// Tidies profile links: http(s) only, labels up to 32 characters (empty = the site's name, chosen by the client).
fn clean_links(links: Vec<Link>) -> ApiResult<Vec<Link>> {
    if links.len() > MAX_LINKS {
        return Err(bad("you can add up to 5 links"));
    }
    let mut out = Vec::with_capacity(links.len());
    for l in links {
        let raw = l.url.trim();
        let with_scheme = if raw.contains("://") { raw.to_string() } else { format!("https://{raw}") };
        let parsed = reqwest::Url::parse(&with_scheme).map_err(|_| bad("that link doesn't look right"))?;
        let host_ok = parsed.host_str().is_some_and(|h| h.contains('.'));
        if !matches!(parsed.scheme(), "http" | "https") || !host_ok || with_scheme.len() > 512 {
            return Err(bad("that link doesn't look right"));
        }
        let label = l.label.split_whitespace().collect::<Vec<_>>().join(" ");
        if label.chars().count() > 32 {
            return Err(bad("link names can be at most 32 characters"));
        }
        out.push(Link { label, url: parsed.to_string() });
    }
    Ok(out)
}

/// 'MM-DD' or 'YYYY-MM-DD' (a real date; 29 February is fine without a year). Empty clears it.
fn clean_birthday(b: &str) -> ApiResult<Option<String>> {
    let b = b.trim();
    if b.is_empty() {
        return Ok(None);
    }
    let invalid = || bad("that birthday isn't a real date");
    let (year, md) = match b.len() {
        5 => (None, b),
        10 if b.as_bytes()[4] == b'-' => (Some(b[..4].parse::<i32>().map_err(|_| invalid())?), &b[5..]),
        _ => return Err(invalid()),
    };
    let (m, d) = md.split_once('-').ok_or_else(invalid)?;
    let (m, d): (u32, u32) = (m.parse().map_err(|_| invalid())?, d.parse().map_err(|_| invalid())?);
    let this_year = chrono::Datelike::year(&Utc::now());
    if year.is_some_and(|y| y < 1900 || y > this_year) {
        return Err(invalid());
    }
    // A leap year stands in for "any year".
    chrono::NaiveDate::from_ymd_opt(year.unwrap_or(2000), m, d).ok_or_else(invalid)?;
    Ok(Some(match year {
        Some(y) => format!("{y:04}-{m:02}-{d:02}"),
        None => format!("{m:02}-{d:02}"),
    }))
}

// ---------- widgets: Kass's top songs and the stats card ----------

/// The songs Kass played most for someone (music.rs counts them).
async fn top_songs(st: &AppState, user: Id) -> ApiResult<Vec<serde_json::Value>> {
    let rows: Vec<(String, String, Option<String>, Option<String>, i32)> = sqlx::query_as(
        "SELECT title, url, uploader, thumbnail, plays FROM kass_plays WHERE user_id = $1 ORDER BY plays DESC, last_played DESC LIMIT 5",
    )
    .bind(user)
    .fetch_all(&st.db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(title, url, uploader, thumbnail, plays)| json!({ "title": title, "url": url, "uploader": uploader, "thumbnail": thumbnail, "plays": plays }))
        .collect())
}

/// A few of the numbers from Settings -> Stats, for the profile (no channels: the viewer may not see them).
async fn public_stats(st: &AppState, user: Id) -> ApiResult<serde_json::Value> {
    let db = &st.db;
    let voice_seconds: i64 = sqlx::query_scalar("SELECT voice_seconds FROM users WHERE id = $1").bind(user).fetch_one(db).await?;
    let (messages, active_days): (i64, i64) =
        sqlx::query_as("SELECT COUNT(*), COUNT(DISTINCT created_at::date) FROM messages WHERE author_id = $1 AND type = 0")
            .bind(user)
            .fetch_one(db)
            .await?;
    let top_emoji: Vec<(String, i64)> =
        sqlx::query_as("SELECT emoji, COUNT(*) FROM reactions WHERE user_id = $1 GROUP BY emoji ORDER BY 2 DESC, 1 LIMIT 3")
            .bind(user)
            .fetch_all(db)
            .await?;
    let keys: Vec<String> = ["stream_seconds", "longest_voice_seconds", "sounds_played", "songs_queued", "game_seconds"].map(String::from).to_vec();
    let counters: std::collections::HashMap<String, i64> =
        sqlx::query_as::<_, (String, i64)>("SELECT key, value FROM user_stats WHERE user_id = $1 AND key = ANY($2)")
            .bind(user)
            .bind(keys)
            .fetch_all(db)
            .await?
            .into_iter()
            .collect();
    let top_game: Option<(String, Option<String>, i64)> =
        sqlx::query_as("SELECT name, icon, seconds FROM user_games WHERE user_id = $1 ORDER BY seconds DESC LIMIT 1")
            .bind(user)
            .fetch_optional(db)
            .await?;
    Ok(json!({
        "voice_seconds": voice_seconds,
        "messages": messages,
        "active_days": active_days,
        "counters": counters,
        "top_emoji": top_emoji.into_iter().map(|(emoji, n)| json!({ "emoji": emoji, "count": n })).collect::<Vec<_>>(),
        "top_game": top_game.map(|(name, icon, seconds)| json!({ "name": name, "icon": icon, "seconds": seconds })),
    }))
}

// ---------- profile song ----------

const MAX_SONG_SECONDS: f64 = 30.0;
const MAX_SONG_SOURCE: usize = 15 * 1024 * 1024;
const SONG_TOO_LONG: &str = "profile songs can be at most 30 seconds long";

#[derive(Deserialize, Default)]
struct SongFields {
    title: Option<String>,
    volume: Option<f32>,
    trim_start: Option<f64>,
    trim_end: Option<f64>,
}

/// The profile song as clients see it; the original file it was cut from only for its owner (to trim it again).
async fn profile_song(st: &AppState, user: Id, own: bool) -> ApiResult<Option<serde_json::Value>> {
    let row: Option<(String, String, String, f32, f32, f32)> =
        sqlx::query_as("SELECT url, source, title, volume, trim_start, trim_end FROM profile_songs WHERE user_id = $1")
            .bind(user)
            .fetch_optional(&st.db)
            .await?;
    Ok(row.map(|(url, source, title, volume, start, end)| {
        let mut v = json!({ "url": url, "title": title, "volume": volume, "duration": end - start });
        if own {
            v["source"] = source.into();
            v["trim_start"] = start.into();
            v["trim_end"] = end.into();
        }
        v
    }))
}

fn clean_song_title(t: Option<&str>) -> ApiResult<String> {
    let t = t.unwrap_or_default().split_whitespace().collect::<Vec<_>>().join(" ");
    if t.chars().count() > 80 {
        return Err(bad("song titles can be at most 80 characters"));
    }
    Ok(t)
}

/// Multipart: `file` (audio, up to 15 MB) and `payload_json` {title, volume, trim_start, trim_end}; up to 30 s of it
/// is cut to MP3 (soundboard.rs).
async fn upload_song(State(st): State<AppState>, AuthUser(me): AuthUser, mut mp: Multipart) -> ApiResult<Json<serde_json::Value>> {
    let mut fields = SongFields::default();
    let mut file: Option<(String, Vec<u8>)> = None;
    while let Some(field) = mp.next_field().await.map_err(|e| bad(e.body_text()))? {
        match field.name() {
            Some("payload_json") => {
                let text = field.text().await.map_err(|e| bad(e.body_text()))?;
                fields = serde_json::from_str(&text).map_err(|_| bad("invalid payload_json"))?;
            }
            Some("file") => {
                let name = field.file_name().unwrap_or("song.mp3").to_string();
                let ext = name.rsplit('.').next().unwrap_or_default().to_ascii_lowercase();
                if !crate::soundboard::AUDIO_EXT.contains(&ext.as_str()) {
                    return Err(bad("songs must be mp3, ogg, wav, webm or m4a files"));
                }
                file = Some((name, uploads::read_field(field, MAX_SONG_SOURCE).await?));
            }
            _ => {}
        }
    }
    let (filename, bytes) = file.ok_or_else(|| bad("missing file"))?;
    let title = clean_song_title(fields.title.as_deref())?;
    uploads::reserve(&st, me, bytes.len()).await?;
    // One song per person: the previous one's files go.
    let dir = format!("profile-songs/{me}");
    let _ = tokio::fs::remove_dir_all(st.cfg.uploads_dir().join(&dir)).await;
    let source = uploads::save(&st, &dir, &filename, &bytes).await?;
    let path = crate::soundboard::upload_path(&st, &source).ok_or_else(|| bad("couldn't read that song"))?;
    let length = crate::soundboard::duration(&path).await.unwrap_or(MAX_SONG_SECONDS);
    let start = fields.trim_start.unwrap_or(0.0).max(0.0);
    let end = fields.trim_end.unwrap_or(start + MAX_SONG_SECONDS).min(length).max(start);
    let url = match crate::soundboard::cut_clip(&st, &source, start, end, MAX_SONG_SECONDS, SONG_TOO_LONG).await {
        Ok(url) => url,
        Err(e) => {
            let _ = tokio::fs::remove_dir_all(st.cfg.uploads_dir().join(&dir)).await;
            uploads::release(&st, me, bytes.len() as u64).await;
            return Err(e);
        }
    };
    sqlx::query(
        "INSERT INTO profile_songs (user_id, url, source, title, volume, trim_start, trim_end) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id) DO UPDATE SET url = EXCLUDED.url, source = EXCLUDED.source, title = EXCLUDED.title,
             volume = EXCLUDED.volume, trim_start = EXCLUDED.trim_start, trim_end = EXCLUDED.trim_end",
    )
    .bind(me)
    .bind(&url)
    .bind(&source)
    .bind(title)
    .bind(fields.volume.unwrap_or(1.0).clamp(0.05, 1.0))
    .bind(start as f32)
    .bind(end as f32)
    .execute(&st.db)
    .await?;
    tracing::info!(user = %me, "profile song set");
    Ok(Json(profile_song(&st, me, true).await?.unwrap_or_default()))
}

/// Title and volume, and a new trim (cut again from the original).
async fn update_song(State(st): State<AppState>, AuthUser(me): AuthUser, Json(body): Json<SongFields>) -> ApiResult<Json<serde_json::Value>> {
    let (url, source, start, end): (String, String, f32, f32) =
        sqlx::query_as("SELECT url, source, trim_start, trim_end FROM profile_songs WHERE user_id = $1")
            .bind(me)
            .fetch_optional(&st.db)
            .await?
            .ok_or(crate::error::ApiError::NotFound)?;
    let (mut new_url, mut start, mut end) = (url.clone(), start as f64, end as f64);
    if body.trim_start.is_some() || body.trim_end.is_some() {
        start = body.trim_start.unwrap_or(start).max(0.0);
        end = body.trim_end.unwrap_or(end).max(start);
        new_url = crate::soundboard::cut_clip(&st, &source, start, end, MAX_SONG_SECONDS, SONG_TOO_LONG).await?;
        if let Some(old) = crate::soundboard::upload_path(&st, &url) {
            let _ = tokio::fs::remove_file(old).await;
        }
    }
    let title = body.title.as_deref().map(|t| clean_song_title(Some(t))).transpose()?;
    sqlx::query(
        "UPDATE profile_songs SET url = $2, title = COALESCE($3, title), volume = COALESCE($4, volume), trim_start = $5, trim_end = $6
         WHERE user_id = $1",
    )
    .bind(me)
    .bind(&new_url)
    .bind(title)
    .bind(body.volume.map(|v| v.clamp(0.05, 1.0)))
    .bind(start as f32)
    .bind(end as f32)
    .execute(&st.db)
    .await?;
    Ok(Json(profile_song(&st, me, true).await?.unwrap_or_default()))
}

async fn remove_song(State(st): State<AppState>, AuthUser(me): AuthUser) -> ApiResult<()> {
    sqlx::query("DELETE FROM profile_songs WHERE user_id = $1").bind(me).execute(&st.db).await?;
    let _ = tokio::fs::remove_dir_all(st.cfg.uploads_dir().join(format!("profile-songs/{me}"))).await;
    Ok(())
}

#[derive(Deserialize)]
struct ProfileUpdate {
    username: Option<String>,
    display_name: Option<String>,
    bio: Option<String>,
    pronouns: Option<String>,
    status: Option<String>,
    accent_color: Option<i32>,
    links: Option<Vec<Link>>,
    /// 'MM-DD' or 'YYYY-MM-DD'; empty clears it.
    birthday: Option<String>,
    show_stats: Option<bool>,
    show_top_songs: Option<bool>,
}

async fn update_me(State(st): State<AppState>, AuthUser(me): AuthUser, Json(body): Json<ProfileUpdate>) -> ApiResult<Json<serde_json::Value>> {
    let before = User::get(&st.db, me).await?;
    if let Some(name) = body.username.as_deref().map(str::trim).filter(|n| *n != before.username) {
        crate::models::validate_username(name).map_err(bad)?;
        st.limits.check(format!("username:{me}"), 5.0, 1.0 / 600.0)?;
        if crate::auth::username_taken(&st.db, name, Some(me)).await? {
            return Err(bad("that username is taken"));
        }
        sqlx::query("UPDATE users SET username = $2, username_set = true, needs_username = false WHERE id = $1")
            .bind(me)
            .bind(name)
            .execute(&st.db)
            .await?;
        tracing::info!(user = %me, "changed username");
    } else if body.username.is_some() && before.needs_username {
        // Keeping the stand-in name is a choice too.
        sqlx::query("UPDATE users SET username_set = true, needs_username = false WHERE id = $1").bind(me).execute(&st.db).await?;
    }
    if let Some(s) = &body.status {
        if !matches!(s.as_str(), "online" | "idle" | "dnd" | "invisible") {
            return Err(bad("invalid status"));
        }
    }
    if body.display_name.as_ref().is_some_and(|n| n.trim().chars().count() > 32) {
        return Err(bad("display name must be at most 32 characters"));
    }
    if body.bio.as_ref().is_some_and(|b| b.chars().count() > 190) {
        return Err(bad("bio must be at most 190 characters"));
    }
    let pronouns = body.pronouns.map(|p| p.split_whitespace().collect::<Vec<_>>().join(" ")).unwrap_or(before.pronouns.clone());
    if pronouns.chars().count() > 40 {
        return Err(bad("pronouns must be at most 40 characters"));
    }
    // An empty display name clears it (falls back to the username).
    let display_name = match body.display_name {
        Some(n) if n.trim().is_empty() => None,
        Some(n) => Some(n.trim().to_string()),
        None => before.display_name.clone(),
    };
    let birthday = match body.birthday.as_deref() {
        Some(b) => clean_birthday(b)?,
        None => before.birthday.clone(),
    };
    let links = body.links.map(clean_links).transpose()?.map(sqlx::types::Json);
    sqlx::query(
        "UPDATE users SET display_name = $2, bio = $3, status = $4, accent_color = $5, pronouns = $6, birthday = $7,
             links = COALESCE($8, links), show_stats = COALESCE($9, show_stats), show_top_songs = COALESCE($10, show_top_songs)
         WHERE id = $1",
    )
    .bind(me)
    .bind(display_name)
    .bind(body.bio.unwrap_or(before.bio.clone()))
    .bind(body.status.unwrap_or(before.status.clone()))
    .bind(body.accent_color.or(before.accent_color))
    .bind(pronouns)
    .bind(birthday)
    .bind(links)
    .bind(body.show_stats)
    .bind(body.show_top_songs)
    .execute(&st.db)
    .await?;
    let after = User::get(&st.db, me).await?;
    notify_update(&st, &after).await?;
    if after.status != before.status {
        broadcast_presence(&st, &after).await?;
    }
    Ok(Json(serde_json::to_value(after.me()).unwrap()))
}

// ---------- favorite games (profile widget) ----------

const MAX_FAVORITE_GAMES: usize = 20;

/// A user's favorite games, in their order, with art from the game catalog and the time Linkord saw them play it.
pub async fn favorite_games(st: &AppState, user: Id) -> ApiResult<Vec<serde_json::Value>> {
    let rows: Vec<(Option<String>, String, Option<String>, Option<i64>)> = sqlx::query_as(
        "SELECT f.game_id, f.name, f.art, g.seconds FROM favorite_games f
         LEFT JOIN user_games g ON g.user_id = f.user_id AND lower(g.name) = lower(f.name)
         WHERE f.user_id = $1 ORDER BY f.position",
    )
    .bind(user)
    .fetch_all(&st.db)
    .await?;
    let catalog = st.games.catalog.read().unwrap().clone();
    Ok(rows
        .into_iter()
        .map(|(id, name, art, seconds)| {
            let mut v = id.as_deref().and_then(|id| catalog.as_ref()?.get(id)).map(|g| g.json()).unwrap_or_else(|| serde_json::json!({ "id": id }));
            if art.is_some() {
                v["cover"] = art.into();
            }
            v["name"] = name.into();
            v["seconds"] = seconds.unwrap_or(0).into();
            v
        })
        .collect())
}

#[derive(Deserialize)]
struct FavoriteGame {
    /// A game from the catalog (GET /games/search), or null with a name for one typed by hand.
    id: Option<String>,
    #[serde(default)]
    name: String,
}

#[derive(Deserialize)]
struct FavoriteGames {
    games: Vec<FavoriteGame>,
}

async fn set_favorite_games(State(st): State<AppState>, AuthUser(me): AuthUser, Json(body): Json<FavoriteGames>) -> ApiResult<Json<Vec<serde_json::Value>>> {
    if body.games.len() > MAX_FAVORITE_GAMES {
        return Err(bad("you can pick up to 20 favorite games"));
    }
    let catalog = st.games.catalog.read().unwrap().clone();
    let mut list: Vec<(Option<String>, String, Option<String>)> = Vec::with_capacity(body.games.len());
    // Games already saved keep what was checked then (no Wikipedia lookups for a reorder).
    let saved: Vec<(Option<String>, String, Option<String>)> =
        sqlx::query_as("SELECT game_id, name, art FROM favorite_games WHERE user_id = $1").bind(me).fetch_all(&st.db).await?;
    for g in body.games {
        let (id, name, art) = match g.id.filter(|i| !i.is_empty()) {
            // Found on Wikipedia: the server checks the page is a game and takes its name and box art from it.
            Some(id) if id.starts_with(crate::activities::WIKI_PREFIX) => match saved.iter().find(|s| s.0.as_deref() == Some(&id)) {
                Some(s) => s.clone(),
                None => {
                    let title = id[crate::activities::WIKI_PREFIX.len()..].to_string();
                    let page = if st.cfg.game_info { crate::activities::wiki_page(&st, &title).await } else { None };
                    let page = page.ok_or_else(|| bad("unknown game"))?;
                    let v = crate::activities::wiki_game_json(&title, &page);
                    let name = v["name"].as_str().unwrap_or(&title).to_string();
                    (Some(id), name, v["cover"].as_str().map(str::to_string))
                }
            },
            Some(id) => match catalog.as_ref().and_then(|c| c.get(&id)) {
                Some(known) => (Some(id), known.name.clone(), None),
                // The catalog isn't loaded yet (right after a first start): keep what the client sent.
                None if catalog.is_none() && !g.name.trim().is_empty() => (Some(id), g.name.trim().to_string(), None),
                None => return Err(bad("unknown game")),
            },
            None => (None, g.name.split_whitespace().collect::<Vec<_>>().join(" "), None),
        };
        if name.is_empty() || name.chars().count() > 128 {
            return Err(bad("Game name must be 1-128 characters"));
        }
        if list.iter().any(|(i, n, _)| (id.is_some() && *i == id) || n.eq_ignore_ascii_case(&name)) {
            continue;
        }
        list.push((id, name, art));
    }
    let mut tx = st.db.begin().await?;
    sqlx::query("DELETE FROM favorite_games WHERE user_id = $1").bind(me).execute(&mut *tx).await?;
    for (pos, (id, name, art)) in list.iter().enumerate() {
        sqlx::query("INSERT INTO favorite_games (user_id, position, game_id, name, art) VALUES ($1, $2, $3, $4, $5)")
            .bind(me)
            .bind(pos as i16)
            .bind(id)
            .bind(name)
            .bind(art)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(Json(favorite_games(&st, me).await?))
}

pub async fn notify_update(st: &AppState, user: &User) -> ApiResult<()> {
    let audience = related_users(&st.db, user.id).await?;
    st.hub.send(&audience, "USER_UPDATE", user);
    Ok(())
}

/// Avatars kept per user. The client sends them already cropped and compressed (512 px WebP), so these are small.
/// Recent pictures kept (owner: the last 5), the one in use included.
const AVATAR_HISTORY: i64 = 5;
const MAX_AVATAR: usize = 2 * 1024 * 1024;
const MAX_BANNER: usize = 4 * 1024 * 1024;
const MAX_NAMEPLATE: usize = 1024 * 1024;
/// Animated (GIF or WebM video) nameplates are uploaded as they are, without the client's cropping and compression.
const MAX_ANIMATED_NAMEPLATE: usize = 3 * 1024 * 1024;
/// GIF pictures and banners: a canvas would keep only the first frame, so the client sends the original GIF and
/// where to crop it, and the server crops and resizes it here (ffmpeg, kept animated as WebP).
const MAX_GIF_SOURCE: usize = 15 * 1024 * 1024;
const MAX_ANIMATED_AVATAR: usize = 4 * 1024 * 1024;
const MAX_ANIMATED_BANNER: usize = 8 * 1024 * 1024;

/// Where to crop a GIF, in source pixels after turning it `rotate` degrees clockwise (what the editor framed).
#[derive(Deserialize, Default)]
struct Crop {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    #[serde(default)]
    rotate: i32,
}

async fn upload_image(State(st): State<AppState>, AuthUser(me): AuthUser, mp: Multipart, which: &'static str) -> ApiResult<Json<serde_json::Value>> {
    let (name, bytes) = read_image(&st, mp, which).await?;
    uploads::reserve(&st, me, bytes.len()).await?;
    let url = uploads::save(&st, &format!("{which}s/{me}"), &name, &bytes).await?;
    sqlx::query(&format!("UPDATE users SET {which} = $2 WHERE id = $1")).bind(me).bind(&url).execute(&st.db).await?;
    if which == "avatar" {
        sqlx::query("INSERT INTO avatar_history (user_id, url, size) VALUES ($1, $2, $3)")
            .bind(me)
            .bind(&url)
            .bind(bytes.len() as i64)
            .execute(&st.db)
            .await?;
        prune_avatars(&st, me).await?;
    }
    let after = User::get(&st.db, me).await?;
    notify_update(&st, &after).await?;
    Ok(Json(serde_json::to_value(after.me()).unwrap()))
}

/// Reads an uploaded picture, banner or nameplate (`which`) and checks it: the file name to keep and its bytes (GIF
/// pictures and banners already cropped into animated WebP). Server profiles (guilds.rs) use it too.
pub async fn read_image(st: &AppState, mut mp: Multipart, which: &'static str) -> ApiResult<(String, Vec<u8>)> {
    // A "crop" field (GIF pictures and banners) may come before the file.
    let mut crop: Option<Crop> = None;
    let field = loop {
        let field = mp.next_field().await.map_err(|e| bad(e.body_text()))?.ok_or_else(|| bad("missing file"))?;
        if field.name() == Some("crop") {
            let text = field.text().await.map_err(|e| bad(e.body_text()))?;
            crop = Some(serde_json::from_str(&text).map_err(|_| bad("invalid crop"))?);
            continue;
        }
        break field;
    };
    let ct = field.content_type().unwrap_or_default().to_string();
    let video = which == "nameplate" && ct == "video/webm";
    let gif = which != "nameplate" && ct == "image/gif";
    if !uploads::is_image(&ct) && !video {
        return Err(bad("must be a png, jpeg, gif or webp image"));
    }
    // Clients show a nameplate as a video when its URL ends in .webm, so that name is ours to give.
    let name = if video {
        "nameplate.webm".to_string()
    } else if gif {
        format!("{which}.webp")
    } else {
        field.file_name().unwrap_or("image").to_string()
    };
    let limit = match which {
        _ if gif => MAX_GIF_SOURCE,
        "avatar" => MAX_AVATAR,
        "nameplate" if ct == "image/gif" || video => MAX_ANIMATED_NAMEPLATE,
        "nameplate" => MAX_NAMEPLATE,
        _ => MAX_BANNER,
    };
    let mut bytes = uploads::read_field(field, limit).await?;
    // WebM (Matroska) files start with the EBML magic number.
    if video && !bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
        return Err(bad("that file isn't a WebM video"));
    }
    if gif {
        bytes = crop_gif(st, &bytes, crop, which == "avatar").await?;
    }
    Ok((name, bytes))
}

/// Crops and resizes an animated GIF (avatar 1:1 up to 320 px, banner 3:1 up to 960 px) into an animated WebP,
/// smaller and smaller until it fits.
async fn crop_gif(st: &AppState, gif: &[u8], crop: Option<Crop>, avatar: bool) -> ApiResult<Vec<u8>> {
    if !gif.starts_with(b"GIF8") {
        return Err(bad("couldn't read that GIF"));
    }
    let (aspect, max_w, limit) = if avatar { (1.0, 320.0, MAX_ANIMATED_AVATAR) } else { (3.0, 960.0, MAX_ANIMATED_BANNER) };
    let turn = match crop.as_ref().map(|c| c.rotate.rem_euclid(360)) {
        Some(90) => "transpose=1,",
        Some(180) => "hflip,vflip,",
        Some(270) => "transpose=2,",
        _ => "",
    };
    // The editor's frame, kept inside the picture (commas in expressions are escaped for the filter graph);
    // without one, the largest centred frame.
    let frame = match crop.filter(|c| [c.x, c.y, c.w, c.h].iter().all(|v| v.is_finite()) && c.w >= 1.0 && c.h >= 1.0) {
        Some(c) => format!(
            "crop=w=min({w}\\,iw):h=min({h}\\,ih):x=min({x}\\,iw-ow):y=min({y}\\,ih-oh)",
            w = c.w.round(),
            h = c.h.round(),
            x = c.x.max(0.0).round(),
            y = c.y.max(0.0).round()
        ),
        None => format!("crop=w=min(iw\\,ih*{aspect}):h=min(ih\\,iw/{aspect})"),
    };
    let dir = st.cfg.data_dir.join("tmp");
    tokio::fs::create_dir_all(&dir).await?;
    let tag = crate::auth::random_token(8);
    let (src, out) = (dir.join(format!("{tag}.gif")), dir.join(format!("{tag}.webp")));
    tokio::fs::write(&src, gif).await?;
    let mut result = Err(bad("couldn't read that GIF"));
    // Full size first; then smaller, lower quality and fewer frames per second.
    for (scale, quality, fps) in [(1.0, 75, ""), (0.75, 60, ",fps=20"), (0.5, 50, ",fps=15")] {
        // Never larger than the framed part.
        let filter = format!("{turn}{frame},scale=w=min({max_w}\\,iw)*{scale}:h=ow/{aspect}:flags=lanczos{fps}");
        let run = tokio::process::Command::new("ffmpeg")
            .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
            .arg(&src)
            .args(["-vf", &filter, "-an", "-c:v", "libwebp_anim", "-loop", "0", "-quality", &quality.to_string(), "-compression_level", "4"])
            .arg(&out)
            .kill_on_drop(true)
            .output();
        match tokio::time::timeout(std::time::Duration::from_secs(60), run).await {
            Ok(Ok(o)) if o.status.success() => {}
            Ok(Ok(o)) => {
                tracing::warn!(stderr = %String::from_utf8_lossy(&o.stderr), "gif crop failed");
                break;
            }
            _ => {
                result = Err(bad("that GIF took too long to process; try a shorter one"));
                break;
            }
        }
        let bytes = tokio::fs::read(&out).await?;
        if bytes.len() <= limit {
            result = Ok(bytes);
            break;
        }
        result = Err(bad("that GIF is too big even after shrinking it; try a shorter one"));
    }
    let _ = tokio::fs::remove_file(&src).await;
    let _ = tokio::fs::remove_file(&out).await;
    result
}

/// Drops the oldest history entries beyond the cap (never the avatar in use) and frees their files and quota.
async fn prune_avatars(st: &AppState, me: Id) -> ApiResult<()> {
    let old: Vec<(i64, String, i64)> = sqlx::query_as(
        "DELETE FROM avatar_history WHERE id IN (
             SELECT h.id FROM avatar_history h JOIN users u ON u.id = h.user_id
             WHERE h.user_id = $1 AND h.url IS DISTINCT FROM u.avatar
             ORDER BY h.created_at DESC OFFSET $2)
         RETURNING id, url, size",
    )
    .bind(me)
    .bind(AVATAR_HISTORY - 1)
    .fetch_all(&st.db)
    .await?;
    for (_, url, size) in old {
        remove_avatar_file(st, me, &url, size).await;
    }
    Ok(())
}

/// Deletes an old avatar's file and gives its bytes back to the quota.
async fn remove_avatar_file(st: &AppState, me: Id, url: &str, size: i64) {
    if let Some(dir) = url.strip_prefix("/uploads/").map(|r| st.cfg.uploads_dir().join(r)).and_then(|p| p.parent().map(|d| d.to_path_buf())) {
        // Only ever remove the random per-upload directory under this user's avatars.
        if dir.starts_with(st.cfg.uploads_dir().join("avatars").join(me.to_string())) {
            let _ = tokio::fs::remove_dir_all(dir).await;
        }
    }
    uploads::release(st, me, size as u64).await;
}

/// Removes a picture from your recent pictures (not the one in use).
async fn forget_avatar(State(st): State<AppState>, AuthUser(me): AuthUser, Json(body): Json<RestoreAvatar>) -> ApiResult<()> {
    let gone: Option<i64> = sqlx::query_scalar(
        "DELETE FROM avatar_history h USING users u
         WHERE h.user_id = $1 AND h.url = $2 AND u.id = h.user_id AND h.url IS DISTINCT FROM u.avatar
         RETURNING h.size",
    )
    .bind(me)
    .bind(&body.url)
    .fetch_optional(&st.db)
    .await?;
    let size = gone.ok_or_else(|| bad("that picture can't be removed"))?;
    remove_avatar_file(&st, me, &body.url, size).await;
    Ok(())
}

async fn avatar_history(State(st): State<AppState>, AuthUser(me): AuthUser) -> ApiResult<Json<Vec<String>>> {
    let urls = sqlx::query_scalar("SELECT url FROM avatar_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2")
        .bind(me)
        .bind(AVATAR_HISTORY)
        .fetch_all(&st.db)
        .await?;
    Ok(Json(urls))
}

#[derive(Deserialize)]
struct RestoreAvatar {
    url: String,
}

/// Switches back to one of the avatars from the history.
async fn restore_avatar(State(st): State<AppState>, AuthUser(me): AuthUser, Json(body): Json<RestoreAvatar>) -> ApiResult<Json<serde_json::Value>> {
    let found = sqlx::query("UPDATE avatar_history SET created_at = now() WHERE user_id = $1 AND url = $2")
        .bind(me)
        .bind(&body.url)
        .execute(&st.db)
        .await?
        .rows_affected();
    if found == 0 {
        return Err(bad("that picture is no longer available"));
    }
    sqlx::query("UPDATE users SET avatar = $2 WHERE id = $1").bind(me).bind(&body.url).execute(&st.db).await?;
    let after = User::get(&st.db, me).await?;
    notify_update(&st, &after).await?;
    Ok(Json(serde_json::to_value(after.me()).unwrap()))
}

async fn clear_image(State(st): State<AppState>, AuthUser(me): AuthUser, which: &'static str) -> ApiResult<Json<serde_json::Value>> {
    sqlx::query(&format!("UPDATE users SET {which} = NULL WHERE id = $1")).bind(me).execute(&st.db).await?;
    let after = User::get(&st.db, me).await?;
    notify_update(&st, &after).await?;
    Ok(Json(serde_json::to_value(after.me()).unwrap()))
}

/// Linked accounts. Discord is the only login, so there is exactly one (none for dev logins).
async fn connections(State(st): State<AppState>, AuthUser(me): AuthUser) -> ApiResult<Json<serde_json::Value>> {
    let (discord_id, username, linked_at): (String, Option<String>, DateTime<Utc>) =
        sqlx::query_as("SELECT discord_id, discord_username, created_at FROM users WHERE id = $1").bind(me).fetch_one(&st.db).await?;
    let mut list = Vec::new();
    if !discord_id.starts_with("dev:") {
        list.push(json!({ "type": "discord", "id": discord_id, "username": username, "linked_at": linked_at }));
    }
    list.extend(crate::spotify::list(&st, me).await?);
    Ok(Json(json!(list)))
}

#[derive(Deserialize)]
struct StatsQuery {
    /// The viewer's UTC offset in minutes, so the activity chart uses their hours.
    #[serde(default)]
    tz: i32,
}

/// Everything measured about you, for Settings -> Stats. Voice time is counted since 0.1.14, the rest of what's
/// counted live (stats.rs) since 0.2.15; deleted messages don't count. The old top-level numbers stay for older
/// clients.
async fn stats(
    State(st): State<AppState>,
    AuthUser(me): AuthUser,
    axum::extract::Query(q): axum::extract::Query<StatsQuery>,
) -> ApiResult<Json<serde_json::Value>> {
    let tz = q.tz.clamp(-14 * 60, 14 * 60);
    let db = &st.db;
    let (created_at, voice_seconds, upload_bytes): (DateTime<Utc>, i64, i64) =
        sqlx::query_as("SELECT created_at, voice_seconds, upload_bytes FROM users WHERE id = $1").bind(me).fetch_one(db).await?;
    let count = |sql: &'static str| sqlx::query_scalar::<_, i64>(sql).bind(me).fetch_one(db);
    let servers = count("SELECT COUNT(*) FROM members WHERE user_id = $1").await?;
    let servers_owned = count("SELECT COUNT(*) FROM guilds WHERE owner_id = $1").await?;
    let friends: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM relationships WHERE user_id = $1 AND kind = $2")
        .bind(me)
        .bind(relationships::FRIEND)
        .fetch_one(db)
        .await?;
    let avatars = count("SELECT COUNT(*) FROM avatar_history WHERE user_id = $1").await?;
    let invites_created = count("SELECT COUNT(*) FROM invites WHERE creator_id = $1").await?;
    let invite_uses = count("SELECT COALESCE(SUM(uses), 0)::BIGINT FROM invites WHERE creator_id = $1").await?;
    let emojis_uploaded = count("SELECT COUNT(*) FROM emojis WHERE creator_id = $1").await?;
    let sounds_uploaded = count("SELECT COUNT(*) FROM soundboard_sounds WHERE creator_id = $1").await?;
    let reactions = count("SELECT COUNT(*) FROM reactions WHERE user_id = $1").await?;
    let reactions_received =
        count("SELECT COUNT(*) FROM reactions r JOIN messages m ON m.id = r.message_id WHERE m.author_id = $1 AND r.user_id <> $1").await?;
    let mentions_received = count("SELECT COUNT(*) FROM messages WHERE content LIKE '%<@' || $1::TEXT || '>%'").await?;
    let pins = count("SELECT COUNT(*) FROM messages WHERE author_id = $1 AND type = 6").await?;
    let threads: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM channels WHERE owner_id = $1 AND kind = $2")
        .bind(me)
        .bind(kind::THREAD)
        .fetch_one(db)
        .await?;

    // Your own messages (not system ones).
    let m: (i64, i64, i64, i64, i64, i64, i64, i64, i64, i64, Option<DateTime<Utc>>, i64) = sqlx::query_as(
        r"SELECT COUNT(*),
                COALESCE(SUM(jsonb_array_length(attachments)), 0)::BIGINT,
                COALESCE(SUM((SELECT COUNT(*) FROM jsonb_array_elements(attachments) a WHERE a->>'content_type' LIKE 'image/%')), 0)::BIGINT,
                COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(attachments) a WHERE a ? 'waveform')),
                COUNT(*) FILTER (WHERE reply_to IS NOT NULL),
                COUNT(*) FILTER (WHERE forwarded IS NOT NULL),
                COUNT(*) FILTER (WHERE edited_at IS NOT NULL),
                COUNT(*) FILTER (WHERE content ~ 'https?://'),
                COALESCE(SUM(array_length(regexp_split_to_array(btrim(content), '\s+'), 1)) FILTER (WHERE btrim(content) <> ''), 0)::BIGINT,
                COALESCE(SUM(char_length(content)), 0)::BIGINT,
                MIN(created_at),
                COUNT(DISTINCT (created_at + make_interval(mins => $2))::date)
           FROM messages WHERE author_id = $1 AND type = 0",
    )
    .bind(me)
    .bind(tz)
    .fetch_one(db)
    .await?;
    let top_emoji: Vec<(String, i64)> =
        sqlx::query_as("SELECT emoji, COUNT(*) FROM reactions WHERE user_id = $1 GROUP BY emoji ORDER BY 2 DESC, 1 LIMIT 6")
            .bind(me)
            .fetch_all(db)
            .await?;
    let top_channels: Vec<(Id, i64)> = sqlx::query_as(
        "SELECT channel_id, COUNT(*) FROM messages WHERE author_id = $1 AND type = 0 GROUP BY 1 ORDER BY 2 DESC LIMIT 5",
    )
    .bind(me)
    .fetch_all(db)
    .await?;
    // When you write: [weekday 0 = Sunday, hour, messages], in your time.
    let activity: Vec<(i32, i32, i64)> = sqlx::query_as(
        "SELECT EXTRACT(DOW FROM t)::INT, EXTRACT(HOUR FROM t)::INT, COUNT(*)
           FROM (SELECT created_at + make_interval(mins => $2) AS t FROM messages WHERE author_id = $1 AND type = 0) m
          GROUP BY 1, 2",
    )
    .bind(me)
    .bind(tz)
    .fetch_all(db)
    .await?;
    let counters: Vec<(String, i64)> = sqlx::query_as("SELECT key, value FROM user_stats WHERE user_id = $1").bind(me).fetch_all(db).await?;
    let games: Vec<(String, Option<String>, i64, DateTime<Utc>)> = sqlx::query_as(
        "SELECT name, icon, seconds, last_played FROM user_games WHERE user_id = $1 ORDER BY seconds DESC LIMIT 8",
    )
    .bind(me)
    .fetch_all(db)
    .await?;

    Ok(Json(json!({
        "created_at": created_at,
        "voice_seconds": voice_seconds,
        "messages": m.0,
        "attachments": m.1,
        "reactions": reactions,
        "servers": servers,
        "friends": friends,
        "upload_bytes": upload_bytes,
        "upload_quota": st.cfg.upload_quota,
        "servers_owned": servers_owned,
        "avatars": avatars,
        "invites_created": invites_created,
        "invite_uses": invite_uses,
        "emojis_uploaded": emojis_uploaded,
        "sounds_uploaded": sounds_uploaded,
        "reactions_received": reactions_received,
        "mentions_received": mentions_received,
        "pins": pins,
        "threads": threads,
        "message_stats": {
            "images": m.2,
            "voice_notes": m.3,
            "replies": m.4,
            "forwards": m.5,
            "edited": m.6,
            "links": m.7,
            "words": m.8,
            "characters": m.9,
            "first_at": m.10,
            "active_days": m.11,
        },
        "top_emoji": top_emoji.into_iter().map(|(emoji, n)| json!({ "emoji": emoji, "count": n })).collect::<Vec<_>>(),
        "top_channels": top_channels.into_iter().map(|(id, n)| json!({ "channel_id": id, "count": n })).collect::<Vec<_>>(),
        "activity": activity.into_iter().map(|(d, h, n)| json!([d, h, n])).collect::<Vec<_>>(),
        "counters": counters.into_iter().collect::<std::collections::HashMap<_, _>>(),
        "games": games
            .into_iter()
            .map(|(name, icon, seconds, last)| json!({ "name": name, "icon": icon, "seconds": seconds, "last_played": last }))
            .collect::<Vec<_>>(),
    })))
}

#[derive(Deserialize)]
struct DeleteAccount {
    /// The user's username, typed to confirm.
    confirm: String,
}

/// Deletes the account: leaves every server, group and friendship, wipes the profile and unlinks
/// Discord. Messages stay (shown as "Deleted User"), like Discord does it.
async fn delete_me(State(st): State<AppState>, AuthUser(me): AuthUser, Json(body): Json<DeleteAccount>) -> ApiResult<()> {
    let user = User::get(&st.db, me).await?;
    if body.confirm.trim() != user.username {
        return Err(bad("type your username to confirm"));
    }
    let owned: Vec<String> = sqlx::query_scalar("SELECT name FROM guilds WHERE owner_id = $1 ORDER BY name").bind(me).fetch_all(&st.db).await?;
    if !owned.is_empty() {
        return Err(bad(format!("delete the servers you own first: {}", owned.join(", "))));
    }
    voice::leave(&st, me).await;
    let audience = related_users(&st.db, me).await?;

    let guild_ids: Vec<Id> = sqlx::query_scalar("SELECT guild_id FROM members WHERE user_id = $1").bind(me).fetch_all(&st.db).await?;
    for g in guild_ids {
        guilds::remove_member(&st, g, me).await?;
    }
    let groups: Vec<(Id, Option<Id>)> = sqlx::query_as(
        "SELECT c.id, c.owner_id FROM channels c JOIN dm_recipients r ON r.channel_id = c.id WHERE r.user_id = $1 AND c.kind = $2",
    )
    .bind(me)
    .bind(kind::GROUP_DM)
    .fetch_all(&st.db)
    .await?;
    for (id, owner) in groups {
        dms::leave_group(&st, id, owner, me).await?;
    }
    let others: Vec<Id> = sqlx::query_scalar("DELETE FROM relationships WHERE user_id = $1 OR target_id = $1 RETURNING CASE WHEN user_id = $1 THEN target_id ELSE user_id END")
        .bind(me)
        .fetch_all(&st.db)
        .await?;
    for other in others {
        relationships::notify(&st, other, me).await?;
    }

    let short = &me.to_string()[me.to_string().len().saturating_sub(6)..];
    sqlx::query(
        "UPDATE users SET discord_id = 'deleted:' || id, discord_username = NULL, username = $2, display_name = 'Deleted User',
         avatar = NULL, banner = NULL, nameplate = NULL, accent_color = NULL, bio = '', pronouns = '', birthday = NULL, links = '[]',
         status = 'invisible', deleted_at = now() WHERE id = $1",
    )
    .bind(me)
    .bind(format!("deleted_user_{short}"))
    .execute(&st.db)
    .await?;
    sqlx::query("DELETE FROM user_notes WHERE user_id = $1 OR target_id = $1").bind(me).execute(&st.db).await?;
    for table in ["sessions", "read_states", "user_settings", "custom_statuses", "favorite_games", "kass_plays", "profile_songs"] {
        sqlx::query(&format!("DELETE FROM {table} WHERE user_id = $1")).bind(me).execute(&st.db).await?;
    }
    for dir in ["avatars", "banners", "nameplates", "profile-songs"] {
        let _ = tokio::fs::remove_dir_all(st.cfg.uploads_dir().join(dir).join(me.to_string())).await;
    }
    sqlx::query("DELETE FROM avatar_history WHERE user_id = $1").bind(me).execute(&st.db).await?;
    let after = User::get(&st.db, me).await?;
    st.hub.send(&audience, "USER_UPDATE", &after);
    st.hub.send(&audience, "PRESENCE_UPDATE", &json!({ "user_id": me, "status": "offline" }));
    tracing::info!("account {me} deleted");
    Ok(())
}

const NAMEPLATE_EXT: [&str; 7] = ["png", "jpg", "jpeg", "webp", "gif", "svg", "webm"];

/// The default nameplates: image (and WebM video) files in the server's nameplates folder, as public paths.
async fn default_nameplates(State(st): State<AppState>, AuthUser(_): AuthUser) -> ApiResult<Json<Vec<String>>> {
    let mut names = Vec::new();
    if let Ok(mut dir) = tokio::fs::read_dir(&st.cfg.nameplates_dir).await {
        while let Ok(Some(e)) = dir.next_entry().await {
            let name = e.file_name().to_string_lossy().into_owned();
            let ext = name.rsplit('.').next().unwrap_or_default().to_ascii_lowercase();
            if !name.starts_with('.') && NAMEPLATE_EXT.contains(&ext.as_str()) && e.file_type().await.is_ok_and(|t| t.is_file()) {
                names.push(name);
            }
        }
    }
    names.sort();
    Ok(Json(names.into_iter().map(|n| format!("/nameplates/{}", urlencoding::encode(&n))).collect()))
}

#[derive(Deserialize)]
struct ChooseNameplate {
    url: String,
}

/// Picks one of the default nameplates (a file that exists in the nameplates folder).
async fn choose_nameplate(State(st): State<AppState>, AuthUser(me): AuthUser, Json(body): Json<ChooseNameplate>) -> ApiResult<Json<serde_json::Value>> {
    let listed = default_nameplates(State(st.clone()), AuthUser(me)).await?.0;
    if !listed.contains(&body.url) {
        return Err(bad("unknown nameplate"));
    }
    sqlx::query("UPDATE users SET nameplate = $2 WHERE id = $1").bind(me).bind(&body.url).execute(&st.db).await?;
    let after = User::get(&st.db, me).await?;
    notify_update(&st, &after).await?;
    Ok(Json(serde_json::to_value(after.me()).unwrap()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn birthdays() {
        assert_eq!(clean_birthday("03-14").unwrap().as_deref(), Some("03-14"));
        assert_eq!(clean_birthday(" 1999-03-14 ").unwrap().as_deref(), Some("1999-03-14"));
        assert_eq!(clean_birthday("02-29").unwrap().as_deref(), Some("02-29"), "leap day without a year");
        assert_eq!(clean_birthday("").unwrap(), None);
        for bad in ["2001-02-29", "13-01", "04-31", "1850-01-01", "3000-01-01", "3-14", "1999/03/14", "ab-cd"] {
            assert!(clean_birthday(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn links() {
        let l = |url: &str| Link { label: String::new(), url: url.into() };
        let out = clean_links(vec![l("github.com/someone"), Link { label: "  My   blog ".into(), url: "http://blog.example.org/x".into() }]).unwrap();
        assert_eq!(out[0].url, "https://github.com/someone");
        assert_eq!(out[1].label, "My blog");
        for bad in ["javascript:alert(1)", "ftp://example.com", "https://localhost", "not a link"] {
            assert!(clean_links(vec![l(bad)]).is_err(), "{bad}");
        }
        assert!(clean_links((0..6).map(|i| l(&format!("example{i}.com"))).collect()).is_err());
    }
}
