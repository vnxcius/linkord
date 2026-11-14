use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context};

#[derive(Clone, Debug)]
pub struct Config {
    /// Host names the dashboard answers to, besides IP addresses and localhost.
    pub allowed_hosts: Vec<String>,
    pub bind: String,
    pub password: String,
    pub data_dir: PathBuf,
    pub web_dir: PathBuf,
    /// The app's server, as this machine reaches it.
    pub app_url: String,
    pub public_url: String,
    /// https://mc.example.com:8443, when direct access is on.
    pub direct_url: Option<String>,
    pub internal_url: Option<String>,
    /// The app's data directory (logs, uploads, internal-token).
    pub app_data: PathBuf,
    pub nameplates_dir: PathBuf,
    pub sounds_dir: PathBuf,
    pub database_url: String,
    /// Bare name of the app's process, to find it among the system's.
    pub app_process: String,
    /// Off in tests: no calls to Discord, Cloudflare and friends.
    pub probe_internet: bool,
}

/// The few settings the monitor shares with the app. Only these are read from server/.env: its secrets (Discord,
/// Cloudflare...) never reach this process.
const SHARED: &[&str] = &[
    "DATABASE_URL",
    "POTTIRA_BIND",
    "POTTIRA_PUBLIC_URL",
    "POTTIRA_DATA_DIR",
    "POTTIRA_NAMEPLATES_DIR",
    "POTTIRA_SOUNDS_DIR",
    "POTTIRA_DIRECT_BIND",
    "POTTIRA_DIRECT_HOST",
    "POTTIRA_DIRECT_TLS",
    "POTTIRA_INTERNAL_BIND",
];

fn opt(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.trim().is_empty())
}

fn shared_file(server_dir: &Path) -> HashMap<String, String> {
    let mut out = HashMap::new();
    if let Ok(iter) = dotenvy::from_path_iter(server_dir.join(".env")) {
        for (k, v) in iter.flatten() {
            if SHARED.contains(&k.as_str()) && !v.trim().is_empty() {
                out.insert(k, v);
            }
        }
    }
    out
}

impl Config {
    pub fn from_env() -> anyhow::Result<Config> {
        let _ = dotenvy::dotenv();
        let server_dir = PathBuf::from(opt("POTTIRA_MONITOR_SERVER_DIR").unwrap_or_else(|| "../server".into()));
        let file = shared_file(&server_dir);
        // The environment wins over server/.env (tests point at their own instance that way).
        let shared = |key: &str| opt(key).or_else(|| file.get(key).cloned());
        // Relative paths in server/.env are relative to the server.
        let in_server = |key: &str, default: &str| -> PathBuf {
            let raw = PathBuf::from(shared(key).unwrap_or_else(|| default.into()));
            if raw.is_absolute() {
                raw
            } else {
                server_dir.join(raw)
            }
        };

        let password = opt("POTTIRA_MONITOR_PASSWORD").unwrap_or_default();
        if password.len() < 8 {
            bail!("POTTIRA_MONITOR_PASSWORD must be set in monitor/.env (8 characters or more)");
        }
        let app_bind = shared("POTTIRA_BIND").unwrap_or_else(|| "127.0.0.1:7700".into());
        let public_url = shared("POTTIRA_PUBLIC_URL").unwrap_or_else(|| format!("http://{app_bind}")).trim_end_matches('/').to_string();
        let direct_url = match (shared("POTTIRA_DIRECT_BIND"), shared("POTTIRA_DIRECT_HOST")) {
            (Some(bind), Some(host)) => {
                let port = bind.rsplit(':').next().unwrap_or("443").to_string();
                let tls = shared("POTTIRA_DIRECT_TLS").is_none_or(|v| v != "off");
                Some(format!("{}://{host}:{port}", if tls { "https" } else { "http" }))
            }
            _ => None,
        };
        let internal_url = match shared("POTTIRA_INTERNAL_BIND").as_deref() {
            Some("off") => None,
            Some(v) => Some(format!("http://{v}")),
            None => Some("http://127.0.0.1:7711".to_string()),
        };
        Ok(Config {
            bind: opt("POTTIRA_MONITOR_BIND").unwrap_or_else(|| "127.0.0.1:7710".into()),
            allowed_hosts: opt("POTTIRA_MONITOR_HOSTS").map(|v| v.split(',').map(|h| h.trim().to_string()).filter(|h| !h.is_empty()).collect()).unwrap_or_default(),
            password,
            data_dir: opt("POTTIRA_MONITOR_DATA_DIR").unwrap_or_else(|| "./data".into()).into(),
            web_dir: opt("POTTIRA_MONITOR_WEB_DIR").unwrap_or_else(|| "./web/dist".into()).into(),
            app_url: format!("http://{}", app_bind.replace("0.0.0.0", "127.0.0.1")),
            public_url,
            direct_url,
            internal_url,
            app_data: in_server("POTTIRA_DATA_DIR", "./data"),
            nameplates_dir: in_server("POTTIRA_NAMEPLATES_DIR", "./nameplates"),
            sounds_dir: in_server("POTTIRA_SOUNDS_DIR", "./soundboard"),
            database_url: shared("DATABASE_URL").context("DATABASE_URL not found in the environment or server/.env")?,
            app_process: opt("POTTIRA_MONITOR_APP_PROCESS").unwrap_or_else(|| "pottira-server".into()),
            probe_internet: opt("POTTIRA_MONITOR_PROBE_INTERNET").as_deref() != Some("off"),
        })
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.app_data.join("logs")
    }

    pub fn uploads_dir(&self) -> PathBuf {
        self.app_data.join("uploads")
    }
}
