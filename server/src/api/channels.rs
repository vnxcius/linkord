use axum::extract::{Path, State};
use axum::routing::{patch, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::api::messages::{hydrate, load_message};
use crate::auth::AuthUser;
use crate::error::{bad, ApiError, ApiResult};
use crate::gateway::channel_audience;
use crate::id::Id;
use crate::models::{kind, Channel, CHANNEL_COLS, MESSAGE_COLS};
use crate::perms::{self, guild_perms, Perms};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/guilds/{id}/channels", post(create_channel).put(reorder_channels))
        .route("/channels/{id}", patch(update_channel).delete(delete_channel))
        .route("/channels/{id}/messages/{mid}/threads", post(create_thread))
}

/// A channel the user can see, with their permissions in it.
pub struct Access {
    pub ch: Channel,
    pub perms: Perms,
}

impl Access {
    pub fn has(&self, p: i64) -> bool {
        self.perms.has(p)
    }

    pub fn require(&self, p: i64) -> ApiResult<()> {
        self.perms.require(p)
    }
}

pub async fn channel_for(st: &AppState, id: Id, me: Id) -> ApiResult<Access> {
    let ch = Channel::get(&st.db, id).await?;
    let perms = match ch.guild_id {
        Some(g) => guild_perms(&st.db, g, me).await?,
        None => {
            let ok: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM dm_recipients WHERE channel_id = $1 AND user_id = $2)")
                .bind(id)
                .bind(me)
                .fetch_one(&st.db)
                .await?;
            if !ok {
                return Err(ApiError::NotFound);
            }
            Perms::dm()
        }
    };
    Ok(Access { ch, perms })
}

pub(super) fn channel_name(name: &str, kind: i16) -> ApiResult<String> {
    let name = name.trim();
    // Text channels are slugs like Discord's; voice channels, categories, threads and groups keep their spelling.
    let name = if kind == kind::TEXT { name.to_lowercase().split_whitespace().collect::<Vec<_>>().join("-") } else { name.to_string() };
    if name.is_empty() || name.chars().count() > 100 {
        return Err(bad("name must be 1-100 characters"));
    }
    Ok(name)
}

#[derive(Deserialize)]
struct NewChannel {
    name: String,
    kind: i16,
    #[serde(default)]
    topic: String,
    /// The category to put a text or voice channel in.
    parent_id: Option<Id>,
}

/// A category of this server, or an error.
async fn category_of(st: &AppState, gid: Id, id: Id) -> ApiResult<Id> {
    let ok: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM channels WHERE id = $1 AND guild_id = $2 AND kind = $3)")
        .bind(id)
        .bind(gid)
        .bind(kind::CATEGORY)
        .fetch_one(&st.db)
        .await?;
    if ok {
        Ok(id)
    } else {
        Err(bad("unknown category"))
    }
}

async fn create_channel(State(st): State<AppState>, AuthUser(me): AuthUser, Path(gid): Path<Id>, Json(body): Json<NewChannel>) -> ApiResult<Json<Channel>> {
    guild_perms(&st.db, gid, me).await?.require(perms::MANAGE_CHANNELS)?;
    if ![kind::TEXT, kind::VOICE, kind::CATEGORY].contains(&body.kind) {
        return Err(bad("invalid channel kind"));
    }
    let parent = match body.parent_id.filter(|_| body.kind != kind::CATEGORY) {
        Some(p) => Some(category_of(&st, gid, p).await?),
        None => None,
    };
    let name = channel_name(&body.name, body.kind)?;
    let ch = sqlx::query_as::<_, Channel>(&format!(
        "INSERT INTO channels (id, guild_id, kind, name, topic, position, parent_id)
         VALUES ($1, $2, $3, $4, $5, (SELECT COALESCE(MAX(position) + 1, 0) FROM channels WHERE guild_id = $2), $6)
         RETURNING {CHANNEL_COLS}"
    ))
    .bind(Id::new())
    .bind(gid)
    .bind(body.kind)
    .bind(name)
    .bind(body.topic.trim())
    .bind(parent)
    .fetch_one(&st.db)
    .await?;
    st.hub.send(&channel_audience(&st.db, &ch).await?, "CHANNEL_CREATE", &ch);
    Ok(Json(ch))
}

#[derive(Deserialize)]
struct Reorder {
    /// The server's channels and categories in their new order (threads aren't positioned).
    ids: Vec<Id>,
    /// New category per moved channel (null = no category). Clients before categories leave it out.
    #[serde(default)]
    parents: std::collections::HashMap<Id, Option<Id>>,
}

async fn reorder_channels(State(st): State<AppState>, AuthUser(me): AuthUser, Path(gid): Path<Id>, Json(body): Json<Reorder>) -> ApiResult<()> {
    guild_perms(&st.db, gid, me).await?.require(perms::MANAGE_CHANNELS)?;
    let current: Vec<(Id, i32, i16, Option<Id>)> = sqlx::query_as("SELECT id, position, kind, parent_id FROM channels WHERE guild_id = $1 AND kind <> $2")
        .bind(gid)
        .bind(kind::THREAD)
        .fetch_all(&st.db)
        .await?;
    let mut sorted = body.ids.clone();
    sorted.sort();
    sorted.dedup();
    if sorted.len() != body.ids.len() || sorted.len() != current.len() || !current.iter().all(|(id, ..)| sorted.binary_search(id).is_ok()) {
        return Err(bad("send every channel of the server exactly once"));
    }
    let is_category = |id: Id| current.iter().any(|(c, _, k, _)| *c == id && *k == kind::CATEGORY);
    for (id, parent) in &body.parents {
        // Only text and voice channels go in categories, and categories don't nest.
        if is_category(*id) || parent.is_some_and(|p| !is_category(p)) {
            return Err(bad("unknown category"));
        }
    }
    let mut tx = st.db.begin().await?;
    let mut moved = vec![];
    for (pos, id) in body.ids.iter().enumerate() {
        let Some((_, old_pos, _, old_parent)) = current.iter().find(|(c, ..)| c == id) else { continue };
        let parent = body.parents.get(id).copied().unwrap_or(*old_parent);
        if *old_pos != pos as i32 || parent != *old_parent {
            sqlx::query("UPDATE channels SET position = $2, parent_id = $3 WHERE id = $1").bind(id).bind(pos as i32).bind(parent).execute(&mut *tx).await?;
            moved.push(*id);
        }
    }
    tx.commit().await?;
    for id in moved {
        let ch = Channel::get(&st.db, id).await?;
        st.hub.send(&channel_audience(&st.db, &ch).await?, "CHANNEL_UPDATE", &ch);
    }
    Ok(())
}

#[derive(Deserialize)]
struct ChannelUpdate {
    name: Option<String>,
    topic: Option<String>,
    archived: Option<bool>,
}

/// Who may edit: channel managers for guild channels, the creator or thread managers for threads, anyone in a group DM.
fn can_edit(a: &Access, me: Id) -> bool {
    match a.ch.kind {
        kind::THREAD => a.ch.owner_id == Some(me) || a.has(perms::MANAGE_THREADS),
        kind::GROUP_DM => true,
        kind::DM => false,
        _ => a.has(perms::MANAGE_CHANNELS),
    }
}

async fn update_channel(State(st): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<Id>, Json(body): Json<ChannelUpdate>) -> ApiResult<Json<Channel>> {
    let a = channel_for(&st, id, me).await?;
    if !can_edit(&a, me) {
        return Err(ApiError::Forbidden);
    }
    if body.topic.as_ref().is_some_and(|t| t.chars().count() > 1024) {
        return Err(bad("topic must be at most 1024 characters"));
    }
    let ch = a.ch;
    let name = match body.name {
        Some(n) if ch.kind == kind::GROUP_DM && n.trim().is_empty() => String::new(),
        Some(n) => channel_name(&n, ch.kind)?,
        None => ch.name.clone(),
    };
    let archived = body.archived.filter(|_| ch.kind == kind::THREAD).unwrap_or(ch.archived);
    let ch = sqlx::query_as::<_, Channel>(&format!(
        "UPDATE channels SET name = $2, topic = $3, archived = $4 WHERE id = $1 RETURNING {CHANNEL_COLS}"
    ))
    .bind(id)
    .bind(name)
    .bind(body.topic.map(|t| t.trim().to_string()).unwrap_or(ch.topic))
    .bind(archived)
    .fetch_one(&st.db)
    .await?;
    st.hub.send(&channel_audience(&st.db, &ch).await?, "CHANNEL_UPDATE", &ch);
    Ok(Json(ch))
}

async fn delete_channel(State(st): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<Id>) -> ApiResult<()> {
    let a = channel_for(&st, id, me).await?;
    if kind::is_private(a.ch.kind) || !can_edit(&a, me) {
        return Err(ApiError::Forbidden);
    }
    let ch = a.ch;
    let audience = channel_audience(&st.db, &ch).await?;
    // A deleted category's channels stay, without a category (like Discord).
    let orphans = if ch.kind == kind::CATEGORY {
        sqlx::query_as::<_, Channel>(&format!("UPDATE channels SET parent_id = NULL WHERE parent_id = $1 RETURNING {CHANNEL_COLS}"))
            .bind(id)
            .fetch_all(&st.db)
            .await?
    } else {
        vec![]
    };
    sqlx::query("DELETE FROM channels WHERE id = $1").bind(id).execute(&st.db).await?;
    for c in &orphans {
        st.hub.send(&audience, "CHANNEL_UPDATE", c);
    }
    // Deleting a thread detaches it from its starter message.
    if let (kind::THREAD, Some(parent), Some(mid)) = (ch.kind, ch.parent_id, ch.thread_message_id) {
        sqlx::query("UPDATE messages SET thread_id = NULL WHERE id = $1").bind(mid).execute(&st.db).await?;
        if let Ok(row) = load_message(&st, parent, mid).await {
            if let Some(msg) = hydrate(&st, vec![row]).await?.pop() {
                st.hub.send(&audience, "MESSAGE_UPDATE", &msg);
            }
        }
    }
    st.hub.send(&audience, "CHANNEL_DELETE", &json!({ "id": ch.id, "guild_id": ch.guild_id, "parent_id": ch.parent_id }));
    Ok(())
}

#[derive(Deserialize)]
struct NewThread {
    name: Option<String>,
}

/// Starts a thread from a message in a text channel.
async fn create_thread(
    State(st): State<AppState>,
    AuthUser(me): AuthUser,
    Path((id, mid)): Path<(Id, Id)>,
    Json(body): Json<NewThread>,
) -> ApiResult<Json<Channel>> {
    let a = channel_for(&st, id, me).await?;
    if a.ch.kind != kind::TEXT {
        return Err(bad("threads can only be started in text channels"));
    }
    a.require(perms::CREATE_THREADS)?;
    let msg = load_message(&st, id, mid).await?;
    if msg.thread_id.is_some() {
        return Err(bad("this message already has a thread"));
    }
    let fallback: String = msg.content.lines().next().unwrap_or("").chars().take(40).collect();
    let name = body.name.filter(|n| !n.trim().is_empty()).unwrap_or(if fallback.trim().is_empty() { "thread".into() } else { fallback });
    let name = channel_name(&name, kind::THREAD)?;

    let thread_id = Id::new();
    let mut tx = st.db.begin().await?;
    let thread = sqlx::query_as::<_, Channel>(&format!(
        "INSERT INTO channels (id, guild_id, kind, name, parent_id, owner_id, thread_message_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING {CHANNEL_COLS}"
    ))
    .bind(thread_id)
    .bind(a.ch.guild_id)
    .bind(kind::THREAD)
    .bind(name)
    .bind(id)
    .bind(me)
    .bind(mid)
    .fetch_one(&mut *tx)
    .await?;
    let row = sqlx::query_as(&format!("UPDATE messages SET thread_id = $2 WHERE id = $1 RETURNING {MESSAGE_COLS}"))
        .bind(mid)
        .bind(thread_id)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;

    let audience = channel_audience(&st.db, &thread).await?;
    st.hub.send(&audience, "CHANNEL_CREATE", &thread);
    if let Some(msg) = hydrate(&st, vec![row]).await?.pop() {
        st.hub.send(&audience, "MESSAGE_UPDATE", &msg);
    }
    Ok(Json(thread))
}
