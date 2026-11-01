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
//! kinds: 1 = voice (Opus), 2 = camera video, 3 = screen video, 4 = screen audio (Opus, stereo),
//! 5 = music (Opus, stereo; only sent by bots, on the voice lane, to everyone).
//! Video payload: [flags u8][seq u16 BE][codec: len u8 + ascii, only on keyframes][frame]; flag bit 0 = keyframe.
//!
//! Screen shares are only forwarded to people watching them ("Watch Stream").

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::ws::{CloseFrame, Message as WsMsg, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::{get, patch, put};
use axum::{Json, Router};
use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::mpsc;

use crate::api::channels::channel_for;
use crate::auth::{user_from_token, AuthUser};
use crate::error::{bad, ApiError, ApiResult};
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
const KIND_MUSIC: u8 = 5;

static NEXT_CONN: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Serialize)]
pub struct VoiceState {
    pub user_id: Id,
    /// None for calls in DMs and group DMs.
    pub guild_id: Option<Id>,
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
    /// The channel this session was in, kept after leaving so a DM call's members hear about it.
    #[serde(skip)]
    home: Id,
}

type MediaTx = mpsc::Sender<(Instant, WsMsg)>;

struct Peer {
    user: Id,
    conn: u64,
    /// Last time they talked (or joined, or changed mute/camera/stream), for the AFK channel.
    active: Mutex<Instant>,
    tx: mpsc::Sender<WsMsg>,
    /// Set while the peer's media socket is connected.
    media: Mutex<Option<MediaTx>>,
    watching: Mutex<HashSet<Id>>,
}

/// A voice channel's call: it starts when the first person joins and ends when the last one leaves.
struct Call {
    /// None for DM calls.
    guild_id: Option<Id>,
    /// DM calls: who is being rung (and hasn't joined or declined yet).
    ringing: HashSet<Id>,
    /// Bumped each time ringing starts, so an old ringing timeout doesn't cut a newer one short.
    ring_gen: u64,
    started_at: i64,
    /// Set while nobody is in it, so a lone user reconnecting keeps the call going.
    empty_since: Option<Instant>,
    /// The channel status ("what we're up to"), like Discord's. Lives as long as the call.
    status: Option<String>,
}

impl Call {
    fn ended(&self) -> bool {
        self.empty_since.is_some_and(|t| t.elapsed() > CALL_GRACE)
    }
}

/// Longest voice channel status, as on Discord.
const MAX_STATUS: usize = 500;

#[derive(Clone, Serialize)]
pub struct ChannelStatus {
    pub guild_id: Option<Id>,
    pub channel_id: Id,
    pub status: Option<String>,
}

/// How long an empty channel keeps its call (a reconnect, switching device).
const CALL_GRACE: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct VoiceStates {
    by_user: DashMap<Id, VoiceState>,
    rooms: DashMap<Id, Vec<Peer>>,
    calls: DashMap<Id, Call>,
}

/// For the monitor: what's going on in voice right now.
pub struct VoiceSnapshot {
    pub users: usize,
    pub calls: usize,
    pub streams: usize,
    pub cameras: usize,
}

impl VoiceStates {
    pub fn snapshot(&self) -> VoiceSnapshot {
        let (mut streams, mut cameras) = (0, 0);
        for v in self.by_user.iter() {
            streams += v.self_stream as usize;
            cameras += v.self_video as usize;
        }
        VoiceSnapshot { users: self.by_user.len(), calls: self.rooms.iter().filter(|r| !r.is_empty()).count(), streams, cameras }
    }

    pub fn for_guilds(&self, guilds: &[Id]) -> Vec<VoiceState> {
        self.by_user.iter().filter(|v| v.guild_id.is_some_and(|g| guilds.contains(&g))).map(|v| v.clone()).collect()
    }

    /// People in calls in these (DM) channels.
    pub fn for_channels(&self, channels: &[Id]) -> Vec<VoiceState> {
        self.by_user.iter().filter(|v| v.channel_id.is_some_and(|c| channels.contains(&c))).map(|v| v.clone()).collect()
    }

    /// DM calls going on in these channels, with who is being rung.
    pub fn calls_for(&self, channels: &[Id]) -> Vec<CallInfo> {
        self.calls
            .iter()
            .filter(|c| channels.contains(c.key()) && c.guild_id.is_none() && c.empty_since.is_none())
            .map(|c| CallInfo { channel_id: *c.key(), ringing: c.ringing.iter().copied().collect() })
            .collect()
    }

    /// Statuses of the calls going on in these guilds.
    pub fn statuses_for(&self, guilds: &[Id]) -> Vec<ChannelStatus> {
        self.calls
            .iter()
            .filter(|c| c.guild_id.is_some_and(|g| guilds.contains(&g)) && !c.ended())
            .filter_map(|c| c.status.clone().map(|s| ChannelStatus { guild_id: c.guild_id, channel_id: *c.key(), status: Some(s) }))
            .collect()
    }

    /// Sends to everyone in the channel except the sender. Voice goes on the voice lane; video and stream
    /// audio on the media lane (screen media only to its watchers). Never blocks.
    fn relay(&self, channel: Id, from: u64, from_user: Id, kind: u8, msg: WsMsg) {
        let Some(room) = self.rooms.get(&channel) else { return };
        let now = Instant::now();
        let screen = kind == KIND_SCREEN || kind == KIND_SCREEN_AUDIO;
        let counters = crate::internal::counters();
        let size = if let WsMsg::Binary(b) = &msg { b.len() as u64 } else { 0 };
        if kind == KIND_VOICE || kind == KIND_MUSIC {
            counters.voice_packets.fetch_add(1, Ordering::Relaxed);
            counters.voice_bytes.fetch_add(size, Ordering::Relaxed);
        } else if kind != 0 {
            counters.media_packets.fetch_add(1, Ordering::Relaxed);
            counters.media_bytes.fetch_add(size, Ordering::Relaxed);
        }
        for p in room.iter().filter(|p| p.conn != from) {
            let sent = if kind == KIND_VOICE || kind == KIND_MUSIC || kind == 0 {
                p.tx.try_send(msg.clone()).is_ok()
            } else if screen && !p.watching.lock().unwrap().contains(&from_user) {
                continue;
            } else {
                match p.media.lock().unwrap().as_ref() {
                    Some(media) => media.try_send((now, msg.clone())).is_ok(),
                    // Apps older than 0.1.7 have no media socket yet.
                    None => p.tx.try_send(msg.clone()).is_ok(),
                }
            };
            if !sent {
                counters.queue_drops.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    /// Sends a control message to everyone in the channel, the sender included.
    fn send_all(&self, channel: Id, msg: WsMsg) {
        if let Some(room) = self.rooms.get(&channel) {
            for p in room.iter() {
                let _ = p.tx.try_send(msg.clone());
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

    /// The start of the channel's call, beginning one if it had none (or it ended a while ago), and
    /// whether an old call's status was cleared by that.
    fn join_call(&self, channel: Id, guild_id: Option<Id>) -> (i64, bool) {
        let now = chrono::Utc::now().timestamp_millis();
        let mut call = self.calls.entry(channel).or_insert(Call {
            guild_id,
            ringing: HashSet::new(),
            ring_gen: 0,
            started_at: now,
            empty_since: None,
            status: None,
        });
        let mut cleared = false;
        if call.ended() {
            call.started_at = now;
            cleared = call.status.take().is_some();
        }
        call.empty_since = None;
        (call.started_at, cleared)
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

/// Who hears about a voice session: the server members who can see the channel, or the people in the DM.
async fn audience(st: &AppState, guild: Option<Id>, channel: Id) -> Vec<Id> {
    let r = match guild {
        Some(g) => perms::channel_viewers(&st.db, g, channel).await,
        None => crate::api::dms::recipients(&st.db, channel).await,
    };
    r.unwrap_or_default()
}

async fn announce(st: &AppState, vs: &VoiceState) {
    let to = audience(st, vs.guild_id, vs.home).await;
    st.hub.send(&to, "VOICE_STATE_UPDATE", vs);
}

/// A DM call and who it's ringing, as clients get it.
#[derive(Clone, Serialize)]
pub struct CallInfo {
    pub channel_id: Id,
    pub ringing: Vec<Id>,
}

/// Tells the DM's people who is being rung (an empty list: nobody, or the call ended).
async fn announce_call(st: &AppState, channel: Id) {
    let ringing: Vec<Id> = st.voice.calls.get(&channel).map(|c| c.ringing.iter().copied().collect()).unwrap_or_default();
    let to = audience(st, None, channel).await;
    st.hub.send(&to, "CALL_UPDATE", &CallInfo { channel_id: channel, ringing });
}

/// How long a DM call rings before giving up, like Discord's.
const RING_FOR: Duration = Duration::from_secs(60);

/// Rings `users` for the DM call in `channel` (people already in it are skipped), for RING_FOR.
pub async fn ring(st: &AppState, channel: Id, users: Vec<Id>) {
    let inside: HashSet<Id> = st.voice.rooms.get(&channel).map(|r| r.iter().map(|p| p.user).collect()).unwrap_or_default();
    let gen = {
        let Some(mut call) = st.voice.calls.get_mut(&channel) else { return };
        call.ringing.extend(users.into_iter().filter(|u| !inside.contains(u)));
        call.ring_gen += 1;
        call.ring_gen
    };
    announce_call(st, channel).await;
    let st = st.clone();
    tokio::spawn(async move {
        tokio::time::sleep(RING_FOR).await;
        let stopped = st.voice.calls.get_mut(&channel).filter(|c| c.ring_gen == gen && !c.ringing.is_empty()).map(|mut c| c.ringing.clear()).is_some();
        if stopped {
            announce_call(&st, channel).await;
        }
    });
}

/// Stops ringing `user` (they joined or declined).
pub async fn stop_ringing(st: &AppState, channel: Id, user: Id) {
    let changed = st.voice.calls.get_mut(&channel).is_some_and(|mut c| c.ringing.remove(&user));
    if changed {
        announce_call(st, channel).await;
    }
}

/// Disconnects the user from voice (closing their sockets) and tells their guild.
pub async fn leave(st: &AppState, user: Id) {
    st.previews.remove(&user);
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
        let left = vs.channel_id;
        vs.channel_id = None;
        vs.self_stream = false;
        vs.self_video = false;
        vs.watching.clear();
        vs.call_started_at = None;
        announce(st, &vs).await;
        if let Some(ch) = left {
            if st.voice.rooms.get(&ch).is_none_or(|r| r.is_empty()) {
                crate::watch::call_ended(st, ch, vs.guild_id).await;
            } else {
                crate::watch::left(st, ch, vs.guild_id, user).await;
            }
            if vs.guild_id.is_none() {
                end_dm_call_if_empty(st, ch).await;
            }
        }
    }
}

/// A DM call nobody is in any more stops ringing.
async fn end_dm_call_if_empty(st: &AppState, channel: Id) {
    let empty = st.voice.rooms.get(&channel).is_none_or(|r| r.is_empty());
    if empty && st.voice.calls.get_mut(&channel).is_some_and(|mut c| !std::mem::take(&mut c.ringing).is_empty() || c.guild_id.is_none()) {
        announce_call(st, channel).await;
    }
}

/// Puts `me` in a voice channel (ending any other voice session of theirs) and tells the guild.
/// Returns the session's connection id and the queue of what others send it.
pub async fn join(st: &AppState, me: Id, guild_id: Option<Id>, channel: Id, self_mute: bool, self_deaf: bool) -> (u64, mpsc::Receiver<WsMsg>) {
    // One voice session per user: joining here ends any session in another channel or on another device.
    leave(st, me).await;
    let conn = NEXT_CONN.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = mpsc::channel(VOICE_QUEUE);
    st.voice.rooms.entry(channel).or_default().push(Peer {
        user: me,
        conn,
        tx,
        active: Mutex::new(Instant::now()),
        media: Mutex::new(None),
        watching: Mutex::new(HashSet::new()),
    });
    let (started_at, status_cleared) = st.voice.join_call(channel, guild_id);
    // Whoever opens a DM's call started it (a call already going started earlier than this).
    if guild_id.is_none() && chrono::Utc::now().timestamp_millis() - started_at < 1000 {
        crate::stats::bump(st, me, "calls_started");
    }
    let vs = VoiceState {
        user_id: me,
        guild_id,
        channel_id: Some(channel),
        self_mute,
        self_deaf,
        self_stream: false,
        self_video: false,
        watching: Vec::new(),
        call_started_at: Some(started_at),
        conn,
        home: channel,
    };
    st.voice.by_user.insert(me, vs.clone());
    tracing::info!(user = %me, channel = %channel, "voice: joined");
    announce(st, &vs).await;
    if status_cleared {
        announce_status(st, &ChannelStatus { guild_id, channel_id: channel, status: None }).await;
    }
    if guild_id.is_none() {
        // Joining a DM call answers it; starting one rings everyone else in the DM.
        let alone = st.voice.rooms.get(&channel).is_some_and(|r| r.len() == 1);
        if alone {
            let others: Vec<Id> = crate::api::dms::recipients(&st.db, channel).await.unwrap_or_default().into_iter().filter(|u| *u != me).collect();
            ring(st, channel, others).await;
        } else {
            stop_ringing(st, channel, me).await;
        }
    }
    (conn, rx)
}

/// Ends the voice session `conn` (when it still is in `channel`) and tells the guild.
pub async fn part(st: &AppState, me: Id, conn: u64, channel: Id) {
    if let Some(peer) = st.voice.remove_peer(channel, conn) {
        if let Some(media) = peer.media.lock().unwrap().take() {
            let _ = media.try_send((Instant::now(), WsMsg::Close(None)));
        }
    }
    for viewer in st.voice.unwatch(channel, me) {
        announce(st, &viewer).await;
    }
    if let Some((_, mut vs)) = st.voice.by_user.remove_if(&me, |_, v| v.conn == conn) {
        tracing::info!(user = %me, channel = %channel, "voice: left");
        st.previews.remove(&me);
        vs.channel_id = None;
        vs.self_stream = false;
        vs.self_video = false;
        vs.watching.clear();
        vs.call_started_at = None;
        announce(st, &vs).await;
        if st.voice.rooms.get(&channel).is_none_or(|r| r.is_empty()) {
            crate::watch::call_ended(st, channel, vs.guild_id).await;
        } else {
            crate::watch::left(st, channel, vs.guild_id, me).await;
        }
        if vs.guild_id.is_none() {
            end_dm_call_if_empty(st, channel).await;
        }
    }
}

/// The voice channel a user is in (and its server; None for DM calls).
/// The channel the user is streaming their screen in, if they are.
pub fn streaming_in(st: &AppState, user: Id) -> Option<Id> {
    st.voice.by_user.get(&user).filter(|v| v.self_stream).and_then(|v| v.channel_id)
}

pub fn channel_of(st: &AppState, user: Id) -> Option<(Option<Id>, Id)> {
    st.voice.by_user.get(&user).and_then(|v| v.channel_id.map(|c| (v.guild_id, c)))
}

/// Who else is in the channel.
pub fn others_in(st: &AppState, channel: Id, me: Id) -> usize {
    st.voice.rooms.get(&channel).map_or(0, |r| r.iter().filter(|p| p.user != me).count())
}

/// Sends a bot's music packet (Opus, stereo, 20 ms) to everyone else in the channel.
pub fn send_music(st: &AppState, channel: Id, conn: u64, me: Id, packet: &[u8]) {
    let mut out = Vec::with_capacity(packet.len() + 9);
    out.push(KIND_MUSIC);
    out.extend_from_slice(&(me.0 as u64).to_be_bytes());
    out.extend_from_slice(packet);
    st.voice.relay(channel, conn, me, KIND_MUSIC, WsMsg::Binary(out.into()));
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/voice/connect", get(voice_handler))
        .route("/voice/media", get(media_handler))
        .route("/channels/{id}/voice-status", put(set_status))
        .route("/channels/{id}/call/decline", axum::routing::post(decline_call))
        .route("/channels/{id}/call/ring", axum::routing::post(ring_again))
        .route("/guilds/{id}/members/{user}/voice", patch(move_member))
}

#[derive(Deserialize)]
struct MoveMember {
    /// Where to move them; null disconnects them.
    channel_id: Option<Id>,
}

/// Drags someone to another voice channel of the server, or disconnects them (`channel_id: null`). Needs Move
/// Members in the channel they're in (and in the one they go to, which they must be able to join), like Discord.
/// Their client gets a `move` and rejoins there (or leaves).
async fn move_member(State(st): State<AppState>, AuthUser(me): AuthUser, Path((gid, user)): Path<(Id, Id)>, Json(body): Json<MoveMember>) -> ApiResult<()> {
    let ctx = perms::GuildCtx::load(&st.db, gid).await?;
    let from = st.voice.by_user.get(&user).filter(|v| v.guild_id == Some(gid)).and_then(|v| v.channel_id);
    let Some(from) = from else { return Err(bad("they aren't in a voice channel of this server")) };
    if !ctx.can(me, from, perms::MOVE_MEMBERS) {
        return Err(ApiError::Forbidden);
    }
    let Some(to) = body.channel_id else {
        tracing::info!(user = %user, by = %me, channel = %from, "voice: disconnected by someone");
        let msg = json!({ "op": "move", "channel_id": null, "reason": "disconnect", "by": me }).to_string();
        st.voice.send_to(from, user, WsMsg::Text(msg.into()));
        leave(&st, user).await;
        return Ok(());
    };
    if to == from {
        return Ok(());
    }
    if ctx.kind_of(to) != Some(kind::VOICE) {
        return Err(bad("not a voice channel"));
    }
    if !ctx.can(me, to, perms::MOVE_MEMBERS | perms::CONNECT) {
        return Err(ApiError::Forbidden);
    }
    if crate::music::bot_id(&st) == Some(user) {
        return Err(bad("Kass can't be moved; use /play in the other channel"));
    }
    if !ctx.can(user, to, perms::CONNECT) {
        return Err(bad("they can't join that channel"));
    }
    tracing::info!(user = %user, by = %me, channel = %to, "voice: moved by someone");
    let msg = json!({ "op": "move", "channel_id": to, "reason": "moved", "by": me }).to_string();
    st.voice.send_to(from, user, WsMsg::Text(msg.into()));
    Ok(())
}

async fn announce_status(st: &AppState, status: &ChannelStatus) {
    let to = audience(st, status.guild_id, status.channel_id).await;
    st.hub.send(&to, "VOICE_CHANNEL_STATUS_UPDATE", status);
}

#[derive(Deserialize)]
struct SetStatus {
    status: Option<String>,
}

/// Sets the status of a call: anyone in it can, and people who manage channels can while it's going on.
async fn set_status(State(st): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<Id>, Json(body): Json<SetStatus>) -> ApiResult<Json<ChannelStatus>> {
    let access = channel_for(&st, id, me).await?;
    if access.ch.kind != kind::VOICE {
        return Err(bad("not a voice channel"));
    }
    let inside = st.voice.by_user.get(&me).is_some_and(|v| v.channel_id == Some(id));
    let live = st.voice.rooms.get(&id).is_some_and(|r| !r.is_empty());
    if !inside && !(live && access.has(perms::MANAGE_CHANNELS)) {
        return Err(bad("join the voice channel to set its status"));
    }
    let status = body.status.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if status.as_ref().is_some_and(|s| s.chars().count() > MAX_STATUS) {
        return Err(bad("status must be at most 500 characters"));
    }
    let out = {
        let Some(mut call) = st.voice.calls.get_mut(&id) else { return Err(bad("join the voice channel to set its status")) };
        call.status = status.clone();
        ChannelStatus { guild_id: call.guild_id, channel_id: id, status }
    };
    announce_status(&st, &out).await;
    Ok(Json(out))
}

/// Declines a DM call that's ringing you.
async fn decline_call(State(st): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<Id>) -> ApiResult<()> {
    channel_for(&st, id, me).await?;
    stop_ringing(&st, id, me).await;
    Ok(())
}

#[derive(Deserialize)]
struct RingAgain {
    /// Who to ring; everyone in the DM who isn't in the call when left out.
    user_ids: Option<Vec<Id>>,
}

/// Rings people again (from inside the DM call).
async fn ring_again(State(st): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<Id>, Json(body): Json<RingAgain>) -> ApiResult<()> {
    let a = channel_for(&st, id, me).await?;
    if !kind::is_private(a.ch.kind) || st.voice.by_user.get(&me).and_then(|v| v.channel_id) != Some(id) {
        return Err(bad("join the call first"));
    }
    let members = crate::api::dms::recipients(&st.db, id).await?;
    let users = body.user_ids.unwrap_or_else(|| members.clone()).into_iter().filter(|u| *u != me && members.contains(u)).collect();
    ring(&st, id, users).await;
    Ok(())
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
    /// Play a soundboard sound for everyone in the channel.
    Sound { sound_id: String },
}

/// What someone may do in a call.
struct CallAccess {
    guild: Option<Id>,
    /// Send voice: Speak in servers, always in DMs, never in the server's AFK channel (everyone there is muted,
    /// like Discord).
    speak: bool,
    /// Camera and screen share (Video).
    stream: bool,
    soundboard: bool,
}

/// Whether `me` may join the call in `channel` (a server voice channel with Connect, or a DM / group DM they're
/// in), and what they may do there.
async fn call_access(st: &AppState, channel: Id, me: Id) -> Option<CallAccess> {
    let a = channel_for(st, channel, me).await.ok()?;
    if kind::is_private(a.ch.kind) {
        return Some(CallAccess { guild: None, speak: true, stream: true, soundboard: true });
    }
    if a.ch.kind != kind::VOICE || !a.has(perms::CONNECT) {
        return None;
    }
    let guild = a.ch.guild_id?;
    let afk: Option<Id> = sqlx::query_scalar("SELECT afk_channel_id FROM guilds WHERE id = $1").bind(guild).fetch_optional(&st.db).await.ok().flatten().flatten();
    let speak = a.has(perms::SPEAK) && afk != Some(channel);
    Some(CallAccess { guild: Some(guild), speak, stream: speak && a.has(perms::STREAM), soundboard: speak && a.has(perms::USE_SOUNDBOARD) })
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
            crate::stats::bump(st, me, if kind == KIND_SCREEN { "streams_started" } else { "camera_sessions" });
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
    let channel = ident.channel_id;
    let Some(access) = call_access(&st, channel, me).await else {
        return close(socket, 4004, "not a voice channel").await;
    };
    let (guild_id, can_speak, can_stream) = (access.guild, access.speak, access.stream);
    let (conn, mut rx) = join(&st, me, guild_id, channel, !can_speak, false).await;
    let Some(tx) = st.voice.with_peer(channel, conn, |p| p.tx.clone()) else { return };

    let (mut sink, mut stream) = socket.split();
    let ready = sink.send(WsMsg::Text(json!({ "op": "ready" }).to_string().into())).await.is_ok();
    let prefix = (me.0 as u64).to_be_bytes();
    let mut ping = tokio::time::interval(Duration::from_secs(20));
    let mut last_seen = Instant::now();
    // Time in voice, saved every ping so a restart loses at most a few seconds.
    let mut counted = Instant::now();
    let session = Instant::now();
    crate::stats::bump(&st, me, "voice_sessions");

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
                        // Without the Speak permission the server drops this peer's media; video also needs Video.
                        if data.len() < 2 || !(KIND_VOICE..=KIND_SCREEN_AUDIO).contains(&kind) || !can_speak || (kind != KIND_VOICE && !can_stream) {
                            continue;
                        }
                        if kind == KIND_VOICE {
                            st.voice.with_peer(channel, conn, |p| *p.active.lock().unwrap() = Instant::now());
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
                            st.voice.with_peer(channel, conn, |p| *p.active.lock().unwrap() = Instant::now());
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
                                crate::stats::bump(&st, me, "streams_watched");
                                // A new viewer needs a keyframe to start decoding.
                                let msg = json!({ "op": "keyframe", "source": "screen" }).to_string();
                                st.voice.send_to(channel, user_id, WsMsg::Text(msg.into()));
                            }
                        }
                        Ok(ClientOp::RequestKeyframe { user_id, source }) => {
                            let msg = json!({ "op": "keyframe", "source": source }).to_string();
                            st.voice.send_to(channel, user_id, WsMsg::Text(msg.into()));
                        }
                        Ok(ClientOp::Sound { sound_id }) => {
                            // Spamming is part of the fun: 100 in a row, refilling at 100 a minute.
                            if !access.soundboard || st.limits.check(format!("sound:{me}"), 100.0, 100.0 / 60.0).is_err() {
                                continue;
                            }
                            if let Ok(sound) = crate::soundboard::find(&st, &sound_id, me).await {
                                st.voice.with_peer(channel, conn, |p| *p.active.lock().unwrap() = Instant::now());
                                let msg = json!({ "op": "sound", "user_id": me, "sound": sound }).to_string();
                                st.voice.send_all(channel, WsMsg::Text(msg.into()));
                                crate::stats::bump(&st, me, "sounds_played");
                            }
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
    crate::stats::max(&st, me, "longest_voice_seconds", session.elapsed().as_secs() as i64).await;
    part(&st, me, conn, channel).await;
}

/// Moves people who haven't talked for the server's AFK timeout into its AFK channel (when one is set), like
/// Discord. Their client gets a `move` and rejoins there. People streaming or on camera count as active.
pub async fn afk_sweeper(st: AppState) {
    let mut tick = tokio::time::interval(Duration::from_secs(15));
    loop {
        tick.tick().await;
        let Ok(guilds) = sqlx::query_as::<_, (Id, Id, i32)>(
            "SELECT id, afk_channel_id, afk_timeout FROM guilds WHERE afk_channel_id IS NOT NULL",
        )
        .fetch_all(&st.db)
        .await
        else {
            continue;
        };
        for (guild, afk, timeout) in guilds {
            let idle: Vec<(Id, u64)> = st
                .voice
                .by_user
                .iter()
                .filter(|v| v.guild_id == Some(guild) && v.channel_id.is_some_and(|c| c != afk) && !v.self_stream && !v.self_video)
                .map(|v| (v.user_id, v.conn))
                .collect();
            for (user, conn) in idle {
                let Some(ch) = st.voice.by_user.get(&user).and_then(|v| v.channel_id) else { continue };
                let expired = st
                    .voice
                    .with_peer(ch, conn, |p| {
                        let mut at = p.active.lock().unwrap();
                        let expired = at.elapsed() >= Duration::from_secs(timeout.max(60) as u64);
                        if expired {
                            // Give the client time to move before asking again.
                            *at = Instant::now();
                        }
                        expired
                    })
                    .unwrap_or(false);
                let bot = sqlx::query_scalar::<_, bool>("SELECT bot FROM users WHERE id = $1").bind(user).fetch_one(&st.db).await.unwrap_or(true);
                if expired && !bot {
                    tracing::info!(user = %user, channel = %ch, "voice: moved to the AFK channel");
                    let msg = json!({ "op": "move", "channel_id": afk, "reason": "afk" }).to_string();
                    st.voice.send_to(ch, user, WsMsg::Text(msg.into()));
                }
            }
        }
    }
}

async fn add_voice_time(st: &AppState, user: Id, since: &mut Instant) {
    let secs = since.elapsed().as_secs();
    if secs == 0 {
        return;
    }
    *since += Duration::from_secs(secs);
    let _ = sqlx::query("UPDATE users SET voice_seconds = voice_seconds + $2 WHERE id = $1").bind(user).bind(secs as i64).execute(&st.db).await;
    // What they were doing in the call this whole stretch (the state now stands for the last ~20 s).
    let Some(vs) = st.voice.by_user.get(&user).map(|v| v.clone()) else { return };
    let secs = secs as i64;
    let watching_together = vs.channel_id.is_some_and(|c| st.watches.get(&c).is_some_and(|w| w.viewers.contains(&user)));
    for (key, on) in [
        ("stream_seconds", vs.self_stream),
        ("camera_seconds", vs.self_video),
        ("stream_watch_seconds", !vs.watching.is_empty()),
        ("watch_together_seconds", watching_together),
        ("muted_seconds", vs.self_mute && !vs.self_deaf),
        ("deafened_seconds", vs.self_deaf),
    ] {
        if on {
            crate::stats::add(st, user, key, secs).await;
        }
    }
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
    let can_stream = call_access(&st, channel, me).await.is_some_and(|a| a.stream);
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
                Some((at, _)) if at.elapsed() > MEDIA_MAX_AGE => {
                    crate::internal::counters().stale_media.fetch_add(1, Ordering::Relaxed);
                }
                Some((_, m)) => if sink.send(m).await.is_err() { break },
            },
            inc = stream.next() => {
                last_seen = Instant::now();
                match inc {
                    Some(Ok(WsMsg::Binary(data))) => {
                        let kind = data.first().copied().unwrap_or(0);
                        if data.len() >= 2 && (KIND_CAMERA..=KIND_SCREEN_AUDIO).contains(&kind) && can_stream {
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
