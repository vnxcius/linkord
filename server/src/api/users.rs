use axum::extract::{Multipart, Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::Deserialize;
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
        .route("/users/@me/avatar", post(|st, me, mp| upload_image(st, me, mp, "avatar")).delete(|st, me| clear_image(st, me, "avatar")))
        .route("/users/@me/banner", post(|st, me, mp| upload_image(st, me, mp, "banner")).delete(|st, me| clear_image(st, me, "banner")))
        .route("/users/{id}", get(get_user))
        .route("/users/{id}/profile", get(profile))
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
    Ok(Json(serde_json::json!({ "user": user, "mutual_friends": friends, "mutual_guilds": mutual_guilds, "created_at": created_at, "connections": connections })))
}

#[derive(Deserialize)]
struct ProfileUpdate {
    display_name: Option<String>,
    bio: Option<String>,
    status: Option<String>,
    accent_color: Option<i32>,
}

async fn update_me(State(st): State<AppState>, AuthUser(me): AuthUser, Json(body): Json<ProfileUpdate>) -> ApiResult<Json<serde_json::Value>> {
    let before = User::get(&st.db, me).await?;
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
    // An empty display name clears it (falls back to the username).
    let display_name = match body.display_name {
        Some(n) if n.trim().is_empty() => None,
        Some(n) => Some(n.trim().to_string()),
        None => before.display_name.clone(),
    };
    sqlx::query("UPDATE users SET display_name = $2, bio = $3, status = $4, accent_color = $5 WHERE id = $1")
        .bind(me)
        .bind(display_name)
        .bind(body.bio.unwrap_or(before.bio.clone()))
        .bind(body.status.unwrap_or(before.status.clone()))
        .bind(body.accent_color.or(before.accent_color))
        .execute(&st.db)
        .await?;
    let after = User::get(&st.db, me).await?;
    notify_update(&st, &after).await?;
    if after.status != before.status {
        broadcast_presence(&st, &after).await?;
    }
    Ok(Json(serde_json::to_value(after.me()).unwrap()))
}

async fn notify_update(st: &AppState, user: &User) -> ApiResult<()> {
    let audience = related_users(&st.db, user.id).await?;
    st.hub.send(&audience, "USER_UPDATE", user);
    Ok(())
}

async fn upload_image(State(st): State<AppState>, AuthUser(me): AuthUser, mut mp: Multipart, which: &'static str) -> ApiResult<Json<serde_json::Value>> {
    let field = mp.next_field().await.map_err(|e| bad(e.body_text()))?.ok_or_else(|| bad("missing file"))?;
    let ct = field.content_type().unwrap_or_default().to_string();
    if !uploads::is_image(&ct) {
        return Err(bad("must be a png, jpeg, gif or webp image"));
    }
    let name = field.file_name().unwrap_or("image").to_string();
    let bytes = uploads::read_field(field, uploads::MAX_IMAGE).await?;
    uploads::reserve(&st, me, bytes.len()).await?;
    let url = uploads::save(&st, &format!("{which}s/{me}"), &name, &bytes).await?;
    sqlx::query(&format!("UPDATE users SET {which} = $2 WHERE id = $1")).bind(me).bind(&url).execute(&st.db).await?;
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

/// Numbers for Settings -> My Account. Voice time is counted since 0.1.14; deleted messages don't count.
async fn stats(State(st): State<AppState>, AuthUser(me): AuthUser) -> ApiResult<Json<serde_json::Value>> {
    let (created_at, voice_seconds, upload_bytes): (DateTime<Utc>, i64, i64) =
        sqlx::query_as("SELECT created_at, voice_seconds, upload_bytes FROM users WHERE id = $1").bind(me).fetch_one(&st.db).await?;
    let (messages, attachments): (i64, i64) = sqlx::query_as(
        "SELECT COUNT(*), COALESCE(SUM(jsonb_array_length(attachments)), 0)::BIGINT FROM messages WHERE author_id = $1",
    )
    .bind(me)
    .fetch_one(&st.db)
    .await?;
    let reactions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM reactions WHERE user_id = $1").bind(me).fetch_one(&st.db).await?;
    let servers: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM members WHERE user_id = $1").bind(me).fetch_one(&st.db).await?;
    let friends: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM relationships WHERE user_id = $1 AND kind = $2")
        .bind(me)
        .bind(relationships::FRIEND)
        .fetch_one(&st.db)
        .await?;
    Ok(Json(json!({
        "created_at": created_at,
        "voice_seconds": voice_seconds,
        "messages": messages,
        "attachments": attachments,
        "reactions": reactions,
        "servers": servers,
        "friends": friends,
        "upload_bytes": upload_bytes,
        "upload_quota": st.cfg.upload_quota,
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
         avatar = NULL, banner = NULL, accent_color = NULL, bio = '', status = 'invisible', deleted_at = now() WHERE id = $1",
    )
    .bind(me)
    .bind(format!("deleted_user_{short}"))
    .execute(&st.db)
    .await?;
    for table in ["sessions", "read_states", "user_settings", "custom_statuses"] {
        sqlx::query(&format!("DELETE FROM {table} WHERE user_id = $1")).bind(me).execute(&st.db).await?;
    }
    for dir in ["avatars", "banners"] {
        let _ = tokio::fs::remove_dir_all(st.cfg.uploads_dir().join(dir).join(me.to_string())).await;
    }
    let after = User::get(&st.db, me).await?;
    st.hub.send(&audience, "USER_UPDATE", &after);
    st.hub.send(&audience, "PRESENCE_UPDATE", &json!({ "user_id": me, "status": "offline" }));
    tracing::info!("account {me} deleted");
    Ok(())
}
