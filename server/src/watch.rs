//! Watch together: a YouTube video or a Twitch/Kick stream played in a call, in sync for everyone who opens it.
//! The server keeps where the video is (playing or paused, at which second, as of when) and everyone in the
//! call can play, pause or seek; clients follow it (each with their own volume). It lasts as long as the call.

use axum::extract::{Path, State};
use axum::routing::put;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::api::channels::channel_for;
use crate::auth::AuthUser;
use crate::error::{bad, ApiResult};
use crate::id::Id;
use crate::state::AppState;

#[derive(Clone, Serialize)]
pub struct Watch {
    /// youtube | twitch | kick
    pub provider: String,
    /// YouTube video id, Twitch channel or "v<id>" for a Twitch video, Kick channel.
    pub media: String,
    /// The link that was shared.
    pub url: String,
    /// Live streams can't be paused or seeked (everyone is at the live edge anyway).
    pub live: bool,
    pub started_by: Id,
    pub playing: bool,
    /// Seconds into the video at `updated_at` (unix ms).
    pub position: f64,
    pub updated_at: i64,
    /// The video played to the end (everyone sees "Video ended" until someone plays it again).
    pub ended: bool,
    /// Who opened it (watching is opt-in, like a screen share): "who's watching" in the call.
    pub viewers: Vec<Id>,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// A shareable link -> (provider, media, live). Only these sites: the link ends up in everyone's player.
pub fn parse(url: &str) -> Option<(String, String, bool, f64)> {
    let rest = url.trim().strip_prefix("https://").or_else(|| url.trim().strip_prefix("http://"))?;
    let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
    let host = host.to_ascii_lowercase();
    let host = host.strip_prefix("www.").or_else(|| host.strip_prefix("m.")).unwrap_or(&host).to_string();
    let (path, query) = path.split_once('?').unwrap_or((path, ""));
    let seg: Vec<&str> = path.split(['/', '#']).filter(|s| !s.is_empty()).collect();
    let param = |k: &str| query.split('&').find_map(|p| p.strip_prefix(&format!("{k}=")).map(str::to_string));
    let ok = |s: &str| !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    let start = param("t").or_else(|| param("start")).map(|t| parse_time(&t)).unwrap_or(0.0);
    match host.as_str() {
        "youtube.com" | "music.youtube.com" | "youtu.be" => {
            let (id, live) = match (host.as_str(), seg.first().copied()) {
                ("youtu.be", Some(id)) => (id.to_string(), false),
                (_, Some("watch")) => (param("v")?, false),
                (_, Some("live")) => (seg.get(1)?.to_string(), true),
                (_, Some("shorts" | "embed")) => (seg.get(1)?.to_string(), false),
                _ => return None,
            };
            ok(&id).then(|| ("youtube".into(), id, live, start))
        }
        "twitch.tv" => {
            let first = *seg.first()?;
            if first == "videos" {
                let id = seg.get(1)?;
                return id.chars().all(|c| c.is_ascii_digit()).then(|| ("twitch".into(), format!("v{id}"), false, start));
            }
            ok(first).then(|| ("twitch".into(), first.to_ascii_lowercase(), true, 0.0))
        }
        "kick.com" => {
            let first = *seg.first()?;
            ok(first).then(|| ("kick".into(), first.to_ascii_lowercase(), true, 0.0))
        }
        _ => None,
    }
}

/// "1h2m3s", "90s" or "90" -> seconds.
fn parse_time(t: &str) -> f64 {
    if let Ok(n) = t.parse::<f64>() {
        return n.max(0.0);
    }
    let mut total = 0.0;
    let mut num = String::new();
    for c in t.chars() {
        match c {
            '0'..='9' => num.push(c),
            'h' | 'm' | 's' => {
                let n: f64 = num.parse().unwrap_or(0.0);
                total += n * match c { 'h' => 3600.0, 'm' => 60.0, _ => 1.0 };
                num.clear();
            }
            _ => return 0.0,
        }
    }
    total
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/channels/{id}/watch", put(start).patch(control).delete(stop))
        .route("/channels/{id}/watch/view", put(view))
}

/// The call's audience hears about changes (sidebars show what a call is watching).
async fn announce(st: &AppState, channel: Id, guild: Option<Id>) {
    let to = match guild {
        Some(g) => crate::gateway::guild_members(&st.db, g).await,
        None => crate::api::dms::recipients(&st.db, channel).await,
    }
    .unwrap_or_default();
    let watch = st.watches.get(&channel).map(|w| w.clone());
    st.hub.send(&to, "WATCH_UPDATE", &json!({ "channel_id": channel, "watch": watch, "server_now": now_ms() }));
}

/// You must be in the call to start or control what it watches.
async fn in_call(st: &AppState, channel: Id, me: Id) -> ApiResult<Option<Id>> {
    let a = channel_for(st, channel, me).await?;
    if crate::voice::channel_of(st, me).map(|(_, c)| c) != Some(channel) {
        return Err(bad("join the call first"));
    }
    Ok(a.ch.guild_id)
}

#[derive(Deserialize)]
struct Start {
    url: String,
}

async fn start(State(st): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<Id>, Json(body): Json<Start>) -> ApiResult<Json<Watch>> {
    let guild = in_call(&st, id, me).await?;
    let (provider, media, live, position) = parse(&body.url).ok_or_else(|| bad("paste a YouTube, Twitch or Kick link"))?;
    // Whoever shares it is watching it; a new link keeps the people who already had the player open.
    let mut viewers = st.watches.get(&id).map(|w| w.viewers.clone()).unwrap_or_default();
    if !viewers.contains(&me) {
        viewers.push(me);
    }
    let w = Watch { provider, media, url: body.url.trim().to_string(), live, started_by: me, playing: true, position, updated_at: now_ms(), ended: false, viewers };
    st.watches.insert(id, w.clone());
    crate::stats::bump(&st, me, "videos_shared");
    tracing::info!(user = %me, channel = %id, provider = %w.provider, "watch together: started");
    announce(&st, id, guild).await;
    Ok(Json(w))
}

#[derive(Deserialize)]
struct Control {
    playing: Option<bool>,
    position: Option<f64>,
    /// A player reached the end of the video (it also pauses). Playing or seeking again clears it.
    ended: Option<bool>,
    /// The player found out the YouTube video is a live stream (a plain watch?v= link doesn't say): from then on
    /// it never ends and isn't synced.
    live: Option<bool>,
}

/// Play, pause or seek, for everyone.
async fn control(State(st): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<Id>, Json(body): Json<Control>) -> ApiResult<Json<Watch>> {
    st.limits.check(format!("watch:{me}"), 10.0, 2.0)?;
    let guild = in_call(&st, id, me).await?;
    let w = {
        let Some(mut w) = st.watches.get_mut(&id) else { return Err(bad("nothing is playing")) };
        let now = now_ms();
        if body.live == Some(true) && w.provider == "youtube" {
            // Reported by every player that loads it: the first one wins.
            if w.live {
                return Ok(Json(w.clone()));
            }
            w.live = true;
            w.playing = true;
            w.ended = false;
            w.position = 0.0;
            w.updated_at = now;
        }
        // A live stream has no end (a hiccup in the player can look like one).
        if w.live && body.ended == Some(true) {
            return Ok(Json(w.clone()));
        }
        // Where it is now, before the change.
        if w.playing && !w.live {
            w.position += (now - w.updated_at) as f64 / 1000.0;
        }
        if let Some(p) = body.position.filter(|p| p.is_finite()) {
            w.position = p.max(0.0);
        }
        if let Some(p) = body.playing {
            w.playing = p;
        }
        match body.ended {
            Some(true) => {
                // Players that reach the end at about the same time all report it once.
                if w.ended {
                    return Ok(Json(w.clone()));
                }
                w.ended = true;
                w.playing = false;
            }
            _ if body.playing == Some(true) || body.position.is_some() => w.ended = false,
            _ => {}
        }
        w.updated_at = now;
        w.clone()
    };
    announce(&st, id, guild).await;
    Ok(Json(w))
}

#[derive(Deserialize)]
struct View {
    on: bool,
}

/// Opening or hiding the shared video for yourself: only changes who's watching.
async fn view(State(st): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<Id>, Json(body): Json<View>) -> ApiResult<()> {
    st.limits.check(format!("watch-view:{me}"), 10.0, 1.0)?;
    let guild = in_call(&st, id, me).await?;
    let changed = {
        let Some(mut w) = st.watches.get_mut(&id) else { return Err(bad("nothing is playing")) };
        let has = w.viewers.contains(&me);
        if body.on && !has {
            w.viewers.push(me);
        } else if !body.on && has {
            w.viewers.retain(|v| *v != me);
        }
        has != body.on
    };
    if changed {
        announce(&st, id, guild).await;
    }
    Ok(())
}

/// Someone left the call: they aren't watching any more.
pub async fn left(st: &AppState, channel: Id, guild: Option<Id>, user: Id) {
    let changed = st.watches.get_mut(&channel).is_some_and(|mut w| {
        let before = w.viewers.len();
        w.viewers.retain(|v| *v != user);
        w.viewers.len() != before
    });
    if changed {
        announce(st, channel, guild).await;
    }
}

async fn stop(State(st): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<Id>) -> ApiResult<()> {
    let guild = in_call(&st, id, me).await?;
    if st.watches.remove(&id).is_some() {
        announce(&st, id, guild).await;
    }
    Ok(())
}

/// The call ended: so does what it was watching.
pub async fn call_ended(st: &AppState, channel: Id, guild: Option<Id>) {
    if st.watches.remove(&channel).is_some() {
        announce(st, channel, guild).await;
    }
}

/// What the calls in these channels are watching, for READY.
pub fn for_channels(st: &AppState, channels: &[Id]) -> Vec<serde_json::Value> {
    st.watches
        .iter()
        .filter(|w| channels.contains(w.key()))
        .map(|w| json!({ "channel_id": w.key(), "watch": w.value().clone() }))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::parse;

    #[test]
    fn links() {
        assert_eq!(parse("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m5s"), Some(("youtube".into(), "dQw4w9WgXcQ".into(), false, 65.0)));
        assert_eq!(parse("https://youtu.be/dQw4w9WgXcQ"), Some(("youtube".into(), "dQw4w9WgXcQ".into(), false, 0.0)));
        assert_eq!(parse("https://www.twitch.tv/Gaules"), Some(("twitch".into(), "gaules".into(), true, 0.0)));
        assert_eq!(parse("https://www.twitch.tv/videos/123456?t=10s"), Some(("twitch".into(), "v123456".into(), false, 10.0)));
        assert_eq!(parse("https://kick.com/xqc"), Some(("kick".into(), "xqc".into(), true, 0.0)));
        assert_eq!(parse("https://evil.com/watch?v=x"), None);
        assert_eq!(parse("https://youtube.com/watch?v=<script>"), None);
    }
}
