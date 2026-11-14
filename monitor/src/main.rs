//! Pottira's monitor: a dashboard for the server's health and for moderating what's on it.
//!
//! A separate service so it can't get in the app's way, and still works when the app doesn't: its own process, port,
//! login and history. It reads the app's log and upload files from disk and Postgres over a small read-only connection.
//! The only thing it asks of the app is a loopback endpoint for live counters and removing media (server/src/internal.rs).

mod auth;
mod checks;
mod config;
mod diagnose;
mod logs;
mod moderation;
mod pg;
mod sampler;
mod state;
mod storage;
mod store;

use std::time::Duration;

use anyhow::Context;
use axum::extract::{Query, Request, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use tower_http::services::{ServeDir, ServeFile};
use tracing_subscriber::EnvFilter;

use crate::state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "pottira_monitor=info".into())).init();
    let cfg = config::Config::from_env()?;
    let bind = cfg.bind.clone();
    let web_dir = cfg.web_dir.clone();
    let st = AppState::new(cfg).context("opening the monitor's history")?;

    tokio::spawn(sampler::run(st.clone()));
    tokio::spawn(checks::run(st.clone()));
    tokio::spawn(checks::keep_certs(st.clone()));
    tokio::spawn(checks::keep_trace(st.clone()));
    tokio::spawn(pg::keep_quick(st.clone()));
    tokio::spawn(storage::keep(st.clone()));
    tokio::spawn(prune_history(st.clone()));

    let protected = Router::new()
        .route("/now", get(now))
        .route("/series", get(series))
        .route("/system", get(system))
        .route("/availability", get(availability))
        .route("/network", get(network))
        .route("/storage", get(storage_tab))
        .route("/database", get(database))
        .route("/logs/days", get(logs::days))
        .route("/logs", get(logs::read_day))
        .route("/logs/stats", get(logs::stats))
        .route("/logs/live", get(logs::live))
        .route("/moderation/summary", get(moderation::summary))
        .route("/moderation/servers", get(moderation::servers))
        .route("/moderation/servers/{id}", get(moderation::server))
        .route("/moderation/accounts", get(moderation::accounts))
        .route("/moderation/media", get(moderation::media))
        .route("/moderation/media/totals", get(moderation::media_totals))
        .route("/moderation/media/remove", post(moderation::remove))
        .route("/moderation/accounts/suspend", post(moderation::suspend))
        .route("/moderation/accounts/badge", post(moderation::badge))
        .route("/diagnostics/run", post(diagnose::run))
        .route("/tools/dns", post(diagnose::tool_dns))
        .route("/tools/tcp", post(diagnose::tool_tcp))
        .route("/tools/http", post(diagnose::tool_http))
        .route("/tools/tls", post(diagnose::tool_tls))
        .route("/tools/speedtest", post(diagnose::speedtest))
        .route_layer(middleware::from_fn_with_state(st.clone(), auth::require));

    let api = Router::new()
        .route("/session", get(auth::session))
        .route("/login", post(auth::login))
        .route("/logout", post(auth::logout))
        .merge(protected);

    let files = Router::new()
        .route("/media/{*path}", get(moderation::file))
        .route_layer(middleware::from_fn_with_state(st.clone(), auth::require));

    let web = ServeDir::new(&web_dir).fallback(ServeFile::new(web_dir.join("index.html")));
    let app = Router::new()
        .nest("/api", api)
        .merge(files)
        .fallback_service(web)
        .layer(middleware::from_fn(security_headers))
        .layer(middleware::from_fn_with_state(st.clone(), auth::check_host))
        .with_state(st);

    let listener = tokio::net::TcpListener::bind(&bind).await.with_context(|| format!("binding {bind}"))?;
    tracing::info!("monitor on http://{bind}");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn security_headers(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.entry(header::X_CONTENT_TYPE_OPTIONS).or_insert(HeaderValue::from_static("nosniff"));
    h.entry(header::X_FRAME_OPTIONS).or_insert(HeaderValue::from_static("DENY"));
    h.entry(header::REFERRER_POLICY).or_insert(HeaderValue::from_static("no-referrer"));
    h.entry(header::CONTENT_SECURITY_POLICY).or_insert(HeaderValue::from_static(
        "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    ));
    res
}

async fn prune_history(st: AppState) {
    let mut tick = tokio::time::interval(Duration::from_secs(3600));
    loop {
        tick.tick().await;
        let store = st.store.clone();
        let _ = tokio::task::spawn_blocking(move || store.prune(chrono::Utc::now().timestamp())).await;
    }
}

// ---------- the summary every tab starts from ----------

fn attention(level: &str, title: impl Into<String>, detail: impl Into<String>, tab: &str) -> Value {
    json!({ "level": level, "title": title.into(), "detail": detail.into(), "tab": tab })
}

/// Everything that needs a person right now, worst first.
async fn what_needs_attention(st: &AppState, live: &Value) -> Vec<Value> {
    let mut out = vec![];
    for c in st.checks.read().unwrap().iter() {
        if c.status == "down" {
            let level = if c.group == "app" || c.id == "public" { "critical" } else { "warning" };
            out.push(attention(level, format!("{} is down", c.name), c.detail.clone(), "availability"));
        } else if c.status == "slow" {
            out.push(attention("warning", format!("{} is slow", c.name), format!("{:.0} ms", c.ms.unwrap_or(0.0)), "availability"));
        }
    }
    if !live.is_null() {
        let app = &live["app"];
        if app["config"]["dev_login"] == true && !st.cfg.public_url.contains("localhost") && !st.cfg.public_url.contains("127.0.0.1") {
            out.push(attention("critical", "Dev login is on in production", "Anyone can sign in as anyone. Set POTTIRA_DEV_LOGIN=false.", "diagnostics"));
        }
        for d in live["disks"].as_array().into_iter().flatten() {
            let (total, free) = (d["total"].as_f64().unwrap_or(1.0), d["free"].as_f64().unwrap_or(0.0));
            let pct = (1.0 - free / total) * 100.0;
            let mount = d["mount"].as_str().unwrap_or("");
            if pct >= 95.0 {
                out.push(attention("critical", format!("Disk {mount} is {pct:.0}% full"), "Uploads and the database fail when it fills up.", "storage"));
            } else if pct >= 85.0 {
                out.push(attention("warning", format!("Disk {mount} is {pct:.0}% full"), "See what's growing.", "storage"));
            }
        }
        let (mem_total, available) = (live["memory"]["total"].as_f64().unwrap_or(1.0), live["memory"]["available"].as_f64().unwrap_or(1.0));
        let mem = (1.0 - available / mem_total) * 100.0;
        if mem >= 92.0 {
            out.push(attention("warning", format!("Memory is {mem:.0}% used"), "See what's using it.", "performance"));
        }
        if live["cpu"]["total"].as_f64().unwrap_or(0.0) >= 90.0 {
            out.push(attention("warning", "CPU is nearly maxed out", "Voice starts cutting out when this stays high.", "performance"));
        }
        if app["runtime"]["lag_ms"].as_f64().unwrap_or(0.0) > 100.0 {
            out.push(attention("warning", "The app's timers are running late", "It's overloaded or something is blocking it.", "performance"));
        }
        let server_errors = app["rates"]["server_err"].as_f64().unwrap_or(0.0);
        if server_errors > 0.0 {
            out.push(attention("warning", format!("{server_errors:.1} failed requests a second"), "See the errors in Logs.", "logs"));
        }
        if app["rates"]["queue_drops"].as_f64().unwrap_or(0.0) > 5.0 {
            out.push(attention("warning", "Voice packets are being dropped", "A listener's queue is full: their connection or this machine can't keep up.", "performance"));
        }
    }
    for cert in st.certs.read().unwrap().as_array().into_iter().flatten() {
        if let Some(days) = cert["cert"]["days_left"].as_i64() {
            if days < 7 {
                out.push(attention("critical", format!("{} certificate expires in {days} days", cert["label"].as_str().unwrap_or("")), "It should have renewed by now.", "network"));
            } else if days < 20 {
                out.push(attention("warning", format!("{} certificate expires in {days} days", cert["label"].as_str().unwrap_or("")), "Renewal should have happened already.", "network"));
            }
        }
    }
    let (errors, _) = logs::count_recent(st, 3600).await;
    if errors > 0 {
        let what = if errors == 1 { "1 error".to_string() } else { format!("{errors} errors") };
        out.push(attention("warning", format!("{what} logged in the last hour"), "See them in Logs.", "logs"));
    }
    out.sort_by_key(|a| a["level"] != "critical");
    out
}

/// The headline. What's known to be broken comes first, and "ok" is only said once every check has confirmed it: until
/// then the app could be down and no check would have said so yet.
fn verdict(critical: usize, attention: usize, unconfirmed: bool) -> &'static str {
    if critical > 0 {
        "critical"
    } else if attention > 0 {
        "warning"
    } else if unconfirmed {
        "starting"
    } else {
        "ok"
    }
}

/// The headline, the things that need attention and the numbers on the overview. Polled every few seconds.
async fn now(State(st): State<AppState>) -> Json<Value> {
    let live = st.live.read().unwrap().clone();
    let checks = st.checks.read().unwrap().clone();
    let attention = what_needs_attention(&st, &live).await;
    let problems = logs::recent_problems(&st, 15).await;
    let (store_now, store) = (chrono::Utc::now().timestamp(), st.store.clone());
    let (uptime, incidents) = tokio::task::spawn_blocking(move || (store.uptime(store_now).unwrap_or(Value::Null), store.incidents(5).unwrap_or(Value::Null))).await.unwrap_or((Value::Null, Value::Null));
    let critical = attention.iter().filter(|a| a["level"] == "critical").count();
    let unconfirmed = live.is_null() || checks.is_empty() || checks.iter().any(|c| c.status == "waiting");
    let verdict = verdict(critical, attention.len(), unconfirmed);
    Json(json!({
        "ts": store_now,
        "verdict": verdict,
        "attention": attention,
        "checks": checks,
        "uptime": uptime,
        "incidents": incidents,
        "problems": problems,
        "host": live["host"],
        "cpu": { "total": live["cpu"]["total"], "load": live["cpu"]["load"] },
        "memory": live["memory"],
        "data_disk": live["data_disk"],
        "net": live["net"],
        "disk_io": live["disk_io"],
        "app": if live["app"].is_null() { Value::Null } else { json!({
            "uptime_s": live["app"]["uptime_s"],
            "gateway": live["app"]["gateway"],
            "voice": live["app"]["voice"],
            "features": live["app"]["features"],
            "rates": live["app"]["rates"],
            "in_flight": live["app"]["http"]["in_flight"],
        }) },
        "app_process": live["app_process"],
    }))
}

#[derive(Deserialize)]
struct SeriesQuery {
    keys: String,
    /// 15m | 1h | 6h | 24h | 7d | 30d
    range: Option<String>,
}

fn range_seconds(range: Option<&str>) -> i64 {
    match range {
        Some("15m") => 900,
        Some("6h") => 6 * 3600,
        Some("24h") => 86400,
        Some("7d") => 7 * 86400,
        Some("30d") => 30 * 86400,
        _ => 3600,
    }
}

async fn series(State(st): State<AppState>, Query(q): Query<SeriesQuery>) -> Result<Json<Value>, StatusCode> {
    let to = chrono::Utc::now().timestamp();
    let from = to - range_seconds(q.range.as_deref());
    let keys: Vec<String> = q.keys.split(',').map(str::to_string).collect();
    let store = st.store.clone();
    tokio::task::spawn_blocking(move || {
        let refs: Vec<&str> = keys.iter().map(String::as_str).collect();
        store.series(&refs, from, to, 180)
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .map(|mut v| {
        v["from"] = json!(from);
        v["to"] = json!(to);
        Json(v)
    })
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn system(State(st): State<AppState>) -> Json<Value> {
    Json(st.live.read().unwrap().clone())
}

async fn availability(State(st): State<AppState>) -> Json<Value> {
    let checks = st.checks.read().unwrap().clone();
    let ids: Vec<&'static str> = checks.iter().map(|c| c.id).collect();
    let (to, store) = (chrono::Utc::now().timestamp(), st.store.clone());
    let (uptime, incidents, history) = tokio::task::spawn_blocking(move || {
        let history: serde_json::Map<String, Value> = ids.iter().filter_map(|id| Some((id.to_string(), store.check_history(id, to - 90 * 86400, to, 90).ok()?))).collect();
        let day: serde_json::Map<String, Value> = ids.iter().filter_map(|id| Some((id.to_string(), store.check_history(id, to - 86400, to, 96).ok()?))).collect();
        (store.uptime(to).unwrap_or(Value::Null), store.incidents(50).unwrap_or(Value::Null), json!({ "days": history, "today": day }))
    })
    .await
    .unwrap_or((Value::Null, Value::Null, Value::Null));
    Json(json!({ "ts": to, "checks": checks, "uptime": uptime, "incidents": incidents, "history": history }))
}

async fn network(State(st): State<AppState>) -> Json<Value> {
    let (interfaces, net) = {
        let live = st.live.read().unwrap();
        (live["interfaces"].clone(), live["net"].clone())
    };
    let store = st.store.clone();
    let speedtests = tokio::task::spawn_blocking(move || store.speedtests(10).unwrap_or(Value::Null)).await.unwrap_or(Value::Null);
    let checks: Vec<_> = st.checks.read().unwrap().iter().filter(|c| c.group != "app").cloned().collect();
    Json(json!({
        "interfaces": interfaces,
        "net": net,
        "checks": checks,
        "trace": *st.trace.read().unwrap(),
        "certs": *st.certs.read().unwrap(),
        "speedtests": speedtests,
        "probing": st.cfg.probe_internet,
    }))
}

async fn storage_tab(State(st): State<AppState>) -> Json<Value> {
    Json(storage::overview(&st).await)
}

async fn database(State(st): State<AppState>) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    match pg::overview(&st).await {
        Ok(v) => Ok(Json(v)),
        Err(e) => Err((StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "error": e.to_string() })))),
    }
}

#[cfg(test)]
mod tests {
    use super::verdict;

    #[test]
    fn ok_is_only_said_once_everything_confirmed_it() {
        assert_eq!(verdict(0, 0, true), "starting");
        assert_eq!(verdict(0, 0, false), "ok");
        assert_eq!(verdict(0, 2, true), "warning");
        assert_eq!(verdict(1, 2, true), "critical");
    }
}
