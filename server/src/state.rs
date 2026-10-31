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

pub struct PendingLogin {
    pub token: String,
    pub created: Instant,
}

pub struct OAuthState {
    pub nonce: Option<String>,
    pub created: Instant,
}

pub struct Inner {
    pub cfg: Config,
    pub db: PgPool,
    pub http: reqwest::Client,
    pub hub: Hub,
    pub voice: VoiceStates,
    /// Desktop login: nonce -> session token, picked up by polling.
    pub pending_logins: DashMap<String, PendingLogin>,
    pub oauth_states: DashMap<String, OAuthState>,
    pub limits: RateLimiter,
    /// url -> (fetched at, embed)
    pub embed_cache: DashMap<String, (Instant, Option<serde_json::Value>)>,
    /// What each user is doing right now (e.g. listening to Spotify), shown with their presence.
    pub activities: DashMap<Id, Vec<serde_json::Value>>,
    /// Detectable games list and game activity expiry (activities.rs).
    pub games: crate::activities::Games,
    /// Spotify connect: OAuth state -> (user, created).
    pub spotify_states: DashMap<String, (Id, Instant)>,
    /// Kass, the music bot.
    pub music: crate::music::Music,
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
