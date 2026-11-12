use std::ops::Deref;
use std::sync::Arc;
use std::time::Instant;

use dashmap::DashMap;
use sqlx::PgPool;

use crate::config::Config;
use crate::id::Id;
use crate::gateway::Hub;
use crate::ratelimit::RateLimiter;
use crate::voice::VoiceStates;

/// A desktop sign-in that reached its callback: the app swaps the code for a session, proving it started the sign-in.
pub struct PendingLogin {
    pub user: Id,
    pub challenge: String,
    pub created: Instant,
}

/// Where a desktop sign-in ends: the local address of the app that started it.
pub struct DesktopLogin {
    pub port: u16,
    pub state: String,
    pub challenge: String,
}

pub struct OAuthState {
    pub desktop: Option<DesktopLogin>,
    /// The invite link this person came through, which lets a new account be created.
    pub invite: Option<String>,
    pub created: Instant,
}

pub struct Inner {
    pub cfg: Config,
    pub db: PgPool,
    pub http: reqwest::Client,
    pub hub: Hub,
    pub voice: VoiceStates,
    /// Desktop login: one-time code -> who signed in.
    pub pending_logins: DashMap<String, PendingLogin>,
    pub oauth_states: DashMap<String, OAuthState>,
    pub limits: RateLimiter,
    /// url -> (fetched at, embed)
    pub embed_cache: DashMap<String, (Instant, Option<serde_json::Value>)>,
    /// What each user is doing right now (e.g. listening to Spotify), shown with their presence.
    pub activities: DashMap<Id, Vec<serde_json::Value>>,
    /// Detectable games list and game activity expiry (activities.rs).
    pub games: crate::activities::Games,
    /// League of Legends: Riot API limits and caches, champion names (league.rs).
    pub league: crate::league::League,
    /// Spotify connect: OAuth state -> (user, created).
    pub spotify_states: DashMap<String, (Id, Instant)>,
    /// Kass, the music bot.
    pub music: crate::music::Music,
    /// Steve, the Minecraft bot mc-manager drives.
    pub steve: crate::steve::Steve,
    /// Watch together: what each call is watching (watch.rs).
    pub watches: DashMap<Id, crate::watch::Watch>,
    /// Stream previews (previews.rs): each streamer's latest JPEG and when it came (unix ms).
    pub previews: DashMap<Id, (axum::body::Bytes, i64)>,
}

#[derive(Clone)]
pub struct AppState(pub Arc<Inner>);

impl Deref for AppState {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        &self.0
    }
}
