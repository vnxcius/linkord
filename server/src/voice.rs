//! Voice channels, relayed by this server over websockets.
//!
//! Each client opens two sockets to a voice channel:
//! - the voice socket (`/voice/connect`): voice audio and control messages;
//! - the media socket (`/voice/media`): camera/screen video and stream audio.
//!
//! Keeping them apart means a heavy screen share can never delay anyone's voice: voice has its own
//! TCP connection and its own small queue, while video that can't be delivered within a few hundred
//! milliseconds is dropped (viewers then ask the streamer for a fresh keyframe) instead of piling up.
//!
//! Wire format (binary):
//!   client -> server: [kind u8][payload]
//!   server -> client: [kind u8][sender id u64 BE][payload]
//! kinds: 1 = voice (Opus), 2 = camera video, 3 = screen video, 4 = screen audio (Opus, stereo).
//! Video payload: [flags u8][seq u16 BE][codec: len u8 + ascii, only on keyframes][frame]; flag bit 0 = keyframe.
//!
//! Screen shares are only forwarded to people watching them ("Watch Stream").

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::ws::{CloseFrame, Message as WsMsg, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::mpsc;

use crate::api::channels::channel_for;
use crate::auth::user_from_token;
use crate::gateway::guild_members;
use crate::id::Id;
use crate::models::kind;
use crate::perms;
use crate::state::AppState;

/// 1080p60 keyframes from a hardware encoder can approach a megabyte.
const MAX_FRAME: usize = 3 * 1024 * 1024;
/// Voice/control queue per listener: about a second of audio. Beyond that, packets are dropped.
const VOICE_QUEUE: usize = 128;
/// Media queue per listener.
const MEDIA_QUEUE: usize = 256;
/// Media older than this when it's about to be sent is dropped: late video is useless, and keeping it
/// would make the stream lag further and further behind.
const MEDIA_MAX_AGE: Duration = Duration::from_millis(400);

const KIND_VOICE: u8 = 1;
const KIND_CAMERA: u8 = 2;
const KIND_SCREEN: u8 = 3;
const KIND_SCREEN_AUDIO: u8 = 4;

static NEXT_CONN: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Serialize)]
pub struct VoiceState {
    pub user_id: Id,
    pub guild_id: Id,
    pub channel_id: Option<Id>,
    pub self_mute: bool,
    pub self_deaf: bool,
    /// Sharing their screen (shows the LIVE badge).
    pub self_stream: bool,
    /// Camera on.
    pub self_video: bool,
    /// Streamers whose screen share this user is watching.
    pub watching: Vec<Id>,
    /// When the call in this channel started (unix ms), the same for everyone in it.
    pub call_started_at: Option<i64>,
    /// The voice socket that owns this state.
    #[serde(skip)]
    conn: u64,
}

type MediaTx = mpsc::Sender<(Instant, WsMsg)>;

struct Peer {
    user: Id,
    conn: u64,
    tx: mpsc::Sender<WsMsg>,
    /// Set while the peer's media socket is connected.
    media: Mutex<Option<MediaTx>>,
    watching: Mutex<HashSet<Id>>,
}

/// A voice channel's call: it starts when the first person joins and ends when the last one leaves.
struct Call {
    started_at: i64,
    /// Set while nobody is in it, so a lone user reconnecting keeps the call going.
    empty_since: Option<Instant>,
}

/// How long an empty channel keeps its call (a reconnect, switching device).
const CALL_GRACE: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct VoiceStates {
    by_user: DashMap<Id, VoiceState>,
    rooms: DashMap<Id, Vec<Peer>>,
    calls: DashMap<Id, Call>,
}

impl VoiceStates {
    pub fn for_guilds(&self, guilds: &[Id]) -> Vec<VoiceState> {
        self.by_user.iter().filter(|v| guilds.contains(&v.guild_id)).map(|v| v.clone()).collect()
    }

    /// Sends to everyone in the channel except the sender. Voice goes on the voice lane; video and stream
    /// audio on the media lane (screen media only to its watchers). Never blocks.
    fn relay(&self, channel: Id, from: u64, from_user: Id, kind: u8, msg: WsMsg) {
        let Some(room) = self.rooms.get(&channel) else { return };
        let now = Instant::now();
        let screen = kind == KIND_SCREEN || kind == KIND_SCREEN_AUDIO;
        for p in room.iter().filter(|p| p.conn != from) {
            if kind == KIND_VOICE || kind == 0 {
                let _ = p.tx.try_send(msg.clone());
                continue;
            }
            if screen && !p.watching.lock().unwrap().contains(&from_user) {
                continue;
            }
            match p.media.lock().unwrap().as_ref() {
                Some(media) => drop(media.try_send((now, msg.clone()))),
                // Apps older than 0.1.7 have no media socket yet.
                None => drop(p.tx.try_send(msg.clone())),
            }
        }
    }

    /// Sends a control message to one user's voice socket in the channel.
    fn send_to(&self, channel: Id, user: Id, msg: WsMsg) {
        if let Some(room) = self.rooms.get(&channel) {
            if let Some(p) = room.iter().find(|p| p.user == user) {
                let _ = p.tx.try_send(msg);
            }
        }
    }

    fn with_peer<R>(&self, channel: Id, conn: u64, f: impl FnOnce(&Peer) -> R) -> Option<R> {
        self.rooms.get(&channel).and_then(|room| room.iter().find(|p| p.conn == conn).map(f))
    }

    fn remove_peer(&self, channel: Id, conn: u64) -> Option<Peer> {
        let mut removed = None;
        let emptied = self
            .rooms
            .remove_if_mut(&channel, |_, peers| {
                if let Some(i) = peers.iter().position(|p| p.conn == conn) {
                    removed = Some(peers.remove(i));
                }
                peers.is_empty()
            })
            .is_some();
        if emptied {
            if let Some(mut call) = self.calls.get_mut(&channel) {
                call.empty_since = Some(Instant::now());
            }
        }
        removed
    }

    /// The start of the channel's call, beginning one if it had none (or it ended a while ago).
    fn join_call(&self, channel: Id) -> i64 {
        let now = chrono::Utc::now().timestamp_millis();
        let mut call = self.calls.entry(channel).or_insert(Call { started_at: now, empty_since: None });
        if call.empty_since.is_some_and(|t| t.elapsed() > CALL_GRACE) {
            call.started_at = now;
        }
        call.empty_since = None;
        call.started_at
    }

    /// Stops everyone in the channel watching `streamer` (their stream ended or they left), so a later
    /// stream isn't sent to people who never clicked Watch. Returns the viewers' updated states.
    fn unwatch(&self, channel: Id, streamer: Id) -> Vec<VoiceState> {
        let viewers: Vec<(Id, u64, Vec<Id>)> = match self.rooms.get(&channel) {
            Some(room) => room
                .iter()
                .filter_map(|p| {
                    let mut w = p.watching.lock().unwrap();
                    w.remove(&streamer).then(|| (p.user, p.conn, w.iter().copied().collect()))
                })
                .collect(),
            None => return Vec::new(),
        };
        viewers.into_iter().filter_map(|(user, conn, list)| self.update(user, conn, |v| v.watching = list)).collect()
    }

    /// Updates the caller's own state if this socket still owns it.
    fn update(&self, user: Id, conn: u64, f: impl FnOnce(&mut VoiceState)) -> Option<VoiceState> {
        self.by_user.get_mut(&user).filter(|v| v.conn == conn).map(|mut v| {
            f(&mut v);
            v.clone()
        })
    }
}

async fn announce(st: &AppState, vs: &VoiceState) {
    if let Ok(members) = guild_members(&st.db, vs.guild_id).await {
        st.hub.send(&members, "VOICE_STATE_UPDATE", vs);
    }
}

/// Disconnects the user from voice (closing their sockets) and tells their guild.
pub async fn leave(st: &AppState, user: Id) {
    if let Some((_, mut vs)) = st.voice.by_user.remove(&user) {
        if let Some(peer) = vs.channel_id.and_then(|ch| st.voice.remove_peer(ch, vs.conn)) {
            let _ = peer.tx.try_send(WsMsg::Close(None));
            if let Some(media) = peer.media.lock().unwrap().take() {
                let _ = media.try_send((Instant::now(), WsMsg::Close(None)));
            }
        }
        if let Some(ch) = vs.channel_id {
            for viewer in st.voice.unwatch(ch, user) {
                announce(st, &viewer).await;
            }
        }
        vs.channel_id = None;
        vs.self_stream = false;
        vs.self_video = false;
        vs.watching.clear();
        vs.call_started_at = None;
        announce(st, &vs).await;
    }
}

pub fn routes() -> Router<AppState> {
    Router::new().route("/voice/connect", get(voice_handler)).route("/voice/media", get(media_handler))
}

async fn voice_handler(State(st): State<AppState>, ws: WebSocketUpgrade) -> Response {
    ws.max_message_size(MAX_FRAME).on_upgrade(move |socket| run_voice(st, socket))
}

async fn media_handler(State(st): State<AppState>, ws: WebSocketUpgrade) -> Response {
    ws.max_message_size(MAX_FRAME).on_upgrade(move |socket| run_media(st, socket))
}

#[derive(Deserialize)]
struct Identify {
    token: String,
    channel_id: Id,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum ClientOp {
    State { self_mute: bool, self_deaf: bool },
    VideoStop { source: String },
    /// Start/stop receiving someone's screen share.
    Watch { user_id: Id, on: bool },
    /// Ask a streamer for a keyframe (after joining or losing frames).
    RequestKeyframe { user_id: Id, source: String },
    /// Round-trip measurement for the ping display; echoed straight back.
    Ping { t: f64 },
}

async fn close(mut socket: WebSocket, code: u16, reason: &'static str) {
    let _ = socket.send(WsMsg::Close(Some(CloseFrame { code, reason: reason.into() }))).await;
}

async fn identify(st: &AppState, socket: &mut WebSocket) -> Option<(Id, Identify)> {
    let ident = match tokio::time::timeout(Duration::from_secs(15), socket.recv()).await {
        Ok(Some(Ok(WsMsg::Text(t)))) => serde_json::from_str::<Identify>(&t).ok()?,
        _ => return None,
    };
    let me = user_from_token(st, &ident.token).await.ok().flatten()?;
    Some((me, ident))
}

/// Video or stream audio from a client (sent on either socket; older clients use the voice socket).
async fn on_media(st: &AppState, me: Id, conn: u64, channel: Id, prefix: &[u8; 8], data: &[u8]) {
    let kind = data[0];
    // The first video frame marks the stream/camera as live for everyone's sidebar.
    if kind == KIND_SCREEN || kind == KIND_CAMERA {
        let mut turned_on = false;
        let vs = st.voice.update(me, conn, |v| {
            let flag = if kind == KIND_SCREEN { &mut v.self_stream } else { &mut v.self_video };
            turned_on = !*flag;
            *flag = true;
        });
        if let Some(vs) = vs.filter(|_| turned_on) {
            announce(st, &vs).await;
        }
    }
    let mut out = Vec::with_capacity(data.len() + 8);
    out.push(kind);
    out.extend_from_slice(prefix);
    out.extend_from_slice(&data[1..]);
    st.voice.relay(channel, conn, me, kind, WsMsg::Binary(out.into()));
}

async fn run_voice(st: AppState, mut socket: WebSocket) {
    let Some((me, ident)) = identify(&st, &mut socket).await else {
        return close(socket, 4001, "invalid token").await;
    };
    let (guild_id, can_speak) = match channel_for(&st, ident.channel_id, me).await {
        Ok(a) if a.ch.kind == kind::VOICE && a.has(perms::CONNECT) => (a.ch.guild_id.unwrap(), a.has(perms::SPEAK)),
        _ => return close(socket, 4004, "not a voice channel").await,
    };
    let channel = ident.channel_id;

    // One voice session per user: joining here ends any session in another channel or on another device.
    leave(&st, me).await;
    let conn = NEXT_CONN.fetch_add(1, Ordering::Relaxed);
    let (tx, mut rx) = mpsc::channel(VOICE_QUEUE);
    st.voice.rooms.entry(channel).or_default().push(Peer {
        user: me,
        conn,
        tx: tx.clone(),
        media: Mutex::new(None),
        watching: Mutex::new(HashSet::new()),
    });
    let vs = VoiceState {
        user_id: me,
        guild_id,
        channel_id: Some(channel),
        self_mute: !can_speak,
        self_deaf: false,
        self_stream: false,
        self_video: false,
        watching: Vec::new(),
        call_started_at: Some(st.voice.join_call(channel)),
        conn,
    };
    st.voice.by_user.insert(me, vs.clone());
    announce(&st, &vs).await;

    let (mut sink, mut stream) = socket.split();
    let ready = sink.send(WsMsg::Text(json!({ "op": "ready" }).to_string().into())).await.is_ok();
    let prefix = (me.0 as u64).to_be_bytes();
    let mut ping = tokio::time::interval(Duration::from_secs(20));
    let mut last_seen = Instant::now();
    // Time in voice, saved every ping so a restart loses at most a few seconds.
    let mut counted = Instant::now();

    while ready {
        tokio::select! {
            out = rx.recv() => match out {
                Some(WsMsg::Close(_)) | None => {
                    let _ = sink.send(WsMsg::Close(Some(CloseFrame { code: 4002, reason: "session replaced".into() }))).await;
                    break;
                }
                Some(m) => if sink.send(m).await.is_err() { break },
            },
            inc = stream.next() => {
                last_seen = Instant::now();
                match inc {
                    Some(Ok(WsMsg::Binary(data))) => {
                        let kind = data.first().copied().unwrap_or(0);
                        // Without the Speak permission the server drops this peer's media.
                        if data.len() < 2 || !(KIND_VOICE..=KIND_SCREEN_AUDIO).contains(&kind) || !can_speak {
                            continue;
                        }
                        if kind == KIND_VOICE {
                            let mut out = Vec::with_capacity(data.len() + 8);
                            out.push(kind);
                            out.extend_from_slice(&prefix);
                            out.extend_from_slice(&data[1..]);
                            st.voice.relay(channel, conn, me, kind, WsMsg::Binary(out.into()));
                        } else {
                            on_media(&st, me, conn, channel, &prefix, &data).await;
                        }
                    }
                    Some(Ok(WsMsg::Text(t))) => match serde_json::from_str::<ClientOp>(&t) {
                        Ok(ClientOp::State { self_mute, self_deaf }) => {
                            if let Some(vs) = st.voice.update(me, conn, |v| {
                                v.self_mute = self_mute || !can_speak;
                                v.self_deaf = self_deaf;
                            }) {
                                announce(&st, &vs).await;
                            }
                        }
                        Ok(ClientOp::VideoStop { source }) => {
                            let vs = st.voice.update(me, conn, |v| match source.as_str() {
                                "screen" => v.self_stream = false,
                                _ => v.self_video = false,
                            });
                            if let Some(vs) = vs {
                                announce(&st, &vs).await;
                            }
                            if source == "screen" {
                                for viewer in st.voice.unwatch(channel, me) {
                                    announce(&st, &viewer).await;
                                }
                            }
                            let msg = json!({ "op": "video_stop", "user_id": me, "source": source }).to_string();
                            st.voice.relay(channel, conn, me, 0, WsMsg::Text(msg.into()));
                        }
                        Ok(ClientOp::Watch { user_id, on }) => {
                            let list = st.voice.with_peer(channel, conn, |p| {
                                let mut w = p.watching.lock().unwrap();
                                if on { w.insert(user_id); } else { w.remove(&user_id); }
                                w.iter().copied().collect::<Vec<_>>()
                            });
                            if let Some(vs) = list.and_then(|l| st.voice.update(me, conn, |v| v.watching = l)) {
                                announce(&st, &vs).await;
                            }
                            if on {
                                // A new viewer needs a keyframe to start decoding.
                                let msg = json!({ "op": "keyframe", "source": "screen" }).to_string();
                                st.voice.send_to(channel, user_id, WsMsg::Text(msg.into()));
                            }
                        }
                        Ok(ClientOp::RequestKeyframe { user_id, source }) => {
                            let msg = json!({ "op": "keyframe", "source": source }).to_string();
                            st.voice.send_to(channel, user_id, WsMsg::Text(msg.into()));
                        }
                        Ok(ClientOp::Ping { t }) => {
                            let _ = tx.try_send(WsMsg::Text(json!({ "op": "pong", "t": t }).to_string().into()));
                        }
                        Err(_) => {}
                    },
                    Some(Ok(WsMsg::Close(_))) | Some(Err(_)) | None => break,
                    Some(Ok(_)) => {}
                }
            },
            _ = ping.tick() => {
                if last_seen.elapsed() > Duration::from_secs(60) { break }
                if sink.send(WsMsg::Ping(Default::default())).await.is_err() { break }
                add_voice_time(&st, me, &mut counted).await;
            }
        }
    }
    add_voice_time(&st, me, &mut counted).await;

    if let Some(peer) = st.voice.remove_peer(channel, conn) {
        if let Some(media) = peer.media.lock().unwrap().take() {
            let _ = media.try_send((Instant::now(), WsMsg::Close(None)));
        }
    }
    for viewer in st.voice.unwatch(channel, me) {
        announce(&st, &viewer).await;
    }
    if let Some((_, mut vs)) = st.voice.by_user.remove_if(&me, |_, v| v.conn == conn) {
        vs.channel_id = None;
        vs.self_stream = false;
        vs.self_video = false;
        vs.watching.clear();
        vs.call_started_at = None;
        announce(&st, &vs).await;
    }
}

async fn add_voice_time(st: &AppState, user: Id, since: &mut Instant) {
    let secs = since.elapsed().as_secs();
    if secs == 0 {
        return;
    }
    *since += Duration::from_secs(secs);
    let _ = sqlx::query("UPDATE users SET voice_seconds = voice_seconds + $2 WHERE id = $1").bind(user).bind(secs as i64).execute(&st.db).await;
}

/// The media socket: attaches to the user's existing voice session in the channel.
async fn run_media(st: AppState, mut socket: WebSocket) {
    let Some((me, ident)) = identify(&st, &mut socket).await else {
        return close(socket, 4001, "invalid token").await;
    };
    let channel = ident.channel_id;
    let Some(vs) = st.voice.by_user.get(&me).map(|v| v.clone()).filter(|v| v.channel_id == Some(channel)) else {
        return close(socket, 4004, "not in this voice channel").await;
    };
    let conn = vs.conn;
    let can_speak = channel_for(&st, channel, me).await.is_ok_and(|a| a.has(perms::SPEAK));
    let (tx, mut rx) = mpsc::channel::<(Instant, WsMsg)>(MEDIA_QUEUE);
    if st.voice.with_peer(channel, conn, |p| *p.media.lock().unwrap() = Some(tx)).is_none() {
        return close(socket, 4004, "not in this voice channel").await;
    }

    let (mut sink, mut stream) = socket.split();
    let ready = sink.send(WsMsg::Text(json!({ "op": "ready" }).to_string().into())).await.is_ok();
    let prefix = (me.0 as u64).to_be_bytes();
    let mut ping = tokio::time::interval(Duration::from_secs(20));
    let mut last_seen = Instant::now();
    while ready {
        tokio::select! {
            out = rx.recv() => match out {
                Some((_, WsMsg::Close(_))) | None => break,
                // Too old to be useful: skip it. The viewer notices the gap and asks for a keyframe.
                Some((at, _)) if at.elapsed() > MEDIA_MAX_AGE => {}
                Some((_, m)) => if sink.send(m).await.is_err() { break },
            },
            inc = stream.next() => {
                last_seen = Instant::now();
                match inc {
                    Some(Ok(WsMsg::Binary(data))) => {
                        let kind = data.first().copied().unwrap_or(0);
                        if data.len() >= 2 && (KIND_CAMERA..=KIND_SCREEN_AUDIO).contains(&kind) && can_speak {
                            on_media(&st, me, conn, channel, &prefix, &data).await;
                        }
                    }
                    Some(Ok(WsMsg::Close(_))) | Some(Err(_)) | None => break,
                    Some(Ok(_)) => {}
                }
            },
            _ = ping.tick() => {
                if last_seen.elapsed() > Duration::from_secs(60) { break }
                if sink.send(WsMsg::Ping(Default::default())).await.is_err() { break }
            }
        }
    }
    let _ = st.voice.with_peer(channel, conn, |p| p.media.lock().unwrap().take());
}
