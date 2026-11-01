use axum::extract::{Path, State};
use axum::routing::{patch, post, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::api::messages::{hydrate, load_message};
use crate::auth::AuthUser;
use crate::error::{bad, ApiError, ApiResult};
use crate::gateway::{announce_visibility, channel_audience, visibility};
use crate::id::Id;
use crate::models::{kind, Channel, CHANNEL_COLS, MESSAGE_COLS};
use crate::perms::{self, guild_perms, load_overwrites, Overwrite, Perms};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/guilds/{id}/channels", post(create_channel).put(reorder_channels))
        .route("/channels/{id}", patch(update_channel).delete(delete_channel))
        .route("/channels/{id}/messages/{mid}/threads", post(create_thread))
        .route("/channels/{id}/permissions", put(put_overwrites))
        .route("/channels/{id}/permissions/sync", post(sync_overwrites))
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
        Some(g) => {
            let p = perms::channel_perms(&st.db, g, id, me).await?;
            if !p.has(perms::VIEW_CHANNEL) {
                return Err(ApiError::NotFound);
            }
            p
        }
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
    /// Its overwrites (a private channel); left out = the category's (synced), or none.
    permission_overwrites: Option<Vec<Overwrite>>,
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
    let mine = guild_perms(&st.db, gid, me).await?;
    mine.require(perms::MANAGE_CHANNELS)?;
    if ![kind::TEXT, kind::VOICE, kind::CATEGORY].contains(&body.kind) {
        return Err(bad("invalid channel kind"));
    }
    let parent = match body.parent_id.filter(|_| body.kind != kind::CATEGORY) {
        Some(p) => Some(category_of(&st, gid, p).await?),
        None => None,
    };
    let inherited = match parent {
        Some(p) => load_overwrites(&st.db, p).await?,
        None => vec![],
    };
    let overwrites = match body.permission_overwrites {
        Some(list) => {
            // Permissions changed from what the channel would inherit must be ones you have there.
            let have = match parent {
                Some(p) => perms::channel_perms(&st.db, gid, p, me).await?,
                None => mine,
            };
            let list = clean_overwrites(&st, gid, list).await?;
            check_overwrite_change(&have, &inherited, &list)?;
            list
        }
        None => inherited,
    };
    let name = channel_name(&body.name, body.kind)?;
    let mut tx = st.db.begin().await?;
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
    .fetch_one(&mut *tx)
    .await?;
    write_overwrites(&mut tx, ch.id, &overwrites).await?;
    tx.commit().await?;
    let ch = ch.with_overwrites(&st.db).await?;
    st.hub.send(&channel_audience(&st.db, &ch).await?, "CHANNEL_CREATE", &ch);
    Ok(Json(ch))
}

const MAX_OVERWRITES: usize = 100;

/// Validates overwrites for a server's channel: known roles (@everyone = the server's id) and members, only
/// channel permissions, never allowing and denying the same one, sorted like `load_overwrites`.
async fn clean_overwrites(st: &AppState, gid: Id, list: Vec<Overwrite>) -> ApiResult<Vec<Overwrite>> {
    if list.len() > MAX_OVERWRITES {
        return Err(bad("a channel can have up to 100 permission overwrites"));
    }
    let roles: Vec<Id> = sqlx::query_scalar("SELECT id FROM roles WHERE guild_id = $1").bind(gid).fetch_all(&st.db).await?;
    let members: Vec<Id> = sqlx::query_scalar("SELECT user_id FROM members WHERE guild_id = $1").bind(gid).fetch_all(&st.db).await?;
    let mut out: Vec<Overwrite> = Vec::with_capacity(list.len());
    for mut o in list {
        let known = match o.kind {
            perms::OVERWRITE_ROLE => roles.contains(&o.id),
            perms::OVERWRITE_MEMBER => members.contains(&o.id),
            _ => false,
        };
        if !known {
            return Err(bad("unknown role or member"));
        }
        if out.iter().any(|x| x.id == o.id) {
            return Err(bad("each role or member can only have one overwrite"));
        }
        o.allow &= perms::CHANNEL;
        o.deny &= perms::CHANNEL & !o.allow;
        out.push(o);
    }
    out.sort_by_key(|o| (o.kind, o.id));
    Ok(out)
}

/// Bits whose state differs between two overwrite lists for any role or member.
fn changed_bits(old: &[Overwrite], new: &[Overwrite]) -> i64 {
    let find = |l: &[Overwrite], o: &Overwrite| l.iter().find(|x| x.id == o.id && x.kind == o.kind).map(|x| (x.allow, x.deny)).unwrap_or((0, 0));
    let mut bits = 0;
    for o in old.iter().chain(new) {
        let (a1, d1) = find(old, o);
        let (a2, d2) = find(new, o);
        bits |= (a1 ^ a2) | (d1 ^ d2);
    }
    bits
}

/// Like Discord, you can only allow or deny permissions you have in the channel yourself.
fn check_overwrite_change(mine: &Perms, old: &[Overwrite], new: &[Overwrite]) -> ApiResult<()> {
    if mine.has(perms::ADMINISTRATOR) || changed_bits(old, new) & !mine.bits == 0 {
        Ok(())
    } else {
        Err(bad("you cannot change permissions you don't have"))
    }
}

async fn write_overwrites(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, channel: Id, list: &[Overwrite]) -> ApiResult<()> {
    sqlx::query("DELETE FROM channel_overwrites WHERE channel_id = $1").bind(channel).execute(&mut **tx).await?;
    for o in list {
        sqlx::query("INSERT INTO channel_overwrites (channel_id, target_id, kind, allow, deny) VALUES ($1, $2, $3, $4, $5)")
            .bind(channel)
            .bind(o.id)
            .bind(o.kind)
            .bind(o.allow)
            .bind(o.deny)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}

/// Gives a channel new overwrites, tells everyone who can see it, and adds it to / removes it from the lists of
/// people who gained or lost access. A category's synced channels (same overwrites as it) change with it.
async fn replace_overwrites(st: &AppState, gid: Id, ch: &Channel, list: Vec<Overwrite>) -> ApiResult<Vec<Overwrite>> {
    let before = visibility(&st.db, gid).await?;
    let old = load_overwrites(&st.db, ch.id).await?;
    let mut targets = vec![ch.id];
    if ch.kind == kind::CATEGORY {
        let children: Vec<Id> = sqlx::query_scalar("SELECT id FROM channels WHERE parent_id = $1 AND kind <> $2")
            .bind(ch.id)
            .bind(kind::THREAD)
            .fetch_all(&st.db)
            .await?;
        for c in children {
            if load_overwrites(&st.db, c).await? == old {
                targets.push(c);
            }
        }
    }
    let mut tx = st.db.begin().await?;
    for t in &targets {
        write_overwrites(&mut tx, *t, &list).await?;
    }
    tx.commit().await?;
    announce_visibility(st, gid, before).await?;
    for t in targets {
        let c = Channel::get(&st.db, t).await?.with_overwrites(&st.db).await?;
        st.hub.send(&channel_audience(&st.db, &c).await?, "CHANNEL_UPDATE", &c);
    }
    Ok(list)
}

#[derive(Deserialize)]
struct OverwritesBody {
    permission_overwrites: Vec<Overwrite>,
}

/// Editing a channel's overwrites needs Manage Permissions (Manage Roles) in it.
async fn overwritable(st: &AppState, id: Id, me: Id) -> ApiResult<(Id, Access)> {
    let a = channel_for(st, id, me).await?;
    let gid = a.ch.guild_id.ok_or_else(|| bad("only server channels have permissions"))?;
    if a.ch.kind == kind::THREAD {
        return Err(bad("threads use their channel's permissions"));
    }
    a.require(perms::MANAGE_ROLES)?;
    Ok((gid, a))
}

async fn put_overwrites(State(st): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<Id>, Json(body): Json<OverwritesBody>) -> ApiResult<Json<Vec<Overwrite>>> {
    let (gid, a) = overwritable(&st, id, me).await?;
    let list = clean_overwrites(&st, gid, body.permission_overwrites).await?;
    check_overwrite_change(&a.perms, &load_overwrites(&st.db, id).await?, &list)?;
    Ok(Json(replace_overwrites(&st, gid, &a.ch, list).await?))
}

/// Gives a channel its category's overwrites again ("Sync Now").
async fn sync_overwrites(State(st): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<Id>) -> ApiResult<Json<Vec<Overwrite>>> {
    let (gid, a) = overwritable(&st, id, me).await?;
    let parent = a.ch.parent_id.ok_or_else(|| bad("this channel isn't in a category"))?;
    let list = load_overwrites(&st.db, parent).await?;
    check_overwrite_change(&a.perms, &load_overwrites(&st.db, id).await?, &list)?;
    Ok(Json(replace_overwrites(&st, gid, &a.ch, list).await?))
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
    // Only channels you can see and manage move: moving one can change who sees it.
    let ctx = crate::perms::GuildCtx::load(&st.db, gid).await?;
    if body.ids.iter().any(|id| !ctx.can(me, *id, perms::VIEW_CHANNEL)) {
        return Err(ApiError::Forbidden);
    }
    if body.parents.keys().any(|id| !ctx.can(me, *id, perms::VIEW_CHANNEL | perms::MANAGE_CHANNELS)) {
        return Err(ApiError::Forbidden);
    }
    if body.parents.values().flatten().any(|parent| !ctx.can(me, *parent, perms::VIEW_CHANNEL)) {
        return Err(ApiError::Forbidden);
    }
    let current: Vec<(Id, i32, i16, Option<Id>)> = sqlx::query_as("SELECT id, position, kind, parent_id FROM channels WHERE guild_id = $1 AND kind <> $2")
        .bind(gid)
        .bind(kind::THREAD)
        .fetch_all(&st.db)
        .await?;
    // Clients send the channels they can see; channels hidden from them keep their places around those.
    let mut sorted = body.ids.clone();
    sorted.sort();
    sorted.dedup();
    if sorted.len() != body.ids.len() || !sorted.iter().all(|id| current.iter().any(|(c, ..)| c == id)) {
        return Err(bad("send every channel of the server exactly once"));
    }
    let mut full: Vec<&(Id, i32, i16, Option<Id>)> = current.iter().collect();
    full.sort_by_key(|(id, pos, ..)| (*pos, *id));
    let mut given = body.ids.iter();
    let order: Vec<Id> = full.iter().map(|(id, ..)| if sorted.binary_search(id).is_ok() { *given.next().unwrap() } else { *id }).collect();
    let is_category = |id: Id| current.iter().any(|(c, _, k, _)| *c == id && *k == kind::CATEGORY);
    for (id, parent) in &body.parents {
        // Only text and voice channels go in categories, and categories don't nest.
        if is_category(*id) || parent.is_some_and(|p| !is_category(p)) {
            return Err(bad("unknown category"));
        }
    }
    // A channel moved into another category takes its overwrites when it was synced with its old category (or
    // had none), like Discord.
    let mut resync: Vec<(Id, Vec<Overwrite>)> = vec![];
    for (id, parent) in &body.parents {
        let Some((_, _, _, old_parent)) = current.iter().find(|(c, ..)| c == id) else { continue };
        let Some(new_parent) = parent.filter(|p| Some(*p) != *old_parent) else { continue };
        let own = load_overwrites(&st.db, *id).await?;
        let was_synced = match old_parent {
            Some(op) => own == load_overwrites(&st.db, *op).await?,
            None => own.is_empty(),
        };
        if was_synced {
            let new = load_overwrites(&st.db, new_parent).await?;
            check_overwrite_change(&channel_for(&st, *id, me).await?.perms, &own, &new)?;
            resync.push((*id, new));
        }
    }
    let before = if resync.is_empty() { None } else { Some(visibility(&st.db, gid).await?) };
    let mut tx = st.db.begin().await?;
    let mut moved = vec![];
    for (pos, id) in order.iter().enumerate() {
        let Some((_, old_pos, _, old_parent)) = current.iter().find(|(c, ..)| c == id) else { continue };
        let parent = body.parents.get(id).copied().unwrap_or(*old_parent);
        if *old_pos != pos as i32 || parent != *old_parent {
            sqlx::query("UPDATE channels SET position = $2, parent_id = $3 WHERE id = $1").bind(id).bind(pos as i32).bind(parent).execute(&mut *tx).await?;
            moved.push(*id);
        }
    }
    for (id, list) in &resync {
        write_overwrites(&mut tx, *id, list).await?;
    }
    tx.commit().await?;
    if let Some(before) = before {
        announce_visibility(&st, gid, before).await?;
    }
    for id in moved {
        let ch = Channel::get(&st.db, id).await?.with_overwrites(&st.db).await?;
        st.hub.send(&channel_audience(&st.db, &ch).await?, "CHANNEL_UPDATE", &ch);
    }
    Ok(())
}

#[derive(Deserialize)]
struct ChannelUpdate {
    name: Option<String>,
    topic: Option<String>,
    archived: Option<bool>,
    /// Group DMs: hand the group to another member (owner only).
    owner_id: Option<Id>,
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
    let owner = match body.owner_id {
        Some(o) if ch.kind == kind::GROUP_DM => {
            if ch.owner_id != Some(me) {
                return Err(bad("only the group owner can do that"));
            }
            if !crate::api::dms::recipients(&st.db, id).await?.contains(&o) {
                return Err(bad("they aren't in this group"));
            }
            Some(o)
        }
        Some(_) => return Err(bad("only group DMs have an owner to change")),
        None => ch.owner_id,
    };
    let ch = sqlx::query_as::<_, Channel>(&format!(
        "UPDATE channels SET name = $2, topic = $3, archived = $4, owner_id = $5 WHERE id = $1 RETURNING {CHANNEL_COLS}"
    ))
    .bind(id)
    .bind(name)
    .bind(body.topic.map(|t| t.trim().to_string()).unwrap_or(ch.topic))
    .bind(archived)
    .bind(owner)
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
        st.hub.send(&channel_audience(&st.db, c).await?, "CHANNEL_UPDATE", c);
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
    a.require(perms::READ_MESSAGE_HISTORY)?;
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
