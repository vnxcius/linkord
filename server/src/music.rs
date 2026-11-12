//! Kass, the music bot. `/play <YouTube link or search>` in a server's text channel brings him into the voice
//! channel you're in, where he plays the audio like any other participant: yt-dlp downloads it, ffmpeg turns it
//! into 20 ms stereo Opus packets (in Ogg), and those go out on the voice lane as kind 5 (voice.rs), paced in
//! real time. Also /skip, /pause, /resume, /queue, /remove (a queued song, by number or name), /repeat (the song or
//! the whole queue) and /stop.
//!
//! Kass is one user, and a user can only be in one voice channel, so he plays in one channel at a time.
//! He leaves when the queue has been empty for a minute, when everyone else leaves, or on /stop.
//!
//! LINKORD_YTDLP points at yt-dlp (default: data/bin/yt-dlp if present, else `yt-dlp` on the PATH); it is
//! updated daily with `yt-dlp -U`. LINKORD_YTDLP_ARGS adds arguments to every call (e.g. `--js-runtimes node`).

use std::collections::VecDeque;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use axum::extract::{Multipart, Path, State};
use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::io::{AsyncRead, AsyncReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, Notify};
use tokio::time::Instant;

use crate::api::channels::channel_for;
use crate::api::guilds::load_member;
use crate::api::messages::post_bot_message;
use crate::auth::{AdminUser, AuthUser};
use crate::error::{bad, ApiError, ApiResult};
use crate::gateway::guild_members;
use crate::id::Id;
use crate::models::{kind, Message, User};
use crate::uploads;
use crate::perms;
use crate::state::AppState;
use crate::voice;

/// How long Kass waits in an idle call for something new to play.
const IDLE_LEAVE: Duration = Duration::from_secs(60);
const FRAME: Duration = Duration::from_millis(20);
const MAX_QUEUE: usize = 100;
const AVATAR: &str = include_str!("../assets/kass.svg");
const DEFAULT_AVATAR: &str = "/uploads/bots/kass.svg";
const GOLD: i32 = 0xe3b341;
/// Kass's slash commands (and the client's /snowball): another bot (steve.rs) can't take these names.
pub const COMMANDS: &[&str] = &["play", "skip", "pause", "resume", "queue", "repeat", "remove", "stop", "snowball"];

#[derive(Default)]
pub struct Music {
    bot: OnceLock<Id>,
    player: Mutex<Option<Arc<Player>>>,
}

impl Music {
    /// For the monitor.
    pub fn is_playing(&self) -> bool {
        self.player.lock().unwrap().as_ref().is_some_and(|p| p.now.lock().unwrap().is_some())
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Track {
    /// What yt-dlp plays: a YouTube URL, or `ytsearch1:<artist> - <title>` for songs from Spotify (looked up
    /// only when they're about to play, so a whole playlist queues at once).
    url: String,
    /// The link shown in "Now playing" when it isn't `url` (the song on Spotify).
    page: Option<String>,
    title: String,
    /// Seconds; None for live streams.
    duration: Option<f64>,
    uploader: Option<String>,
    thumbnail: Option<String>,
    requested_by: Id,
}

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
enum Repeat {
    Off,
    /// The current song plays again until skipped.
    Song,
    /// Finished (and skipped) songs go to the back of the queue.
    Queue,
}

/// Kass's session in one voice channel.
struct Player {
    guild_id: Id,
    channel_id: Id,
    /// Where "Now playing" goes: the text channel of the latest /play.
    text_channel: Mutex<Id>,
    queue: Mutex<VecDeque<Track>>,
    now: Mutex<Option<Track>>,
    /// The next song's download, started early: (its URL, the pipeline).
    prepared: Mutex<Option<(String, Pipeline)>>,
    repeat: Mutex<Repeat>,
    paused: AtomicBool,
    skip: AtomicBool,
    stop: AtomicBool,
    /// Wakes the player after any change above.
    wake: Notify,
    /// How far into the current song it is (ms), for a handover.
    position_ms: AtomicU64,
    /// After a restart: the song that was playing and where to pick it up (ms).
    resume_at: Mutex<Option<(String, u64)>>,
}

impl Player {
    fn poke(&self) {
        self.wake.notify_one();
    }

    fn done(&self) -> bool {
        self.stop.load(Ordering::Relaxed)
    }
}

/// Creates (or finds) Kass's account and writes his default avatar. A picture an admin uploaded
/// (POST /bots/music/avatar) is kept; the account was called Link before, hence its discord_id.
pub async fn init(st: &AppState) -> anyhow::Result<()> {
    let dir = st.cfg.uploads_dir().join("bots");
    tokio::fs::create_dir_all(&dir).await?;
    tokio::fs::write(dir.join("kass.svg"), AVATAR).await?;
    let id: Id = sqlx::query_scalar(
        "INSERT INTO users (id, discord_id, username, display_name, avatar, bio, bot)
         VALUES ($1, 'bot:link', 'kass', 'Kass', $3, $2, true)
         ON CONFLICT (discord_id) DO UPDATE SET bot = true, username = 'kass', display_name = 'Kass', bio = EXCLUDED.bio,
             avatar = CASE WHEN users.avatar IS NULL OR users.avatar LIKE '/uploads/bots/link%' OR users.avatar = $3
                           THEN EXCLUDED.avatar ELSE users.avatar END
         RETURNING id",
    )
    .bind(Id::new())
    .bind("Plays YouTube and Spotify in voice channels. Join one and type /play with a link or a search.")
    .bind(DEFAULT_AVATAR)
    .fetch_one(&st.db)
    .await?;
    let _ = st.music.bot.set(id);
    // Kass is in every server, except the ones that removed him.
    sqlx::query("INSERT INTO members (guild_id, user_id) SELECT id, $1 FROM guilds WHERE music_bot ON CONFLICT DO NOTHING")
        .bind(id)
        .execute(&st.db)
        .await?;
    Ok(())
}

pub fn bot_id(st: &AppState) -> Option<Id> {
    st.music.bot.get().copied()
}

async fn in_guild(st: &AppState, guild: Id, bot: Id) -> ApiResult<bool> {
    Ok(sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM members WHERE guild_id = $1 AND user_id = $2)")
        .bind(guild)
        .bind(bot)
        .fetch_one(&st.db)
        .await?)
}

/// Kicking Kass is how a server opts out: he stays out (even after restarts) until he's added back.
pub async fn removed_from(st: &AppState, guild: Id) {
    let _ = sqlx::query("UPDATE guilds SET music_bot = false WHERE id = $1").bind(guild).execute(&st.db).await;
}

/// Server Settings or Settings -> Kass: takes Kass out of a server (like kicking him), Manage Server.
async fn remove_from_guild(State(st): State<AppState>, AuthUser(me): AuthUser, Path(guild): Path<Id>) -> ApiResult<()> {
    crate::perms::guild_perms(&st.db, guild, me).await?.require(perms::MANAGE_GUILD)?;
    let bot = bot_id(&st).ok_or(ApiError::NotFound)?;
    removed_from(&st, guild).await;
    if in_guild(&st, guild, bot).await? {
        tracing::info!(user = %me, guild = %guild, "music bot removed");
        crate::api::guilds::remove_member(&st, guild, bot).await?;
    }
    Ok(())
}

#[derive(Deserialize)]
struct KassSettings {
    /// Servers you create start with Kass.
    new_servers: bool,
}

async fn kass_settings(State(st): State<AppState>, AuthUser(me): AuthUser) -> ApiResult<Json<serde_json::Value>> {
    let on: bool = sqlx::query_scalar("SELECT kass_new_servers FROM users WHERE id = $1").bind(me).fetch_one(&st.db).await?;
    Ok(Json(json!({ "new_servers": on })))
}

async fn set_kass_settings(State(st): State<AppState>, AuthUser(me): AuthUser, Json(body): Json<KassSettings>) -> ApiResult<Json<serde_json::Value>> {
    sqlx::query("UPDATE users SET kass_new_servers = $2 WHERE id = $1").bind(me).bind(body.new_servers).execute(&st.db).await?;
    Ok(Json(json!({ "new_servers": body.new_servers })))
}

/// Server Settings: brings Kass back into a server that removed him (Manage Server).
async fn add_to_guild(State(st): State<AppState>, AuthUser(me): AuthUser, Path(guild): Path<Id>) -> ApiResult<()> {
    crate::perms::guild_perms(&st.db, guild, me).await?.require(perms::MANAGE_GUILD)?;
    let bot = bot_id(&st).ok_or(ApiError::NotFound)?;
    sqlx::query("UPDATE guilds SET music_bot = true WHERE id = $1").bind(guild).execute(&st.db).await?;
    let joined = sqlx::query("INSERT INTO members (guild_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING")
        .bind(guild)
        .bind(bot)
        .execute(&st.db)
        .await?
        .rows_affected()
        > 0;
    if joined {
        tracing::info!(user = %me, guild = %guild, "music bot added back");
        let member = load_member(&st.db, guild, bot).await?;
        let others = guild_members(&st.db, guild).await?;
        st.hub.send(&others, "GUILD_MEMBER_ADD", &json!({ "guild_id": guild, "member": member, "status": "online" }));
    }
    Ok(())
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/channels/{id}/commands", post(run_command))
        .route("/bots/music/avatar", post(set_avatar).delete(reset_avatar))
        .route("/guilds/{id}/bots/music", post(add_to_guild).delete(remove_from_guild))
        .route("/users/@me/kass", axum::routing::get(kass_settings).put(set_kass_settings))
}

const MAX_AVATAR: usize = 4 * 1024 * 1024;

/// An admin gives Kass a new picture (png, jpeg, gif or webp).
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
    let bot = *st.music.bot.get().ok_or(ApiError::NotFound)?;
    sqlx::query("UPDATE users SET avatar = $2 WHERE id = $1").bind(bot).bind(url).execute(&st.db).await?;
    let user = User::get(&st.db, bot).await?;
    let audience: Vec<Id> = sqlx::query_scalar("SELECT id FROM users WHERE deleted_at IS NULL AND NOT bot").fetch_all(&st.db).await?;
    st.hub.send(&audience, "USER_UPDATE", &user);
    Ok(Json(user))
}

fn ytdlp(st: &AppState) -> PathBuf {
    if let Some(p) = std::env::var_os("LINKORD_YTDLP").filter(|p| !p.is_empty()) {
        return p.into();
    }
    let local = st.cfg.data_dir.join(if cfg!(windows) { "bin/yt-dlp.exe" } else { "bin/yt-dlp" });
    if local.exists() {
        local
    } else {
        "yt-dlp".into()
    }
}

fn ytdlp_cmd(st: &AppState) -> Command {
    let mut cmd = Command::new(ytdlp(st));
    if let Ok(extra) = std::env::var("LINKORD_YTDLP_ARGS") {
        cmd.args(extra.split_whitespace());
    }
    cmd.kill_on_drop(true).stdin(Stdio::null());
    cmd
}

/// `yt-dlp --version`, for the monitor (internal.rs probe_tools).
pub fn ytdlp_version_cmd(st: &AppState) -> Command {
    let mut cmd = Command::new(ytdlp(st));
    cmd.arg("--version");
    cmd
}

/// YouTube breaks old yt-dlp versions regularly, so keep it current.
pub async fn keep_ytdlp_updated(st: AppState) {
    loop {
        match ytdlp_cmd(&st).arg("-U").output().await {
            Ok(out) => {
                let text = String::from_utf8_lossy(&out.stdout);
                if let Some(line) = text.lines().rev().find(|l| !l.trim().is_empty()) {
                    tracing::info!("yt-dlp -U: {line}");
                }
            }
            Err(e) => tracing::warn!("yt-dlp not available ({e}): /play won't work until it's installed"),
        }
        crate::internal::probe_tools(&st).await;
        tokio::time::sleep(Duration::from_secs(24 * 3600)).await;
        if crate::handover::retired() {
            return;
        }
    }
}

/// Only YouTube: yt-dlp would fetch any URL from this machine otherwise.
fn youtube_url(q: &str) -> Option<&str> {
    let rest = q.strip_prefix("https://").or_else(|| q.strip_prefix("http://"))?;
    let host = rest.split(['/', '?', '#']).next()?.to_ascii_lowercase();
    let ok = matches!(host.as_str(), "youtube.com" | "www.youtube.com" | "m.youtube.com" | "music.youtube.com" | "youtu.be");
    ok.then_some(q)
}

/// Looks up a YouTube link, or searches YouTube for anything else.
/// What to hand yt-dlp for `/play <query>`: the YouTube link, or a search.
fn target_for(query: &str) -> ApiResult<String> {
    match youtube_url(query) {
        Some(url) => Ok(url.to_string()),
        None if query.starts_with("http://") || query.starts_with("https://") => Err(bad("only YouTube and Spotify links can be played")),
        None => Ok(format!("ytsearch1:{query}")),
    }
}

/// Looks up a YouTube link or search (see [`target_for`]).
async fn resolve(st: &AppState, target: String, requested_by: Id) -> ApiResult<Track> {
    let _turn = crate::media::lookup_turn().await?;
    let run = ytdlp_cmd(st).args(["-j", "--no-playlist", "--no-warnings", "--", &target]).output();
    let out = match tokio::time::timeout(Duration::from_secs(30), run).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => {
            tracing::error!("running yt-dlp: {e}");
            return Err(bad("the music player isn't set up on this server"));
        }
        Err(_) => return Err(bad("YouTube took too long to answer")),
    };
    let info: serde_json::Value = String::from_utf8_lossy(&out.stdout)
        .lines()
        .find_map(|l| serde_json::from_str(l).ok())
        .ok_or_else(|| {
            // What someone searched for stays out of the log.
            let what = if target.starts_with("ytsearch") { "a search" } else { "a link" };
            tracing::warn!("yt-dlp found nothing for {what}: {}", String::from_utf8_lossy(&out.stderr).trim());
            bad("couldn't find that video")
        })?;
    let s = |k: &str| info[k].as_str().map(str::to_string);
    Ok(Track {
        page: None,
        url: s("webpage_url").or_else(|| s("original_url")).unwrap_or(target),
        title: s("title").unwrap_or_else(|| "Untitled".into()),
        duration: info["duration"].as_f64().filter(|_| info["is_live"].as_bool() != Some(true)),
        uploader: s("uploader").or_else(|| s("channel")),
        thumbnail: s("thumbnail"),
        requested_by,
    })
}

/// Search results asked of YouTube, and the most shown of those that can be used.
const SEARCH_ASK: usize = 10;
const SEARCH_SHOW: usize = 6;
/// Longer videos aren't offered, and only this much is read: at 128 kbit/s it stays under the 15 MB a song can upload.
const MAX_AUDIO_SECONDS: u32 = 900;

/// A YouTube video id. Only these reach yt-dlp as a link: never a URL someone typed, which could point anywhere.
pub fn is_video_id(id: &str) -> bool {
    id.len() == 11 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// One line of `yt-dlp --flat-playlist -j`, if it's something that can be used (not live, a channel, or too long).
fn search_hit(line: &str) -> Option<serde_json::Value> {
    let info: serde_json::Value = serde_json::from_str(line).ok()?;
    let id = info["id"].as_str().filter(|id| is_video_id(id))?;
    let duration = info["duration"].as_f64().filter(|d| *d > 0.0 && *d <= MAX_AUDIO_SECONDS as f64)?;
    Some(json!({
        "id": id,
        "title": info["title"].as_str()?,
        "uploader": info["uploader"].as_str().or(info["channel"].as_str()),
        "duration": duration,
        "thumbnail": format!("https://i.ytimg.com/vi/{id}/mqdefault.jpg"),
    }))
}

pub async fn search_videos(st: &AppState, query: &str) -> ApiResult<Vec<serde_json::Value>> {
    let _turn = crate::media::lookup_turn().await?;
    let target = format!("ytsearch{SEARCH_ASK}:{query}");
    let run = ytdlp_cmd(st).args(["--flat-playlist", "-j", "--no-warnings", "--", &target]).output();
    let out = match tokio::time::timeout(Duration::from_secs(30), run).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => {
            tracing::error!("running yt-dlp: {e}");
            return Err(bad("the music player isn't set up on this server"));
        }
        Err(_) => return Err(bad("YouTube took too long to answer")),
    };
    Ok(String::from_utf8_lossy(&out.stdout).lines().filter_map(search_hit).take(SEARCH_SHOW).collect())
}

/// A video's audio as MP3.
pub async fn video_audio(st: &AppState, id: &str) -> ApiResult<Vec<u8>> {
    let _turn = crate::media::lookup_turn().await?;
    let url = format!("https://www.youtube.com/watch?v={id}");
    let not_set_up = |e: std::io::Error| {
        tracing::error!("running yt-dlp: {e}");
        bad("the music player isn't set up on this server")
    };
    let mut download = ytdlp_cmd(st)
        .args(["-f", "bestaudio/best", "--no-playlist", "--no-part", "--quiet", "--no-warnings", "-o", "-", "--", &url])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(not_set_up)?;
    let input: Stdio = download.stdout.take().ok_or_else(|| bad("couldn't get that song"))?.try_into().map_err(not_set_up)?;
    let mut encode = Command::new("ffmpeg");
    encode
        .args(["-nostdin", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "pipe", "-i", "pipe:0", "-vn", "-map_metadata", "-1", "-t", &MAX_AUDIO_SECONDS.to_string()])
        .args(["-ac", "2", "-ar", "48000", "-c:a", "libmp3lame", "-b:a", "128k", "-f", "mp3", "pipe:1"])
        .stdin(input)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    crate::media::limit(&mut encode);
    let encode = encode.spawn().map_err(not_set_up)?;
    let out = match tokio::time::timeout(Duration::from_secs(120), encode.wait_with_output()).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => return Err(not_set_up(e)),
        Err(_) => return Err(bad("YouTube took too long to answer")),
    };
    if !out.status.success() || out.stdout.is_empty() {
        tracing::warn!("couldn't read a video's audio for a profile song");
        return Err(bad("couldn't get that song"));
    }
    Ok(out.stdout)
}

#[derive(Deserialize)]
struct CommandBody {
    name: String,
    #[serde(default)]
    query: String,
}

/// Runs a slash command. Mistakes ("join a voice channel first") come back as errors only the caller sees;
/// everything else is answered by Kass in the channel.
async fn run_command(State(st): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<Id>, Json(body): Json<CommandBody>) -> ApiResult<Json<Message>> {
    st.limits.check(format!("cmd:{me}"), 10.0, 1.0)?;
    if crate::steve::has_command(&st, &body.name) {
        return crate::steve::run(&st, me, id, &body.name, body.query.trim()).await.map(Json);
    }
    let a = channel_for(&st, id, me).await?;
    let Some(guild) = a.ch.guild_id.filter(|_| kind::has_messages(a.ch.kind)) else {
        return Err(bad("commands only work in server channels"));
    };
    a.require(perms::SEND_MESSAGES)?;
    let bot = *st.music.bot.get().ok_or(ApiError::NotFound)?;
    if !in_guild(&st, guild, bot).await? {
        return Err(bad("Kass isn't in this server. Someone with Manage Server can add him back in Settings → Kass."));
    }
    crate::stats::bump(&st, me, "kass_commands");
    let name = body.name.as_str();
    let reply = |content: String, embeds: serde_json::Value| {
        let (st, a) = (st.clone(), &a);
        async move { post_bot_message(&st, a, bot, me, name, content, embeds).await.map(Json) }
    };

    if name == "play" {
        let query = body.query.trim();
        if query.is_empty() {
            return Err(bad("tell me what to play: a YouTube or Spotify link, or a search"));
        }
        let voice = voice::channel_of(&st, me).filter(|(g, _)| *g == Some(guild)).map(|(_, c)| c);
        let Some(voice) = voice else { return Err(bad("join a voice channel first")) };
        if let Some(p) = current(&st) {
            if p.channel_id != voice && voice::others_in(&st, p.channel_id, bot) > 0 {
                return Err(bad("Kass is already playing in another voice channel"));
            }
        }
        let spotify = spotify::lookup(&st, query).await?;
        let target = match &spotify {
            Some(list) => list.tracks[0].url.clone(),
            None => target_for(query)?,
        };
        // Something that plays right away starts downloading while it's looked up (both take seconds).
        let here = current(&st).filter(|p| p.channel_id == voice);
        let idle = here.as_ref().is_none_or(|p| p.now.lock().unwrap().is_none() && p.queue.lock().unwrap().is_empty());
        let early = if idle { Pipeline::spawn(&st, &target).ok() } else { None };
        let mut more = vec![];
        let track = match &spotify {
            Some(list) => {
                let mut tracks = list.tracks.iter().map(|t| t.track(me));
                let first = tracks.next().unwrap();
                more = tracks.collect();
                first
            }
            None => resolve(&st, target, me).await?,
        };
        let player = match current(&st).filter(|p| p.channel_id == voice) {
            Some(p) => p,
            None => start(&st, bot, guild, voice, a.ch.id).await?,
        };
        if let Some(pipe) = early {
            *player.prepared.lock().unwrap() = Some((track.url.clone(), pipe));
        }
        *player.text_channel.lock().unwrap() = a.ch.id;
        let added = 1 + more.len();
        let queued = {
            let idle = player.now.lock().unwrap().is_none();
            let mut q = player.queue.lock().unwrap();
            if q.len() >= MAX_QUEUE {
                return Err(bad("the queue is full"));
            }
            q.push_back(track.clone());
            let pos = if idle && q.len() == 1 {
                // Playing right away: this reply is the "Now playing".
                player.now.lock().unwrap().replace(q.pop_front().unwrap());
                0
            } else {
                q.len()
            };
            let room = MAX_QUEUE.saturating_sub(q.len());
            q.extend(more.drain(..).take(room));
            pos
        };
        player.poke();
        crate::stats::bump_by(&st, me, "songs_queued", added.min(MAX_QUEUE) as i64);
        if let Some(list) = spotify.filter(|l| l.kind != "track") {
            return reply(String::new(), spotify::list_embed(&list, queued == 0, GOLD)).await;
        }
        return reply(String::new(), now_playing_embed(&track, (queued > 0).then_some(queued))).await;
    }

    // The rest control a player you're listening to.
    let player = current(&st).filter(|p| voice::channel_of(&st, me).is_some_and(|(_, c)| c == p.channel_id));
    let Some(player) = player else { return Err(bad("join Kass's voice channel first")) };
    let now = player.now.lock().unwrap().clone();
    match name {
        "skip" => {
            let Some(now) = now else { return Err(bad("nothing is playing")) };
            player.skip.store(true, Ordering::Relaxed);
            player.poke();
            reply(format!("Skipped **{}**", escape(&now.title)), json!([])).await
        }
        "pause" | "resume" => {
            let Some(now) = now else { return Err(bad("nothing is playing")) };
            let pause = name == "pause";
            if player.paused.swap(pause, Ordering::Relaxed) == pause {
                return Err(bad(if pause { "already paused" } else { "not paused" }));
            }
            player.poke();
            let verb = if pause { "Paused" } else { "Resumed" };
            reply(format!("{verb} **{}**", escape(&now.title)), json!([])).await
        }
        "stop" => {
            player.queue.lock().unwrap().clear();
            player.stop.store(true, Ordering::Relaxed);
            player.poke();
            reply("Stopped the music and left the call.".into(), json!([])).await
        }
        "queue" => {
            let q = player.queue.lock().unwrap().clone();
            let mut lines = Vec::new();
            match &now {
                Some(t) => lines.push(format!("**Now playing:** {}{}", link(t), if player.paused.load(Ordering::Relaxed) { " (paused)" } else { "" })),
                None => lines.push("Nothing is playing.".into()),
            }
            match *player.repeat.lock().unwrap() {
                Repeat::Song => lines.push("**Repeating** this song".into()),
                Repeat::Queue => lines.push("**Repeating** the queue".into()),
                Repeat::Off => {}
            }
            for (i, t) in q.iter().take(10).enumerate() {
                lines.push(format!("`{}.` {}", i + 1, link(t)));
            }
            if q.len() > 10 {
                lines.push(format!("…and {} more", q.len() - 10));
            }
            reply(lines.join("\n"), json!([])).await
        }
        "repeat" => {
            let mode = match body.query.trim().to_lowercase().as_str() {
                // On its own it toggles repeating the current song.
                "" if *player.repeat.lock().unwrap() == Repeat::Off => Repeat::Song,
                "" | "off" | "none" => Repeat::Off,
                "song" | "one" | "track" | "this" => Repeat::Song,
                "queue" | "all" | "playlist" => Repeat::Queue,
                _ => return Err(bad("repeat takes song, queue or off")),
            };
            *player.repeat.lock().unwrap() = mode;
            // What comes next changed, so a song downloading early may not be next anymore.
            player.prepared.lock().unwrap().take();
            let text = match (mode, &now) {
                (Repeat::Song, Some(t)) => format!("Repeating **{}**", escape(&t.title)),
                (Repeat::Song, None) => "Repeating each song".into(),
                (Repeat::Queue, _) => "Repeating the queue".into(),
                (Repeat::Off, _) => "Stopped repeating".into(),
            };
            reply(text, json!([])).await
        }
        "remove" => {
            let query = body.query.trim();
            if query.is_empty() {
                return Err(bad("tell me which song to remove: its number in /queue or part of its name"));
            }
            let removed = {
                let mut q = player.queue.lock().unwrap();
                if q.is_empty() {
                    return Err(bad("the queue is empty"));
                }
                let at = match query.parse::<usize>() {
                    Ok(n) => n.checked_sub(1).filter(|i| *i < q.len()).ok_or_else(|| bad("no song with that number in the queue"))?,
                    Err(_) => {
                        let needle = query.to_lowercase();
                        q.iter().position(|t| t.title.to_lowercase().contains(&needle)).ok_or_else(|| bad("no song in the queue matches that"))?
                    }
                };
                let removed = q.remove(at).unwrap();
                // The next song may already be downloading; it isn't next anymore.
                if at == 0 {
                    player.prepared.lock().unwrap().take();
                }
                removed
            };
            reply(format!("Removed **{}** from the queue", escape(&removed.title)), json!([])).await
        }
        _ => Err(bad("unknown command")),
    }
}

fn current(st: &AppState) -> Option<Arc<Player>> {
    st.music.player.lock().unwrap().clone().filter(|p| !p.done())
}

fn escape(s: &str) -> String {
    s.chars().fold(String::new(), |mut out, c| {
        if "*_~`|[]()<>\\".contains(c) {
            out.push('\\');
        }
        out.push(c);
        out
    })
}

fn link(t: &Track) -> String {
    format!("[{}](<{}>) {}", escape(&t.title), t.url, length(t))
}

fn length(t: &Track) -> String {
    match t.duration {
        Some(d) => {
            let d = d as u64;
            if d >= 3600 {
                format!("`{}:{:02}:{:02}`", d / 3600, d / 60 % 60, d % 60)
            } else {
                format!("`{}:{:02}`", d / 60, d % 60)
            }
        }
        None => "`LIVE`".into(),
    }
}

/// A card like Discord music bots post: title, YouTube channel, length, thumbnail.
fn now_playing_embed(t: &Track, queued_at: Option<usize>) -> serde_json::Value {
    let site = match queued_at {
        None => "Now playing".to_string(),
        Some(n) => format!("Queued · #{n}"),
    };
    // Who asked for it shows above the message ("<user> used /play").
    let desc: Vec<String> = t.uploader.iter().cloned().chain([length(t).trim_matches('`').to_string()]).collect();
    json!([{
        "type": "rich",
        "url": t.page.as_ref().unwrap_or(&t.url),
        "title": t.title,
        "site_name": site,
        "description": desc.join(" · "),
        "image": t.thumbnail,
        "color": GOLD,
    }])
}

/// Adds Kass to the server (so everyone's client knows him) and joins the voice channel.
async fn start(st: &AppState, bot: Id, guild: Id, channel: Id, text_channel: Id) -> ApiResult<Arc<Player>> {
    let joined = sqlx::query("INSERT INTO members (guild_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING")
        .bind(guild)
        .bind(bot)
        .execute(&st.db)
        .await?
        .rows_affected()
        > 0;
    if joined {
        let member = load_member(&st.db, guild, bot).await?;
        let others = guild_members(&st.db, guild).await?;
        st.hub.send(&others, "GUILD_MEMBER_ADD", &json!({ "guild_id": guild, "member": member, "status": "online" }));
    }
    // A player still in another channel (alone there) gives way.
    if let Some(old) = st.music.player.lock().unwrap().take() {
        old.stop.store(true, Ordering::Relaxed);
        old.poke();
    }
    let player = Arc::new(Player {
        guild_id: guild,
        channel_id: channel,
        text_channel: Mutex::new(text_channel),
        queue: Mutex::new(VecDeque::new()),
        now: Mutex::new(None),
        prepared: Mutex::new(None),
        repeat: Mutex::new(Repeat::Off),
        paused: AtomicBool::new(false),
        skip: AtomicBool::new(false),
        stop: AtomicBool::new(false),
        wake: Notify::new(),
        position_ms: AtomicU64::new(0),
        resume_at: Mutex::new(None),
    });
    *st.music.player.lock().unwrap() = Some(player.clone());
    // After a restart Kass's seat is waiting for him (voice.rs restore): he takes it back without a join.
    let voice::Joined { conn, mut rx, .. } = voice::join(st, bot, Some(guild), channel, false, true, None).await;
    // Nobody talks to Kass, but his queue must be drained; a close means he was disconnected (kicked, server deleted).
    let p = player.clone();
    tokio::spawn(async move {
        while let Some(m) = rx.recv().await {
            if matches!(m, axum::extract::ws::Message::Close(_)) {
                break;
            }
        }
        p.stop.store(true, Ordering::Relaxed);
        p.poke();
    });
    tokio::spawn(run(st.clone(), player.clone(), bot, conn));
    Ok(player)
}

async fn run(st: AppState, p: Arc<Player>, bot: Id, conn: u64) {
    let mut idle_since = Instant::now();
    let mut first = true;
    while !p.done() {
        // The /play that started the player already announced its track.
        let track = p.now.lock().unwrap().clone();
        let track = match track {
            Some(t) => Some(t),
            None => {
                let next = p.queue.lock().unwrap().pop_front();
                if let Some(t) = &next {
                    *p.now.lock().unwrap() = Some(t.clone());
                    announce(&st, &p, bot, t).await;
                }
                next
            }
        };
        let Some(track) = track else {
            if idle_since.elapsed() > IDLE_LEAVE || (!first && voice::others_in(&st, p.channel_id, bot) == 0) {
                break;
            }
            let _ = tokio::time::timeout(Duration::from_secs(1), p.wake.notified()).await;
            continue;
        };
        first = false;
        p.skip.store(false, Ordering::Relaxed);
        p.paused.store(false, Ordering::Relaxed);
        let began = Instant::now();
        let played = match play(&st, &p, bot, conn, &track).await {
            Ok(()) => {
                count_play(&st, &track, began.elapsed()).await;
                true
            }
            Err(e) => {
                tracing::warn!("couldn't play {}: {e}", track.url);
                let channel = *p.text_channel.lock().unwrap();
                let a = channel_for(&st, channel, track.requested_by).await;
                if let Ok(a) = a {
                    let text = format!("Couldn't play **{}**: YouTube didn't send the audio.", escape(&track.title));
                    let _ = post_bot_message(&st, &a, bot, track.requested_by, "play", text, json!([])).await;
                }
                false
            }
        };
        // A song that failed is never repeated (it would fail forever).
        let again = played && !p.done();
        match *p.repeat.lock().unwrap() {
            // Keeping it as the current song plays it again, without another "Now playing".
            Repeat::Song if again && !p.skip.load(Ordering::Relaxed) => {}
            Repeat::Queue if again => {
                p.queue.lock().unwrap().push_back(track.clone());
                *p.now.lock().unwrap() = None;
            }
            _ => *p.now.lock().unwrap() = None,
        }
        idle_since = Instant::now();
        if voice::others_in(&st, p.channel_id, bot) == 0 {
            break;
        }
    }
    p.stop.store(true, Ordering::Relaxed);
    {
        let mut cur = st.music.player.lock().unwrap();
        if cur.as_ref().is_some_and(|c| Arc::ptr_eq(c, &p)) {
            *cur = None;
        }
    }
    voice::part(&st, bot, conn, p.channel_id).await;
}

/// A song counts for its requester's top songs (profile widget) once it played half its length or 30 s: songs
/// skipped right away don't.
async fn count_play(st: &AppState, t: &Track, played: Duration) {
    // Cut short by a handover: the next process finishes the song and counts it.
    if crate::handover::retired() {
        return;
    }
    let enough = t.duration.map_or(30.0, |d| (d * 0.5).min(30.0));
    if played.as_secs_f64() < enough {
        return;
    }
    let url = t.page.clone().unwrap_or_else(|| t.url.clone());
    let _ = sqlx::query(
        "INSERT INTO kass_plays (user_id, key, title, url, uploader, thumbnail, plays) VALUES ($1, $2, $3, $4, $5, $6, 1)
         ON CONFLICT (user_id, key) DO UPDATE SET plays = kass_plays.plays + 1, last_played = now(), title = EXCLUDED.title,
             url = EXCLUDED.url, uploader = EXCLUDED.uploader, thumbnail = COALESCE(EXCLUDED.thumbnail, kass_plays.thumbnail)",
    )
    .bind(t.requested_by)
    .bind(t.title.to_lowercase())
    .bind(&t.title)
    .bind(url)
    .bind(&t.uploader)
    .bind(&t.thumbnail)
    .execute(&st.db)
    .await;
}

/// "Now playing" for tracks that start from the queue.
async fn announce(st: &AppState, p: &Player, bot: Id, t: &Track) {
    let channel = *p.text_channel.lock().unwrap();
    if let Ok(a) = channel_for(st, channel, t.requested_by).await {
        if a.ch.guild_id == Some(p.guild_id) {
            let _ = post_bot_message(st, &a, bot, t.requested_by, "play", String::new(), now_playing_embed(t, None)).await;
        }
    }
}

/// A track being downloaded (yt-dlp) and encoded (ffmpeg) into Opus packets. Started ahead of time where possible,
/// because YouTube makes yt-dlp wait several seconds before the first byte. Dropping it kills both processes.
struct Pipeline {
    dl: Child,
    ff: Child,
    packets: mpsc::Receiver<Vec<u8>>,
    reader: tokio::task::JoinHandle<()>,
    /// yt-dlp's error output, for "couldn't play".
    errors: tokio::task::JoinHandle<String>,
}

impl Drop for Pipeline {
    fn drop(&mut self) {
        self.reader.abort();
        self.errors.abort();
    }
}

impl Pipeline {
    /// `target` is a YouTube URL or `ytsearch1:<query>`.
    fn spawn(st: &AppState, target: &str) -> anyhow::Result<Pipeline> {
        Self::spawn_at(st, target, 0)
    }

    /// The same, starting `ms` into the song (after a restart).
    fn spawn_at(st: &AppState, target: &str, ms: u64) -> anyhow::Result<Pipeline> {
        let mut dl = ytdlp_cmd(st)
            .args(["-f", "bestaudio/best", "--no-playlist", "--no-part", "--quiet", "--no-warnings", "-o", "-", "--", target])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let input: Stdio = dl.stdout.take().ok_or_else(|| anyhow::anyhow!("no yt-dlp output"))?.try_into()?;
        let skip = format!("{:.3}", ms as f64 / 1000.0);
        let mut ff = Command::new("ffmpeg")
            .args(["-hide_banner", "-loglevel", "error", "-i", "pipe:0"])
            .args(if ms > 0 { vec!["-ss", skip.as_str()] } else { vec![] })
            .args(["-vn", "-af", "volume=0.5", "-ac", "2", "-ar", "48000"])
            .args(["-c:a", "libopus", "-b:a", "128k", "-frame_duration", "20", "-application", "audio", "-f", "ogg", "pipe:1"])
            .stdin(input)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        let mut stderr = dl.stderr.take();
        let errors = tokio::spawn(async move {
            let mut s = String::new();
            if let Some(e) = stderr.as_mut() {
                let _ = e.take(16 * 1024).read_to_string(&mut s).await;
            }
            s
        });
        // Reading happens in its own task: an Ogg read interrupted halfway (by a /pause) would lose its place.
        // Up to a second of packets waits here; then ffmpeg and yt-dlp simply wait for us.
        let mut ogg = OggPackets::new(BufReader::new(ff.stdout.take().ok_or_else(|| anyhow::anyhow!("no ffmpeg output"))?));
        let (tx, packets) = mpsc::channel::<Vec<u8>>(50);
        let reader = tokio::spawn(async move {
            while let Ok(Some(packet)) = ogg.next().await {
                // The two Ogg Opus header packets.
                if !(packet.starts_with(b"OpusHead") || packet.starts_with(b"OpusTags")) && tx.send(packet).await.is_err() {
                    break;
                }
            }
        });
        Ok(Pipeline { dl, ff, packets, reader, errors })
    }
}

/// How long before the end of a song the next one starts downloading.
const PREFETCH: Duration = Duration::from_secs(15);

/// Streams one track into the call until it ends, is skipped, or the player stops.
async fn play(st: &AppState, p: &Player, bot: Id, conn: u64, t: &Track) -> anyhow::Result<()> {
    tracing::info!(channel = %p.channel_id, title = %t.title, "music: playing");
    let ready = p.prepared.lock().unwrap().take().filter(|(url, _)| *url == t.url).map(|(_, pipe)| pipe);
    tracing::debug!("playing {} ({})", t.url, if ready.is_some() { "started early" } else { "starting now" });
    let resume = p.resume_at.lock().unwrap().take().filter(|(url, _)| *url == t.url).map(|(_, ms)| ms);
    let mut pipe = match (ready, resume) {
        (_, Some(ms)) => Pipeline::spawn_at(st, &t.url, ms)?,
        (Some(pipe), None) => pipe,
        (None, None) => Pipeline::spawn(st, &t.url)?,
    };
    let start_ms = resume.unwrap_or(0);
    p.position_ms.store(start_ms, Ordering::Relaxed);
    // Packet count at which to prefetch (right away for short songs).
    let prefetch_at = t.duration.map(|d| {
        let left = Duration::from_secs_f64(d).saturating_sub(Duration::from_millis(start_ms)).saturating_sub(PREFETCH);
        ((left.as_millis() / FRAME.as_millis()) as u64).max(1)
    });
    // A song whose prefetch couldn't start (so it isn't retried every packet).
    let mut failed: Option<String> = None;
    let mut sent = 0u64;
    let mut next = Instant::now();
    // A packet waiting for its time, kept when a command wakes the player early.
    let mut pending: Option<(Vec<u8>, Instant)> = None;
    loop {
        if p.done() || p.skip.load(Ordering::Relaxed) {
            break;
        }
        if p.paused.load(Ordering::Relaxed) {
            p.wake.notified().await;
            next = Instant::now();
            pending = pending.map(|(packet, _)| (packet, next));
            continue;
        }
        let (packet, due) = match pending.take() {
            Some(waiting) => waiting,
            None => {
                let packet = tokio::select! {
                    r = pipe.packets.recv() => r,
                    _ = p.wake.notified() => continue,
                };
                let Some(packet) = packet else { break };
                // Real time, catching up after short hiccups but never bursting more than 200 ms.
                next = next.max(Instant::now() - Duration::from_millis(200)) + FRAME;
                (packet, next)
            }
        };
        tokio::select! {
            _ = tokio::time::sleep_until(due) => {}
            _ = p.wake.notified() => {
                pending = Some((packet, due));
                continue;
            }
        }
        voice::send_music(st, p.channel_id, conn, bot, &packet);
        sent += 1;
        p.position_ms.store(start_ms + sent * FRAME.as_millis() as u64, Ordering::Relaxed);
        // Keeps checking from then on: the next song may be queued (or /removed) during the last seconds.
        if prefetch_at.is_some_and(|at| sent >= at) && p.prepared.lock().unwrap().is_none() {
            prefetch(st, p, t, &mut failed);
        }
        if sent % 50 == 0 && voice::others_in(st, p.channel_id, bot) == 0 {
            p.stop.store(true, Ordering::Relaxed);
        }
    }
    pipe.reader.abort();
    let _ = pipe.ff.start_kill();
    let _ = pipe.dl.start_kill();
    let err = (&mut pipe.errors).await.unwrap_or_default();
    if sent == 0 && !p.done() && !p.skip.load(Ordering::Relaxed) {
        anyhow::bail!("no audio: {}", err.trim());
    }
    Ok(())
}

/// Starts downloading the next song in the queue so it follows the current one without a gap.
fn prefetch(st: &AppState, p: &Player, current: &Track, failed: &mut Option<String>) {
    let front = p.queue.lock().unwrap().front().map(|t| t.url.clone());
    let next = match *p.repeat.lock().unwrap() {
        Repeat::Off => front,
        Repeat::Song => Some(current.url.clone()),
        Repeat::Queue => front.or_else(|| Some(current.url.clone())),
    };
    let Some(next) = next.filter(|n| failed.as_ref() != Some(n)) else { return };
    match Pipeline::spawn(st, &next) {
        Ok(pipe) => {
            tracing::debug!("prefetching {next}");
            *p.prepared.lock().unwrap() = Some((next, pipe));
        }
        Err(e) => {
            tracing::warn!("prefetching {next}: {e}");
            *failed = Some(next);
        }
    }
}

/// Splits an Ogg stream into its packets (RFC 3533): each page has a table of segment lengths, and a packet
/// is a run of 255-byte segments ending in a shorter one, possibly continuing on the next page.
struct OggPackets<R> {
    r: R,
    lacing: Vec<u8>,
    data: Vec<u8>,
    seg: usize,
    off: usize,
    packet: Vec<u8>,
}

impl<R: AsyncRead + Unpin> OggPackets<R> {
    fn new(r: R) -> Self {
        OggPackets { r, lacing: Vec::new(), data: Vec::new(), seg: 0, off: 0, packet: Vec::new() }
    }

    async fn next(&mut self) -> std::io::Result<Option<Vec<u8>>> {
        loop {
            while self.seg < self.lacing.len() {
                let len = self.lacing[self.seg] as usize;
                self.seg += 1;
                self.packet.extend_from_slice(&self.data[self.off..self.off + len]);
                self.off += len;
                if len < 255 {
                    return Ok(Some(std::mem::take(&mut self.packet)));
                }
            }
            let mut head = [0u8; 27];
            match self.r.read_exact(&mut head).await {
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
                r => r?,
            };
            if &head[..4] != b"OggS" {
                return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "not an Ogg page"));
            }
            self.lacing.resize(head[26] as usize, 0);
            self.r.read_exact(&mut self.lacing).await?;
            self.data.resize(self.lacing.iter().map(|&l| l as usize).sum(), 0);
            self.r.read_exact(&mut self.data).await?;
            self.seg = 0;
            self.off = 0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_video_ids_reach_ytdlp() {
        assert!(is_video_id("dQw4w9WgXcQ"));
        assert!(is_video_id("a-b_c1234XY"));
        assert!(!is_video_id("https://evil"));
        assert!(!is_video_id("../../etc/p"));
        assert!(!is_video_id(""));
    }

    #[test]
    fn search_results_leave_out_what_cant_be_used() {
        let hit = search_hit(r#"{"id":"dQw4w9WgXcQ","title":"Song","channel":"Someone","duration":212.0}"#).unwrap();
        assert_eq!(hit["uploader"], "Someone");
        assert_eq!(hit["thumbnail"], "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg");
        assert!(search_hit(r#"{"id":"dQw4w9WgXcQ","title":"Live","duration":null}"#).is_none(), "live");
        assert!(search_hit(r#"{"id":"dQw4w9WgXcQ","title":"Mix","duration":36000.0}"#).is_none(), "too long");
        assert!(search_hit(r#"{"id":"UCchannelidthatislonger","title":"A channel","duration":10.0}"#).is_none(), "not a video");
        assert!(search_hit("not json").is_none());
    }

    fn page(segments: &[u8], body: &[u8]) -> Vec<u8> {
        let mut p = b"OggS".to_vec();
        p.extend_from_slice(&[0; 22]);
        p.push(segments.len() as u8);
        p.extend_from_slice(segments);
        p.extend_from_slice(body);
        p
    }

    #[tokio::test]
    async fn splits_packets_across_pages() {
        let mut stream = page(&[3, 255], &[[1u8; 3].as_slice(), &[2u8; 255]].concat());
        stream.extend(page(&[10, 0], &[3u8; 10]));
        let mut ogg = OggPackets::new(stream.as_slice());
        assert_eq!(ogg.next().await.unwrap(), Some(vec![1; 3]));
        let long = ogg.next().await.unwrap().unwrap();
        assert_eq!(long.len(), 265);
        assert!(long[..255].iter().all(|&b| b == 2) && long[255..].iter().all(|&b| b == 3));
        assert_eq!(ogg.next().await.unwrap(), Some(vec![]));
        assert_eq!(ogg.next().await.unwrap(), None);
    }

    #[tokio::test]
    async fn reads_ffmpeg_opus() {
        let Ok(out) = std::process::Command::new("ffmpeg")
            .args(["-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ac", "2", "-ar", "48000"])
            .args(["-c:a", "libopus", "-frame_duration", "20", "-f", "ogg", "pipe:1"])
            .output()
        else {
            return eprintln!("no ffmpeg, skipped");
        };
        let mut ogg = OggPackets::new(out.stdout.as_slice());
        let mut packets = Vec::new();
        while let Some(p) = ogg.next().await.unwrap() {
            packets.push(p);
        }
        assert!(packets[0].starts_with(b"OpusHead") && packets[1].starts_with(b"OpusTags"));
        // One second of 20 ms frames.
        assert!((50..=52).contains(&(packets.len() - 2)), "{} packets", packets.len());
    }

    #[test]
    fn only_youtube_links() {
        assert!(youtube_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ").is_some());
        assert!(youtube_url("https://youtu.be/dQw4w9WgXcQ?t=3").is_some());
        assert!(youtube_url("https://music.youtube.com/watch?v=x").is_some());
        assert!(youtube_url("https://youtube.com.evil.example/watch").is_none());
        assert!(youtube_url("http://127.0.0.1:5433/").is_none());
        assert!(youtube_url("never gonna give you up").is_none());
    }

    #[test]
    fn escapes_markdown() {
        assert_eq!(escape("a*b_[c]"), "a\\*b\\_\\[c\\]");
    }
}

/// Spotify links for /play, without a Spotify API key: the song list comes from Spotify's public embed page
/// (the one websites embed), and each song is played from YouTube by searching for "<artists> - <title>".
mod spotify {
    use serde_json::{json, Value};

    use super::Track;
    use crate::error::{bad, ApiResult};
    use crate::id::Id;
    use crate::state::AppState;

    /// Songs taken from one album or playlist (the embed lists up to about 100).
    const MAX_TRACKS: usize = 100;

    pub struct Song {
        pub url: String,
        title: String,
        artists: String,
        duration: Option<f64>,
        page: String,
        image: Option<String>,
    }

    impl Song {
        pub fn track(&self, requested_by: Id) -> Track {
            Track {
                url: self.url.clone(),
                page: Some(self.page.clone()),
                title: if self.artists.is_empty() { self.title.clone() } else { format!("{} — {}", self.artists, self.title) },
                duration: self.duration,
                uploader: Some("Spotify".into()),
                thumbnail: self.image.clone(),
                requested_by,
            }
        }
    }

    pub struct List {
        /// track | album | playlist
        pub kind: String,
        name: String,
        url: String,
        image: Option<String>,
        pub tracks: Vec<Song>,
    }

    /// "https://open.spotify.com/intl-pt/playlist/<id>?si=..." or "spotify:album:<id>" -> ("playlist", "<id>").
    fn parse(q: &str) -> Option<(String, String)> {
        let q = q.trim();
        if let Some(rest) = q.strip_prefix("spotify:") {
            let (kind, id) = rest.split_once(':')?;
            return valid(kind, id);
        }
        let rest = q.strip_prefix("https://").or_else(|| q.strip_prefix("http://"))?;
        let (host, path) = rest.split_once('/')?;
        if host != "open.spotify.com" {
            return None;
        }
        let mut parts = path.split(['?', '#']).next()?.split('/').filter(|p| !p.is_empty() && !p.starts_with("intl-"));
        valid(parts.next()?, parts.next()?)
    }

    fn valid(kind: &str, id: &str) -> Option<(String, String)> {
        let ok = matches!(kind, "track" | "album" | "playlist") && !id.is_empty() && id.len() <= 40 && id.chars().all(|c| c.is_ascii_alphanumeric());
        ok.then(|| (kind.to_string(), id.to_string()))
    }

    fn is_spotify(q: &str) -> bool {
        let q = q.trim();
        q.starts_with("spotify:") || ["https://open.spotify.com/", "https://spotify.link/", "http://open.spotify.com/"].iter().any(|p| q.starts_with(p))
    }

    /// The songs behind a Spotify link, or None when `query` isn't one.
    pub async fn lookup(st: &AppState, query: &str) -> ApiResult<Option<List>> {
        if !is_spotify(query) {
            return Ok(None);
        }
        let mut link = parse(query);
        // Short links (spotify.link/...) redirect to open.spotify.com; only that host is fetched.
        if link.is_none() && query.trim().starts_with("https://spotify.link/") {
            // Through the guarded client: a redirect must not reach this machine or the home network.
            if let Some(res) = crate::embeds::safe_get(query.trim()).await {
                link = parse(res.url().as_str());
            }
        }
        let (kind, id) = link.ok_or_else(|| bad("that Spotify link isn't a song, album or playlist"))?;
        let page = st
            .http
            .get(format!("https://open.spotify.com/embed/{kind}/{id}"))
            .header("user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36")
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| {
                tracing::warn!("spotify embed: {e}");
                bad("Spotify didn't answer, try again in a moment")
            })?
            .text()
            .await
            .map_err(|_| bad("Spotify didn't answer, try again in a moment"))?;
        let list = parse_embed(&page, &kind, &id).ok_or_else(|| {
            tracing::warn!("spotify embed for a {kind} had no songs we could read");
            bad("couldn't read that Spotify link")
        })?;
        if list.tracks.is_empty() {
            return Err(bad("that Spotify list is empty"));
        }
        Ok(Some(list))
    }

    fn image(entity: &Value) -> Option<String> {
        entity["visualIdentity"]["image"].as_array()?.iter().max_by_key(|i| i["maxWidth"].as_u64().unwrap_or(0))?["url"].as_str().map(str::to_string)
    }

    fn search(artists: &str, title: &str) -> String {
        format!("ytsearch1:{artists} - {title} audio")
    }

    /// Reads the song list out of the embed page's `__NEXT_DATA__` JSON.
    fn parse_embed(html: &str, kind: &str, id: &str) -> Option<List> {
        let start = html.find(r#"<script id="__NEXT_DATA__" type="application/json">"#)?;
        let json = &html[start..];
        let json = &json[json.find('>')? + 1..];
        let json = &json[..json.find("</script>")?];
        let data: Value = serde_json::from_str(json).ok()?;
        let e = &data["props"]["pageProps"]["state"]["data"]["entity"];
        let cover = image(e);
        let name = e["name"].as_str().or(e["title"].as_str()).unwrap_or("Spotify").to_string();
        let url = format!("https://open.spotify.com/{kind}/{id}");
        let tracks = if kind == "track" {
            let artists = e["artists"].as_array().map(|a| a.iter().filter_map(|x| x["name"].as_str()).collect::<Vec<_>>().join(", ")).unwrap_or_default();
            vec![Song {
                url: search(&artists, &name),
                title: name.clone(),
                artists,
                duration: e["duration"].as_f64().map(|ms| ms / 1000.0),
                page: url.clone(),
                image: cover.clone(),
            }]
        } else {
            e["trackList"]
                .as_array()?
                .iter()
                .filter(|t| t["isPlayable"].as_bool() != Some(false))
                .take(MAX_TRACKS)
                .filter_map(|t| {
                    let title = t["title"].as_str()?.to_string();
                    let artists = t["subtitle"].as_str().unwrap_or_default().replace('\u{a0}', " ");
                    let page = t["uri"].as_str().and_then(|u| u.strip_prefix("spotify:track:")).map(|id| format!("https://open.spotify.com/track/{id}"));
                    Some(Song {
                        url: search(&artists, &title),
                        title,
                        artists,
                        duration: t["duration"].as_f64().map(|ms| ms / 1000.0),
                        page: page.unwrap_or_else(|| url.clone()),
                        image: cover.clone(),
                    })
                })
                .collect()
        };
        Some(List { kind: kind.to_string(), name, url, image: cover, tracks })
    }

    /// The answer to /play with an album or playlist.
    pub fn list_embed(list: &List, playing: bool, color: i32) -> Value {
        let what = if list.kind == "album" { "album" } else { "playlist" };
        let n = list.tracks.len();
        let songs = if n == 1 { "1 song".to_string() } else { format!("{n} songs") };
        json!([{
            "type": "rich",
            "url": list.url,
            "title": list.name,
            "site_name": if playing { format!("Now playing · Spotify {what}") } else { format!("Queued · Spotify {what}") },
            "description": format!("{songs} · first up: {}", list.tracks[0].title),
            "image": list.image,
            "color": color,
        }])
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn spotify_links() {
            assert_eq!(super::parse("https://open.spotify.com/intl-pt/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc"), Some(("playlist".into(), "37i9dQZF1DXcBWIGoYBM5M".into())));
            assert_eq!(super::parse("spotify:track:7bxaFZ1O3cHkgLKMsdC3xR"), Some(("track".into(), "7bxaFZ1O3cHkgLKMsdC3xR".into())));
            assert_eq!(super::parse("https://open.spotify.com/artist/5INjqkS1o8h1imAzPqGZBb"), None);
            assert_eq!(super::parse("https://evil.com/track/abc"), None);
        }

        #[test]
        fn embed_page() {
            let html = r#"<html><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"state":{"data":{"entity":{"name":"Mix","trackList":[{"title":"Loser","subtitle":"Tame Impala","duration":223069,"uri":"spotify:track:7bx"}],"visualIdentity":{"image":[{"url":"https://i/1","maxWidth":300}]}}}}}}}</script></html>"#;
            let list = super::parse_embed(html, "playlist", "abc").unwrap();
            assert_eq!(list.tracks.len(), 1);
            assert_eq!(list.tracks[0].url, "ytsearch1:Tame Impala - Loser audio");
            assert_eq!(list.tracks[0].page, "https://open.spotify.com/track/7bx");
        }
    }
}

// ---------- handover (handover.rs) ----------

#[derive(Serialize, Deserialize)]
struct PlayerSnap {
    guild_id: Id,
    channel_id: Id,
    text_channel: Id,
    queue: Vec<Track>,
    now: Option<Track>,
    position_ms: u64,
    repeat: Repeat,
    paused: bool,
}

pub fn snapshot(st: &AppState) -> serde_json::Value {
    let Some(p) = current(st) else { return serde_json::Value::Null };
    let snap = PlayerSnap {
        guild_id: p.guild_id,
        channel_id: p.channel_id,
        text_channel: *p.text_channel.lock().unwrap(),
        queue: p.queue.lock().unwrap().iter().cloned().collect(),
        now: p.now.lock().unwrap().clone(),
        position_ms: p.position_ms.load(Ordering::Relaxed),
        repeat: *p.repeat.lock().unwrap(),
        paused: p.paused.load(Ordering::Relaxed),
    };
    serde_json::to_value(snap).unwrap_or_default()
}

/// Kass goes on with his queue, picking the song up where it was (yt-dlp takes a few seconds to start again).
pub async fn restore(st: &AppState, v: serde_json::Value, age_ms: i64) -> anyhow::Result<()> {
    if v.is_null() {
        return Ok(());
    }
    let snap: PlayerSnap = serde_json::from_value(v)?;
    let Some(bot) = bot_id(st) else { return Ok(()) };
    let p = start(st, bot, snap.guild_id, snap.channel_id, snap.text_channel).await.map_err(|e| anyhow::anyhow!("{e:?}"))?;
    if let Some(now) = &snap.now {
        // It kept playing in the old process until the handover.
        let at = snap.position_ms + if snap.paused { 0 } else { age_ms.max(0) as u64 };
        *p.resume_at.lock().unwrap() = Some((now.url.clone(), at));
    }
    // The current song before the queue: the player would otherwise start the queue's first one.
    *p.repeat.lock().unwrap() = snap.repeat;
    p.paused.store(snap.paused, Ordering::Relaxed);
    *p.now.lock().unwrap() = snap.now;
    *p.queue.lock().unwrap() = snap.queue.into();
    p.poke();
    tracing::info!(channel = %snap.channel_id, "handover: Kass is back");
    Ok(())
}
