use axum::extract::{Path, State};
use axum::routing::{post, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use sqlx::PgPool;

use crate::api::channels::channel_for;
use crate::api::relationships::{are_friends, blocked_between};
use crate::auth::AuthUser;
use crate::error::{bad, ApiError, ApiResult};
use crate::id::Id;
use crate::models::{kind, prefixed, Channel, DmChannel, User, CHANNEL_COLS};
use crate::state::AppState;

const MAX_GROUP: usize = 10;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/users/@me/channels", post(open_dm))
        .route("/channels/{id}/recipients/{user}", put(add_recipient).delete(remove_recipient))
}

pub async fn recipients(db: &PgPool, channel: Id) -> ApiResult<Vec<Id>> {
    Ok(sqlx::query_scalar("SELECT user_id FROM dm_recipients WHERE channel_id = $1").bind(channel).fetch_all(db).await?)
}

async fn load_dm(db: &PgPool, ch: Channel) -> ApiResult<DmChannel> {
    let ids = recipients(db, ch.id).await?;
    Ok(DmChannel { channel: ch, recipients: User::get_many(db, &ids).await? })
}

pub async fn load_dms(db: &PgPool, me: Id) -> ApiResult<Vec<DmChannel>> {
    let chans = sqlx::query_as::<_, Channel>(&format!(
        "SELECT {} FROM channels c JOIN dm_recipients r ON r.channel_id = c.id AND r.user_id = $1
         ORDER BY c.last_message_id DESC NULLS LAST",
        prefixed(CHANNEL_COLS, "c")
    ))
    .bind(me)
    .fetch_all(db)
    .await?;
    let mut out = Vec::with_capacity(chans.len());
    for ch in chans {
        out.push(load_dm(db, ch).await?);
    }
    Ok(out)
}

async fn shares_guild(db: &PgPool, a: Id, b: Id) -> ApiResult<bool> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM members x JOIN members y ON y.guild_id = x.guild_id WHERE x.user_id = $1 AND y.user_id = $2)",
    )
    .bind(a)
    .bind(b)
    .fetch_one(db)
    .await?)
}

#[derive(Deserialize)]
struct OpenDm {
    recipient_id: Option<Id>,
    /// Two or more friends: creates a group DM.
    #[serde(default)]
    recipients: Vec<Id>,
}

/// Returns the existing 1:1 DM with the recipient, or creates one. With `recipients`, creates a group DM.
async fn open_dm(State(st): State<AppState>, AuthUser(me): AuthUser, Json(body): Json<OpenDm>) -> ApiResult<Json<DmChannel>> {
    let mut others: Vec<Id> = body.recipients.into_iter().chain(body.recipient_id).filter(|u| *u != me).collect();
    others.sort();
    others.dedup();
    match others.as_slice() {
        [] => Err(bad("pick someone to message")),
        [other] => open_direct(&st, me, *other).await,
        _ => create_group(&st, me, others).await,
    }
}

pub async fn open_direct(st: &AppState, me: Id, other: Id) -> ApiResult<Json<DmChannel>> {
    User::get(&st.db, other).await?;
    let existing = sqlx::query_as::<_, Channel>(&format!(
        "SELECT {} FROM channels c
         JOIN dm_recipients a ON a.channel_id = c.id AND a.user_id = $1
         JOIN dm_recipients b ON b.channel_id = c.id AND b.user_id = $2
         WHERE c.kind = $3 LIMIT 1",
        prefixed(CHANNEL_COLS, "c")
    ))
    .bind(me)
    .bind(other)
    .bind(kind::DM)
    .fetch_optional(&st.db)
    .await?;
    if let Some(ch) = existing {
        return Ok(Json(load_dm(&st.db, ch).await?));
    }
    if blocked_between(&st.db, me, other).await? {
        return Err(bad("you can't message this user"));
    }
    if !are_friends(&st.db, me, other).await? && !shares_guild(&st.db, me, other).await? {
        return Err(bad("add them as a friend first"));
    }
    create(st, me, kind::DM, &[me, other]).await
}

async fn create_group(st: &AppState, me: Id, others: Vec<Id>) -> ApiResult<Json<DmChannel>> {
    if others.len() + 1 > MAX_GROUP {
        return Err(bad(format!("group DMs can have up to {MAX_GROUP} people")));
    }
    for o in &others {
        if !are_friends(&st.db, me, *o).await? {
            return Err(bad("you can only add friends to a group DM"));
        }
    }
    let mut members = others;
    members.push(me);
    create(st, me, kind::GROUP_DM, &members).await
}

async fn create(st: &AppState, me: Id, k: i16, members: &[Id]) -> ApiResult<Json<DmChannel>> {
    let mut tx = st.db.begin().await?;
    let ch = sqlx::query_as::<_, Channel>(&format!("INSERT INTO channels (id, kind, owner_id) VALUES ($1, $2, $3) RETURNING {CHANNEL_COLS}"))
        .bind(Id::new())
        .bind(k)
        .bind(me)
        .fetch_one(&mut *tx)
        .await?;
    for m in members {
        sqlx::query("INSERT INTO dm_recipients (channel_id, user_id) VALUES ($1, $2)").bind(ch.id).bind(m).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    let dm = load_dm(&st.db, ch).await?;
    st.hub.send(members, "CHANNEL_CREATE", &dm);
    Ok(Json(dm))
}

async fn add_recipient(State(st): State<AppState>, AuthUser(me): AuthUser, Path((id, user)): Path<(Id, Id)>) -> ApiResult<()> {
    let a = channel_for(&st, id, me).await?;
    if a.ch.kind != kind::GROUP_DM {
        return Err(bad("people can only be added to group DMs"));
    }
    if !are_friends(&st.db, me, user).await? {
        return Err(bad("you can only add friends"));
    }
    let current = recipients(&st.db, id).await?;
    if current.contains(&user) {
        return Ok(());
    }
    if current.len() >= MAX_GROUP {
        return Err(bad(format!("group DMs can have up to {MAX_GROUP} people")));
    }
    sqlx::query("INSERT INTO dm_recipients (channel_id, user_id) VALUES ($1, $2)").bind(id).bind(user).execute(&st.db).await?;
    let added = User::get(&st.db, user).await?;
    st.hub.send(&current, "CHANNEL_RECIPIENT_ADD", &json!({ "channel_id": id, "user": added }));
    st.hub.send(&[user], "CHANNEL_CREATE", &load_dm(&st.db, a.ch).await?);
    Ok(())
}

/// Leave a group (yourself) or remove someone (group owner).
async fn remove_recipient(State(st): State<AppState>, AuthUser(me): AuthUser, Path((id, user)): Path<(Id, Id)>) -> ApiResult<()> {
    let a = channel_for(&st, id, me).await?;
    if a.ch.kind != kind::GROUP_DM {
        return Err(bad("not a group DM"));
    }
    if user != me && a.ch.owner_id != Some(me) {
        return Err(ApiError::Forbidden);
    }
    leave_group(&st, a.ch.id, a.ch.owner_id, user).await
}

/// Removes `user` from a group DM, handing ownership on or deleting the group when it empties.
pub async fn leave_group(st: &AppState, id: Id, owner: Option<Id>, user: Id) -> ApiResult<()> {
    if crate::voice::channel_of(st, user).is_some_and(|(_, ch)| ch == id) {
        crate::voice::leave(st, user).await;
    }
    sqlx::query("DELETE FROM dm_recipients WHERE channel_id = $1 AND user_id = $2").bind(id).bind(user).execute(&st.db).await?;
    let rest = recipients(&st.db, id).await?;
    if rest.is_empty() {
        sqlx::query("DELETE FROM channels WHERE id = $1").bind(id).execute(&st.db).await?;
    } else if owner == Some(user) {
        sqlx::query("UPDATE channels SET owner_id = $2 WHERE id = $1").bind(id).bind(rest[0]).execute(&st.db).await?;
        st.hub.send(&rest, "CHANNEL_UPDATE", &Channel::get(&st.db, id).await?);
    }
    st.hub.send(&rest, "CHANNEL_RECIPIENT_REMOVE", &json!({ "channel_id": id, "user_id": user }));
    st.hub.send(&[user], "CHANNEL_DELETE", &json!({ "id": id, "guild_id": null }));
    Ok(())
}
