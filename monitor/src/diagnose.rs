//! "Is everything actually right?": one button that verifies everything it can, each result with what to do about it,
//! plus small tools for chasing a problem. Nothing here changes anything, and nothing runs a shell.

use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::process::Command;

use crate::checks;
use crate::state::AppState;

struct Report(Vec<Value>);

impl Report {
    fn add(&mut self, group: &str, name: &str, status: &str, detail: impl Into<String>, fix: &str) {
        self.0.push(json!({ "group": group, "name": name, "status": status, "detail": detail.into(), "fix": fix }));
    }
    fn pass(&mut self, group: &str, name: &str, detail: impl Into<String>) {
        self.add(group, name, "pass", detail, "");
    }
    fn warn(&mut self, group: &str, name: &str, detail: impl Into<String>, fix: &str) {
        self.add(group, name, "warn", detail, fix);
    }
    fn fail(&mut self, group: &str, name: &str, detail: impl Into<String>, fix: &str) {
        self.add(group, name, "fail", detail, fix);
    }
    fn info(&mut self, group: &str, name: &str, detail: impl Into<String>) {
        self.add(group, name, "info", detail, "");
    }
}

/// Runs a program with a time limit and returns its first line of output.
async fn first_line(program: &str, args: &[&str]) -> Option<String> {
    let out = tokio::time::timeout(Duration::from_secs(8), Command::new(program).args(args).kill_on_drop(true).output()).await.ok()?.ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout).lines().next().map(|l| l.trim().to_string())
}

fn gb(bytes: f64) -> String {
    format!("{:.1} GB", bytes / 1024.0 / 1024.0 / 1024.0)
}

fn config_checks(st: &AppState, r: &mut Report, live: &Value) {
    const G: &str = "Configuration";
    let app = &live["app"];
    if app.is_null() {
        r.warn(G, "App settings", "Can't read them: the app isn't answering on its internal address.", "Start the server, or check POTTIRA_INTERNAL_BIND and that both services use the same data directory.");
        return;
    }
    let cfg = &app["config"];
    let is_public = !st.cfg.public_url.contains("localhost") && !st.cfg.public_url.contains("127.0.0.1");
    if cfg["dev_login"] == true {
        if is_public {
            r.fail(G, "Dev login", "POTTIRA_DEV_LOGIN is on while the app is public: anyone can sign in as anyone.", "Set POTTIRA_DEV_LOGIN=false in server/.env and restart the server right away.");
        } else {
            r.info(G, "Dev login", "On, which is fine for a local server.");
        }
    } else {
        r.pass(G, "Dev login", "Off.");
    }
    if cfg["discord_login"] == true {
        r.pass(G, "Discord login", "Configured.");
    } else if is_public {
        r.fail(G, "Discord login", "No Discord client id or secret, so nobody can sign in.", "Set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET in server/.env.");
    } else {
        r.info(G, "Discord login", "Not configured.");
    }
    if cfg["admins"].as_u64().unwrap_or(0) == 0 {
        r.warn(G, "Admins", "POTTIRA_ADMINS is empty, so nobody can change Kass's picture.", "Add your Discord username to POTTIRA_ADMINS in server/.env.");
    } else {
        r.pass(G, "Admins", format!("{} configured.", cfg["admins"]));
    }
    r.info(G, "Spotify connection", if cfg["spotify"] == true { "Configured." } else { "Not configured (the option is hidden, Kass still plays Spotify links)." });
    r.info(G, "Direct access", if cfg["direct"] == true { "On." } else { "Off." });
}

fn app_checks(st: &AppState, r: &mut Report, live: &Value) {
    const G: &str = "App";
    for c in st.checks.read().unwrap().iter().filter(|c| c.group == "app") {
        match c.status {
            "up" => r.pass(G, c.name, format!("{} ({:.0} ms).", c.detail, c.ms.unwrap_or(0.0))),
            "slow" => r.warn(G, c.name, format!("Answering, but slowly ({:.0} ms).", c.ms.unwrap_or(0.0)), "Look at CPU, disk and database load in Performance."),
            "down" => r.fail(G, c.name, c.detail.clone(), "See Logs for why, and check the service is running."),
            _ => r.info(G, c.name, "Not tried yet."),
        }
    }
    let app = &live["app"];
    if !app.is_null() {
        let up = app["uptime_s"].as_u64().unwrap_or(0);
        if up < 300 {
            r.warn(G, "Uptime", format!("Restarted {up} s ago."), "If you didn't deploy just now, look in Logs for a crash.");
        } else {
            r.pass(G, "Uptime", format!("Running for {:.1} hours.", up as f64 / 3600.0));
        }
        let (size, idle, max) = (app["db_pool"]["size"].as_f64().unwrap_or(0.0), app["db_pool"]["idle"].as_f64().unwrap_or(0.0), app["db_pool"]["max"].as_f64().unwrap_or(1.0));
        if (size - idle) / max > 0.8 {
            r.warn(G, "Database connections", format!("{} of {max} in use.", size - idle), "Requests may be queueing. Look for slow queries in Database.");
        } else {
            r.pass(G, "Database connections", format!("{} of {max} in use.", size - idle));
        }
        let lag = app["runtime"]["lag_ms"].as_f64().unwrap_or(0.0);
        if lag > 100.0 {
            r.warn(G, "Runtime", format!("Timers are running {lag:.0} ms late."), "The server is overloaded or something is blocking it: voice suffers first.");
        } else {
            r.pass(G, "Runtime", format!("Timers on time ({lag:.1} ms late), {} tasks.", app["runtime"]["tasks"]));
        }
    }
}

async fn database_checks(st: &AppState, r: &mut Report, live: &Value) {
    const G: &str = "Database";
    let overview = match crate::pg::overview(st).await {
        Ok(v) => v,
        Err(e) => {
            r.fail(G, "Connection", e.to_string(), "Is the Postgres container running? docker ps; docker compose -f deploy/docker-compose.yml up -d");
            return;
        }
    };
    r.pass(G, "Connection", overview["version"].as_str().unwrap_or("").split(" on ").next().unwrap_or("").to_string());
    match overview["migrations"].as_object() {
        Some(m) => {
            let failed = m["failed"].as_i64().unwrap_or(0);
            let applied = m["applied"].as_i64().unwrap_or(0);
            // The server says how many it has; older servers: the files next to its data folder.
            let files = match live["app"]["migrations_in_code"].as_i64() {
                Some(n) => Some(n),
                None => migration_files(st).await,
            };
            if failed > 0 {
                r.fail(G, "Migrations", format!("{failed} failed."), "See the server's log at startup; never edit an applied migration.");
            } else if files.is_some_and(|n| n > applied) {
                r.warn(G, "Migrations", format!("{applied} applied, {} in the code.", files.unwrap_or(0)), "Restart the server so it applies the new ones.");
            } else {
                r.pass(G, "Migrations", format!("{applied} applied, latest: {}.", m["latest_name"].as_str().unwrap_or("none")));
            }
        }
        None => r.warn(G, "Migrations", "No migrations table.", "The server hasn't started against this database yet."),
    }
    let (used, max) = (overview["backends"].as_f64().unwrap_or(0.0), overview["max_connections"].as_f64().unwrap_or(100.0));
    if used / max > 0.8 {
        r.warn(G, "Connections", format!("{used} of {max}."), "Close to the limit: new connections will be refused.");
    } else {
        r.pass(G, "Connections", format!("{used} of {max}."));
    }
    match overview["cache_hit"].as_f64() {
        Some(hit) if hit < 90.0 => r.warn(G, "Cache", format!("{hit:.1}% of reads from memory."), "Reads are going to disk a lot: the machine may be short on memory."),
        Some(hit) => r.pass(G, "Cache", format!("{hit:.1}% of reads from memory.")),
        None => r.info(G, "Cache", "No reads yet."),
    }
    if overview["deadlocks"].as_i64().unwrap_or(0) > 0 {
        r.warn(G, "Deadlocks", format!("{} since the statistics were reset.", overview["deadlocks"]), "Search the logs around when they happened.");
    } else {
        r.pass(G, "Deadlocks", "None.");
    }
    if overview["waiting_locks"].as_i64().unwrap_or(0) > 0 {
        r.warn(G, "Locks", format!("{} queries waiting for a lock right now.", overview["waiting_locks"]), "See Database -> Running now.");
    } else {
        r.pass(G, "Locks", "Nothing waiting.");
    }
    let bloated: Vec<String> = overview["tables"]
        .as_array()
        .map(|t| {
            t.iter()
                .filter(|x| x["dead"].as_f64().unwrap_or(0.0) > 10_000.0 && x["dead"].as_f64().unwrap_or(0.0) > x["rows"].as_f64().unwrap_or(0.0) * 0.5)
                .filter_map(|x| x["name"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if bloated.is_empty() {
        r.pass(G, "Dead rows", "Autovacuum is keeping up.");
    } else {
        r.warn(G, "Dead rows", format!("Many in: {}.", bloated.join(", ")), "Autovacuum isn't keeping up with these tables.");
    }
    r.warn(G, "Backups", "No automatic backups: if this disk dies, the messages are gone.", "Set up nightly pg_dump to another machine (you deferred this earlier).");
}

async fn migration_files(st: &AppState) -> Option<i64> {
    // server/data/.. is the server's folder when the default layout is in use.
    let dir = st.cfg.app_data.parent()?.join("migrations");
    let mut rd = tokio::fs::read_dir(dir).await.ok()?;
    let mut n = 0;
    while let Ok(Some(e)) = rd.next_entry().await {
        if e.file_name().to_string_lossy().ends_with(".sql") {
            n += 1;
        }
    }
    Some(n)
}

async fn storage_checks(st: &AppState, r: &mut Report, live: &Value) {
    const G: &str = "Storage";
    for d in live["disks"].as_array().into_iter().flatten() {
        let (total, free) = (d["total"].as_f64().unwrap_or(1.0), d["free"].as_f64().unwrap_or(0.0));
        let used = (1.0 - free / total) * 100.0;
        let name = format!("Disk {}", d["mount"].as_str().unwrap_or(""));
        let detail = format!("{used:.0}% used, {} free.", gb(free));
        if used >= 95.0 {
            r.fail(G, &name, detail, "Free space now: at 100% uploads and the database start failing. See Storage for what's taking it.");
        } else if used >= 85.0 {
            r.warn(G, &name, detail, "Getting full. See Storage for what's growing.");
        } else {
            r.pass(G, &name, detail);
        }
    }
    let uploads = st.cfg.uploads_dir();
    if tokio::fs::metadata(&uploads).await.is_ok() {
        r.pass(G, "Uploads folder", "Readable.");
    } else {
        r.fail(G, "Uploads folder", format!("Not found at {}.", uploads.display()), "Check POTTIRA_DATA_DIR in server/.env and POTTIRA_MONITOR_SERVER_DIR in monitor/.env.");
    }
    let today = chrono::Utc::now().format("%Y-%m-%d");
    if tokio::fs::metadata(st.cfg.logs_dir().join(format!("{today}.jsonl"))).await.is_ok() {
        r.pass(G, "Log file", "Today's log is being written.");
    } else {
        r.warn(G, "Log file", "Nothing logged yet today.", "Fine shortly after midnight UTC or on a quiet day; otherwise check the data directory.");
    }
}

async fn tool_checks(st: &AppState, r: &mut Report, live: &Value) {
    const G: &str = "Tools";
    // What the server can run, as it reports it (it lives in its own container); servers before that: checked here.
    let reported = live["app"]["tools"].as_object().cloned();
    let (ffmpeg, ytdlp) = match &reported {
        Some(t) => (t.get("ffmpeg").and_then(Value::as_str).map(str::to_string), t.get("yt_dlp").and_then(Value::as_str).map(str::to_string)),
        None => {
            let ff = first_line("ffmpeg", &["-hide_banner", "-version"]).await.map(|v| v.split(" Copyright").next().unwrap_or(&v).to_string());
            let bundled = st.cfg.app_data.join("bin").join(if cfg!(windows) { "yt-dlp.exe" } else { "yt-dlp" });
            let program = if tokio::fs::metadata(&bundled).await.is_ok() { bundled.to_string_lossy().to_string() } else { "yt-dlp".to_string() };
            (ff, first_line(&program, &["--version"]).await)
        }
    };
    match ffmpeg {
        Some(v) => r.pass(G, "ffmpeg", v),
        None => r.fail(G, "ffmpeg", "The server can't run it.", "Voice messages, sound clips and GIF pictures need it: it's in the server image (deploy/server.Dockerfile)."),
    }
    match ytdlp {
        Some(v) => r.pass(G, "yt-dlp", format!("Version {v}.")),
        None => r.warn(G, "yt-dlp", "The server can't run it.", "Kass can't play anything without it: put it in server/data/bin."),
    }
    if let Some(t) = &reported {
        match t.get("node").and_then(Value::as_str) {
            Some(v) => r.pass(G, "Node", format!("{v} (yt-dlp's JavaScript runtime).")),
            None => r.warn(G, "Node", "The server can't run it.", "yt-dlp needs it for YouTube (POTTIRA_YTDLP_ARGS=--js-runtimes node)."),
        }
    }
    match tokio::fs::metadata(st.cfg.app_data.join("detectable.json")).await.and_then(|m| m.modified()) {
        Ok(at) => {
            let days = at.elapsed().unwrap_or_default().as_secs() / 86400;
            if days > 3 {
                r.warn(G, "Detectable games list", format!("Last fetched {days} days ago."), "It should refresh daily: check that Discord is reachable.");
            } else {
                r.pass(G, "Detectable games list", "Fresh.");
            }
        }
        Err(_) => r.info(G, "Detectable games list", "Not fetched yet."),
    }
    let updates = st.cfg.app_data.join("updates");
    match tokio::fs::read(updates.join("latest.json")).await.ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) {
        Some(latest) => {
            let version = latest["version"].as_str().unwrap_or("?").to_string();
            let mut missing = vec![];
            for p in latest["platforms"].as_object().into_iter().flat_map(|o| o.values()) {
                if let Some(file) = p["file"].as_str() {
                    if tokio::fs::metadata(updates.join(file)).await.is_err() {
                        missing.push(file.to_string());
                    }
                }
            }
            if missing.is_empty() {
                r.pass(G, "Desktop updates", format!("Latest is {version}, published {}.", latest["pub_date"].as_str().unwrap_or("?")));
            } else {
                r.fail(G, "Desktop updates", format!("{version} lists a file that isn't there: {}.", missing.join(", ")), "Apps can't update: publish again with app/publish-windows.sh.");
            }
        }
        None => r.info(G, "Desktop updates", "Nothing published on this server."),
    }
}

fn network_checks(st: &AppState, r: &mut Report) {
    const G: &str = "Network";
    for c in st.checks.read().unwrap().iter().filter(|c| c.group != "app") {
        match c.status {
            "up" => r.pass(G, c.name, format!("{} ({:.0} ms).", c.detail, c.ms.unwrap_or(0.0))),
            "slow" => r.warn(G, c.name, format!("Slow: {:.0} ms.", c.ms.unwrap_or(0.0)), "Run a speed test in Network."),
            "down" if c.id == "direct" => r.warn(G, c.name, c.detail.clone(), "From inside the house this can fail when the router doesn't do NAT hairpin. Try it from a phone on mobile data before worrying."),
            "down" => r.fail(G, c.name, c.detail.clone(), "See Network for what still answers."),
            _ => r.info(G, c.name, "Not tried yet."),
        }
    }
    for cert in st.certs.read().unwrap().as_array().into_iter().flatten() {
        let name = format!("Certificate, {}", cert["label"].as_str().unwrap_or(""));
        if let Some(days) = cert["cert"]["days_left"].as_i64() {
            let host = cert["host"].as_str().unwrap_or("");
            if days < 7 {
                r.fail(G, &name, format!("{host}: {days} days left."), "It should have renewed by now: look for ACME errors in Logs.");
            } else if days < 20 {
                r.warn(G, &name, format!("{host}: {days} days left."), "Renewal should already have happened 30 days before expiry: look for ACME errors in Logs.");
            } else {
                r.pass(G, &name, format!("{host}: {days} days left."));
            }
        } else {
            r.warn(G, &name, cert["error"].as_str().unwrap_or("Couldn't read it.").to_string(), "See whether the address answers at all.");
        }
    }
    let trace = st.trace.read().unwrap();
    if let Some(offset) = trace["clock_offset_s"].as_i64() {
        if offset.abs() > 30 {
            r.warn(G, "Clock", format!("{offset} s off from Cloudflare's clock."), "Certificates and session expiry depend on the clock: check time sync on this machine.");
        } else {
            r.pass(G, "Clock", format!("{offset} s off from Cloudflare's clock."));
        }
    }
    if let (Some(ip), Some(ips)) = (trace["ip"].as_str(), trace["direct_ips"].as_array()) {
        if ips.is_empty() {
            r.warn(G, "Direct address DNS", "Doesn't resolve.", "Check the DNS-only record of the direct address.");
        } else if ips.iter().any(|x| x.as_str() == Some(ip)) {
            r.pass(G, "Direct address DNS", "Points at this machine's public IP.");
        } else {
            r.warn(G, "Direct address DNS", format!("Points at {}, but this machine goes out through {ip}.", ips.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(", ")), "If the IP changed, update the DNS record.");
        }
    }
}

fn system_checks(r: &mut Report, live: &Value) {
    const G: &str = "System";
    let (total, available) = (live["memory"]["total"].as_f64().unwrap_or(1.0), live["memory"]["available"].as_f64().unwrap_or(0.0));
    let used = (1.0 - available / total) * 100.0;
    if used > 92.0 {
        r.warn(G, "Memory", format!("{used:.0}% used, {} available.", gb(available)), "See Performance for what's using it. Running out kills processes.");
    } else {
        r.pass(G, "Memory", format!("{used:.0}% used, {} available.", gb(available)));
    }
    let cpu = live["cpu"]["total"].as_f64().unwrap_or(0.0);
    if cpu > 90.0 {
        r.warn(G, "CPU", format!("{cpu:.0}% busy."), "See Performance for what's using it. Voice starts cutting out when this stays high.");
    } else {
        r.pass(G, "CPU", format!("{cpu:.0}% busy."));
    }
    let swap = live["memory"]["swap_used"].as_f64().unwrap_or(0.0);
    if swap > 1024.0 * 1024.0 * 1024.0 {
        r.warn(G, "Swap", format!("{} in use.", gb(swap)), "The machine has been short on memory recently.");
    } else {
        r.pass(G, "Swap", format!("{} in use.", gb(swap)));
    }
    r.info(G, "Machine", format!("{}, up {:.1} days.", live["host"]["os"].as_str().unwrap_or("?"), live["host"]["uptime"].as_f64().unwrap_or(0.0) / 86400.0));
}

/// The server process (in Docker: slot a or b of deploy/docker-compose.yml) and Postgres.
async fn service_checks(r: &mut Report, live: &Value) {
    const G: &str = "Services";
    let app = &live["app"];
    if app.is_null() {
        r.fail(G, "Server", "Not answering on its internal address.", "docker ps -a; docker logs --tail 50 pottira-server-<slot> (server/data/run/live says which slot serves)");
    } else {
        let slot = app["slot"].as_str().filter(|s| !s.is_empty()).map(|s| format!("slot {s}, ")).unwrap_or_default();
        let version = app["version"].as_str().map(|v| format!("version {v}, ")).unwrap_or_default();
        let hours = app["uptime_s"].as_f64().unwrap_or(0.0) / 3600.0;
        r.pass(G, "Server", format!("Running ({slot}{version}up {hours:.1} h)."));
    }
    // Only where the docker CLI is around (not inside the monitor's own container, which has no access to Docker).
    if let Some(state) = first_line("docker", &["inspect", "--format", "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}} restarts={{.RestartCount}}", "pottira-postgres-1"]).await {
        if state.starts_with("running") && !state.contains("unhealthy") {
            r.pass(G, "Postgres container", state);
        } else {
            r.fail(G, "Postgres container", state, "docker logs pottira-postgres-1");
        }
    }
}

pub async fn run(State(st): State<AppState>) -> Json<Value> {
    let started = Instant::now();
    let live = st.live.read().unwrap().clone();
    let mut r = Report(vec![]);
    config_checks(&st, &mut r, &live);
    app_checks(&st, &mut r, &live);
    database_checks(&st, &mut r, &live).await;
    storage_checks(&st, &mut r, &live).await;
    tool_checks(&st, &mut r, &live).await;
    network_checks(&st, &mut r);
    system_checks(&mut r, &live);
    service_checks(&mut r, &live).await;
    Json(json!({ "ran_at": chrono::Utc::now().timestamp(), "took_ms": started.elapsed().as_millis() as u64, "results": r.0 }))
}

// ---------- tools ----------

type ToolResult = Result<Json<Value>, (StatusCode, Json<Value>)>;

fn bad(msg: &str) -> (StatusCode, Json<Value>) {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": msg })))
}

#[derive(Deserialize)]
pub struct Target {
    host: Option<String>,
    port: Option<u16>,
    url: Option<String>,
}

pub async fn tool_dns(Json(t): Json<Target>) -> ToolResult {
    let host = t.host.filter(|h| !h.trim().is_empty()).ok_or_else(|| bad("Enter a host name."))?;
    let start = Instant::now();
    match tokio::time::timeout(Duration::from_secs(8), tokio::net::lookup_host(format!("{}:443", host.trim()))).await {
        Ok(Ok(addrs)) => {
            let mut ips: Vec<String> = addrs.map(|a| a.ip().to_string()).collect();
            ips.dedup();
            Ok(Json(json!({ "ok": true, "ms": start.elapsed().as_millis() as u64, "addresses": ips })))
        }
        Ok(Err(e)) => Ok(Json(json!({ "ok": false, "ms": start.elapsed().as_millis() as u64, "error": e.to_string() }))),
        Err(_) => Ok(Json(json!({ "ok": false, "error": "No answer in 8 s." }))),
    }
}

pub async fn tool_tcp(Json(t): Json<Target>) -> ToolResult {
    let host = t.host.filter(|h| !h.trim().is_empty()).ok_or_else(|| bad("Enter a host name."))?;
    let port = t.port.ok_or_else(|| bad("Enter a port."))?;
    let mut times = vec![];
    let mut errors = vec![];
    for _ in 0..4 {
        match checks::tcp_ping(&format!("{}:{port}", host.trim())).await {
            Ok(ms) => times.push(ms),
            Err(e) => errors.push(e),
        }
    }
    let best = times.iter().copied().fold(f64::MAX, f64::min);
    let worst = times.iter().copied().fold(0.0, f64::max);
    Ok(Json(json!({
        "ok": !times.is_empty(),
        "tries": 4,
        "answered": times.len(),
        "best_ms": if times.is_empty() { Value::Null } else { json!(best) },
        "worst_ms": if times.is_empty() { Value::Null } else { json!(worst) },
        "error": errors.first(),
    })))
}

pub async fn tool_http(State(st): State<AppState>, Json(t): Json<Target>) -> ToolResult {
    let url = t.url.filter(|u| u.starts_with("http://") || u.starts_with("https://")).ok_or_else(|| bad("Enter a full http(s) address."))?;
    let start = Instant::now();
    match st.http.get(&url).send().await {
        Ok(res) => {
            let wanted = ["server", "content-type", "content-length", "cf-ray", "cache-control", "location"];
            let headers: serde_json::Map<String, Value> = res.headers().iter().filter(|(k, _)| wanted.contains(&k.as_str())).map(|(k, v)| (k.to_string(), json!(v.to_str().unwrap_or("")))).collect();
            Ok(Json(json!({ "ok": res.status().is_success(), "status": res.status().as_u16(), "ms": start.elapsed().as_millis() as u64, "version": format!("{:?}", res.version()), "headers": headers })))
        }
        Err(e) => {
            let mut text = e.to_string();
            let mut src = std::error::Error::source(&e);
            while let Some(s) = src {
                text = format!("{text}: {s}");
                src = s.source();
            }
            Ok(Json(json!({ "ok": false, "ms": start.elapsed().as_millis() as u64, "error": text })))
        }
    }
}

pub async fn tool_tls(Json(t): Json<Target>) -> ToolResult {
    let host = t.host.filter(|h| !h.trim().is_empty()).ok_or_else(|| bad("Enter a host name."))?;
    match checks::tls_info(host.trim(), t.port.unwrap_or(443)).await {
        Ok(info) => Ok(Json(json!({ "ok": true, "cert": info }))),
        Err(e) => Ok(Json(json!({ "ok": false, "error": e }))),
    }
}

/// On demand only: it uses the connection the voice calls are on. Downloads about 25 MB and uploads about 10 MB.
pub async fn speedtest(State(st): State<AppState>) -> ToolResult {
    if !st.cfg.probe_internet {
        return Err(bad("Internet checks are turned off here."));
    }
    let Ok(_running) = st.speedtest.try_lock() else {
        return Err(bad("A speed test is already running."));
    };
    let client = reqwest::Client::builder().user_agent("pottira-monitor").timeout(Duration::from_secs(40)).build().map_err(|_| bad("Couldn't start."))?;

    let mut latency = None;
    if let Ok(ms) = checks::tcp_ping("speed.cloudflare.com:443").await {
        latency = Some(ms);
    }
    let mut colo = None;
    let start = Instant::now();
    let mut down = None;
    if let Ok(res) = client.get("https://speed.cloudflare.com/__down?bytes=25000000").send().await {
        colo = res.headers().get("cf-ray").and_then(|v| v.to_str().ok()).and_then(|r| r.rsplit('-').next()).map(str::to_string);
        if let Ok(bytes) = res.bytes().await {
            down = Some(bytes.len() as f64 * 8.0 / 1_000_000.0 / start.elapsed().as_secs_f64());
        }
    }
    let payload = vec![0u8; 10_000_000];
    let size = payload.len() as f64;
    let start = Instant::now();
    let up = match client.post("https://speed.cloudflare.com/__up").body(payload).send().await {
        Ok(r) if r.status().is_success() => Some(size * 8.0 / 1_000_000.0 / start.elapsed().as_secs_f64()),
        _ => None,
    };
    let now = chrono::Utc::now().timestamp();
    let store = st.store.clone();
    let c = colo.clone();
    let _ = tokio::task::spawn_blocking(move || store.add_speedtest(now, down, up, latency, c.as_deref())).await;
    Ok(Json(json!({ "ts": now, "down": down, "up": up, "latency": latency, "colo": colo })))
}
