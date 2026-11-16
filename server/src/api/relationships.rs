//! Friends and blocks. Each side of a relationship has its own row (kinds below).

use axum::extract::{Path, State};
use axum::routing::{post, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::PgPool;

use crate::auth::AuthUser;
use crate::error::{bad, ApiResult};
use crate::gateway::broadcast_presence_to;
use crate::id::Id;
use crate::models::{prefixed, User, USER_COLS};
use crate::state::AppState;

pub const FRIEND: i16 = 1;
pub const BLOCKED: i16 = 2;
pub const INCOMING: i16 = 3;
pub const OUTGOING: i16 = 4;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/users/@me/relationships", post(send_by_username))
        .route("/users/@me/relationships/{user}", put(put_relationship).delete(remove))
}

#[derive(Serialize, sqlx::FromRow)]
pub struct Relationship {
    pub id: Id,
    #[sqlx(rename = "kind")]
    #[serde(rename = "type")]
    pub kind: i16,
    #[sqlx(flatten)]
    pub user: User,
}

pub async fn load(db: &PgPool, me: Id) -> ApiResult<Vec<Relationship>> {
    Ok(sqlx::query_as::<_, Relationship>(&format!(
        "SELECT r.target_id AS id, r.kind, {} FROM relationships r JOIN users u ON u.id = r.target_id WHERE r.user_id = $1",
        prefixed(USER_COLS, "u")
    ))
    .bind(me)
    .fetch_all(db)
    .await?)
}

async fn kind_of(db: &PgPool, from: Id, to: Id) -> ApiResult<Option<i16>> {
    Ok(sqlx::query_scalar("SELECT kind FROM relationships WHERE user_id = $1 AND target_id = $2").bind(from).bind(to).fetch_optional(db).await?)
}

pub async fn are_friends(db: &PgPool, a: Id, b: Id) -> ApiResult<bool> {
    Ok(kind_of(db, a, b).await? == Some(FRIEND))
}

pub async fn blocked_between(db: &PgPool, a: Id, b: Id) -> ApiResult<bool> {
    Ok(kind_of(db, a, b).await? == Some(BLOCKED) || kind_of(db, b, a).await? == Some(BLOCKED))
}

async fn set(db: &PgPool, from: Id, to: Id, kind: i16) -> ApiResult<()> {
    sqlx::query(
        "INSERT INTO relationships (user_id, target_id, kind) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, target_id) DO UPDATE SET kind = EXCLUDED.kind, created_at = now()",
    )
    .bind(from)
    .bind(to)
    .bind(kind)
    .execute(db)
    .await?;
    Ok(())
}

/// Deletes from->to unless it is a block (blocks survive the other side's actions).
async fn clear(db: &PgPool, from: Id, to: Id) -> ApiResult<()> {
    sqlx::query("DELETE FROM relationships WHERE user_id = $1 AND target_id = $2 AND kind <> $3").bind(from).bind(to).bind(BLOCKED).execute(db).await?;
    Ok(())
}

pub async fn notify(st: &AppState, to: Id, about: Id) -> ApiResult<()> {
    match kind_of(&st.db, to, about).await? {
        Some(kind) => {
            let user = User::get(&st.db, about).await?;
            st.hub.send(&[to], "RELATIONSHIP_ADD", &Relationship { id: about, kind, user });
        }
        None => st.hub.send(&[to], "RELATIONSHIP_REMOVE", &json!({ "id": about })),
    }
    Ok(())
}

async fn send_request(st: &AppState, me: Id, target: Id) -> ApiResult<()> {
    if target == me {
        return Err(bad("you can't add yourself"));
    }
    if User::get(&st.db, target).await?.bot {
        return Err(bad("bots can't be friends"));
    }
    match kind_of(&st.db, me, target).await? {
        Some(FRIEND) => return Err(bad("you're already friends")),
        Some(BLOCKED) => return Err(bad("unblock this user first")),
        Some(OUTGOING) => return Ok(()),
        _ => {}
    }
    match kind_of(&st.db, target, me).await? {
        Some(BLOCKED) => return Err(bad("couldn't send a friend request to this user")),
        // They already asked us: accept.
        Some(OUTGOING) => {
            set(&st.db, me, target, FRIEND).await?;
            set(&st.db, target, me, FRIEND).await?;
            broadcast_presence_to(st, me, &[target]).await?;
            broadcast_presence_to(st, target, &[me]).await?;
        }
        _ => {
            set(&st.db, me, target, OUTGOING).await?;
            set(&st.db, target, me, INCOMING).await?;
            // Their phone hears about it even with the app closed (the open apps show it from RELATIONSHIP_ADD).
            crate::push::on_friend_request(st, target, me);
        }
    }
    notify(st, me, target).await?;
    notify(st, target, me).await
}

#[derive(Deserialize)]
struct ByUsername {
    username: String,
}

async fn send_by_username(State(st): State<AppState>, AuthUser(me): AuthUser, Json(body): Json<ByUsername>) -> ApiResult<()> {
    // Limited before the lookup so usernames can't be probed in bulk.
    st.limits.check(format!("friend:{me}"), 10.0, 0.1)?;
    let name = body.username.trim().trim_start_matches('@').to_lowercase();
    // Usernames come from Discord and are unique there; dev accounts are excluded from lookups.
    let ids: Vec<Id> = sqlx::query_scalar("SELECT id FROM users WHERE username = $1 AND discord_id NOT LIKE 'dev:%' AND deleted_at IS NULL LIMIT 2")
        .bind(&name)
        .fetch_all(&st.db)
        .await?;
    let ids = if ids.is_empty() {
        sqlx::query_scalar("SELECT id FROM users WHERE username = $1 LIMIT 2").bind(&name).fetch_all(&st.db).await?
    } else {
        ids
    };
    match ids.as_slice() {
        [id] => send_request(&st, me, *id).await,
        [] => Err(bad("no one with that username has joined Linkord yet")),
        _ => Err(bad("several people share that username; add them from their profile instead")),
    }
}

#[derive(Deserialize, Default)]
struct PutBody {
    #[serde(rename = "type")]
    kind: Option<i16>,
}

/// Sends/accepts a friend request, or blocks with `{"type": 2}`.
async fn put_relationship(State(st): State<AppState>, AuthUser(me): AuthUser, Path(target): Path<Id>, body: Option<Json<PutBody>>) -> ApiResult<()> {
    st.limits.check(format!("friend:{me}"), 10.0, 0.1)?;
    User::get(&st.db, target).await?;
    if body.and_then(|b| b.0.kind) == Some(BLOCKED) {
        if target == me {
            return Err(bad("you can't block yourself"));
        }
        set(&st.db, me, target, BLOCKED).await?;
        clear(&st.db, target, me).await?;
        notify(&st, me, target).await?;
        return notify(&st, target, me).await;
    }
    send_request(&st, me, target).await
}

/// Unfriend, cancel, decline or unblock.
async fn remove(State(st): State<AppState>, AuthUser(me): AuthUser, Path(target): Path<Id>) -> ApiResult<()> {
    sqlx::query("DELETE FROM relationships WHERE user_id = $1 AND target_id = $2").bind(me).bind(target).execute(&st.db).await?;
    clear(&st.db, target, me).await?;
    notify(&st, me, target).await?;
    notify(&st, target, me).await
}
