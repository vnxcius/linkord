//! DM receipts, WhatsApp-style: sent (the server has it), delivered (one of the recipient's devices got it) and read
//! (their read state reached it). Only DMs and group DMs have them.
//!
//! Delivered = a recipient had a gateway socket open when the message went out, their phone got its push (the Android
//! app reports it: POST /channels/{id}/delivered), or they connected afterwards (on_connect). Read positions are the
//! read_states the unread markers use (messages.rs upsert_read_state calls on_read). Each change reaches the other
//! people in the conversation as DM_RECEIPT {channel_id, user_id, delivered_id?, read_id?}; READY has everyone's
//! as dm_receipts {channel_id: [{user_id, delivered_id, read_id}]}. Clients read delivered as the larger of the two.
//! Privacy (users.read_receipts): someone's read positions reach another person only while both have read receipts
//! on, WhatsApp-style (off = nobody sees when you read, and you don't see when they do; delivered still shows).
//! Turning it on or off sends DM_RECEIPTS {receipts} (the whole dm_receipts again) to everyone it changes things for.
//! Each move is also logged in receipt_marks, so Message info (GET /channels/{id}/messages/{mid}/receipts, the
//! author only) can say when a message was delivered and read.

use std::collections::HashMap;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::PgPool;

use crate::auth::AuthUser;
use crate::error::ApiResult;
use crate::id::Id;
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/channels/{id}/delivered", post(delivered))
        .route("/channels/{id}/messages/{mid}/receipts", get(message_receipts))
}

#[derive(Serialize)]
pub struct Receipt {
    user_id: Id,
    delivered_id: Option<Id>,
    read_id: Option<Id>,
}

/// The other people's receipts in each of `me`'s DMs and group DMs (READY), their reads only while both of you
/// have read receipts on.
pub async fn for_ready(db: &PgPool, me: Id) -> ApiResult<HashMap<Id, Vec<Receipt>>> {
    let rows = sqlx::query_as::<_, (Id, Id, Option<Id>, Option<Id>)>(
        "SELECT r.channel_id, r.user_id, d.last_delivered_id,
                CASE WHEN mu.read_receipts AND ru.read_receipts THEN rs.last_read_id END
         FROM dm_recipients mine
         JOIN users mu ON mu.id = mine.user_id
         JOIN dm_recipients r ON r.channel_id = mine.channel_id AND r.user_id <> $1
         JOIN users ru ON ru.id = r.user_id
         LEFT JOIN delivered_states d ON d.user_id = r.user_id AND d.channel_id = r.channel_id
         LEFT JOIN read_states rs ON rs.user_id = r.user_id AND rs.channel_id = r.channel_id
         WHERE mine.user_id = $1",
    )
    .bind(me)
    .fetch_all(db)
    .await?;
    let mut out: HashMap<Id, Vec<Receipt>> = HashMap::new();
    for (channel, user_id, delivered_id, read_id) in rows {
        out.entry(channel).or_default().push(Receipt { user_id, delivered_id, read_id });
    }
    Ok(out)
}

/// Someone turned read receipts on or off: they and everyone they share a DM with get their receipts again.
pub fn on_setting(st: &AppState, user: Id, on: bool) {
    let st = st.clone();
    tokio::spawn(async move {
        let people: Vec<Id> = match sqlx::query_scalar(
            "SELECT DISTINCT r.user_id FROM dm_recipients mine JOIN dm_recipients r ON r.channel_id = mine.channel_id WHERE mine.user_id = $1",
        )
        .bind(user)
        .fetch_all(&st.db)
        .await
        {
            Ok(p) => p,
            Err(e) => return tracing::warn!("receipts: {e:?}"),
        };
        for p in people.into_iter().chain(std::iter::once(user)).collect::<std::collections::HashSet<_>>() {
            match for_ready(&st.db, p).await {
                Ok(r) if p == user => st.hub.send(&[p], "DM_RECEIPTS", &json!({ "receipts": r, "read_receipts": on })),
                Ok(r) => st.hub.send(&[p], "DM_RECEIPTS", &json!({ "receipts": r })),
                Err(e) => tracing::warn!("receipts: {e:?}"),
            }
        }
    });
}

/// The others in a DM or group DM; empty for any other channel.
async fn others(db: &PgPool, channel: Id, user: Id) -> ApiResult<Vec<Id>> {
    Ok(sqlx::query_scalar("SELECT user_id FROM dm_recipients WHERE channel_id = $1 AND user_id <> $2").bind(channel).bind(user).fetch_all(db).await?)
}

/// Someone's read state moved (messages.rs upsert_read_state): what they read has reached them too (delivered), and
/// the others in the DM see it read if both have read receipts on.
pub async fn on_read(st: &AppState, user: Id, channel: Id, message: Id) -> ApiResult<()> {
    let to: Vec<Id> = sqlx::query_scalar(
        "SELECT r.user_id FROM dm_recipients r JOIN users u ON u.id = r.user_id
         WHERE r.channel_id = $1 AND r.user_id <> $2 AND u.read_receipts AND (SELECT read_receipts FROM users WHERE id = $2)",
    )
    .bind(channel)
    .bind(user)
    .fetch_all(&st.db)
    .await?;
    if others(&st.db, channel, user).await?.is_empty() {
        return Ok(());
    }
    // Logged only when it's further than any read mark before (acks repeat).
    sqlx::query(
        "INSERT INTO receipt_marks (channel_id, user_id, read, message_id)
         SELECT $1, $2, true, $3
         WHERE NOT EXISTS (SELECT 1 FROM receipt_marks WHERE channel_id = $1 AND user_id = $2 AND read AND message_id >= $3)",
    )
    .bind(channel)
    .bind(user)
    .bind(message)
    .execute(&st.db)
    .await?;
    mark(st, channel, &[user], message).await?;
    if !to.is_empty() {
        st.hub.send(&to, "DM_RECEIPT", &json!({ "channel_id": channel, "user_id": user, "read_id": message }));
    }
    Ok(())
}

/// Moves `users`' delivered positions in a DM to `message` and tells the rest of the conversation. Returns whose moved.
async fn mark(st: &AppState, channel: Id, users: &[Id], message: Id) -> ApiResult<Vec<Id>> {
    if users.is_empty() {
        return Ok(vec![]);
    }
    let moved: Vec<Id> = sqlx::query_scalar(
        "INSERT INTO delivered_states (user_id, channel_id, last_delivered_id)
         SELECT u, $2, $3 FROM UNNEST($1::BIGINT[]) AS u
           WHERE EXISTS (SELECT 1 FROM dm_recipients WHERE channel_id = $2 AND user_id = u)
         ON CONFLICT (user_id, channel_id) DO UPDATE SET last_delivered_id = EXCLUDED.last_delivered_id
           WHERE delivered_states.last_delivered_id < EXCLUDED.last_delivered_id
         RETURNING user_id",
    )
    .bind(users)
    .bind(channel)
    .bind(message)
    .fetch_all(&st.db)
    .await?;
    if moved.is_empty() {
        return Ok(moved);
    }
    sqlx::query("INSERT INTO receipt_marks (channel_id, user_id, read, message_id) SELECT $1, u, false, $2 FROM UNNEST($3::BIGINT[]) AS u")
        .bind(channel)
        .bind(message)
        .bind(&moved)
        .execute(&st.db)
        .await?;
    let everyone: Vec<Id> = sqlx::query_scalar("SELECT user_id FROM dm_recipients WHERE channel_id = $1").bind(channel).fetch_all(&st.db).await?;
    for u in &moved {
        let to: Vec<Id> = everyone.iter().copied().filter(|x| x != u).collect();
        st.hub.send(&to, "DM_RECEIPT", &json!({ "channel_id": channel, "user_id": u, "delivered_id": message }));
    }
    Ok(moved)
}

/// A new DM went out (messages.rs post_message): it reached the recipients with a socket open right now.
pub fn on_message(st: &AppState, channel: Id, author: Id, message: Id, audience: &[Id]) {
    let live: Vec<Id> = audience.iter().copied().filter(|u| *u != author && st.hub.has_socket(*u)).collect();
    if live.is_empty() {
        return;
    }
    let st = st.clone();
    tokio::spawn(async move {
        if let Err(e) = mark(&st, channel, &live, message).await {
            tracing::warn!("receipts: {e:?}");
        }
    });
}

/// Someone connected: everything already in their DMs has reached a device of theirs now.
pub fn on_connect(st: &AppState, user: Id) {
    let st = st.clone();
    tokio::spawn(async move {
        let moved = sqlx::query_as::<_, (Id, Id)>(
            "INSERT INTO delivered_states (user_id, channel_id, last_delivered_id)
             SELECT $1, c.id, c.last_message_id FROM channels c JOIN dm_recipients r ON r.channel_id = c.id AND r.user_id = $1
               WHERE c.last_message_id IS NOT NULL
             ON CONFLICT (user_id, channel_id) DO UPDATE SET last_delivered_id = EXCLUDED.last_delivered_id
               WHERE delivered_states.last_delivered_id < EXCLUDED.last_delivered_id
             RETURNING channel_id, last_delivered_id",
        )
        .bind(user)
        .fetch_all(&st.db)
        .await;
        let moved = match moved {
            Ok(m) => m,
            Err(e) => return tracing::warn!("receipts: {e:?}"),
        };
        for (channel, message) in moved {
            let _ = sqlx::query("INSERT INTO receipt_marks (channel_id, user_id, read, message_id) VALUES ($1, $2, false, $3)")
                .bind(channel)
                .bind(user)
                .bind(message)
                .execute(&st.db)
                .await;
            match others(&st.db, channel, user).await {
                Ok(to) => st.hub.send(&to, "DM_RECEIPT", &json!({ "channel_id": channel, "user_id": user, "delivered_id": message })),
                Err(e) => tracing::warn!("receipts: {e:?}"),
            }
        }
    });
}

#[derive(Deserialize)]
struct Delivered {
    message_id: Id,
}

/// The Android app got a DM's push while closed: it reached the phone.
async fn delivered(State(st): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<Id>, Json(b): Json<Delivered>) -> ApiResult<StatusCode> {
    st.limits.check(format!("delivered:{me}"), 20.0, 2.0)?;
    // Never past the channel's newest message: a made-up id can't mark future messages delivered.
    let last: Option<Option<Id>> = sqlx::query_scalar("SELECT last_message_id FROM channels WHERE id = $1").bind(id).fetch_optional(&st.db).await?;
    if let Some(Some(last)) = last {
        let message = if b.message_id > last { last } else { b.message_id };
        mark(&st, id, &[me], message).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize, sqlx::FromRow)]
struct MessageReceipt {
    user_id: Id,
    delivered: bool,
    read: bool,
    /// False when either of you has read receipts off: then `read` and `read_at` say nothing.
    read_receipts: bool,
    /// Null when it happened before times were kept.
    delivered_at: Option<chrono::DateTime<chrono::Utc>>,
    read_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// Message info: when each of the others got your message and read it. Only its author may ask.
async fn message_receipts(State(st): State<AppState>, AuthUser(me): AuthUser, Path((id, mid)): Path<(Id, Id)>) -> ApiResult<Json<Vec<MessageReceipt>>> {
    let author: Option<Id> = sqlx::query_scalar("SELECT author_id FROM messages WHERE id = $1 AND channel_id = $2").bind(mid).bind(id).fetch_optional(&st.db).await?;
    if author != Some(me) {
        return Err(crate::error::ApiError::NotFound);
    }
    let rows = sqlx::query_as::<_, MessageReceipt>(
        "SELECT r.user_id,
                COALESCE(d.last_delivered_id >= $2, false) OR COALESCE(rs.last_read_id >= $2, false) AS delivered,
                shown AND COALESCE(rs.last_read_id >= $2, false) AS read,
                shown AS read_receipts,
                (SELECT min(at) FROM receipt_marks m WHERE m.channel_id = $1 AND m.user_id = r.user_id AND m.message_id >= $2) AS delivered_at,
                CASE WHEN shown THEN
                  (SELECT min(at) FROM receipt_marks m WHERE m.channel_id = $1 AND m.user_id = r.user_id AND m.read AND m.message_id >= $2)
                END AS read_at
         FROM dm_recipients r
         JOIN users ru ON ru.id = r.user_id
         CROSS JOIN LATERAL (SELECT ru.read_receipts AND (SELECT read_receipts FROM users WHERE id = $3) AS shown) v
         LEFT JOIN delivered_states d ON d.user_id = r.user_id AND d.channel_id = r.channel_id
         LEFT JOIN read_states rs ON rs.user_id = r.user_id AND rs.channel_id = r.channel_id
         WHERE r.channel_id = $1 AND r.user_id <> $3",
    )
    .bind(id)
    .bind(mid)
    .bind(me)
    .fetch_all(&st.db)
    .await?;
    Ok(Json(rows))
}
