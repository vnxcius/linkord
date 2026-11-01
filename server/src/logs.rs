//! The app's log: one JSON line per event in `<data>/logs/YYYY-MM-DD.jsonl` (UTC days), kept for 30 days. The monitor
//! (`monitor/`, a separate service) reads these files; this server only writes them.
//!
//! Everything is redacted on the way in, so a log line never holds anything worth stealing: ids are cut to
//! their first six digits ("109360…"), tokens, secrets, codes and passwords are dropped, query strings are
//! removed from URLs, emails are hidden and IP addresses shortened. Message contents are never logged.
//! Clients report their own errors to POST /logs/client (they go through the same redaction).

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::Response;
use axum::routing::post;
use axum::{Json, Router};
use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Value};
use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::Context;
use tracing_subscriber::Layer;

use crate::auth::AuthUser;
use crate::error::{bad, ApiResult};
use crate::state::AppState;

const KEEP_DAYS: i64 = 30;
/// Longest field value kept (a long error chain is cut).
const MAX_VALUE: usize = 2000;
/// Longest path kept in the access log.
const MAX_PATH: usize = 200;
/// One day's file stops growing here: anyone can make the server log a refused request.
const MAX_DAY_BYTES: u64 = 64 * 1024 * 1024;

// ---------- redaction ----------

struct Rules {
    id: Regex,
    bearer: Regex,
    pair: Regex,
    spaced: Regex,
    url_query: Regex,
    long_secret: Regex,
    email: Regex,
    ipv4: Regex,
    ipv6: Regex,
}

fn rules() -> &'static Rules {
    static R: OnceLock<Rules> = OnceLock::new();
    R.get_or_init(|| Rules {
        // Snowflake ids (users, channels, messages...) and Discord ids.
        id: Regex::new(r"\b(\d{6})\d{9,14}\b").unwrap(),
        bearer: Regex::new(r"(?i)\b(bearer|bot)\s+[\w\-.~+/]+=*").unwrap(),
        spaced: Regex::new(r#"(?i)\b(token|access_token|refresh_token|secret|client_secret|password|passwd|api_key)\s+[^\s"',;&]+"#).unwrap(),
        pair: Regex::new(r#"(?i)\b(token|access_token|refresh_token|secret|client_secret|password|passwd|key|api_key|code|state|nonce|authorization|cookie|session(?:_id)?)(["']?\s*[=:]\s*["']?)[^&\s"',;]+"#).unwrap(),
        url_query: Regex::new(r#"(https?://[^\s?"'#]+)\?[^\s"']*"#).unwrap(),
        // Anything that looks like a key or token (long base64/hex runs).
        long_secret: Regex::new(r"\b[A-Za-z0-9_\-]{32,}={0,2}").unwrap(),
        email: Regex::new(r"\b[\w.+\-]+@[\w\-]+\.[\w.\-]+\b").unwrap(),
        ipv4: Regex::new(r"\b(\d{1,3}\.\d{1,3})\.\d{1,3}\.\d{1,3}\b").unwrap(),
        ipv6: Regex::new(r"\b([0-9a-fA-F]{1,4}):(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}\b").unwrap(),
    })
}

/// Strips ids, secrets and personal details from a piece of log text.
pub fn redact(s: &str) -> String {
    let r = rules();
    let s = r.url_query.replace_all(s, "$1?…");
    let s = r.bearer.replace_all(&s, "$1 [redacted]");
    let s = r.pair.replace_all(&s, "$1$2[redacted]");
    let s = r.spaced.replace_all(&s, "$1 [redacted]");
    let s = r.email.replace_all(&s, "[email]");
    let s = r.long_secret.replace_all(&s, "[redacted]");
    let s = r.id.replace_all(&s, "$1…");
    let s = r.ipv4.replace_all(&s, "$1.x.x");
    let s = r.ipv6.replace_all(&s, "$1:…");
    let mut out = s.into_owned();
    if out.len() > MAX_VALUE {
        let mut cut = MAX_VALUE;
        while !out.is_char_boundary(cut) {
            cut -= 1;
        }
        out.truncate(cut);
        out.push('…');
    }
    out
}

// ---------- writing ----------

pub fn dir(data_dir: &std::path::Path) -> PathBuf {
    data_dir.join("logs")
}

struct DailyFile {
    dir: PathBuf,
    day: String,
    file: Option<std::fs::File>,
    written: u64,
}

impl DailyFile {
    fn write_line(&mut self, line: &str) {
        let day = chrono::Utc::now().format("%Y-%m-%d").to_string();
        if self.file.is_none() || day != self.day {
            let _ = std::fs::create_dir_all(&self.dir);
            self.file = std::fs::OpenOptions::new().create(true).append(true).open(self.dir.join(format!("{day}.jsonl"))).ok();
            self.written = self.file.as_ref().and_then(|f| f.metadata().ok()).map_or(0, |m| m.len());
            self.day = day;
        }
        if self.written >= MAX_DAY_BYTES {
            return;
        }
        if let Some(f) = &mut self.file {
            let _ = writeln!(f, "{line}");
            self.written += line.len() as u64 + 1;
            if self.written >= MAX_DAY_BYTES {
                let at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                let _ = writeln!(f, r#"{{"t":"{at}","level":"WARN","target":"linkord_server::logs","msg":"this day's log reached its size limit; nothing more is written until tomorrow","fields":{{}}}}"#);
            }
        }
    }
}

/// Log paths without what identifies a live secret, and never at length.
fn log_path(path: &str) -> String {
    let path = match path.strip_prefix("/api/invites/") {
        Some(_) => "/api/invites/:code",
        None => path,
    };
    path.chars().take(MAX_PATH).collect()
}

/// A tracing layer that writes redacted JSON lines to the daily file.
pub struct FileLayer {
    out: Mutex<DailyFile>,
}

impl FileLayer {
    pub fn new(data_dir: &std::path::Path) -> FileLayer {
        FileLayer { out: Mutex::new(DailyFile { dir: dir(data_dir), day: String::new(), file: None, written: 0 }) }
    }
}

#[derive(Default)]
struct Fields(BTreeMap<String, String>);

impl Visit for Fields {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.0.insert(field.name().to_string(), value.to_string());
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        let mut s = String::new();
        let _ = write!(s, "{value:?}");
        self.0.insert(field.name().to_string(), s);
    }
}

impl<S: Subscriber> Layer<S> for FileLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let mut fields = Fields::default();
        event.record(&mut fields);
        let meta = event.metadata();
        let msg = fields.0.remove("message").unwrap_or_default();
        let target = meta.target().strip_prefix("linkord_server::").unwrap_or(meta.target());
        let mut line = json!({
            "t": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "level": meta.level().as_str(),
            "target": target,
            "msg": redact(&msg),
        });
        if !fields.0.is_empty() {
            line["fields"] = Value::Object(fields.0.into_iter().map(|(k, v)| (k, Value::String(redact(&v)))).collect());
        }
        let line = line.to_string();
        if let Ok(mut out) = self.out.lock() {
            out.write_line(&line);
        }
    }
}

/// Deletes days older than KEEP_DAYS, once at start and then daily.
pub async fn prune(st: AppState) {
    let mut tick = tokio::time::interval(Duration::from_secs(6 * 3600));
    loop {
        tick.tick().await;
        let oldest = (chrono::Utc::now() - chrono::Duration::days(KEEP_DAYS)).format("%Y-%m-%d").to_string();
        let Ok(mut rd) = tokio::fs::read_dir(dir(&st.cfg.data_dir)).await else { continue };
        while let Ok(Some(e)) = rd.next_entry().await {
            let name = e.file_name().to_string_lossy().into_owned();
            if let Some(day) = name.strip_suffix(".jsonl") {
                if day.len() == 10 && day < oldest.as_str() {
                    let _ = tokio::fs::remove_file(e.path()).await;
                    tracing::info!(day, "log day removed (older than {KEEP_DAYS} days)");
                }
            }
        }
    }
}

// ---------- HTTP access log ----------

/// Refused requests worth a line, across everyone: bursts above this aren't news, and anyone can cause them.
fn refused_budget() -> bool {
    static BUDGET: Mutex<(f64, Option<Instant>)> = Mutex::new((100.0, None));
    let mut b = BUDGET.lock().unwrap();
    let now = Instant::now();
    let tokens = (b.0 + b.1.map_or(0.0, |t| now.duration_since(t).as_secs_f64()) * 5.0).min(100.0);
    *b = (if tokens >= 1.0 { tokens - 1.0 } else { tokens }, Some(now));
    tokens >= 1.0
}

/// One line per API request (method, path with ids cut, status, time). Static files, uploads and health
/// checks are left out unless they fail.
pub async fn access_log(req: Request, next: Next) -> Response {
    let method = req.method().clone();
    let path = log_path(req.uri().path());
    let start = Instant::now();
    crate::internal::request_started();
    let res = next.run(req).await;
    let status = res.status();
    let ms = start.elapsed().as_millis() as u64;
    crate::internal::request_finished(&path, status.as_u16(), ms);
    // Static files, health checks, read receipts, typing and the logs themselves would drown everything else.
    let quiet = !path.starts_with("/api/")
        || path == "/api/health"
        || path.starts_with("/api/updates/download")
        || path.ends_with("/ack")
        || path.ends_with("/typing")
        || path.starts_with("/api/logs/");
    if status.is_server_error() {
        tracing::error!(target: "http", %method, path = %path, status = status.as_u16(), ms, "request failed");
    } else if status.is_client_error() && status != StatusCode::NOT_FOUND && !quiet && refused_budget() {
        tracing::warn!(target: "http", %method, path = %path, status = status.as_u16(), ms, "request refused");
    } else if !quiet && (method != axum::http::Method::GET || ms > 1500) {
        // Reads are many and boring; changes and slow requests are worth a line.
        tracing::info!(target: "http", %method, path = %path, status = status.as_u16(), ms, "request");
    }
    res
}

// ---------- API ----------

pub fn routes() -> Router<AppState> {
    Router::new().route("/logs/client", post(client_log))
}

#[derive(Deserialize)]
struct ClientLog {
    level: String,
    message: String,
    #[serde(default)]
    context: Option<String>,
    /// Client version and platform ("0.2.6 windows desktop").
    #[serde(default)]
    client: Option<String>,
}

/// Errors and notable events from clients (voice failures, crashes), kept with the server's log.
async fn client_log(State(st): State<AppState>, AuthUser(me): AuthUser, Json(body): Json<ClientLog>) -> ApiResult<StatusCode> {
    st.limits.check(format!("clientlog:{me}"), 20.0, 0.3)?;
    let message: String = body.message.chars().take(1000).collect();
    let context: String = body.context.unwrap_or_default().chars().take(2000).collect();
    let client: String = body.client.unwrap_or_default().chars().take(80).collect();
    let user = me.to_string();
    match body.level.as_str() {
        "error" => tracing::error!(target: "client", user, client, context, "{message}"),
        "warn" => tracing::warn!(target: "client", user, client, context, "{message}"),
        "info" => tracing::info!(target: "client", user, client, context, "{message}"),
        _ => return Err(bad("unknown level")),
    }
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::redact;

    #[test]
    fn redacts_ids_secrets_and_personal_details() {
        assert_eq!(redact("user 109360124031664128 joined"), "user 109360… joined");
        assert_eq!(redact("Authorization: Bearer abc.def-ghi"), "Authorization: [redacted] [redacted]");
        assert_eq!(redact("got Bearer abc.def-ghi"), "got Bearer [redacted]");
        assert_eq!(redact("GET /cb?code=xyz&state=1"), "GET /cb?code=[redacted]&state=[redacted]");
        assert_eq!(redact("fetch https://x.dev/a/b?token=1 failed"), "fetch https://x.dev/a/b?… failed");
        assert_eq!(redact("client_secret=s3cr3t"), "client_secret=[redacted]");
        assert_eq!(redact("mail me@example.com"), "mail [email]");
        assert_eq!(redact("from 203.0.113.4"), "from 203.0.x.x");
        assert_eq!(redact("key aGVsbG8taGVsbG8taGVsbG8taGVsbG8taGVsbG8"), "key [redacted]");
        assert_eq!(redact("in 2026-10-30, 1080p 60 fps, 300 ms"), "in 2026-10-30, 1080p 60 fps, 300 ms");
    }
}
