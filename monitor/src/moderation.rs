//! Who and what is on the server: every server and who created it, every account, every uploaded file. All of this is
//! read over the monitor's read-only connection and files are served straight from disk. Removing a file is the one
//! change here, and it goes through the app (internal.rs in the server), so connected apps hear about it.
//!
//! Message text is deliberately not part of any of this.

use std::path::{Component, Path as FsPath, PathBuf};

use axum::body::Body;
use axum::extract::{Path, Query, Request, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use tower::ServiceExt;
use tower_http::services::ServeFile;

use crate::state::AppState;

type ApiResult = Result<Json<Value>, (StatusCode, Json<Value>)>;

fn db_error(e: sqlx::Error) -> (StatusCode, Json<Value>) {
    tracing::warn!("moderation query failed: {e}");
    (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "error": "The database isn't answering." })))
}

/// Snowflakes hold their creation time: the id of the first message after a moment, for fast range queries.
fn snowflake_at(unix_seconds: i64) -> i64 {
    const EPOCH_MS: i64 = 1_767_225_600_000;
    (unix_seconds * 1000 - EPOCH_MS).max(0) << 22
}

pub async fn summary(State(st): State<AppState>) -> ApiResult {
    let now = chrono::Utc::now().timestamp();
    let r = sqlx::query(
        "SELECT
            (SELECT count(*) FROM guilds)::bigint AS servers,
            (SELECT count(*) FROM users WHERE deleted_at IS NULL AND NOT bot)::bigint AS accounts,
            (SELECT count(*) FROM users WHERE deleted_at IS NOT NULL)::bigint AS deleted_accounts,
            (SELECT count(*) FROM users WHERE bot)::bigint AS bots,
            (SELECT count(*) FROM users WHERE created_at > now() - interval '7 days' AND NOT bot)::bigint AS new_accounts_7d,
            (SELECT count(*) FROM channels WHERE guild_id IS NOT NULL)::bigint AS channels,
            (SELECT count(*) FROM channels WHERE guild_id IS NULL)::bigint AS direct_channels,
            (SELECT count(*) FROM messages)::bigint AS messages,
            (SELECT count(*) FROM messages WHERE id >= $1)::bigint AS messages_24h,
            (SELECT count(*) FROM messages WHERE id >= $2)::bigint AS messages_7d,
            (SELECT count(*) FROM invites WHERE expires_at IS NULL OR expires_at > now())::bigint AS invites,
            (SELECT count(*) FROM emojis)::bigint AS emojis,
            (SELECT count(*) FROM soundboard_sounds)::bigint AS sounds,
            (SELECT COALESCE(SUM(upload_bytes), 0)::bigint FROM users) AS quota_used",
    )
    .bind(snowflake_at(now - 86400))
    .bind(snowflake_at(now - 7 * 86400))
    .fetch_one(&st.db)
    .await
    .map_err(db_error)?;
    let per_day: Vec<(String, i64)> = sqlx::query_as(
        "SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD'), count(*)::bigint FROM messages
         WHERE id >= $1 GROUP BY 1 ORDER BY 1",
    )
    .bind(snowflake_at(now - 30 * 86400))
    .fetch_all(&st.db)
    .await
    .map_err(db_error)?;
    let get = |k: &str| r.get::<i64, _>(k);
    Ok(Json(json!({
        "servers": get("servers"),
        "accounts": get("accounts"),
        "deleted_accounts": get("deleted_accounts"),
        "bots": get("bots"),
        "new_accounts_7d": get("new_accounts_7d"),
        "channels": get("channels"),
        "direct_channels": get("direct_channels"),
        "messages": get("messages"),
        "messages_24h": get("messages_24h"),
        "messages_7d": get("messages_7d"),
        "invites": get("invites"),
        "emojis": get("emojis"),
        "sounds": get("sounds"),
        "quota_used": get("quota_used"),
        "messages_per_day": per_day.iter().map(|(d, n)| json!({ "day": d, "count": n })).collect::<Vec<_>>(),
    })))
}

#[derive(Deserialize)]
pub struct Search {
    q: Option<String>,
    /// Accounts only: active | suspended | deleted | bots (everyone when missing).
    status: Option<String>,
}

/// Which accounts a status filter keeps, as SQL on `u`.
fn status_filter(status: Option<&str>) -> &'static str {
    match status {
        Some("active") => "NOT u.bot AND u.deleted_at IS NULL AND u.suspended_at IS NULL",
        Some("suspended") => "u.suspended_at IS NOT NULL",
        Some("deleted") => "u.deleted_at IS NOT NULL",
        Some("bots") => "u.bot",
        _ => "true",
    }
}

pub async fn servers(State(st): State<AppState>, Query(s): Query<Search>) -> ApiResult {
    let q = s.q.unwrap_or_default();
    let rows = sqlx::query(
        "SELECT g.id::text AS id, g.name, g.icon, g.created_at, g.owner_id::text AS owner_id,
            o.username AS owner, o.display_name AS owner_name, o.avatar AS owner_avatar, o.deleted_at IS NOT NULL AS owner_deleted,
            (SELECT count(*) FROM members m WHERE m.guild_id = g.id)::bigint AS members,
            (SELECT count(*) FROM channels c WHERE c.guild_id = g.id AND c.kind = 2)::bigint AS voice_channels,
            (SELECT count(*) FROM channels c WHERE c.guild_id = g.id AND c.kind = 0)::bigint AS text_channels,
            (SELECT count(*) FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.guild_id = g.id)::bigint AS messages,
            (SELECT COALESCE(SUM(jsonb_array_length(m.attachments)), 0)::bigint FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.guild_id = g.id AND m.attachments <> '[]'::jsonb) AS media,
            (SELECT COALESCE(SUM((a->>'size')::bigint), 0)::bigint FROM messages m JOIN channels c ON c.id = m.channel_id CROSS JOIN LATERAL jsonb_array_elements(m.attachments) a WHERE c.guild_id = g.id AND m.attachments <> '[]'::jsonb) AS media_bytes,
            (SELECT MAX(m.created_at) FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.guild_id = g.id) AS last_message,
            (SELECT count(*) FROM emojis e WHERE e.guild_id = g.id)::bigint AS emojis,
            (SELECT count(*) FROM soundboard_sounds e WHERE e.guild_id = g.id)::bigint AS sounds,
            (SELECT count(*) FROM invites i WHERE i.guild_id = g.id AND (i.expires_at IS NULL OR i.expires_at > now()))::bigint AS invites
         FROM guilds g JOIN users o ON o.id = g.owner_id
         WHERE $1 = '' OR g.name ILIKE '%' || $1 || '%' OR o.username ILIKE '%' || $1 || '%' OR o.display_name ILIKE '%' || $1 || '%'
         ORDER BY g.created_at DESC LIMIT 500",
    )
    .bind(&q)
    .fetch_all(&st.db)
    .await
    .map_err(db_error)?;
    let list: Vec<Value> = rows
        .iter()
        .map(|r| {
            let n = |k: &str| r.get::<i64, _>(k);
            json!({
                "id": r.get::<String, _>("id"),
                "name": r.get::<String, _>("name"),
                "icon": r.get::<Option<String>, _>("icon"),
                "created_at": r.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
                "owner": {
                    "id": r.get::<String, _>("owner_id"),
                    "username": r.get::<String, _>("owner"),
                    "name": r.get::<Option<String>, _>("owner_name"),
                    "avatar": r.get::<Option<String>, _>("owner_avatar"),
                    "deleted": r.get::<bool, _>("owner_deleted"),
                },
                "members": n("members"),
                "text_channels": n("text_channels"),
                "voice_channels": n("voice_channels"),
                "messages": n("messages"),
                "media": n("media"),
                "media_bytes": n("media_bytes"),
                "last_message": r.get::<Option<chrono::DateTime<chrono::Utc>>, _>("last_message"),
                "emojis": n("emojis"),
                "sounds": n("sounds"),
                "invites": n("invites"),
            })
        })
        .collect();
    Ok(Json(json!({ "servers": list })))
}

/// One server in full: its people, channels and invites.
pub async fn server(State(st): State<AppState>, Path(id): Path<i64>) -> ApiResult {
    let Some(head) = sqlx::query(
        "SELECT g.name, g.icon, g.created_at, o.id::text AS owner_id, o.username AS owner_username, o.display_name AS owner_name,
            o.avatar AS owner_avatar, o.deleted_at IS NOT NULL AS owner_deleted,
            (SELECT count(*) FROM messages x JOIN channels c ON c.id = x.channel_id WHERE c.guild_id = g.id)::bigint AS messages,
            (SELECT COALESCE(SUM((a->>'size')::bigint), 0)::bigint FROM messages x JOIN channels c ON c.id = x.channel_id
               CROSS JOIN LATERAL jsonb_array_elements(x.attachments) a WHERE c.guild_id = g.id AND x.attachments <> '[]'::jsonb) AS media_bytes
         FROM guilds g JOIN users o ON o.id = g.owner_id WHERE g.id = $1",
    )
    .bind(id)
    .fetch_optional(&st.db)
    .await
    .map_err(db_error)?
    else {
        return Err((StatusCode::NOT_FOUND, Json(json!({ "error": "There's no such server (any more)." }))));
    };
    let members = sqlx::query(
        "SELECT u.id::text AS id, u.username, u.display_name, u.avatar, u.bot, u.deleted_at IS NOT NULL AS deleted, m.nickname, m.joined_at,
            (SELECT count(*) FROM member_roles r WHERE r.guild_id = m.guild_id AND r.user_id = m.user_id)::bigint AS roles,
            (SELECT count(*) FROM messages x JOIN channels c ON c.id = x.channel_id WHERE c.guild_id = m.guild_id AND x.author_id = m.user_id)::bigint AS messages,
            g.owner_id = m.user_id AS owner
         FROM members m JOIN users u ON u.id = m.user_id JOIN guilds g ON g.id = m.guild_id
         WHERE m.guild_id = $1 ORDER BY owner DESC, m.joined_at LIMIT 1000",
    )
    .bind(id)
    .fetch_all(&st.db)
    .await
    .map_err(db_error)?;
    let channels = sqlx::query(
        "SELECT c.id::text AS id, c.name, c.kind::int AS kind, c.parent_id::text AS parent_id, c.position, c.created_at, c.archived,
            cr.username AS creator,
            (SELECT count(*) FROM messages m WHERE m.channel_id = c.id)::bigint AS messages,
            (SELECT COALESCE(SUM(jsonb_array_length(m.attachments)), 0)::bigint FROM messages m WHERE m.channel_id = c.id AND m.attachments <> '[]'::jsonb) AS media,
            (SELECT MAX(m.created_at) FROM messages m WHERE m.channel_id = c.id) AS last_message
         FROM channels c LEFT JOIN users cr ON cr.id = c.owner_id WHERE c.guild_id = $1 ORDER BY c.position, c.created_at",
    )
    .bind(id)
    .fetch_all(&st.db)
    .await
    .map_err(db_error)?;
    let invites = sqlx::query(
        "SELECT i.code, u.username AS creator, i.uses, i.max_uses, i.expires_at, i.created_at
         FROM invites i JOIN users u ON u.id = i.creator_id WHERE i.guild_id = $1 ORDER BY i.created_at DESC LIMIT 100",
    )
    .bind(id)
    .fetch_all(&st.db)
    .await
    .map_err(db_error)?;
    Ok(Json(json!({
        "server": {
            "id": id.to_string(),
            "name": head.get::<String, _>("name"),
            "icon": head.get::<Option<String>, _>("icon"),
            "created_at": head.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
            "messages": head.get::<i64, _>("messages"),
            "media_bytes": head.get::<i64, _>("media_bytes"),
            "owner": {
                "id": head.get::<String, _>("owner_id"),
                "username": head.get::<String, _>("owner_username"),
                "name": head.get::<Option<String>, _>("owner_name"),
                "avatar": head.get::<Option<String>, _>("owner_avatar"),
                "deleted": head.get::<bool, _>("owner_deleted"),
            },
        },
        "members": members.iter().map(|r| json!({
            "id": r.get::<String, _>("id"),
            "username": r.get::<String, _>("username"),
            "name": r.get::<Option<String>, _>("display_name"),
            "avatar": r.get::<Option<String>, _>("avatar"),
            "nickname": r.get::<Option<String>, _>("nickname"),
            "bot": r.get::<bool, _>("bot"),
            "deleted": r.get::<bool, _>("deleted"),
            "owner": r.get::<bool, _>("owner"),
            "joined_at": r.get::<chrono::DateTime<chrono::Utc>, _>("joined_at"),
            "roles": r.get::<i64, _>("roles"),
            "messages": r.get::<i64, _>("messages"),
        })).collect::<Vec<_>>(),
        "channels": channels.iter().map(|r| json!({
            "id": r.get::<String, _>("id"),
            "name": r.get::<String, _>("name"),
            "kind": r.get::<i32, _>("kind"),
            "archived": r.get::<bool, _>("archived"),
            "creator": r.get::<Option<String>, _>("creator"),
            "created_at": r.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
            "messages": r.get::<i64, _>("messages"),
            "media": r.get::<i64, _>("media"),
            "last_message": r.get::<Option<chrono::DateTime<chrono::Utc>>, _>("last_message"),
        })).collect::<Vec<_>>(),
        "invites": invites.iter().map(|r| json!({
            "code": r.get::<String, _>("code"),
            "creator": r.get::<String, _>("creator"),
            "uses": r.get::<i32, _>("uses"),
            "max_uses": r.get::<Option<i32>, _>("max_uses"),
            "expires_at": r.get::<Option<chrono::DateTime<chrono::Utc>>, _>("expires_at"),
            "created_at": r.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
        })).collect::<Vec<_>>(),
    })))
}

/// The badges an admin gives (the app's badges::MANUAL): Bug Hunter, Tester, Contributor, Helper.
const MANUAL_BADGES: [&str; 4] = ["bug_hunter", "tester", "contributor", "helper"];

/// One row per account, with what they have and did. `{where}` filters `u`; $2 is MANUAL_BADGES.
const ACCOUNT: &str = "SELECT u.id::text AS id, u.username, u.display_name, u.discord_username, u.avatar, u.bot, u.deleted_at, u.created_at,
        u.upload_bytes, u.voice_seconds, u.suspended_at,
        (SELECT count(*) FROM guilds g WHERE g.owner_id = u.id)::bigint AS servers_owned,
        (SELECT count(*) FROM members m WHERE m.user_id = u.id)::bigint AS servers_joined,
        (SELECT count(*) FROM messages x WHERE x.author_id = u.id)::bigint AS messages,
        (SELECT COALESCE(SUM(jsonb_array_length(x.attachments)), 0)::bigint FROM messages x WHERE x.author_id = u.id AND x.attachments <> '[]'::jsonb) AS media,
        (SELECT MAX(x.created_at) FROM messages x WHERE x.author_id = u.id) AS last_message,
        (SELECT count(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > now())::bigint AS sessions,
        ARRAY(SELECT b.badge FROM user_badges b WHERE b.user_id = u.id AND b.badge = ANY($2) ORDER BY b.badge) AS badges
     FROM users u";

fn account_json(r: &sqlx::postgres::PgRow) -> Value {
    let n = |k: &str| r.get::<i64, _>(k);
    json!({
        "id": r.get::<String, _>("id"),
        "username": r.get::<String, _>("username"),
        "name": r.get::<Option<String>, _>("display_name"),
        "discord_username": r.get::<Option<String>, _>("discord_username"),
        "avatar": r.get::<Option<String>, _>("avatar"),
        "bot": r.get::<bool, _>("bot"),
        "deleted_at": r.get::<Option<chrono::DateTime<chrono::Utc>>, _>("deleted_at"),
        "created_at": r.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
        "upload_bytes": n("upload_bytes"),
        "voice_seconds": n("voice_seconds"),
        "servers_owned": n("servers_owned"),
        "servers_joined": n("servers_joined"),
        "messages": n("messages"),
        "media": n("media"),
        "last_message": r.get::<Option<chrono::DateTime<chrono::Utc>>, _>("last_message"),
        "sessions": n("sessions"),
        "suspended_at": r.get::<Option<chrono::DateTime<chrono::Utc>>, _>("suspended_at"),
        "badges": r.get::<Vec<String>, _>("badges"),
    })
}

fn manual_badges() -> Vec<String> {
    MANUAL_BADGES.map(String::from).to_vec()
}

pub async fn accounts(State(st): State<AppState>, Query(s): Query<Search>) -> ApiResult {
    let q = s.q.unwrap_or_default();
    const MATCHES: &str = "($1 = '' OR u.username ILIKE '%' || $1 || '%' OR u.display_name ILIKE '%' || $1 || '%' OR u.discord_username ILIKE '%' || $1 || '%')";
    let sql = format!("{ACCOUNT} WHERE {MATCHES} AND {} ORDER BY u.created_at DESC LIMIT 500", status_filter(s.status.as_deref()));
    let rows = sqlx::query(&sql).bind(&q).bind(manual_badges()).fetch_all(&st.db).await.map_err(db_error)?;
    // How many each filter would show, for the search as typed (not just the 500 listed).
    let counts: (i64, i64, i64, i64, i64) = sqlx::query_as(&format!(
        "SELECT count(*), count(*) FILTER (WHERE {}), count(*) FILTER (WHERE {}), count(*) FILTER (WHERE {}), count(*) FILTER (WHERE {})
         FROM users u WHERE {MATCHES}",
        status_filter(Some("active")),
        status_filter(Some("suspended")),
        status_filter(Some("deleted")),
        status_filter(Some("bots")),
    ))
    .bind(&q)
    .fetch_one(&st.db)
    .await
    .map_err(db_error)?;
    Ok(Json(json!({
        "accounts": rows.iter().map(account_json).collect::<Vec<_>>(),
        "counts": { "all": counts.0, "active": counts.1, "suspended": counts.2, "deleted": counts.3, "bots": counts.4 },
    })))
}

/// One person: their account, the servers they're in, and what deleting them would take with it.
pub async fn account(State(st): State<AppState>, Path(id): Path<i64>) -> ApiResult {
    let sql = format!("{ACCOUNT} WHERE u.id = $1");
    let Some(row) = sqlx::query(&sql).bind(id).bind(manual_badges()).fetch_optional(&st.db).await.map_err(db_error)? else {
        return Err((StatusCode::NOT_FOUND, Json(json!({ "error": "There's no such account (any more)." }))));
    };
    let servers = sqlx::query(
        "SELECT g.id::text AS id, g.name, g.icon, g.owner_id = m.user_id AS owner, m.joined_at, m.nickname,
            (SELECT count(*) FROM members o WHERE o.guild_id = g.id)::bigint AS members,
            (SELECT count(*) FROM messages x JOIN channels c ON c.id = x.channel_id WHERE c.guild_id = g.id AND x.author_id = m.user_id)::bigint AS messages
         FROM members m JOIN guilds g ON g.id = m.guild_id WHERE m.user_id = $1 ORDER BY owner DESC, lower(g.name)",
    )
    .bind(id)
    .fetch_all(&st.db)
    .await
    .map_err(db_error)?;
    let other: (i64, i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM dm_recipients r JOIN channels c ON c.id = r.channel_id WHERE r.user_id = $1 AND c.kind = 1)::bigint,
                (SELECT count(*) FROM dm_recipients r JOIN channels c ON c.id = r.channel_id WHERE r.user_id = $1 AND c.kind = 3)::bigint,
                (SELECT count(*) FROM clips k WHERE k.user_id = $1)::bigint,
                (SELECT count(*) FROM relationships x WHERE x.user_id = $1 AND x.kind = 1)::bigint",
    )
    .bind(id)
    .fetch_one(&st.db)
    .await
    .map_err(db_error)?;
    Ok(Json(json!({
        "account": account_json(&row),
        "servers": servers.iter().map(|r| json!({
            "id": r.get::<String, _>("id"),
            "name": r.get::<String, _>("name"),
            "icon": r.get::<Option<String>, _>("icon"),
            "owner": r.get::<bool, _>("owner"),
            "nickname": r.get::<Option<String>, _>("nickname"),
            "joined_at": r.get::<chrono::DateTime<chrono::Utc>, _>("joined_at"),
            "members": r.get::<i64, _>("members"),
            "messages": r.get::<i64, _>("messages"),
        })).collect::<Vec<_>>(),
        "direct_conversations": other.0,
        "group_conversations": other.1,
        "clips": other.2,
        "friends": other.3,
    })))
}

// ---------- media ----------

/// Everything people have uploaded, whatever it was uploaded as. (Nameplates and sounds that ship with the app aren't
/// here, and neither are bot pictures.)
const MEDIA: &str = "
  SELECT 'attachment' AS kind, a->>'url' AS url, a->>'filename' AS filename, a->>'content_type' AS content_type,
         (a->>'size')::bigint AS size, m.created_at, m.author_id AS user_id, c.guild_id, m.channel_id, m.id AS item_id
    FROM messages m JOIN channels c ON c.id = m.channel_id CROSS JOIN LATERAL jsonb_array_elements(m.attachments) a
    WHERE m.attachments <> '[]'::jsonb
  UNION ALL SELECT 'avatar', h.url, NULL, NULL, h.size, h.created_at, h.user_id, NULL, NULL, NULL FROM avatar_history h
  UNION ALL SELECT 'avatar', u.avatar, NULL, NULL, NULL, u.created_at, u.id, NULL, NULL, NULL FROM users u
    WHERE u.avatar LIKE '/uploads/avatars/%' AND NOT EXISTS (SELECT 1 FROM avatar_history h WHERE h.user_id = u.id AND h.url = u.avatar)
  UNION ALL SELECT 'banner', u.banner, NULL, NULL, NULL, u.created_at, u.id, NULL, NULL, NULL FROM users u WHERE u.banner LIKE '/uploads/%'
  UNION ALL SELECT 'server_icon', g.icon, NULL, NULL, NULL, g.created_at, g.owner_id, g.id, NULL, NULL FROM guilds g WHERE g.icon LIKE '/uploads/%'
  UNION ALL SELECT 'server_banner', g.banner, NULL, NULL, NULL, g.created_at, g.owner_id, g.id, NULL, NULL FROM guilds g WHERE g.banner LIKE '/uploads/%'
  UNION ALL SELECT 'member_avatar', m.avatar, NULL, NULL, NULL, m.joined_at, m.user_id, m.guild_id, NULL, NULL FROM members m WHERE m.avatar LIKE '/uploads/%'
  UNION ALL SELECT 'member_banner', m.banner, NULL, NULL, NULL, m.joined_at, m.user_id, m.guild_id, NULL, NULL FROM members m WHERE m.banner LIKE '/uploads/%'
  UNION ALL SELECT 'emoji', '/uploads/emojis/' || e.id || CASE WHEN e.animated THEN '.gif' ELSE '.png' END, e.name, NULL, NULL, e.created_at, e.creator_id, e.guild_id, NULL, e.id FROM emojis e
  UNION ALL SELECT 'sound', s.url, s.name, NULL, NULL, s.created_at, s.creator_id, s.guild_id, NULL, s.id FROM soundboard_sounds s
  UNION ALL SELECT 'profile_song', p.url, p.title, NULL, NULL, NULL, p.user_id, NULL, NULL, NULL FROM profile_songs p
  UNION ALL SELECT 'clip', '/uploads/clips/' || k.slug || '.mp4', NULLIF(k.title, ''), 'video/mp4', k.size, k.created_at, k.user_id, NULL, NULL, k.id FROM clips k
";

/// image | video | audio | file, from a content type or, failing that, the file's name.
const MEDIA_CLASS: &str = "CASE
    WHEN x.kind IN ('sound', 'profile_song') THEN 'audio'
    WHEN x.kind = 'clip' THEN 'video'
    WHEN x.kind <> 'attachment' THEN 'image'
    WHEN x.content_type LIKE 'image/%' THEN 'image'
    WHEN x.content_type LIKE 'video/%' THEN 'video'
    WHEN x.content_type LIKE 'audio/%' THEN 'audio'
    ELSE 'file' END";

#[derive(Deserialize)]
pub struct MediaQuery {
    /// image | video | audio | file
    class: Option<String>,
    /// attachment | avatar | ...
    source: Option<String>,
    /// A server's id, or "dm" for direct messages.
    server: Option<String>,
    /// Only what this person uploaded.
    user: Option<String>,
    q: Option<String>,
    /// newest (default) | oldest | largest
    sort: Option<String>,
    offset: Option<i64>,
    limit: Option<i64>,
}

fn file_on_disk(st: &AppState, url: &str) -> Option<PathBuf> {
    safe_relative(url.strip_prefix("/uploads/")?).map(|r| st.cfg.uploads_dir().join(r))
}

/// Only plain path segments: nothing can step out of the uploads folder.
pub fn safe_relative(rel: &str) -> Option<PathBuf> {
    if rel.is_empty() || rel.contains('\\') || rel.contains('\0') {
        return None;
    }
    let path = FsPath::new(rel);
    path.components().all(|c| matches!(c, Component::Normal(_))).then(|| path.to_path_buf())
}

pub async fn media(State(st): State<AppState>, Query(m): Query<MediaQuery>) -> ApiResult {
    let order = match m.sort.as_deref() {
        Some("largest") => "x.size DESC NULLS LAST, x.url",
        Some("oldest") => "x.created_at ASC NULLS LAST, x.url",
        _ => "x.created_at DESC NULLS LAST, x.url",
    };
    let server = m.server.unwrap_or_default();
    let guild: Option<i64> = server.parse().ok();
    let sql = format!(
        "WITH media AS ({MEDIA}), listed AS (SELECT x.*, {MEDIA_CLASS} AS class FROM media x)
         SELECT x.kind, x.url, x.filename, x.content_type, x.size, x.created_at, x.class,
            x.user_id::text AS user_id, x.guild_id::text AS guild_id, x.channel_id::text AS channel_id, x.item_id::text AS item_id,
            u.username, u.display_name, g.name AS server, c.name AS channel, c.guild_id IS NULL AND c.id IS NOT NULL AS is_dm,
            COUNT(*) OVER () AS total, COALESCE(SUM(x.size) OVER (), 0)::bigint AS total_bytes
         FROM listed x
         LEFT JOIN users u ON u.id = x.user_id
         LEFT JOIN guilds g ON g.id = x.guild_id
         LEFT JOIN channels c ON c.id = x.channel_id
         WHERE ($1 = '' OR x.class = $1)
           AND ($2 = '' OR x.kind = $2)
           AND ($3 = '' OR ($3 = 'dm' AND c.id IS NOT NULL AND c.guild_id IS NULL) OR x.guild_id = $4)
           AND ($8::bigint IS NULL OR x.user_id = $8)
           AND ($5 = '' OR COALESCE(x.filename, '') ILIKE '%' || $5 || '%' OR u.username ILIKE '%' || $5 || '%' OR COALESCE(u.display_name, '') ILIKE '%' || $5 || '%' OR COALESCE(g.name, '') ILIKE '%' || $5 || '%')
         ORDER BY {order} LIMIT $6 OFFSET $7"
    );
    let rows = sqlx::query(&sql)
        .bind(m.class.unwrap_or_default())
        .bind(m.source.unwrap_or_default())
        .bind(&server)
        .bind(guild)
        .bind(m.q.unwrap_or_default())
        .bind(m.limit.unwrap_or(60).clamp(1, 200))
        .bind(m.offset.unwrap_or(0).max(0))
        .bind(m.user.as_deref().and_then(|u| u.parse::<i64>().ok()))
        .fetch_all(&st.db)
        .await
        .map_err(db_error)?;
    let total = rows.first().map(|r| r.get::<i64, _>("total")).unwrap_or(0);
    let total_bytes = rows.first().map(|r| r.get::<i64, _>("total_bytes")).unwrap_or(0);
    let mut items = vec![];
    for r in &rows {
        let url: String = r.get("url");
        let path = file_on_disk(&st, &url);
        let meta = match &path {
            Some(p) => tokio::fs::metadata(p).await.ok(),
            None => None,
        };
        let name_from_url = url.rsplit('/').next().unwrap_or("").to_string();
        let content_type = r.get::<Option<String>, _>("content_type").or_else(|| mime_guess::from_path(&name_from_url).first().map(|m| m.to_string()));
        items.push(json!({
            "kind": r.get::<String, _>("kind"),
            "class": r.get::<String, _>("class"),
            "url": url,
            "file": url.strip_prefix("/uploads/").map(|rel| format!("/media/{rel}")),
            "filename": r.get::<Option<String>, _>("filename").unwrap_or(name_from_url),
            "content_type": content_type,
            "size": r.get::<Option<i64>, _>("size").or(meta.as_ref().map(|m| m.len() as i64)),
            "missing": meta.is_none(),
            "created_at": r.get::<Option<chrono::DateTime<chrono::Utc>>, _>("created_at"),
            "user_id": r.get::<Option<String>, _>("user_id"),
            "username": r.get::<Option<String>, _>("username"),
            "user_name": r.get::<Option<String>, _>("display_name"),
            "guild_id": r.get::<Option<String>, _>("guild_id"),
            "server": r.get::<Option<String>, _>("server"),
            "channel_id": r.get::<Option<String>, _>("channel_id"),
            "channel": r.get::<Option<String>, _>("channel"),
            "is_dm": r.get::<Option<bool>, _>("is_dm").unwrap_or(false),
            "item_id": r.get::<Option<String>, _>("item_id"),
        }));
    }
    Ok(Json(json!({ "items": items, "total": total, "total_bytes": total_bytes })))
}

/// How the media breaks down, for the filters at the top of the tab.
pub async fn media_totals(State(st): State<AppState>) -> ApiResult {
    let sql = format!(
        "WITH media AS ({MEDIA}) SELECT {MEDIA_CLASS} AS class, x.kind, count(*)::bigint AS count, COALESCE(SUM(x.size), 0)::bigint AS bytes
         FROM media x GROUP BY 1, 2 ORDER BY 3 DESC"
    );
    let rows = sqlx::query(&sql).fetch_all(&st.db).await.map_err(db_error)?;
    let guilds: Vec<(String, String)> = sqlx::query_as("SELECT id::text, name FROM guilds ORDER BY lower(name)").fetch_all(&st.db).await.map_err(db_error)?;
    Ok(Json(json!({
        "breakdown": rows.iter().map(|r| json!({
            "class": r.get::<String, _>("class"),
            "kind": r.get::<String, _>("kind"),
            "count": r.get::<i64, _>("count"),
            "bytes": r.get::<i64, _>("bytes"),
        })).collect::<Vec<_>>(),
        "servers": guilds.iter().map(|(id, name)| json!({ "id": id, "name": name })).collect::<Vec<_>>(),
    })))
}

/// Files people uploaded are not trustworthy, and this origin holds the dashboard's session. Pictures, video and audio
/// play inline; anything else downloads. Nothing a file holds can run: the CSP sandboxes it even if opened directly.
fn safe_inline(mime: &str) -> bool {
    (mime.starts_with("image/") && mime != "image/svg+xml") || mime.starts_with("video/") || mime.starts_with("audio/")
}

pub async fn file(State(st): State<AppState>, Path(rel): Path<String>, req: Request) -> Response {
    let Some(relative) = safe_relative(&rel) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let path = st.cfg.uploads_dir().join(relative);
    let mime = mime_guess::from_path(&path).first_or_octet_stream();
    let served = ServeFile::new_with_mime(&path, &mime).oneshot(req).await;
    let mut res = match served {
        Ok(r) => r.map(Body::new),
        Err(e) => match e {},
    };
    let h = res.headers_mut();
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=3600"));
    if !safe_inline(mime.essence_str()) {
        h.insert(header::CONTENT_DISPOSITION, HeaderValue::from_static("attachment"));
    }
    res
}

/// Asks the app (internal.rs in the server) to make a change: this process never changes the app's data itself.
async fn forward<B: serde::Serialize>(st: &AppState, path: &str, body: &B, refused: &str) -> ApiResult {
    let unavailable = |msg: &str| (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "error": msg })));
    let Some(url) = &st.cfg.internal_url else { return Err(unavailable("The app's internal address is turned off.")) };
    let Ok(token) = tokio::fs::read_to_string(st.cfg.app_data.join("internal-token")).await else {
        return Err(unavailable("Can't read the app's internal token."));
    };
    let res = st
        .http
        .post(format!("{url}{path}"))
        .bearer_auth(token.trim())
        .json(body)
        .send()
        .await
        .map_err(|_| unavailable("The app isn't answering, so nothing changed."))?;
    let status = res.status();
    let v: Value = res.json().await.unwrap_or(Value::Null);
    if status.is_success() {
        return Ok(Json(v));
    }
    let message = v["message"].as_str().or(v["error"].as_str()).unwrap_or(refused);
    let message = if status == StatusCode::NOT_FOUND { "It's already gone." } else { message };
    Err((StatusCode::BAD_GATEWAY, Json(json!({ "error": capitalized(message) }))))
}

/// The app's errors are lowercase phrases ("they own servers: ..."); here they stand as sentences.
fn capitalized(s: &str) -> String {
    let mut c = s.chars();
    let first = c.next().map(|f| f.to_uppercase().collect::<String>()).unwrap_or_default();
    let rest: String = c.collect();
    let out = format!("{first}{rest}");
    if out.ends_with(['.', '!', '?']) { out } else { format!("{out}.") }
}

#[derive(Deserialize, serde::Serialize)]
pub struct RemoveMedia {
    kind: String,
    url: String,
    item_id: Option<String>,
    user_id: Option<String>,
    guild_id: Option<String>,
}

/// Removes a file: the app updates the database, tells connected apps and gives back the quota.
pub async fn remove(State(st): State<AppState>, Json(body): Json<RemoveMedia>) -> ApiResult {
    forward(&st, "/moderation/remove", &body, "The app refused to remove it.").await
}

#[derive(Deserialize, serde::Serialize)]
pub struct Suspend {
    user_id: String,
    suspended: bool,
}

/// Suspends or restores an account.
pub async fn suspend(State(st): State<AppState>, Json(body): Json<Suspend>) -> ApiResult {
    forward(&st, "/moderation/suspend", &body, "The app refused.").await
}

#[derive(Deserialize, serde::Serialize)]
pub struct GiveBadge {
    user_id: String,
    badge: String,
    given: bool,
}

/// Gives or takes away a badge (the app tells the person's apps).
pub async fn badge(State(st): State<AppState>, Json(body): Json<GiveBadge>) -> ApiResult {
    forward(&st, "/moderation/badge", &body, "The app refused.").await
}

#[derive(Deserialize, serde::Serialize)]
pub struct DeleteAccount {
    user_id: String,
    /// Their username, typed to confirm.
    confirm: String,
    #[serde(default)]
    with_servers: bool,
}

/// Deletes an account for good: their messages, files, conversations and the account itself (the app's users::purge).
pub async fn delete_account(State(st): State<AppState>, Json(body): Json<DeleteAccount>) -> ApiResult {
    tracing::info!(target: "moderation", user = %body.user_id, with_servers = body.with_servers, "deleting an account for good");
    forward(&st, "/moderation/delete-account", &body, "The app refused to delete it.").await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_can_step_out_of_the_uploads_folder() {
        assert!(safe_relative("attachments/1/abc/cat.png").is_some());
        for bad in ["", "../.env", "a/../../b", "/etc/passwd", "..\\x", "a\\b", "./a"] {
            assert!(safe_relative(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn only_harmless_media_plays_inline() {
        assert!(safe_inline("image/png"));
        assert!(safe_inline("video/mp4"));
        assert!(safe_inline("audio/ogg"));
        assert!(!safe_inline("image/svg+xml"));
        assert!(!safe_inline("text/html"));
        assert!(!safe_inline("application/pdf"));
    }

    #[test]
    fn app_errors_read_as_sentences() {
        assert_eq!(capitalized("they own servers: Kokiri Forest"), "They own servers: Kokiri Forest.");
        assert_eq!(capitalized("It's already gone."), "It's already gone.");
    }

    #[test]
    fn snowflakes_follow_the_clock() {
        assert_eq!(snowflake_at(1_767_225_600), 0);
        assert_eq!(snowflake_at(1_767_225_601), 1000 << 22);
        assert_eq!(snowflake_at(0), 0, "before the epoch means from the very first id");
    }
}
