//! The app's log, readable at /logs by admins (LINKORD_ADMINS): one JSON line per event in
//! `<data>/logs/YYYY-MM-DD.jsonl` (UTC days), kept for 30 days.
//!
//! Everything is redacted on the way in, so a log line never holds anything worth stealing: ids are cut to
//! their first six digits ("109360…"), tokens, secrets, codes and passwords are dropped, query strings are
//! removed from URLs, emails are hidden and IP addresses shortened. Message contents are never logged.
//! Clients report their own errors to POST /logs/client (they go through the same redaction).
//! GET /admin/logs/live streams new lines as they're written (server-sent events) for the page's live view.

use std::collections::BTreeMap;
use std::convert::Infallible;
use std::fmt::Write as _;
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::extract::{Query, Request, State};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::Response;
use futures_util::Stream;
use tokio::sync::broadcast;
use axum::routing::{get, post};
use axum::{Json, Router};
use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Value};
use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::Context;
use tracing_subscriber::Layer;

use crate::auth::{AdminUser, AuthUser};
use crate::error::{bad, ApiResult};
use crate::state::AppState;

const KEEP_DAYS: i64 = 30;
/// Longest field value kept (a long error chain is cut).
const MAX_VALUE: usize = 2000;

// ---------- redaction ----------

struct Rules {
    id: Regex,
    bearer: Regex,
    pair: Regex,
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
}

impl DailyFile {
    fn write_line(&mut self, line: &str) {
        let day = chrono::Utc::now().format("%Y-%m-%d").to_string();
        if self.file.is_none() || day != self.day {
            let _ = std::fs::create_dir_all(&self.dir);
            self.file = std::fs::OpenOptions::new().create(true).append(true).open(self.dir.join(format!("{day}.jsonl"))).ok();
            self.day = day;
        }
        if let Some(f) = &mut self.file {
            let _ = writeln!(f, "{line}");
        }
    }
}

/// Every line as it's written (already redacted), for the live view.
fn live() -> &'static broadcast::Sender<String> {
    static LIVE: OnceLock<broadcast::Sender<String>> = OnceLock::new();
    LIVE.get_or_init(|| broadcast::channel(512).0)
}

/// A tracing layer that writes redacted JSON lines to the daily file.
pub struct FileLayer {
    out: Mutex<DailyFile>,
}

impl FileLayer {
    pub fn new(data_dir: &std::path::Path) -> FileLayer {
        FileLayer { out: Mutex::new(DailyFile { dir: dir(data_dir), day: String::new(), file: None }) }
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
        // No one watching is fine.
        let _ = live().send(line);
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

/// One line per API request (method, path with ids cut, status, time). Static files, uploads and health
/// checks are left out unless they fail.
pub async fn access_log(req: Request, next: Next) -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let start = Instant::now();
    let res = next.run(req).await;
    let status = res.status();
    let ms = start.elapsed().as_millis() as u64;
    // Static files, health checks, read receipts, typing and the logs themselves would drown everything else.
    let quiet = !path.starts_with("/api/")
        || path == "/api/health"
        || path.starts_with("/api/updates/download")
        || path.ends_with("/ack")
        || path.ends_with("/typing")
        || path.starts_with("/api/logs/")
        || path.starts_with("/api/admin/logs");
    if status.is_server_error() {
        tracing::error!(target: "http", %method, path = %path, status = status.as_u16(), ms, "request failed");
    } else if status.is_client_error() && status != StatusCode::NOT_FOUND && !quiet {
        tracing::warn!(target: "http", %method, path = %path, status = status.as_u16(), ms, "request refused");
    } else if !quiet && (method != axum::http::Method::GET || ms > 1500) {
        // Reads are many and boring; changes and slow requests are worth a line.
        tracing::info!(target: "http", %method, path = %path, status = status.as_u16(), ms, "request");
    }
    res
}

// ---------- API ----------

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/logs/client", post(client_log))
        .route("/admin/logs/days", get(days))
        .route("/admin/logs", get(read_day))
        .route("/admin/logs/live", get(live_lines))
}

/// New lines as they're written, one JSON line per event; the page filters them like the day it shows.
async fn live_lines(AdminUser(_): AdminUser) -> Sse<impl Stream<Item = Result<SseEvent, Infallible>>> {
    let stream = futures_util::stream::unfold(live().subscribe(), |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok(line) => return Some((Ok(SseEvent::default().data(line)), rx)),
                // A burst the page couldn't keep up with: those lines are still in the day's file.
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    });
    // Cloudflare closes connections that stay quiet for 100 s.
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
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

/// The days there are logs for, newest first, with their size.
async fn days(State(st): State<AppState>, AdminUser(_): AdminUser) -> ApiResult<Json<Vec<Value>>> {
    let mut out = vec![];
    if let Ok(mut rd) = tokio::fs::read_dir(dir(&st.cfg.data_dir)).await {
        while let Ok(Some(e)) = rd.next_entry().await {
            let name = e.file_name().to_string_lossy().into_owned();
            if let Some(day) = name.strip_suffix(".jsonl") {
                let size = e.metadata().await.map(|m| m.len()).unwrap_or(0);
                out.push(json!({ "day": day, "size": size }));
            }
        }
    }
    out.sort_by(|a, b| b["day"].as_str().cmp(&a["day"].as_str()));
    Ok(Json(out))
}

#[derive(Deserialize)]
struct DayQuery {
    day: String,
    /// Minimum level: error | warn | info | debug.
    level: Option<String>,
    /// Text to look for (anywhere in the line).
    q: Option<String>,
    target: Option<String>,
    /// Newest lines first; `before` = how many matching lines (from the end) to skip.
    #[serde(default)]
    before: usize,
    limit: Option<usize>,
}

fn rank(level: &str) -> u8 {
    match level {
        "ERROR" | "error" => 4,
        "WARN" | "warn" => 3,
        "INFO" | "info" => 2,
        "DEBUG" | "debug" => 1,
        _ => 0,
    }
}

/// One day's lines, newest first, filtered by level, target and text.
async fn read_day(State(st): State<AppState>, AdminUser(_): AdminUser, Query(q): Query<DayQuery>) -> ApiResult<Json<Value>> {
    if !regex::Regex::new(r"^\d{4}-\d{2}-\d{2}$").unwrap().is_match(&q.day) {
        return Err(bad("unknown day"));
    }
    let text = tokio::fs::read_to_string(dir(&st.cfg.data_dir).join(format!("{}.jsonl", q.day))).await.unwrap_or_default();
    let min = q.level.as_deref().map(rank).unwrap_or(0);
    let needle = q.q.as_deref().map(str::to_lowercase).filter(|s| !s.is_empty());
    let limit = q.limit.unwrap_or(300).clamp(1, 1000);
    let mut matched = text
        .lines()
        .rev()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|v| rank(v["level"].as_str().unwrap_or("")) >= min)
        .filter(|v| q.target.as_deref().is_none_or(|t| t.is_empty() || v["target"].as_str() == Some(t)))
        .filter(|v| needle.as_ref().is_none_or(|n| v.to_string().to_lowercase().contains(n.as_str())));
    let lines: Vec<Value> = matched.by_ref().skip(q.before).take(limit).collect();
    let more = matched.next().is_some();
    Ok(Json(json!({ "lines": lines, "more": more })))
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
