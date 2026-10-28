use std::collections::HashMap;

use axum::extract::{FromRequest, Multipart, Path, Query, Request, State};
use axum::http::header::CONTENT_TYPE;
use axum::routing::{get, patch, post, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::api::channels::{channel_for, Access};
use crate::api::relationships::blocked_between;
use crate::auth::AuthUser;
use crate::error::{bad, ApiError, ApiResult};
use crate::gateway::channel_audience;
use crate::id::Id;
use crate::models::{kind, Attachment, Message, MessageRef, MessageRow, Reaction, User, CHANNEL_COLS, MESSAGE_COLS};
use crate::perms::{self, guild_perms};
use crate::state::AppState;
use crate::{embeds, uploads};

const MAX_CONTENT: usize = 4000;
const MAX_ATTACHMENTS: usize = 10;
const MAX_PINS: i64 = 50;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/channels/{id}/messages", get(list_messages).post(create_message))
        .route("/channels/{id}/messages/search", get(search_channel))
        .route("/channels/{id}/messages/bulk-delete", post(bulk_delete))
        .route("/channels/{id}/messages/{mid}", patch(edit_message).delete(delete_message))
        .route("/channels/{id}/messages/{mid}/reactions/{emoji}", put(add_reaction).delete(remove_reaction))
        .route("/channels/{id}/pins", get(list_pins))
        .route("/channels/{id}/pins/{mid}", put(pin).delete(unpin))
        .route("/channels/{id}/typing", post(typing))
        .route("/channels/{id}/ack", post(ack))
        .route("/guilds/{id}/messages/search", get(search_guild))
}

/// Attaches authors, replied-to messages and reactions to raw message rows.
pub async fn hydrate(st: &AppState, rows: Vec<MessageRow>) -> ApiResult<Vec<Message>> {
    if rows.is_empty() {
        return Ok(vec![]);
    }
    let ids: Vec<Id> = rows.iter().map(|r| r.id).collect();
    let ref_ids: Vec<Id> = rows.iter().filter_map(|r| r.reply_to).collect();
    let refs: Vec<(Id, Id, String)> = sqlx::query_as("SELECT id, author_id, content FROM messages WHERE id = ANY($1)")
        .bind(&ref_ids)
        .fetch_all(&st.db)
        .await?;
    let mut user_ids: Vec<Id> = rows.iter().map(|r| r.author_id).chain(refs.iter().map(|r| r.1)).collect();
    user_ids.sort();
    user_ids.dedup();
    let users: HashMap<Id, User> = User::get_many(&st.db, &user_ids).await?.into_iter().map(|u| (u.id, u)).collect();
    let refs: HashMap<Id, MessageRef> = refs
        .into_iter()
        .filter_map(|(id, author, content)| Some((id, MessageRef { id, author: users.get(&author)?.clone(), content })))
        .collect();

    let mut reactions: HashMap<Id, Vec<Reaction>> = HashMap::new();
    let rows_r: Vec<(Id, String, Vec<Id>)> = sqlx::query_as(
        "SELECT message_id, emoji, array_agg(user_id ORDER BY created_at) FROM reactions
         WHERE message_id = ANY($1) GROUP BY message_id, emoji ORDER BY message_id, min(created_at)",
    )
    .bind(&ids)
    .fetch_all(&st.db)
    .await?;
    for (mid, emoji, users) in rows_r {
        reactions.entry(mid).or_default().push(Reaction { emoji, users });
    }

    Ok(rows
        .into_iter()
        .filter_map(|r| {
            Some(Message {
                id: r.id,
                channel_id: r.channel_id,
                author: users.get(&r.author_id)?.clone(),
                content: r.content,
                reply_to: r.reply_to,
                referenced_message: r.reply_to.and_then(|id| refs.get(&id).cloned()),
                attachments: r.attachments.0,
                embeds: r.embeds.0,
                reactions: reactions.remove(&r.id).unwrap_or_default(),
                mention_everyone: r.mention_everyone,
                pinned: r.pinned_at.is_some(),
                thread_id: r.thread_id,
                edited_at: r.edited_at,
                created_at: r.created_at,
                nonce: None,
            })
        })
        .collect())
}

pub async fn load_message(st: &AppState, channel: Id, id: Id) -> ApiResult<MessageRow> {
    sqlx::query_as::<_, MessageRow>(&format!("SELECT {MESSAGE_COLS} FROM messages WHERE id = $1 AND channel_id = $2"))
        .bind(id)
        .bind(channel)
        .fetch_optional(&st.db)
        .await?
        .ok_or(ApiError::NotFound)
}

async fn broadcast_message(st: &AppState, a: &Access, row: MessageRow) -> ApiResult<Message> {
    let msg = hydrate(st, vec![row]).await?.pop().ok_or(ApiError::NotFound)?;
    st.hub.send(&channel_audience(&st.db, &a.ch).await?, "MESSAGE_UPDATE", &msg);
    Ok(msg)
}

#[derive(Deserialize)]
struct Page {
    before: Option<Id>,
    after: Option<Id>,
    around: Option<Id>,
    limit: Option<i64>,
}

/// Messages oldest-first: the latest page, or a page before/after/around a message.
async fn list_messages(State(st): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<Id>, Query(p): Query<Page>) -> ApiResult<Json<Vec<Message>>> {
    channel_for(&st, id, me).await?;
    let limit = p.limit.unwrap_or(50).clamp(1, 100);
    let page = |cmp: &str, order: &str, anchor: Option<Id>, limit: i64| {
        let sql = format!(
            "SELECT {MESSAGE_COLS} FROM messages WHERE channel_id = $1 AND ($2::BIGINT IS NULL OR id {cmp} $2) ORDER BY id {order} LIMIT $3"
        );
        let db = st.db.clone();
        async move { sqlx::query_as::<_, MessageRow>(&sql).bind(id).bind(anchor).bind(limit).fetch_all(&db).await }
    };
    let rows = if let Some(anchor) = p.around {
        let mut older = page("<=", "DESC", Some(anchor), limit / 2 + 1).await?;
        older.reverse();
        older.extend(page(">", "ASC", Some(anchor), limit / 2).await?);
        older
    } else if p.after.is_some() {
        page(">", "ASC", p.after, limit).await?
    } else {
        let mut rows = page("<", "DESC", p.before, limit).await?;
        rows.reverse();
        rows
    };
    Ok(Json(hydrate(&st, rows).await?))
}

#[derive(Deserialize, Default)]
struct NewMessage {
    #[serde(default)]
    content: String,
    reply_to: Option<Id>,
    nonce: Option<String>,
    /// Set when the single attached file is a recorded voice message.
    voice: Option<VoiceMeta>,
}

#[derive(Deserialize)]
struct VoiceMeta {
    duration_secs: f64,
    waveform: String,
}

/// Voice messages are one audio file and nothing else, at most 20 minutes, with a short waveform.
fn mark_voice(attachments: &mut [Attachment], content: &str, meta: VoiceMeta) -> ApiResult<()> {
    use base64::Engine;
    let [att] = attachments else { return Err(bad("a voice message is a single audio file")) };
    let waveform = base64::engine::general_purpose::STANDARD.decode(&meta.waveform).map_err(|_| bad("invalid waveform"))?;
    if !att.content_type.starts_with("audio/") || !content.is_empty() {
        return Err(bad("a voice message is a single audio file"));
    }
    if !(meta.duration_secs.is_finite() && meta.duration_secs > 0.0 && meta.duration_secs <= 1200.0) || waveform.is_empty() || waveform.len() > 256 {
        return Err(bad("invalid waveform"));
    }
    att.duration_secs = Some((meta.duration_secs * 100.0).round() / 100.0);
    att.waveform = Some(meta.waveform);
    Ok(())
}

/// Accepts either a JSON body or multipart with a `payload_json` field plus files.
async fn create_message(State(st): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<Id>, req: Request) -> ApiResult<Json<Message>> {
    st.limits.check(format!("msg:{me}"), 8.0, 1.5)?;
    let a = channel_for(&st, id, me).await?;
    if !kind::has_messages(a.ch.kind) {
        return Err(bad("cannot send messages in this channel"));
    }
    a.require(perms::SEND_MESSAGES)?;
    if a.ch.kind == kind::DM {
        let other: Option<Id> = sqlx::query_scalar("SELECT user_id FROM dm_recipients WHERE channel_id = $1 AND user_id <> $2")
            .bind(id)
            .bind(me)
            .fetch_optional(&st.db)
            .await?;
        if let Some(other) = other {
            if blocked_between(&st.db, me, other).await? {
                return Err(bad("you can't message this user"));
            }
        }
    }

    let multipart = req.headers().get(CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|v| v.starts_with("multipart/"));
    let mut attachments = Vec::new();
    let body = if multipart {
        a.require(perms::ATTACH_FILES)?;
        let mut mp = Multipart::from_request(req, &st).await.map_err(|e| bad(e.body_text()))?;
        let mut payload = NewMessage::default();
        while let Some(field) = mp.next_field().await.map_err(|e| bad(e.body_text()))? {
            if field.name() == Some("payload_json") {
                let text = field.text().await.map_err(|e| bad(e.body_text()))?;
                payload = serde_json::from_str(&text).map_err(|e| bad(e.to_string()))?;
            } else if let Some(filename) = field.file_name().map(str::to_string) {
                if attachments.len() >= MAX_ATTACHMENTS {
                    return Err(bad("too many attachments"));
                }
                let content_type = field
                    .content_type()
                    .map(str::to_string)
                    .unwrap_or_else(|| mime_guess::from_path(&filename).first_or_octet_stream().to_string());
                let bytes = uploads::read_field(field, uploads::MAX_FILE).await?;
                uploads::reserve(&st, me, bytes.len()).await?;
                let url = uploads::save(&st, &format!("attachments/{}", a.ch.id), &filename, &bytes).await?;
                attachments.push(Attachment {
                    id: Id::new(),
                    filename: uploads::sanitize_filename(&filename),
                    url,
                    size: bytes.len() as u64,
                    content_type,
                    duration_secs: None,
                    waveform: None,
                });
            }
        }
        payload
    } else {
        Json::<NewMessage>::from_request(req, &st).await.map_err(|e| bad(e.body_text()))?.0
    };

    let content = body.content.trim().to_string();
    let mut body = body;
    if let Some(meta) = body.voice.take() {
        mark_voice(&mut attachments, &content, meta)?;
        uploads::remux_voice(&st, me, &mut attachments[0]).await;
    }
    if content.is_empty() && attachments.is_empty() {
        return Err(bad("message is empty"));
    }
    if content.chars().count() > MAX_CONTENT {
        return Err(bad(format!("message must be at most {MAX_CONTENT} characters")));
    }
    let reply_to = match body.reply_to {
        Some(r) => load_message(&st, a.ch.id, r).await.ok().map(|m| m.id),
        None => None,
    };
    let mention_everyone =
        a.ch.guild_id.is_some() && a.has(perms::MENTION_EVERYONE) && (content.contains("@everyone") || content.contains("@here"));

    let mid = Id::new();
    let row = sqlx::query_as::<_, MessageRow>(&format!(
        "INSERT INTO messages (id, channel_id, author_id, content, reply_to, attachments, mention_everyone)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING {MESSAGE_COLS}"
    ))
    .bind(mid)
    .bind(a.ch.id)
    .bind(me)
    .bind(&content)
    .bind(reply_to)
    .bind(sqlx::types::Json(&attachments))
    .bind(mention_everyone)
    .fetch_one(&st.db)
    .await?;
    // Posting in an archived thread brings it back, like Discord.
    let ch = sqlx::query_as::<_, crate::models::Channel>(&format!(
        "UPDATE channels SET last_message_id = $2, message_count = message_count + 1, archived = false WHERE id = $1 RETURNING {CHANNEL_COLS}"
    ))
    .bind(a.ch.id)
    .bind(mid)
    .fetch_one(&st.db)
    .await?;
    upsert_read_state(&st, me, a.ch.id, mid).await?;

    let audience = channel_audience(&st.db, &ch).await?;
    if ch.kind == kind::THREAD && (a.ch.archived || a.ch.message_count % 5 == 4) {
        // Keep sidebars' thread state (unarchive, reply count) roughly current without an event per message.
        st.hub.send(&audience, "CHANNEL_UPDATE", &ch);
    }
    let mut msg = hydrate(&st, vec![row]).await?.pop().ok_or(ApiError::NotFound)?;
    msg.nonce = body.nonce;
    st.hub.send(&audience, "MESSAGE_CREATE", &msg);
    embeds::spawn(st.clone(), ch, mid, content);
    Ok(Json(msg))
}

#[derive(Deserialize)]
struct EditMessage {
    content: String,
}

async fn edit_message(State(st): State<AppState>, AuthUser(me): AuthUser, Path((id, mid)): Path<(Id, Id)>, Json(body): Json<EditMessage>) -> ApiResult<Json<Message>> {
    let a = channel_for(&st, id, me).await?;
    let row = load_message(&st, id, mid).await?;
    if row.author_id != me {
        return Err(ApiError::Forbidden);
    }
    let content = body.content.trim().to_string();
    if content.is_empty() && row.attachments.0.is_empty() {
        return Err(bad("message is empty"));
    }
    if content.chars().count() > MAX_CONTENT {
        return Err(bad(format!("message must be at most {MAX_CONTENT} characters")));
    }
    let row = sqlx::query_as::<_, MessageRow>(&format!(
        "UPDATE messages SET content = $2, edited_at = now(), embeds = '[]' WHERE id = $1 RETURNING {MESSAGE_COLS}"
    ))
    .bind(mid)
    .bind(&content)
    .fetch_one(&st.db)
    .await?;
    let msg = broadcast_message(&st, &a, row).await?;
    embeds::spawn(st.clone(), a.ch, mid, content);
    Ok(Json(msg))
}

async fn delete_message(State(st): State<AppState>, AuthUser(me): AuthUser, Path((id, mid)): Path<(Id, Id)>) -> ApiResult<()> {
    let a = channel_for(&st, id, me).await?;
    let row = load_message(&st, id, mid).await?;
    if row.author_id != me && !a.has(perms::MANAGE_MESSAGES) {
        return Err(ApiError::Forbidden);
    }
    sqlx::query("DELETE FROM messages WHERE id = $1").bind(mid).execute(&st.db).await?;
    let freed: u64 = row.attachments.0.iter().map(|x| x.size).sum();
    for att in &row.attachments.0 {
        uploads::delete_attachment(&st, &att.url).await;
    }
    uploads::release(&st, row.author_id, freed).await;
    st.hub.send(&channel_audience(&st.db, &a.ch).await?, "MESSAGE_DELETE", &json!({ "id": mid, "channel_id": id }));
    Ok(())
}

#[derive(Deserialize)]
struct BulkDelete {
    messages: Vec<Id>,
}

/// Deletes up to 100 messages at once. Everything must be deletable by the caller (their own, or
/// any with Manage Messages), otherwise nothing is deleted. Clients get one MESSAGE_DELETE each.
async fn bulk_delete(State(st): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<Id>, Json(body): Json<BulkDelete>) -> ApiResult<()> {
    if body.messages.is_empty() || body.messages.len() > 100 {
        return Err(bad("select between 1 and 100 messages"));
    }
    let a = channel_for(&st, id, me).await?;
    let rows = sqlx::query_as::<_, MessageRow>(&format!("SELECT {MESSAGE_COLS} FROM messages WHERE channel_id = $1 AND id = ANY($2)"))
        .bind(id)
        .bind(&body.messages)
        .fetch_all(&st.db)
        .await?;
    if rows.iter().any(|r| r.author_id != me) && !a.has(perms::MANAGE_MESSAGES) {
        return Err(ApiError::Forbidden);
    }
    let ids: Vec<Id> = rows.iter().map(|r| r.id).collect();
    sqlx::query("DELETE FROM messages WHERE id = ANY($1)").bind(&ids).execute(&st.db).await?;
    for row in &rows {
        for att in &row.attachments.0 {
            uploads::delete_attachment(&st, &att.url).await;
        }
        uploads::release(&st, row.author_id, row.attachments.0.iter().map(|x| x.size).sum()).await;
    }
    let audience = channel_audience(&st.db, &a.ch).await?;
    for mid in ids {
        st.hub.send(&audience, "MESSAGE_DELETE", &json!({ "id": mid, "channel_id": id }));
    }
    Ok(())
}

async fn add_reaction(State(st): State<AppState>, AuthUser(me): AuthUser, Path((id, mid, emoji)): Path<(Id, Id, String)>) -> ApiResult<()> {
    if emoji.is_empty() || emoji.len() > 64 {
        return Err(bad("invalid emoji"));
    }
    st.limits.check(format!("react:{me}"), 10.0, 3.0)?;
    let a = channel_for(&st, id, me).await?;
    a.require(perms::ADD_REACTIONS)?;
    load_message(&st, id, mid).await?;
    let distinct: i64 = sqlx::query_scalar("SELECT COUNT(DISTINCT emoji) FROM reactions WHERE message_id = $1 AND emoji <> $2")
        .bind(mid)
        .bind(&emoji)
        .fetch_one(&st.db)
        .await?;
    if distinct >= 20 {
        return Err(bad("too many reactions on this message"));
    }
    let res = sqlx::query("INSERT INTO reactions (message_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING")
        .bind(mid)
        .bind(me)
        .bind(&emoji)
        .execute(&st.db)
        .await?;
    if res.rows_affected() > 0 {
        let ev = json!({ "channel_id": id, "message_id": mid, "user_id": me, "emoji": emoji });
        st.hub.send(&channel_audience(&st.db, &a.ch).await?, "REACTION_ADD", &ev);
    }
    Ok(())
}

async fn remove_reaction(State(st): State<AppState>, AuthUser(me): AuthUser, Path((id, mid, emoji)): Path<(Id, Id, String)>) -> ApiResult<()> {
    let a = channel_for(&st, id, me).await?;
    let res = sqlx::query("DELETE FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3")
        .bind(mid)
        .bind(me)
        .bind(&emoji)
        .execute(&st.db)
        .await?;
    if res.rows_affected() > 0 {
        let ev = json!({ "channel_id": id, "message_id": mid, "user_id": me, "emoji": emoji });
        st.hub.send(&channel_audience(&st.db, &a.ch).await?, "REACTION_REMOVE", &ev);
    }
    Ok(())
}

/// In servers pinning needs Manage Messages; in DMs anyone in the conversation can pin.
fn can_pin(a: &Access) -> ApiResult<()> {
    if kind::is_private(a.ch.kind) {
        Ok(())
    } else {
        a.require(perms::MANAGE_MESSAGES)
    }
}

async fn list_pins(State(st): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<Id>) -> ApiResult<Json<Vec<Message>>> {
    channel_for(&st, id, me).await?;
    let rows = sqlx::query_as::<_, MessageRow>(&format!(
        "SELECT {MESSAGE_COLS} FROM messages WHERE channel_id = $1 AND pinned_at IS NOT NULL ORDER BY pinned_at DESC"
    ))
    .bind(id)
    .fetch_all(&st.db)
    .await?;
    Ok(Json(hydrate(&st, rows).await?))
}

async fn pin(State(st): State<AppState>, AuthUser(me): AuthUser, Path((id, mid)): Path<(Id, Id)>) -> ApiResult<()> {
    let a = channel_for(&st, id, me).await?;
    can_pin(&a)?;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE channel_id = $1 AND pinned_at IS NOT NULL")
        .bind(id)
        .fetch_one(&st.db)
        .await?;
    if count >= MAX_PINS {
        return Err(bad(format!("channels can have up to {MAX_PINS} pins")));
    }
    let row = sqlx::query_as::<_, MessageRow>(&format!(
        "UPDATE messages SET pinned_at = COALESCE(pinned_at, now()) WHERE id = $1 AND channel_id = $2 RETURNING {MESSAGE_COLS}"
    ))
    .bind(mid)
    .bind(id)
    .fetch_optional(&st.db)
    .await?
    .ok_or(ApiError::NotFound)?;
    broadcast_message(&st, &a, row).await?;
    Ok(())
}

async fn unpin(State(st): State<AppState>, AuthUser(me): AuthUser, Path((id, mid)): Path<(Id, Id)>) -> ApiResult<()> {
    let a = channel_for(&st, id, me).await?;
    can_pin(&a)?;
    let row = sqlx::query_as::<_, MessageRow>(&format!(
        "UPDATE messages SET pinned_at = NULL WHERE id = $1 AND channel_id = $2 RETURNING {MESSAGE_COLS}"
    ))
    .bind(mid)
    .bind(id)
    .fetch_optional(&st.db)
    .await?
    .ok_or(ApiError::NotFound)?;
    broadcast_message(&st, &a, row).await?;
    Ok(())
}

async fn typing(State(st): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<Id>) -> ApiResult<()> {
    st.limits.check(format!("typing:{me}"), 3.0, 0.5)?;
    let a = channel_for(&st, id, me).await?;
    let audience: Vec<Id> = channel_audience(&st.db, &a.ch).await?.into_iter().filter(|u| *u != me).collect();
    st.hub.send(&audience, "TYPING_START", &json!({ "channel_id": id, "user_id": me }));
    Ok(())
}

pub async fn upsert_read_state(st: &AppState, me: Id, channel: Id, message: Id) -> ApiResult<()> {
    sqlx::query(
        "INSERT INTO read_states (user_id, channel_id, last_read_id) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_id = GREATEST(read_states.last_read_id, EXCLUDED.last_read_id)",
    )
    .bind(me)
    .bind(channel)
    .bind(message)
    .execute(&st.db)
    .await?;
    st.hub.send(&[me], "MESSAGE_ACK", &json!({ "channel_id": channel, "message_id": message }));
    Ok(())
}

#[derive(Deserialize)]
struct Ack {
    message_id: Id,
}

async fn ack(State(st): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<Id>, Json(body): Json<Ack>) -> ApiResult<()> {
    channel_for(&st, id, me).await?;
    upsert_read_state(&st, me, id, body.message_id).await
}

// ---------- search ----------

#[derive(Deserialize)]
struct SearchQuery {
    q: Option<String>,
    author_id: Option<Id>,
    channel_id: Option<Id>,
    /// image | file | link
    has: Option<String>,
    #[serde(default)]
    offset: i64,
}

#[derive(Serialize)]
struct SearchResults {
    total: i64,
    messages: Vec<Message>,
}

/// Prefix-matching full-text query: every word must appear (as a word prefix).
fn tsquery(q: &str) -> Option<String> {
    let words: Vec<String> = q
        .split_whitespace()
        .map(|w| w.chars().filter(|c| c.is_alphanumeric()).collect::<String>().to_lowercase())
        .filter(|w| !w.is_empty())
        .take(8)
        .map(|w| format!("{w}:*"))
        .collect();
    (!words.is_empty()).then(|| words.join(" & "))
}

async fn run_search(st: &AppState, channels: Vec<Id>, q: SearchQuery) -> ApiResult<Json<SearchResults>> {
    let ts = q.q.as_deref().and_then(tsquery);
    if ts.is_none() && q.author_id.is_none() && q.has.is_none() {
        return Err(bad("enter something to search for"));
    }
    let has = match q.has.as_deref() {
        Some("image") => "EXISTS (SELECT 1 FROM jsonb_array_elements(attachments) a WHERE a->>'content_type' LIKE 'image/%')",
        Some("file") => "jsonb_array_length(attachments) > 0",
        Some("link") => "content ~ 'https?://'",
        Some(_) => return Err(bad("unknown filter")),
        None => "true",
    };
    let filter = format!(
        "channel_id = ANY($1) AND ($2::TEXT IS NULL OR to_tsvector('simple', content) @@ to_tsquery('simple', $2))
         AND ($3::BIGINT IS NULL OR author_id = $3) AND {has}"
    );
    let total: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM messages WHERE {filter}"))
        .bind(&channels)
        .bind(&ts)
        .bind(q.author_id)
        .fetch_one(&st.db)
        .await?;
    let rows = sqlx::query_as::<_, MessageRow>(&format!("SELECT {MESSAGE_COLS} FROM messages WHERE {filter} ORDER BY id DESC LIMIT 25 OFFSET $4"))
        .bind(&channels)
        .bind(&ts)
        .bind(q.author_id)
        .bind(q.offset.clamp(0, 5000))
        .fetch_all(&st.db)
        .await?;
    Ok(Json(SearchResults { total, messages: hydrate(st, rows).await? }))
}

async fn search_guild(State(st): State<AppState>, AuthUser(me): AuthUser, Path(gid): Path<Id>, Query(q): Query<SearchQuery>) -> ApiResult<Json<SearchResults>> {
    st.limits.check(format!("search:{me}"), 5.0, 1.0)?;
    guild_perms(&st.db, gid, me).await?;
    let mut channels: Vec<Id> = sqlx::query_scalar("SELECT id FROM channels WHERE guild_id = $1").bind(gid).fetch_all(&st.db).await?;
    if let Some(c) = q.channel_id {
        channels.retain(|x| *x == c);
    }
    run_search(&st, channels, q).await
}

async fn search_channel(State(st): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<Id>, Query(q): Query<SearchQuery>) -> ApiResult<Json<SearchResults>> {
    st.limits.check(format!("search:{me}"), 5.0, 1.0)?;
    channel_for(&st, id, me).await?;
    run_search(&st, vec![id], q).await
}
