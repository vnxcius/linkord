use std::env;
use std::path::PathBuf;

use anyhow::Context;

#[derive(Clone, Debug)]
pub struct Config {
    pub bind: String,
    /// Externally reachable base URL, e.g. https://linkord.example.com
    pub public_url: String,
    pub database_url: String,
    pub data_dir: PathBuf,
    pub web_dir: PathBuf,
    /// Default nameplates users can pick without uploading anything (LINKORD_NAMEPLATES_DIR).
    pub nameplates_dir: PathBuf,
    /// Default soundboard sounds (LINKORD_SOUNDS_DIR): audio files, "🦆 quack.mp3".
    pub sounds_dir: PathBuf,
    pub discord_client_id: String,
    pub discord_client_secret: String,
    /// Enables passwordless username login for local testing. Never enable on a public server.
    pub dev_login: bool,
    /// Total bytes each user may upload.
    pub upload_quota: u64,
    /// Spotify connection (Settings -> Connections). Both empty = the option is hidden.
    pub spotify_client_id: String,
    pub spotify_client_secret: String,
    /// Overridable so tests can point at a fake Spotify.
    pub spotify_accounts_url: String,
    pub spotify_api_url: String,
    /// How often to check what a connected user is playing.
    pub spotify_poll: std::time::Duration,
    /// Discord's list of detectable games (executable names), for "Playing" activities.
    pub detectable_url: String,
    /// Game cards look up Steam and Wikipedia; LINKORD_GAME_INFO=off skips them (tests run offline).
    pub game_info: bool,
    /// Direct access that skips Cloudflare (direct.rs): listen address, e.g. 0.0.0.0:8443. Off when unset.
    pub direct_bind: Option<String>,
    /// The DNS-only hostname pointing at this machine, e.g. mc.example.com.
    pub direct_host: String,
    /// Terminate TLS with a Let's Encrypt certificate (default); off = plain HTTP, for tests.
    pub direct_tls: bool,
    /// Cloudflare API token ("Edit zone DNS") for the direct access certificate (DNS-01).
    pub cloudflare_token: Option<String>,
    /// Use Let's Encrypt's staging directory (testing certificates, no rate limits).
    pub acme_staging: bool,
    /// Who may open /logs and change the music bot's picture: Linkord usernames, user ids or Discord ids.
    pub admins: Vec<String>,
}

fn opt(key: &str) -> Option<String> {
    env::var(key).ok().filter(|v| !v.trim().is_empty())
}

impl Config {
    pub fn from_env() -> anyhow::Result<Config> {
        Ok(Config {
            bind: opt("LINKORD_BIND").unwrap_or_else(|| "127.0.0.1:7700".into()),
            public_url: opt("LINKORD_PUBLIC_URL")
                .unwrap_or_else(|| "http://localhost:7700".into())
                .trim_end_matches('/')
                .to_string(),
            database_url: opt("DATABASE_URL").context("DATABASE_URL is required")?,
            data_dir: opt("LINKORD_DATA_DIR").unwrap_or_else(|| "./data".into()).into(),
            nameplates_dir: opt("LINKORD_NAMEPLATES_DIR").unwrap_or_else(|| "./nameplates".into()).into(),
            sounds_dir: opt("LINKORD_SOUNDS_DIR").unwrap_or_else(|| "./soundboard".into()).into(),
            web_dir: opt("LINKORD_WEB_DIR").unwrap_or_else(|| "../app/dist".into()).into(),
            discord_client_id: opt("DISCORD_CLIENT_ID").unwrap_or_default(),
            discord_client_secret: opt("DISCORD_CLIENT_SECRET").unwrap_or_default(),
            dev_login: opt("LINKORD_DEV_LOGIN").is_some_and(|v| v == "true" || v == "1"),
            upload_quota: opt("LINKORD_UPLOAD_QUOTA_MB").and_then(|v| v.parse::<u64>().ok()).unwrap_or(2048) * 1024 * 1024,
            spotify_client_id: opt("SPOTIFY_CLIENT_ID").unwrap_or_default(),
            spotify_client_secret: opt("SPOTIFY_CLIENT_SECRET").unwrap_or_default(),
            spotify_accounts_url: opt("SPOTIFY_ACCOUNTS_URL").unwrap_or_else(|| "https://accounts.spotify.com".into()),
            spotify_api_url: opt("SPOTIFY_API_URL").unwrap_or_else(|| "https://api.spotify.com".into()),
            spotify_poll: std::time::Duration::from_millis(opt("SPOTIFY_POLL_MS").and_then(|v| v.parse().ok()).unwrap_or(5000)),
            detectable_url: opt("LINKORD_DETECTABLE_URL").unwrap_or_else(|| "https://discord.com/api/v9/applications/detectable".into()),
            game_info: opt("LINKORD_GAME_INFO").as_deref() != Some("off"),
            direct_bind: opt("LINKORD_DIRECT_BIND"),
            direct_host: opt("LINKORD_DIRECT_HOST").unwrap_or_default(),
            direct_tls: opt("LINKORD_DIRECT_TLS").is_none_or(|v| v != "off"),
            cloudflare_token: opt("CLOUDFLARE_API_TOKEN"),
            acme_staging: opt("LINKORD_ACME_STAGING").is_some_and(|v| v == "true"),
            admins: opt("LINKORD_ADMINS")
                .map(|v| v.split(',').map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect())
                .unwrap_or_default(),
        })
    }

    pub fn spotify_enabled(&self) -> bool {
        !self.spotify_client_id.is_empty() && !self.spotify_client_secret.is_empty()
    }

    pub fn discord_enabled(&self) -> bool {
        !self.discord_client_id.is_empty() && !self.discord_client_secret.is_empty()
    }

    pub fn uploads_dir(&self) -> PathBuf {
        self.data_dir.join("uploads")
    }
}
