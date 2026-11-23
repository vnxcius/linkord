//! Steve, the Minecraft bot. This server only gives him an account and a voice: what he says comes from mc-manager
//! (a separate Minecraft server panel on the same machine), which drives him the way it drives its Discord bot.
//!
//! mc-manager talks to him on the internal listener (loopback only, see internal.rs), with the token in
//! `<data>/steve-token` (not the monitor's: neither can act as the other):
//! - `GET /bots/steve/gateway` (websocket): `{"op": "hello", "user": ...}` when it connects; then it sends
//!   `{"op": "commands", "commands": [{name, description, option?, optional?}]}` (what "/" offers in the servers
//!   he's in), `{"op": "presence", "status": "online|idle|dnd", "text": "..."}` and `{"op": "reply", "id", ...}`
//!   answers to the `{"op": "interaction", ...}` it gets for each slash command someone uses.
//! - `GET /bots/steve/guilds`: the servers he's in, with their channels and roles (the panel's pickers).
//! - `POST /bots/steve/channels/{id}/messages`, `GET|PATCH .../messages/{mid}`: post and edit his own messages
//!   (the live status message, announcements, the mods changelog).
//! - `PUT /bots/steve/sounds/{name}`: a short clip (Ogg or MP3) a reply can play in the caller's voice channel.
//!
//! He isn't in any server until someone with Manage Server adds him (Settings -> Steve); kicking him removes him.
//! While mc-manager isn't connected he shows offline and his commands answer that he's away.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::ws::{Message as WsMsg, WebSocket, WebSocketUpgrade};
use axum::extract::{Multipart, Path, State};
use axum::response::Response;
use axum::routing::{get, post, put};
use axum::{Json, Router};
use base64::Engine;
use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, oneshot};

use crate::api::channels::{channel_for, Access};
use crate::api::guilds::load_member;
use crate::api::messages::{edit_bot_message, load_message, post_bot_message_with};
use crate::auth::{AdminUser, AuthUser};
use crate::error::{bad, ApiError, ApiResult};
use crate::gateway::guild_members;
use crate::id::Id;
use crate::models::{kind, Attachment, Message, User};
use crate::perms;
use crate::state::AppState;
use crate::uploads;

const AVATAR: &str = include_str!("../assets/steve.svg");
const DEFAULT_AVATAR: &str = "/uploads/bots/steve.svg";
/// Building the modpack reads every mod: the panel may take a while to answer.
const REPLY_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_COMMANDS: usize = 50;
const MAX_EMBEDS: usize = 10;
const MAX_FIELDS: usize = 25;
const MAX_FILES: usize = 4;
const MAX_SOUND: usize = 1024 * 1024;
const MAX_SOUNDS: usize = 50;
/// His clips are mastered louder than the soundboard's; people change it further in his menu (per device).
const SOUND_VOLUME: f32 = 0.5;
const MAX_AVATAR: usize = 4 * 1024 * 1024;

#[derive(Default)]
pub struct Steve {
    bot: OnceLock<Id>,
    /// mc-manager's socket while it's connected: (connection number, sender).
    conn: Mutex<Option<(u64, mpsc::Sender<String>)>>,
    next_conn: AtomicU64,
    commands: RwLock<Vec<BotCommand>>,
    /// Interactions waiting for mc-manager's reply, by id.
    pending: DashMap<String, oneshot::Sender<Reply>>,
    /// Clips a reply can play: name -> URL.
    sounds: DashMap<String, String>,
    /// (channel, sha256) -> a file Steve already posted there: the same modpack isn't stored again each time.
    files: DashMap<(Id, String), Attachment>,
}

impl Steve {
    fn sender(&self) -> Option<mpsc::Sender<String>> {
        self.conn.lock().unwrap().as_ref().map(|(_, tx)| tx.clone())
    }

    pub fn is_connected(&self) -> bool {
        self.conn.lock().unwrap().is_some()
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct BotCommand {
    pub name: String,
    pub description: String,
    /// Placeholder for the text after the command, when it takes some.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub option: Option<String>,
    /// The command also runs without it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub optional: bool,
}

#[derive(Deserialize, Default)]
struct Reply {
    /// Shown only to whoever used the command, as a toast.
    #[serde(default)]
    error: Option<String>,
    /// Only whoever used the command sees the message (it isn't stored).
    #[serde(default)]
    ephemeral: bool,
    #[serde(default)]
    content: String,
    #[serde(default)]
    embeds: Vec<Value>,
    #[serde(default)]
    files: Vec<ReplyFile>,
    /// A clip (PUT /bots/steve/sounds/{name}) played in the caller's voice channel.
    #[serde(default)]
    sound: Option<String>,
}

#[derive(Deserialize)]
struct ReplyFile {
    name: String,
    /// Base64.
    data: String,
    #[serde(default)]
    content_type: Option<String>,
}

/// Creates (or finds) Steve's account and writes his default avatar.
pub async fn init(st: &AppState) -> anyhow::Result<()> {
    let dir = st.cfg.uploads_dir().join("bots");
    tokio::fs::create_dir_all(&dir).await?;
    tokio::fs::write(dir.join("steve.svg"), AVATAR).await?;
    // 'invisible' until mc-manager connects: bots show online otherwise.
    let id: Id = sqlx::query_scalar(
        "INSERT INTO users (id, discord_id, username, display_name, avatar, bio, bot, status)
         VALUES ($1, 'bot:steve', 'steve', 'Steve', $3, $2, true, 'invisible')
         ON CONFLICT (discord_id) DO UPDATE SET bot = true, username = 'steve', display_name = 'Steve', bio = EXCLUDED.bio,
             avatar = CASE WHEN users.avatar IS NULL OR users.avatar = $3 THEN EXCLUDED.avatar ELSE users.avatar END,
             status = 'invisible'
         RETURNING id",
    )
    .bind(Id::new())
    .bind("The Minecraft server's bot: type / to see what he knows (status, players, the address, the mods, the modpack).")
    .bind(DEFAULT_AVATAR)
    .fetch_one(&st.db)
    .await?;
    let _ = st.steve.bot.set(id);
    Ok(())
}

pub fn bot_id(st: &AppState) -> Option<Id> {
    st.steve.bot.get().copied()
}

/// Steve's commands, for READY: only while mc-manager is connected.
pub fn commands_for_ready(st: &AppState) -> Value {
    commands_json(st)
}

fn commands_json(st: &AppState) -> Value {
    let Some(bot) = bot_id(st) else { return json!([]) };
    if !st.steve.is_connected() {
        return json!([]);
    }
    let list = st.steve.commands.read().unwrap();
    Value::Array(list.iter().map(|c| json!({ "bot_id": bot, "name": c.name, "description": c.description, "option": c.option, "optional": c.optional })).collect())
}

/// Whether `/name` is one of Steve's (Kass's own names win: Steve's are dropped when registered).
pub fn has_command(st: &AppState, name: &str) -> bool {
    st.steve.commands.read().unwrap().iter().any(|c| c.name == name)
}

async fn announce_commands(st: &AppState) {
    if let Ok(everyone) = sqlx::query_scalar::<_, Id>("SELECT id FROM users WHERE deleted_at IS NULL AND NOT bot").fetch_all(&st.db).await {
        st.hub.send(&everyone, "BOT_COMMANDS_UPDATE", &json!({ "commands": commands_json(st) }));
    }
}

async fn in_guild(st: &AppState, guild: Id, bot: Id) -> ApiResult<bool> {
    Ok(sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM members WHERE guild_id = $1 AND user_id = $2)").bind(guild).bind(bot).fetch_one(&st.db).await?)
}

// ---------- slash commands ----------

/// Someone used one of Steve's commands: mc-manager gets it and answers. Its mistakes and "only you" errors come
/// back as an error (a toast); ephemeral answers are returned without being stored or sent to anyone else.
pub async fn run(st: &AppState, me: Id, channel: Id, name: &str, query: &str) -> ApiResult<Message> {
    let a = channel_for(st, channel, me).await?;
    let Some(guild) = a.ch.guild_id.filter(|_| kind::has_messages(a.ch.kind)) else {
        return Err(bad("commands only work in server channels"));
    };
    a.require(perms::SEND_MESSAGES)?;
    let bot = bot_id(st).ok_or(ApiError::NotFound)?;
    if !in_guild(st, guild, bot).await? {
        return Err(bad("Steve isn't in this server. Someone with Manage Server can add him in Settings → Steve."));
    }
    let Some(tx) = st.steve.sender() else { return Err(bad("Steve is away right now: the Minecraft panel isn't connected")) };
    let member = load_member(&st.db, guild, me).await?;
    let shown = member.nickname.clone().or(member.user.display_name.clone()).unwrap_or_else(|| member.user.username.clone());
    let voice = crate::voice::channel_of(st, me).filter(|(g, _)| *g == Some(guild)).map(|(_, c)| c);
    let id = crate::auth::random_token(12);
    let (done, wait) = oneshot::channel();
    st.steve.pending.insert(id.clone(), done);
    let event = json!({
        "op": "interaction",
        "id": id,
        "command": name,
        "query": query,
        "user": { "id": me, "name": shown },
        "guild_id": guild,
        "channel_id": a.ch.id,
        "voice_channel_id": voice,
    });
    if tx.send(event.to_string()).await.is_err() {
        st.steve.pending.remove(&id);
        return Err(bad("Steve is away right now: the Minecraft panel isn't connected"));
    }
    let reply = match tokio::time::timeout(REPLY_TIMEOUT, wait).await {
        Ok(Ok(r)) => r,
        Ok(Err(_)) => return Err(bad("Steve lost the connection to the Minecraft panel. Try again in a moment.")),
        Err(_) => {
            st.steve.pending.remove(&id);
            return Err(bad("Steve took too long to answer"));
        }
    };
    if let Some(e) = reply.error.filter(|e| !e.trim().is_empty()) {
        return Err(bad(e.chars().take(300).collect::<String>()));
    }
    let content: String = reply.content.trim().chars().take(4000).collect();
    let embeds = clean_embeds(&reply.embeds);
    if let (Some(sound), Some(voice)) = (reply.sound.as_deref(), voice) {
        play_sound(st, voice, bot, sound);
    }
    if content.is_empty() && embeds.as_array().is_none_or(|e| e.is_empty()) && reply.files.is_empty() {
        return Err(bad("Steve had nothing to say"));
    }
    if reply.ephemeral {
        return Ok(Message {
            id: Id::new(),
            kind: 0,
            channel_id: a.ch.id,
            author: User::get(&st.db, bot).await?,
            content,
            reply_to: None,
            referenced_message: None,
            attachments: vec![],
            embeds,
            reactions: vec![],
            mention_everyone: false,
            pinned: false,
            thread_id: None,
            edited_at: None,
            created_at: chrono::Utc::now(),
            forwarded: None,
            interaction: Some(crate::models::Interaction { user: User::get(&st.db, me).await?, name: name.to_string() }),
            nonce: None,
            played_by: None,
            ephemeral: true,
        });
    }
    let attachments = save_files(st, &a, bot, reply.files).await?;
    post_bot_message_with(st, &a, bot, Some((me, name)), content, embeds, attachments).await
}

fn play_sound(st: &AppState, voice: Id, bot: Id, name: &str) {
    let Some(url) = st.steve.sounds.get(name).map(|u| u.clone()) else { return };
    let sound = crate::soundboard::Sound {
        id: format!("steve:{name}"),
        guild_id: None,
        name: name.to_string(),
        emoji: None,
        volume: SOUND_VOLUME,
        url,
        source: None,
        trim_start: 0.0,
        trim_end: None,
    };
    crate::voice::play_bot_sound(st, voice, bot, &sound);
}

/// Rich embeds as the client draws them; anything else is dropped. Texts are markdown (rendered and sanitized by
/// the client), links only http(s).
fn clean_embeds(list: &[Value]) -> Value {
    let text = |v: &Value, max: usize| v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(|s| s.chars().take(max).collect::<String>());
    let link = |v: &Value| v.as_str().filter(|s| (s.starts_with("https://") || s.starts_with("http://")) && s.len() <= 2000 && !s.contains(char::is_whitespace)).map(str::to_string);
    let out: Vec<Value> = list
        .iter()
        .take(MAX_EMBEDS)
        .filter_map(|e| {
            let mut o = json!({ "type": "rich", "url": link(&e["url"]).unwrap_or_default() });
            let mut any = false;
            let mut put = |k: &str, v: Option<String>| {
                if let Some(v) = v {
                    o[k] = json!(v);
                    any = true;
                }
            };
            put("title", text(&e["title"], 256));
            put("description", text(&e["description"], 4096));
            put("site_name", text(&e["site_name"], 256));
            put("author_icon", link(&e["author_icon"]));
            put("footer", text(&e["footer"], 2048));
            put("footer_icon", link(&e["footer_icon"]));
            put("image", link(&e["image"]));
            put("thumbnail", link(&e["thumbnail"]));
            if let Some(c) = e["color"].as_i64().filter(|c| (0..=0xffffff).contains(c)) {
                o["color"] = json!(c);
            }
            if let Some(t) = e["timestamp"].as_i64().filter(|t| *t > 0) {
                o["timestamp"] = json!(t);
            }
            if e["image"].is_string() && o.get("image").is_some() {
                o["large_image"] = json!(true);
            }
            let fields: Vec<Value> = e["fields"]
                .as_array()
                .map(|f| {
                    f.iter()
                        .take(MAX_FIELDS)
                        .filter_map(|f| {
                            let name = text(&f["name"], 256).unwrap_or_default();
                            let value = text(&f["value"], 1024).unwrap_or_default();
                            (!name.is_empty() || !value.is_empty()).then(|| json!({ "name": name, "value": value, "inline": f["inline"].as_bool() == Some(true) }))
                        })
                        .collect()
                })
                .unwrap_or_default();
            if !fields.is_empty() {
                o["fields"] = json!(fields);
                any = true;
            }
            any.then_some(o)
        })
        .collect();
    Value::Array(out)
}

/// The reply's files, saved as attachments of Steve's (the same file in the same channel is reused).
async fn save_files(st: &AppState, a: &Access, bot: Id, files: Vec<ReplyFile>) -> ApiResult<Vec<Attachment>> {
    let mut out = vec![];
    for f in files.into_iter().take(MAX_FILES) {
        let bytes = base64::engine::general_purpose::STANDARD.decode(f.data.as_bytes()).map_err(|_| bad("bad file"))?;
        if bytes.is_empty() || bytes.len() > uploads::MAX_FILE {
            return Err(bad("that file is too big for Linkord"));
        }
        let hash = hex::encode(Sha256::digest(&bytes));
        let key = (a.ch.id, hash);
        if let Some(prev) = st.steve.files.get(&key).map(|p| p.clone()) {
            let path = prev.url.strip_prefix("/uploads/").map(|rel| st.cfg.uploads_dir().join(rel));
            if path.is_some_and(|p| p.exists()) {
                out.push(Attachment { id: Id::new(), ..prev });
                continue;
            }
        }
        let filename = uploads::sanitize_filename(&f.name);
        let content_type = f.content_type.filter(|c| !c.is_empty() && !c.contains(char::is_whitespace)).unwrap_or_else(|| mime_guess::from_path(&filename).first_or_octet_stream().to_string());
        uploads::reserve(st, bot, bytes.len()).await?;
        let url = uploads::save(st, &format!("attachments/{}", a.ch.id), &filename, &bytes).await?;
        let att = Attachment { id: Id::new(), filename, url, size: bytes.len() as u64, content_type, duration_secs: None, waveform: None, width: None, height: None, codec: None, playable: None };
        st.steve.files.insert(key, att.clone());
        out.push(att);
    }
    Ok(out)
}

// ---------- Server Settings ----------

/// Brings Steve into a server (Manage Server).
async fn add_to_guild(State(st): State<AppState>, AuthUser(me): AuthUser, Path(guild): Path<Id>) -> ApiResult<()> {
    perms::guild_perms(&st.db, guild, me).await?.require(perms::MANAGE_GUILD)?;
    let bot = bot_id(&st).ok_or(ApiError::NotFound)?;
    let joined = sqlx::query("INSERT INTO members (guild_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING").bind(guild).bind(bot).execute(&st.db).await?.rows_affected() > 0;
    if joined {
        tracing::info!(user = %me, guild = %guild, "steve added");
        let member = load_member(&st.db, guild, bot).await?;
        let others = guild_members(&st.db, guild).await?;
        let status = st.hub.presence(&member.user);
        st.hub.send(&others, "GUILD_MEMBER_ADD", &json!({ "guild_id": guild, "member": member, "status": status }));
    }
    Ok(())
}

async fn remove_from_guild(State(st): State<AppState>, AuthUser(me): AuthUser, Path(guild): Path<Id>) -> ApiResult<()> {
    perms::guild_perms(&st.db, guild, me).await?.require(perms::MANAGE_GUILD)?;
    let bot = bot_id(&st).ok_or(ApiError::NotFound)?;
    if in_guild(&st, guild, bot).await? {
        tracing::info!(user = %me, guild = %guild, "steve removed");
        crate::api::guilds::remove_member(&st, guild, bot).await?;
    }
    Ok(())
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/guilds/{id}/bots/steve", post(add_to_guild).delete(remove_from_guild))
        .route("/bots/steve/avatar", post(set_avatar).delete(reset_avatar))
}

/// An admin (LINKORD_ADMINS) gives Steve a new picture (png, jpeg, gif or webp), like Kass's.
async fn set_avatar(State(st): State<AppState>, AdminUser(_): AdminUser, mut mp: Multipart) -> ApiResult<Json<User>> {
    let field = mp.next_field().await.map_err(|e| bad(e.body_text()))?.ok_or_else(|| bad("missing file"))?;
    if !uploads::is_image(field.content_type().unwrap_or_default()) {
        return Err(bad("must be a png, jpeg, gif or webp image"));
    }
    let bytes = uploads::read_field(field, MAX_AVATAR).await?;
    let name = uploads::image_name("avatar", &bytes)?;
    let url = uploads::save(&st, "bots", &name, &bytes).await?;
    save_avatar(&st, &url).await
}

async fn reset_avatar(State(st): State<AppState>, AdminUser(_): AdminUser) -> ApiResult<Json<User>> {
    save_avatar(&st, DEFAULT_AVATAR).await
}

async fn save_avatar(st: &AppState, url: &str) -> ApiResult<Json<User>> {
    let bot = bot_id(st).ok_or(ApiError::NotFound)?;
    sqlx::query("UPDATE users SET avatar = $2 WHERE id = $1").bind(bot).bind(url).execute(&st.db).await?;
    let user = User::get(&st.db, bot).await?;
    let audience: Vec<Id> = sqlx::query_scalar("SELECT id FROM users WHERE deleted_at IS NULL AND NOT bot").fetch_all(&st.db).await?;
    st.hub.send(&audience, "USER_UPDATE", &user);
    Ok(Json(user))
}

// ---------- mc-manager's side (internal listener) ----------

pub fn bot_routes() -> Router<AppState> {
    Router::new()
        .route("/bots/steve/gateway", get(gateway))
        .route("/bots/steve/guilds", get(guilds))
        .route("/bots/steve/channels/{id}/messages", post(create_message))
        .route("/bots/steve/channels/{id}/messages/{mid}", get(get_message).patch(edit_message))
        .route("/bots/steve/sounds/{name}", put(put_sound))
        .layer(axum::extract::DefaultBodyLimit::max(uploads::MAX_FILE * 2))
}

async fn gateway(State(st): State<AppState>, ws: WebSocketUpgrade) -> Response {
    ws.max_message_size(48 * 1024 * 1024).on_upgrade(move |socket| connected(st, socket))
}

async fn connected(st: AppState, socket: WebSocket) {
    let Some(bot) = bot_id(&st) else { return };
    let n = st.steve.next_conn.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, mut rx) = mpsc::channel::<String>(64);
    // A new connection replaces the old one (mc-manager restarted before its old socket timed out).
    *st.steve.conn.lock().unwrap() = Some((n, tx));
    tracing::info!("steve: mc-manager connected");
    let (mut sink, mut stream) = socket.split();
    if let Ok(user) = User::get(&st.db, bot).await {
        let _ = sink.send(WsMsg::Text(json!({ "op": "hello", "user": user }).to_string().into())).await;
    }
    set_status(&st, bot, "online").await;
    let mut ping = tokio::time::interval(Duration::from_secs(20));
    loop {
        tokio::select! {
            out = rx.recv() => match out {
                Some(text) => if sink.send(WsMsg::Text(text.into())).await.is_err() { break },
                None => break,
            },
            _ = ping.tick() => if sink.send(WsMsg::Ping(Bytes::new())).await.is_err() { break },
            msg = tokio::time::timeout(Duration::from_secs(70), stream.next()) => match msg {
                Ok(Some(Ok(WsMsg::Text(t)))) => on_op(&st, bot, &t).await,
                Ok(Some(Ok(WsMsg::Close(_)))) | Ok(Some(Err(_))) | Ok(None) | Err(_) => break,
                Ok(Some(Ok(_))) => {}
            },
        }
        // Replaced by a newer connection.
        if st.steve.conn.lock().unwrap().as_ref().map(|(c, _)| *c) != Some(n) {
            return;
        }
    }
    let mine = {
        let mut conn = st.steve.conn.lock().unwrap();
        let mine = conn.as_ref().is_some_and(|(c, _)| *c == n);
        if mine {
            *conn = None;
        }
        mine
    };
    // Handed over: mc-manager reconnects to the next process within a second; nothing to announce.
    if mine && crate::handover::retired() {
        return;
    }
    if mine {
        tracing::info!("steve: mc-manager disconnected");
        // Whoever is waiting hears it right away.
        st.steve.pending.clear();
        set_status(&st, bot, "invisible").await;
        crate::activities::put_activity(&st, bot, crate::activities::CUSTOM, None);
        crate::activities::announce(&st, bot).await;
        announce_commands(&st).await;
    }
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum BotOp {
    Commands { commands: Vec<BotCommand> },
    Presence { status: String, #[serde(default)] text: String },
    Reply { id: String, #[serde(flatten)] reply: Reply },
}

async fn on_op(st: &AppState, bot: Id, text: &str) {
    let op = match serde_json::from_str::<BotOp>(text) {
        Ok(op) => op,
        Err(e) => return tracing::warn!("steve: unreadable message from mc-manager: {e}"),
    };
    match op {
        BotOp::Commands { commands } => {
            let taken = crate::music::COMMANDS;
            let mut list: Vec<BotCommand> = vec![];
            for mut c in commands {
                c.name = c.name.trim().to_lowercase();
                let ok = !c.name.is_empty() && c.name.len() <= 32 && c.name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_');
                if !ok || taken.contains(&c.name.as_str()) || list.iter().any(|x| x.name == c.name) {
                    continue;
                }
                c.description = c.description.trim().chars().take(100).collect();
                c.option = c.option.map(|o| o.trim().chars().take(40).collect::<String>()).filter(|o| !o.is_empty());
                list.push(c);
                if list.len() >= MAX_COMMANDS {
                    break;
                }
            }
            *st.steve.commands.write().unwrap() = list;
            announce_commands(st).await;
        }
        BotOp::Presence { status, text } => {
            let status = if matches!(status.as_str(), "idle" | "dnd") { status } else { "online".into() };
            set_status(st, bot, &status).await;
            let text: String = text.trim().chars().take(128).collect();
            let activity = (!text.is_empty()).then(|| crate::activities::custom_activity(Some(&text), None, None));
            crate::activities::put_activity(st, bot, crate::activities::CUSTOM, activity);
            crate::activities::announce(st, bot).await;
        }
        BotOp::Reply { id, reply } => {
            if let Some((_, done)) = st.steve.pending.remove(&id) {
                let _ = done.send(reply);
            }
        }
    }
}

async fn set_status(st: &AppState, bot: Id, status: &str) {
    let changed = sqlx::query("UPDATE users SET status = $2 WHERE id = $1 AND status <> $2").bind(bot).bind(status).execute(&st.db).await.map(|r| r.rows_affected() > 0).unwrap_or(false);
    if changed {
        crate::activities::announce(st, bot).await;
    }
}

/// The servers Steve is in, with their text channels and roles.
async fn guilds(State(st): State<AppState>) -> ApiResult<Json<Value>> {
    let bot = bot_id(&st).ok_or(ApiError::NotFound)?;
    let ids: Vec<Id> = sqlx::query_scalar("SELECT guild_id FROM members WHERE user_id = $1 ORDER BY joined_at").bind(bot).fetch_all(&st.db).await?;
    let mut out = vec![];
    for g in ids {
        let guild = crate::api::guilds::load_guild(&st.db, g, bot).await?;
        let names: std::collections::HashMap<Id, String> = guild.channels.iter().map(|c| (c.id, c.name.clone())).collect();
        let channels: Vec<Value> = guild
            .channels
            .iter()
            .filter(|c| kind::has_messages(c.kind) && c.kind != kind::THREAD)
            .map(|c| json!({ "id": c.id, "name": c.name, "voice": c.kind == kind::VOICE, "category": c.parent_id.and_then(|p| names.get(&p)) }))
            .collect();
        let roles: Vec<Value> = guild.roles.iter().filter(|r| r.id != g).map(|r| json!({ "id": r.id, "name": r.name, "color": r.color, "mentionable": r.mentionable })).collect();
        out.push(json!({ "id": g, "name": guild.guild.name, "icon": guild.guild.icon, "channels": channels, "roles": roles }));
    }
    Ok(Json(Value::Array(out)))
}

#[derive(Deserialize)]
struct PostBody {
    #[serde(default)]
    content: String,
    #[serde(default)]
    embeds: Vec<Value>,
    #[serde(default)]
    files: Vec<ReplyFile>,
}

async fn bot_access(st: &AppState, channel: Id) -> ApiResult<(Id, Access)> {
    let bot = bot_id(st).ok_or(ApiError::NotFound)?;
    let a = channel_for(st, channel, bot).await?;
    if a.ch.guild_id.is_none() || !kind::has_messages(a.ch.kind) {
        return Err(bad("not a server text channel"));
    }
    Ok((bot, a))
}

async fn create_message(State(st): State<AppState>, Path(channel): Path<Id>, Json(body): Json<PostBody>) -> ApiResult<Json<Message>> {
    let (bot, a) = bot_access(&st, channel).await?;
    a.require(perms::SEND_MESSAGES)?;
    let content: String = body.content.trim().chars().take(4000).collect();
    let embeds = clean_embeds(&body.embeds);
    if content.is_empty() && embeds.as_array().is_none_or(|e| e.is_empty()) && body.files.is_empty() {
        return Err(bad("message is empty"));
    }
    let attachments = save_files(&st, &a, bot, body.files).await?;
    Ok(Json(post_bot_message_with(&st, &a, bot, None, content, embeds, attachments).await?))
}

async fn get_message(State(st): State<AppState>, Path((channel, mid)): Path<(Id, Id)>) -> ApiResult<Json<Value>> {
    let (bot, _) = bot_access(&st, channel).await?;
    let row = load_message(&st, channel, mid).await?;
    if row.author_id != bot {
        return Err(ApiError::NotFound);
    }
    Ok(Json(json!({ "id": row.id, "channel_id": channel })))
}

async fn edit_message(State(st): State<AppState>, Path((channel, mid)): Path<(Id, Id)>, Json(body): Json<PostBody>) -> ApiResult<Json<Message>> {
    let (bot, a) = bot_access(&st, channel).await?;
    let row = load_message(&st, channel, mid).await?;
    if row.author_id != bot {
        return Err(ApiError::Forbidden);
    }
    let content: String = body.content.trim().chars().take(4000).collect();
    Ok(Json(edit_bot_message(&st, &a, mid, content, clean_embeds(&body.embeds)).await?))
}

/// A clip for the sound commands; kept under its name until the next upload with that name.
async fn put_sound(State(st): State<AppState>, Path(name): Path<String>, body: Bytes) -> ApiResult<Json<Value>> {
    let name = name.to_lowercase();
    if name.is_empty() || name.len() > 32 || !name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_') {
        return Err(bad("bad sound name"));
    }
    if body.is_empty() || body.len() > MAX_SOUND {
        return Err(bad("a sound must be at most 1 MB"));
    }
    if st.steve.sounds.len() >= MAX_SOUNDS && !st.steve.sounds.contains_key(&name) {
        return Err(bad("too many sounds"));
    }
    let ext = if body.starts_with(b"OggS") {
        "ogg"
    } else if body.starts_with(b"ID3") || (body[0] == 0xff && body.len() > 1 && body[1] & 0xe0 == 0xe0) {
        "mp3"
    } else {
        return Err(bad("sounds must be Ogg or MP3"));
    };
    let hash = &hex::encode(Sha256::digest(&body))[..12];
    let dir = st.cfg.uploads_dir().join("bots/steve");
    tokio::fs::create_dir_all(&dir).await.map_err(anyhow::Error::from)?;
    let file = format!("{name}-{hash}.{ext}");
    tokio::fs::write(dir.join(&file), &body).await.map_err(anyhow::Error::from)?;
    let url = format!("/uploads/bots/steve/{file}");
    st.steve.sounds.insert(name, url.clone());
    Ok(Json(json!({ "url": url })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embeds_keep_only_what_the_client_draws() {
        let out = clean_embeds(&[
            json!({ "title": "Status", "description": "🟢 **Online**", "color": 0x2ecc71, "url": "javascript:alert(1)",
                    "fields": [{ "name": "Jogadores", "value": "2/20", "inline": true }, { "name": "", "value": "" }],
                    "footer": "Status", "timestamp": 1_700_000_000_000i64, "thumbnail": "https://example.com/a.png", "evil": "<script>" }),
            json!({ "color": 5 }),
        ]);
        let list = out.as_array().unwrap();
        assert_eq!(list.len(), 1, "an embed with nothing to show is dropped");
        let e = &list[0];
        assert_eq!(e["type"], "rich");
        assert_eq!(e["url"], "", "only http(s) links");
        assert_eq!(e["fields"].as_array().unwrap().len(), 1);
        assert_eq!(e["fields"][0]["inline"], true);
        assert_eq!(e["footer"], "Status");
        assert!(e.get("evil").is_none());
    }
}

// ---------- handover (handover.rs) ----------

pub fn snapshot(st: &AppState) -> Value {
    let sounds: Vec<(String, String)> = st.steve.sounds.iter().map(|s| (s.key().clone(), s.value().clone())).collect();
    json!({ "sounds": sounds })
}

pub fn restore(st: &AppState, v: Value) -> anyhow::Result<()> {
    if v.is_null() {
        return Ok(());
    }
    for (name, url) in serde_json::from_value::<Vec<(String, String)>>(v["sounds"].clone())? {
        st.steve.sounds.insert(name, url);
    }
    Ok(())
}

/// Ends mc-manager's socket (it reconnects to the next process by itself).
pub fn close_restarting(st: &AppState) {
    st.steve.conn.lock().unwrap().take();
}
