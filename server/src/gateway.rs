//! Realtime gateway: one websocket per client session, server -> client events as `{"s": SEQ, "t": TYPE, "d": DATA}`.
//!
//! Sessions survive short disconnects: events keep buffering for a few minutes, and a client that
//! reconnects with `resume` gets just the events it missed instead of a full READY.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::ws::{CloseFrame, Message as WsMsg, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use dashmap::{DashMap, DashSet};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use tokio::sync::mpsc;

use crate::api::relationships::{self, Relationship};
use crate::api::{dms, guilds, settings};
use crate::auth::{self, random_token};
use crate::error::ApiResult;
use crate::id::Id;
use crate::models::{Channel, DmChannel, Guild, SelfUser, User};
use crate::state::AppState;
use crate::voice::{CallInfo, ChannelStatus, VoiceState};

type Tx = mpsc::UnboundedSender<Arc<str>>;

const BUFFER: usize = 2000;
/// How long a disconnected session can be resumed.
const RESUME_WINDOW: Duration = Duration::from_secs(180);
/// How long a user stays "online" after their last connection drops (covers reconnects).
const PRESENCE_GRACE: Duration = Duration::from_secs(20);
const SEND_TIMEOUT: Duration = Duration::from_secs(30);
/// A session that hasn't answered a ping (every 25 s) for this long isn't "in use" any more (push.rs).
const SEEN_WITHIN: Duration = Duration::from_secs(40);

/// Told to a session's socket through its queue: the session ended, close with 4001.
const CLOSE: &str = "\0close";
/// Told to a session's socket through its queue: this server is handing over (handover.rs), close with 4100 so the
/// client resumes right away.
const RESTART: &str = "\0restart";
/// One person's open sessions; a new one past this ends their oldest.
const MAX_SESSIONS: usize = 16;

struct Session {
    user: Id,
    /// The login this session belongs to; ending the login ends the session.
    token: Vec<u8>,
    tx: Option<Tx>,
    /// Bumped on every attach so a stale socket can't detach a newer one.
    attach: u64,
    seq: u64,
    buffer: VecDeque<(u64, Arc<str>)>,
    detached_at: Option<Instant>,
    /// Last input in the app (op `active`); None while it's in the background (op `away`). push.rs skips people who
    /// are using Linkord somewhere.
    active_at: Option<Instant>,
    /// Last frame from the client (it answers our pings every 25 s): a phone app closed without saying `away` stops
    /// counting as "in use" once this goes stale, before the socket times out.
    seen_at: Instant,
}

/// An event someone missed while frozen: who it's for and its JSON.
pub type Forwarded = (Vec<Id>, String);

#[derive(Default)]
pub struct Hub {
    sessions: DashMap<String, Session>,
    by_user: DashMap<Id, Vec<String>>,
    /// Users we last announced as online.
    announced: DashSet<Id>,
    /// Held for writing while the hub freezes, so no event is half in the snapshot.
    gate: std::sync::RwLock<()>,
    /// While handing over: events go here (to the next process) instead of to sessions.
    forward: std::sync::Mutex<Option<mpsc::UnboundedSender<Forwarded>>>,
}

#[derive(Serialize, Deserialize)]
struct SessionSnap {
    id: String,
    user: Id,
    token: String,
    seq: u64,
    buffer: Vec<(u64, String)>,
    /// How long it had been detached, if it was.
    detached_ms: Option<u64>,
}

#[derive(Serialize, Deserialize, Default)]
struct HubSnap {
    sessions: Vec<SessionSnap>,
    /// Each user's sessions, oldest first.
    by_user: Vec<(Id, Vec<String>)>,
    announced: Vec<Id>,
}

impl Hub {
    /// Everyone with a session (connected, or about to resume).
    pub fn users(&self) -> Vec<Id> {
        self.by_user.iter().filter(|e| !e.value().is_empty()).map(|e| *e.key()).collect()
    }

    /// For the monitor: sessions, sessions with a live socket, users shown as online.
    pub fn snapshot(&self) -> (usize, usize, usize) {
        let attached = self.sessions.iter().filter(|s| s.tx.is_some()).count();
        (self.sessions.len(), attached, self.announced.len())
    }

    fn create(&self, user: Id, token: Vec<u8>, tx: Tx) -> String {
        let id = random_token(16);
        self.sessions.insert(id.clone(), Session { user, token, tx: Some(tx), attach: 0, seq: 0, buffer: VecDeque::new(), detached_at: None, active_at: None, seen_at: Instant::now() });
        let oldest = {
            let mut ids = self.by_user.entry(user).or_default();
            ids.push(id.clone());
            (ids.len() > MAX_SESSIONS).then(|| ids[0].clone())
        };
        if let Some(oldest) = oldest {
            self.end(|s, sid| s.user == user && sid == oldest);
        }
        id
    }

    /// Ends the sessions that match, closing their sockets.
    fn end(&self, matches: impl Fn(&Session, &str) -> bool) {
        let ids: Vec<String> = self.sessions.iter().filter(|e| matches(e.value(), e.key())).map(|e| e.key().clone()).collect();
        for id in ids {
            let Some((_, s)) = self.sessions.remove(&id) else { continue };
            if let Some(tx) = &s.tx {
                let _ = tx.send(CLOSE.into());
            }
            if let Some(mut list) = self.by_user.get_mut(&s.user) {
                list.retain(|other| *other != id);
            }
        }
    }

    /// The login was revoked: its sessions end now, not when the socket happens to drop.
    pub fn close_token(&self, token: &[u8]) {
        self.end(|s, _| s.token == token);
    }

    /// The logins of this user with a socket open right now.
    pub fn live_tokens(&self, user: Id) -> Vec<Vec<u8>> {
        let Some(ids) = self.by_user.get(&user) else { return Vec::new() };
        ids.iter().filter_map(|id| self.sessions.get(id)).filter(|s| s.tx.is_some()).map(|s| s.token.clone()).collect()
    }

    pub fn close_user(&self, user: Id) {
        self.end(|s, _| s.user == user);
    }

    /// Reattaches a disconnected session and returns the events after `seq`, or None if they're gone.
    fn resume(&self, id: &str, user: Id, token: &[u8], seq: u64, tx: Tx) -> Option<(u64, Vec<Arc<str>>)> {
        let mut s = self.sessions.get_mut(id)?;
        if s.user != user || s.token != token || seq > s.seq || s.buffer.front().is_some_and(|(first, _)| *first > seq + 1) {
            return None;
        }
        let missed = s.buffer.iter().filter(|(n, _)| *n > seq).map(|(_, m)| m.clone()).collect();
        s.tx = Some(tx);
        s.attach += 1;
        s.detached_at = None;
        s.seen_at = Instant::now();
        Some((s.attach, missed))
    }

    fn detach(&self, id: &str, attach: u64) {
        if let Some(mut s) = self.sessions.get_mut(id) {
            if s.attach == attach {
                s.tx = None;
                s.detached_at = Some(Instant::now());
            }
        }
    }

    /// Someone is using Linkord right now: a connected session with input within `within`, not in the background.
    pub fn in_use(&self, user: Id, within: Duration) -> bool {
        let Some(ids) = self.by_user.get(&user).map(|v| v.clone()) else { return false };
        ids.iter().any(|id| {
            self.sessions.get(id).is_some_and(|s| s.tx.is_some() && s.seen_at.elapsed() < SEEN_WITHIN && s.active_at.is_some_and(|t| t.elapsed() < within))
        })
    }

    fn set_active(&self, id: &str, active: bool) {
        if let Some(mut s) = self.sessions.get_mut(id) {
            s.active_at = active.then(Instant::now);
        }
    }

    fn seen(&self, id: &str) {
        if let Some(mut s) = self.sessions.get_mut(id) {
            s.seen_at = Instant::now();
        }
    }

    pub fn is_online(&self, user: Id) -> bool {
        self.by_user.get(&user).is_some_and(|ids| {
            ids.iter().any(|id| {
                self.sessions.get(id).is_some_and(|s| s.tx.is_some() || s.detached_at.is_some_and(|t| t.elapsed() < PRESENCE_GRACE))
            })
        })
    }

    pub fn presence(&self, user: &User) -> String {
        // Bots have no session but are always there; Steve shows the Minecraft server's state, and offline while
        // the panel driving him is away ('invisible').
        if user.bot {
            match user.status.as_str() {
                "invisible" => "offline".into(),
                "idle" | "dnd" => user.status.clone(),
                _ => "online".into(),
            }
        } else if self.is_online(user.id) && user.status != "invisible" {
            user.status.clone()
        } else {
            "offline".into()
        }
    }

    pub fn send<T: Serialize>(&self, users: &[Id], t: &str, d: &T) {
        let body = match serde_json::to_string(&serde_json::json!({ "t": t, "d": d })) {
            Ok(s) => s,
            Err(e) => return tracing::error!("event serialization failed: {e}"),
        };
        self.send_raw(users, &body);
    }

    /// Sends an event already serialized as `{"t": ..., "d": ...}`.
    pub fn send_raw(&self, users: &[Id], body: &str) {
        let _gate = self.gate.read().unwrap();
        if let Some(fwd) = self.forward.lock().unwrap().as_ref() {
            let _ = fwd.send((users.to_vec(), body.to_string()));
            return;
        }
        self.deliver(users, body);
    }

    fn deliver(&self, users: &[Id], body: &str) {
        if !body.starts_with('{') {
            return;
        }
        for u in users {
            let Some(ids) = self.by_user.get(u).map(|v| v.clone()) else { continue };
            for id in ids {
                if let Some(mut s) = self.sessions.get_mut(&id) {
                    s.seq += 1;
                    let seq = s.seq;
                    let msg: Arc<str> = format!("{{\"s\":{seq},{}", &body[1..]).into();
                    if s.buffer.len() >= BUFFER {
                        s.buffer.pop_front();
                    }
                    s.buffer.push_back((seq, msg.clone()));
                    if let Some(tx) = &s.tx {
                        let _ = tx.send(msg);
                    }
                }
            }
        }
    }

    /// From now on events are kept for the next process (handover.rs) instead of sent. Returns where they go.
    pub fn freeze(&self) -> mpsc::UnboundedReceiver<Forwarded> {
        let _gate = self.gate.write().unwrap();
        let (tx, rx) = mpsc::unbounded_channel();
        *self.forward.lock().unwrap() = Some(tx);
        rx
    }

    /// The handover didn't happen: events flow again, starting with the ones kept meanwhile.
    pub fn unfreeze(&self, held: Vec<Forwarded>) {
        let _gate = self.gate.write().unwrap();
        *self.forward.lock().unwrap() = None;
        for (users, body) in held {
            self.deliver(&users, &body);
        }
    }

    /// Every session, its buffered events and who's online, for the next process. Call while frozen.
    pub fn snapshot_state(&self) -> serde_json::Value {
        let sessions = self
            .sessions
            .iter()
            .map(|s| SessionSnap {
                id: s.key().clone(),
                user: s.user,
                token: hex::encode(&s.token),
                seq: s.seq,
                buffer: s.buffer.iter().map(|(n, m)| (*n, m.to_string())).collect(),
                detached_ms: if s.tx.is_some() { None } else { s.detached_at.map(|t| t.elapsed().as_millis() as u64) },
            })
            .collect();
        let snap = HubSnap {
            sessions,
            by_user: self.by_user.iter().map(|e| (*e.key(), e.value().clone())).collect(),
            announced: self.announced.iter().map(|u| *u).collect(),
        };
        serde_json::to_value(snap).unwrap_or_default()
    }

    /// Puts sessions back, all detached: their clients reconnect and resume, missing nothing.
    pub fn restore_state(&self, v: serde_json::Value, age_ms: i64) -> anyhow::Result<()> {
        if v.is_null() {
            return Ok(());
        }
        let snap: HubSnap = serde_json::from_value(v)?;
        let now = Instant::now();
        let age = Duration::from_millis(age_ms.max(0) as u64);
        let count = snap.sessions.len();
        for s in snap.sessions {
            // Counted from the snapshot: a session that was connected then left a moment ago.
            let since = Duration::from_millis(s.detached_ms.unwrap_or(0)) + age;
            let Ok(token) = hex::decode(&s.token) else { continue };
            self.sessions.insert(
                s.id,
                Session {
                    user: s.user,
                    token,
                    tx: None,
                    attach: 0,
                    seq: s.seq,
                    buffer: s.buffer.into_iter().map(|(n, m)| (n, Arc::from(m))).collect(),
                    detached_at: Some(now.checked_sub(since).unwrap_or(now)),
                    active_at: None,
                    seen_at: now,
                },
            );
        }
        for (user, ids) in snap.by_user {
            let ids: Vec<String> = ids.into_iter().filter(|id| self.sessions.contains_key(id)).collect();
            if !ids.is_empty() {
                self.by_user.insert(user, ids);
            }
        }
        for u in snap.announced {
            self.announced.insert(u);
        }
        tracing::info!(sessions = count, "handover: gateway sessions restored");
        Ok(())
    }

    /// Closes every socket with 4100: clients reconnect at once and resume (on the next process).
    pub fn close_all_restarting(&self) {
        for s in self.sessions.iter() {
            if let Some(tx) = &s.tx {
                let _ = tx.send(RESTART.into());
            }
        }
    }

    /// Drops expired sessions; returns users whose online state changed.
    fn sweep(&self) -> (Vec<Id>, Vec<Id>) {
        let expired: Vec<(String, Id)> = self
            .sessions
            .iter()
            .filter(|s| s.detached_at.is_some_and(|t| t.elapsed() > RESUME_WINDOW))
            .map(|s| (s.key().clone(), s.user))
            .collect();
        for (id, user) in expired {
            self.sessions.remove(&id);
            self.by_user.remove_if_mut(&user, |_, v| {
                v.retain(|x| *x != id);
                v.is_empty()
            });
        }
        let users: HashSet<Id> = self.by_user.iter().map(|e| *e.key()).chain(self.announced.iter().map(|u| *u)).collect();
        let (mut went_online, mut went_offline) = (vec![], vec![]);
        for u in users {
            match (self.is_online(u), self.announced.contains(&u)) {
                (true, false) => {
                    self.announced.insert(u);
                    went_online.push(u);
                }
                (false, true) => {
                    self.announced.remove(&u);
                    went_offline.push(u);
                }
                _ => {}
            }
        }
        (went_online, went_offline)
    }
}

pub async fn guild_members(db: &PgPool, guild: Id) -> ApiResult<Vec<Id>> {
    Ok(sqlx::query_scalar("SELECT user_id FROM members WHERE guild_id = $1").bind(guild).fetch_all(db).await?)
}

/// Everyone who can see this channel (server channels: members with View Channel there).
pub async fn channel_audience(db: &PgPool, ch: &Channel) -> ApiResult<Vec<Id>> {
    match ch.guild_id {
        Some(g) => crate::perms::channel_viewers(db, g, ch.id).await,
        None => dms::recipients(db, ch.id).await,
    }
}

/// Who sees which channels of a server, taken before a change to roles or overwrites.
pub async fn visibility(db: &PgPool, guild: Id) -> ApiResult<HashMap<Id, HashSet<Id>>> {
    Ok(crate::perms::GuildCtx::load(db, guild).await?.visibility())
}

/// After a permission change: people who can now see a channel get CHANNEL_CREATE (plus who is in it, for voice
/// channels), people who no longer can get CHANNEL_DELETE (with `hidden`, so clients know it still exists).
pub async fn announce_visibility(st: &AppState, guild: Id, before: HashMap<Id, HashSet<Id>>) -> ApiResult<()> {
    let ctx = crate::perms::GuildCtx::load(&st.db, guild).await?;
    let empty = HashSet::new();
    let mut loaded: HashMap<Id, Channel> = HashMap::new();
    for user in ctx.members().collect::<Vec<_>>() {
        let now = ctx.visible_channels(user);
        let was = before.get(&user).unwrap_or(&empty);
        let mut gained: Vec<Id> = now.difference(was).copied().collect();
        // Categories first, so channels land in them.
        gained.sort_by_key(|id| ctx.kind_of(*id) != Some(crate::models::kind::CATEGORY));
        for id in gained {
            let ch = match loaded.get(&id) {
                Some(c) => c.clone(),
                None => {
                    let Ok(c) = Channel::get(&st.db, id).await else { continue };
                    let c = c.with_overwrites(&st.db).await?;
                    loaded.insert(id, c.clone());
                    c
                }
            };
            st.hub.send(&[user], "CHANNEL_CREATE", &ch);
            for vs in st.voice.for_channels(&[id]) {
                st.hub.send(&[user], "VOICE_STATE_UPDATE", &vs);
            }
        }
        for id in was.difference(&now) {
            st.hub.send(&[user], "CHANNEL_DELETE", &serde_json::json!({ "id": id, "guild_id": guild, "hidden": true }));
        }
    }
    crate::voice::recheck(st, &ctx).await;
    Ok(())
}

/// Everyone who shares a guild or DM with the user, or is their friend (including the user).
pub async fn related_users(db: &PgPool, user: Id) -> ApiResult<Vec<Id>> {
    Ok(sqlx::query_scalar(
        "SELECT m2.user_id FROM members m1 JOIN members m2 ON m2.guild_id = m1.guild_id WHERE m1.user_id = $1
         UNION
         SELECT d2.user_id FROM dm_recipients d1 JOIN dm_recipients d2 ON d2.channel_id = d1.channel_id WHERE d1.user_id = $1
         UNION
         SELECT target_id FROM relationships WHERE user_id = $1 AND kind = 1
         UNION SELECT $1",
    )
    .bind(user)
    .fetch_all(db)
    .await?)
}

/// What others see: online status, plus activities (Spotify...) unless offline or invisible.
pub fn activities_of(st: &AppState, user: &User) -> Vec<serde_json::Value> {
    if st.hub.presence(user) == "offline" {
        return vec![];
    }
    st.activities.get(&user.id).map(|a| a.clone()).unwrap_or_default()
}

fn presence_event(st: &AppState, user: &User) -> serde_json::Value {
    serde_json::json!({ "user_id": user.id, "status": st.hub.presence(user), "activities": activities_of(st, user) })
}

pub async fn broadcast_presence(st: &AppState, user: &User) -> ApiResult<()> {
    let audience = related_users(&st.db, user.id).await?;
    st.hub.send(&audience, "PRESENCE_UPDATE", &presence_event(st, user));
    Ok(())
}

/// Sends `user`'s presence to specific people (e.g. a new friend).
pub async fn broadcast_presence_to(st: &AppState, user: Id, to: &[Id]) -> ApiResult<()> {
    let u = User::get(&st.db, user).await?;
    st.hub.send(to, "PRESENCE_UPDATE", &presence_event(st, &u));
    Ok(())
}

/// Announces presence changes caused by connects, disconnects and expired sessions.
pub async fn presence_sweeper(st: AppState) {
    let mut tick = tokio::time::interval(Duration::from_secs(3));
    loop {
        tick.tick().await;
        if crate::handover::retired() {
            return;
        }
        if crate::handover::paused() {
            continue;
        }
        let (online, offline) = st.hub.sweep();
        for u in online.into_iter().chain(offline) {
            if let Ok(user) = User::get(&st.db, u).await {
                let _ = broadcast_presence(&st, &user).await;
            }
        }
    }
}

/// Desktop apps before 0.1.38 read `features.gifs` (their GIF picker); always off now that it's gone.
#[derive(Serialize)]
struct Features {
    gifs: bool,
}

#[derive(Serialize)]
struct Ready<'a> {
    session_id: &'a str,
    user: SelfUser<'a>,
    guilds: Vec<Guild>,
    dms: Vec<DmChannel>,
    relationships: Vec<Relationship>,
    settings: serde_json::Value,
    presences: HashMap<Id, String>,
    /// Users doing something (listening to Spotify...); absent = nothing.
    activities: HashMap<Id, Vec<serde_json::Value>>,
    /// Your own custom status, also while invisible (activities only lists it when others can see it).
    custom_status: Option<serde_json::Value>,
    read_states: HashMap<Id, Id>,
    voice_states: Vec<VoiceState>,
    /// Statuses of the voice calls going on ("what we're up to").
    voice_channel_statuses: Vec<ChannelStatus>,
    /// Calls in your DMs and group DMs, with who they're ringing.
    calls: Vec<CallInfo>,
    /// What calls are watching together (watch.rs), and the server's clock to sync to.
    watches: Vec<serde_json::Value>,
    server_now: i64,
    features: Features,
    /// LINKORD_ADMINS: can change the music bot's picture.
    admin: bool,
    /// Slash commands of bots driven from outside (Steve, steve.rs), while they're connected.
    bot_commands: serde_json::Value,
}

async fn build_ready(st: &AppState, user_id: Id, session_id: &str) -> ApiResult<String> {
    let user = User::get(&st.db, user_id).await?;
    let guild_ids: Vec<Id> =
        sqlx::query_scalar("SELECT guild_id FROM members WHERE user_id = $1 ORDER BY joined_at").bind(user_id).fetch_all(&st.db).await?;
    let mut guild_list = Vec::with_capacity(guild_ids.len());
    for g in &guild_ids {
        guild_list.push(guilds::load_guild(&st.db, *g, user_id).await?);
    }
    let related = related_users(&st.db, user_id).await?;
    let related_users = User::get_many(&st.db, &related).await?;
    let presences = related_users.iter().map(|u| (u.id, st.hub.presence(u))).collect();
    let activities = related_users.iter().map(|u| (u.id, activities_of(st, u))).filter(|(_, a)| !a.is_empty()).collect();
    let read_states = sqlx::query_as::<_, (Id, Id)>("SELECT channel_id, last_read_id FROM read_states WHERE user_id = $1")
        .bind(user_id)
        .fetch_all(&st.db)
        .await?
        .into_iter()
        .collect();
    let dms = dms::load_dms(&st.db, user_id).await?;
    let voice_channels: Vec<Id> = guild_list.iter().flat_map(|g| g.channels.iter().filter(|c| c.kind == crate::models::kind::VOICE).map(|c| c.id)).collect();
    let dm_ids: Vec<Id> = dms.iter().map(|d| d.channel.id).collect();
    let ready = Ready {
        session_id,
        user: user.me(),
        guilds: guild_list,
        dms,
        relationships: relationships::load(&st.db, user_id).await?,
        settings: settings::load(&st.db, user_id).await?,
        presences,
        activities,
        custom_status: crate::activities::own_custom_status(st, user_id),
        read_states,
        voice_states: st.voice.for_channels(&[voice_channels.clone(), dm_ids.clone()].concat()),
        voice_channel_statuses: st.voice.statuses_for(&guild_ids).into_iter().filter(|s| voice_channels.contains(&s.channel_id)).collect(),
        calls: st.voice.calls_for(&dm_ids),
        watches: crate::watch::for_channels(st, &[voice_channels, dm_ids.clone()].concat()),
        server_now: chrono::Utc::now().timestamp_millis(),
        features: Features { gifs: false },
        admin: auth::is_admin(st, user_id).await,
        bot_commands: crate::steve::commands_for_ready(st),
    };
    Ok(serde_json::to_string(&serde_json::json!({ "t": "READY", "d": ready })).map_err(anyhow::Error::from)?)
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum ClientOp {
    Identify {
        token: String,
        #[serde(default)]
        client: Option<String>,
    },
    Resume {
        token: String,
        session_id: String,
        seq: u64,
        #[serde(default)]
        client: Option<String>,
    },
}

/// The longest browser description kept for Settings -> Sessions.
const MAX_USER_AGENT: usize = 256;

pub async fn ws_handler(State(st): State<AppState>, crate::ratelimit::ClientIp(ip): crate::ratelimit::ClientIp, headers: axum::http::HeaderMap, ws: WebSocketUpgrade) -> ApiResult<Response> {
    crate::security::socket_limit(&st, &ip)?;
    let agent = headers.get(axum::http::header::USER_AGENT).and_then(|v| v.to_str().ok()).map(|v| v.chars().take(MAX_USER_AGENT).collect::<String>());
    // Clients only ever send identify or resume here.
    Ok(ws.max_message_size(16 * 1024).max_frame_size(16 * 1024).on_upgrade(move |socket| run(st, socket, agent)))
}

async fn run(st: AppState, mut socket: WebSocket, agent: Option<String>) {
    let op = match tokio::time::timeout(Duration::from_secs(15), socket.recv()).await {
        Ok(Some(Ok(WsMsg::Text(t)))) => match serde_json::from_str::<ClientOp>(&t) {
            Ok(op) => op,
            Err(_) => return,
        },
        _ => return,
    };
    let token = match &op {
        ClientOp::Identify { token, .. } | ClientOp::Resume { token, .. } => token.clone(),
    };
    // Only these two, so a client can't write whatever it likes into its sessions list.
    let client = match &op {
        ClientOp::Identify { client, .. } | ClientOp::Resume { client, .. } => client.as_deref().filter(|c| matches!(*c, "desktop" | "web" | "android")),
    };
    let user_id = match auth::user_from_token(&st, &token).await {
        Ok(Some(u)) => u,
        _ => {
            let _ = socket.send(WsMsg::Close(Some(CloseFrame { code: 4001, reason: "invalid token".into() }))).await;
            return;
        }
    };

    let token_hash = auth::hash_token(&token);
    auth::touch_session(&st, &token_hash, Some((agent.as_deref(), client))).await;
    let login = token_hash.clone();
    let (tx, mut rx) = mpsc::unbounded_channel::<Arc<str>>();
    let resumed = match &op {
        ClientOp::Resume { session_id, seq, .. } => st.hub.resume(session_id, user_id, &token_hash, *seq, tx.clone()).map(|r| (session_id.clone(), r)),
        ClientOp::Identify { .. } => None,
    };
    let (session_id, attach) = match resumed {
        Some((id, (attach, missed))) => {
            let mut ok = socket.send(WsMsg::Text(r#"{"t":"RESUMED","d":null}"#.into())).await.is_ok();
            for m in missed {
                ok = ok && socket.send(WsMsg::Text(m.as_ref().into())).await.is_ok();
            }
            if !ok {
                st.hub.detach(&id, attach);
                return;
            }
            (id, attach)
        }
        None => {
            let id = st.hub.create(user_id, token_hash, tx);
            let sent = match build_ready(&st, user_id, &id).await {
                Ok(r) => socket.send(WsMsg::Text(r.into())).await.is_ok(),
                Err(e) => {
                    tracing::error!("ready failed: {e}");
                    false
                }
            };
            if !sent {
                return st.hub.detach(&id, 0);
            }
            (id, 0)
        }
    };

    let (mut sink, mut stream) = socket.split();
    let mut ping = tokio::time::interval(Duration::from_secs(25));
    let mut last_seen = Instant::now();
    loop {
        tokio::select! {
            out = rx.recv() => match out {
                Some(m) if m.as_ref() == CLOSE => {
                    let _ = sink.send(WsMsg::Close(Some(CloseFrame { code: 4001, reason: "signed out".into() }))).await;
                    break;
                }
                Some(m) if m.as_ref() == RESTART => {
                    let _ = sink.send(WsMsg::Close(Some(CloseFrame { code: 4100, reason: "server restarting".into() }))).await;
                    break;
                }
                // A client that stopped reading loses the socket rather than filling memory; it can resume.
                Some(m) => match tokio::time::timeout(SEND_TIMEOUT, sink.send(WsMsg::Text(m.as_ref().into()))).await {
                    Ok(Ok(())) => {}
                    _ => break,
                },
                None => break,
            },
            inc = stream.next() => match inc {
                Some(Ok(WsMsg::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(m)) => {
                    last_seen = Instant::now();
                    st.hub.seen(&session_id);
                    // The only things clients say after identifying: whether they're being used (push.rs).
                    if let WsMsg::Text(t) = &m {
                        match serde_json::from_str::<serde_json::Value>(t).ok().as_ref().and_then(|v| v["op"].as_str()) {
                            Some("active") => st.hub.set_active(&session_id, true),
                            Some("away") => st.hub.set_active(&session_id, false),
                            _ => {}
                        }
                    }
                }
            },
            _ = ping.tick() => {
                if last_seen.elapsed() > Duration::from_secs(80) { break }
                if sink.send(WsMsg::Ping(Default::default())).await.is_err() { break }
            }
        }
    }
    // Handed over: the session lives on in the next process.
    if crate::handover::retired() {
        return;
    }
    // Voice has its own socket and presence has a grace period, so a brief reconnect changes nothing visible.
    st.hub.detach(&session_id, attach);
    auth::touch_session(&st, &login, None).await;
}
