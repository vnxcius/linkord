//! Availability: every 30 s, each part of the path from a friend's app to the data is tried for real. Two failures in
//! a row open an incident, the first success closes it. Also the TLS certificates and the public IP.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::state::AppState;

const EVERY: Duration = Duration::from_secs(30);
const TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Serialize)]
pub struct CheckState {
    pub id: &'static str,
    pub name: &'static str,
    /// app | access | internet
    pub group: &'static str,
    pub what: String,
    /// up | slow | down | waiting
    pub status: &'static str,
    pub ms: Option<f64>,
    pub detail: String,
    /// Unix time the check entered this status.
    pub since: i64,
    pub last_run: i64,
    /// Failures in a row.
    pub fails: u32,
    /// Internet only: share of the test connections that failed, 0-100.
    pub loss: Option<f64>,
}

struct Outcome {
    ok: bool,
    ms: f64,
    detail: String,
    loss: Option<f64>,
}

fn ok(ms: f64, detail: impl Into<String>) -> Outcome {
    Outcome { ok: true, ms, detail: detail.into(), loss: None }
}

fn failed(ms: f64, detail: impl Into<String>) -> Outcome {
    Outcome { ok: false, ms, detail: detail.into(), loss: None }
}

/// reqwest's error text hides the cause in its source chain.
fn cause(e: &dyn std::error::Error) -> String {
    let mut text = e.to_string();
    let mut src = e.source();
    while let Some(s) = src {
        let t = s.to_string();
        if !text.contains(&t) {
            text = format!("{text}: {t}");
        }
        src = s.source();
    }
    text
}

async fn http_check(st: &AppState, url: &str, want_html: bool) -> Outcome {
    let start = Instant::now();
    match st.http.get(url).timeout(TIMEOUT).send().await {
        Ok(res) => {
            let ms = start.elapsed().as_secs_f64() * 1000.0;
            let status = res.status();
            let html = res.headers().get("content-type").and_then(|v| v.to_str().ok()).is_some_and(|c| c.starts_with("text/html"));
            if !status.is_success() && !status.is_redirection() {
                failed(ms, format!("answered {status}"))
            } else if want_html && !html {
                failed(ms, "answered, but not with the web client's page")
            } else {
                ok(ms, format!("answered {}", status.as_u16()))
            }
        }
        Err(e) => failed(start.elapsed().as_secs_f64() * 1000.0, cause(&e)),
    }
}

/// A real websocket handshake with the gateway; the socket is dropped right after.
async fn gateway_check(st: &AppState) -> Outcome {
    let start = Instant::now();
    let addr = st.cfg.app_url.trim_start_matches("http://").to_string();
    let attempt = async {
        let mut s = TcpStream::connect(&addr).await?;
        let req = format!("GET /api/gateway HTTP/1.1\r\nHost: {addr}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: bGlua29yZC1tb25pdG9yIQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
        s.write_all(req.as_bytes()).await?;
        let mut buf = [0u8; 64];
        let n = s.read(&mut buf).await?;
        Ok::<String, std::io::Error>(String::from_utf8_lossy(&buf[..n]).to_string())
    };
    let ms = || start.elapsed().as_secs_f64() * 1000.0;
    match tokio::time::timeout(TIMEOUT, attempt).await {
        Ok(Ok(head)) if head.starts_with("HTTP/1.1 101") => ok(ms(), "accepted a websocket"),
        Ok(Ok(head)) => failed(ms(), format!("refused the websocket: {}", head.lines().next().unwrap_or(""))),
        Ok(Err(e)) => failed(ms(), e.to_string()),
        Err(_) => failed(ms(), "no answer in 10 s"),
    }
}

async fn database_check(st: &AppState) -> Outcome {
    let start = Instant::now();
    match tokio::time::timeout(TIMEOUT, sqlx::query_scalar::<_, i32>("SELECT 1").fetch_one(&st.db)).await {
        Ok(Ok(_)) => ok(start.elapsed().as_secs_f64() * 1000.0, "answered a query"),
        Ok(Err(e)) => failed(start.elapsed().as_secs_f64() * 1000.0, e.to_string()),
        Err(_) => failed(10_000.0, "no answer in 10 s"),
    }
}

async fn counters_check(st: &AppState) -> Outcome {
    let start = Instant::now();
    let Some(url) = &st.cfg.internal_url else { return failed(0.0, "POTTIRA_INTERNAL_BIND is off") };
    let Ok(token) = tokio::fs::read_to_string(st.cfg.app_data.join("internal-token")).await else {
        return failed(0.0, "can't read data/internal-token: is the app's data directory right?");
    };
    match st.http.get(format!("{url}/metrics")).bearer_auth(token.trim()).timeout(TIMEOUT).send().await {
        Ok(r) if r.status().is_success() => ok(start.elapsed().as_secs_f64() * 1000.0, "answering"),
        Ok(r) => failed(start.elapsed().as_secs_f64() * 1000.0, format!("answered {}", r.status())),
        Err(e) => failed(start.elapsed().as_secs_f64() * 1000.0, cause(&e)),
    }
}

/// Connects to well-known addresses: no raw ping without root, but a TCP handshake measures the same round trip.
pub async fn tcp_ping(addr: &str) -> Result<f64, String> {
    let start = Instant::now();
    match tokio::time::timeout(Duration::from_secs(4), TcpStream::connect(addr)).await {
        Ok(Ok(_)) => Ok(start.elapsed().as_secs_f64() * 1000.0),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err("timed out".into()),
    }
}

async fn internet_check() -> Outcome {
    let targets = ["1.1.1.1:443", "8.8.8.8:443", "9.9.9.9:443", "1.0.0.1:443"];
    let results = futures_util::future::join_all(targets.iter().map(|t| tcp_ping(t))).await;
    let times: Vec<f64> = results.iter().filter_map(|r| r.as_ref().ok().copied()).collect();
    let loss = (targets.len() - times.len()) as f64 * 100.0 / targets.len() as f64;
    if times.is_empty() {
        return Outcome { ok: false, ms: 4000.0, detail: "no well-known address answers".into(), loss: Some(100.0) };
    }
    let best = times.iter().copied().fold(f64::MAX, f64::min);
    let answered = times.len();
    Outcome { ok: true, ms: best, detail: format!("{answered} of {} addresses answered", targets.len()), loss: Some(loss) }
}

async fn dns_check() -> Outcome {
    let start = Instant::now();
    match tokio::time::timeout(TIMEOUT, tokio::net::lookup_host("discord.com:443")).await {
        Ok(Ok(mut addrs)) => {
            let ms = start.elapsed().as_secs_f64() * 1000.0;
            match addrs.next() {
                Some(a) => ok(ms, format!("discord.com is {}", a.ip())),
                None => failed(ms, "no addresses for discord.com"),
            }
        }
        Ok(Err(e)) => failed(start.elapsed().as_secs_f64() * 1000.0, e.to_string()),
        Err(_) => failed(10_000.0, "no answer in 10 s"),
    }
}

fn is_local(url: &str) -> bool {
    url.contains("localhost") || url.contains("127.0.0.1")
}

struct Def {
    id: &'static str,
    name: &'static str,
    group: &'static str,
    what: String,
    /// Slower than this counts as slow, not down.
    slow_ms: f64,
}

fn definitions(st: &AppState) -> Vec<Def> {
    let c = &st.cfg;
    let mut out = vec![
        Def { id: "app", name: "App server", group: "app", what: format!("{}/api/health", c.app_url), slow_ms: 500.0 },
        Def { id: "web", name: "Web client", group: "app", what: format!("{}/", c.app_url), slow_ms: 1000.0 },
        Def { id: "gateway", name: "Gateway", group: "app", what: "websocket handshake".into(), slow_ms: 500.0 },
        Def { id: "database", name: "Database", group: "app", what: "SELECT 1".into(), slow_ms: 200.0 },
        Def { id: "counters", name: "Live numbers", group: "app", what: "the app's internal address".into(), slow_ms: 500.0 },
    ];
    if !is_local(&c.public_url) {
        out.push(Def { id: "public", name: "Public address", group: "access", what: c.public_url.clone(), slow_ms: 2000.0 });
    }
    if let Some(direct) = &c.direct_url {
        out.push(Def { id: "direct", name: "Direct address", group: "access", what: direct.clone(), slow_ms: 2000.0 });
    }
    if c.probe_internet {
        out.push(Def { id: "internet", name: "Internet", group: "internet", what: "1.1.1.1, 8.8.8.8, 9.9.9.9".into(), slow_ms: 300.0 });
        out.push(Def { id: "dns", name: "DNS", group: "internet", what: "resolving discord.com".into(), slow_ms: 500.0 });
        out.push(Def { id: "discord", name: "Discord", group: "internet", what: "login and game list".into(), slow_ms: 2000.0 });
        out.push(Def { id: "youtube", name: "YouTube", group: "internet", what: "Kass's songs".into(), slow_ms: 2000.0 });
        out.push(Def { id: "spotify", name: "Spotify", group: "internet", what: "Kass's Spotify links".into(), slow_ms: 3000.0 });
    }
    out
}

async fn run_check(st: &AppState, id: &str) -> Outcome {
    let c = &st.cfg;
    match id {
        "app" => http_check(st, &format!("{}/api/health", c.app_url), false).await,
        "web" => http_check(st, &format!("{}/", c.app_url), true).await,
        "gateway" => gateway_check(st).await,
        "database" => database_check(st).await,
        "counters" => counters_check(st).await,
        "public" => http_check(st, &format!("{}/api/health", c.public_url), false).await,
        "direct" => http_check(st, &format!("{}/api/health", c.direct_url.as_deref().unwrap_or("")), false).await,
        "internet" => internet_check().await,
        "dns" => dns_check().await,
        "discord" => http_check(st, "https://discord.com/api/v10/gateway", false).await,
        "youtube" => http_check(st, "https://www.youtube.com/generate_204", false).await,
        "spotify" => http_check(st, "https://open.spotify.com/robots.txt", false).await,
        _ => failed(0.0, "unknown check"),
    }
}

/// Applies a result: returns the new status and what happened to the incident, if anything.
pub fn next_status(status: &'static str, fails: u32, is_ok: bool, ms: f64, slow_ms: f64) -> (&'static str, u32, Option<bool>) {
    if is_ok {
        let opened_before = status == "down";
        (if ms > slow_ms { "slow" } else { "up" }, 0, opened_before.then_some(false))
    } else {
        let fails = fails + 1;
        // One failure can be a blip: it only counts as down from the second one on.
        if fails >= 2 {
            ("down", fails, (status != "down").then_some(true))
        } else {
            (if status == "waiting" { "waiting" } else { status }, fails, None)
        }
    }
}

pub async fn run(st: AppState) {
    let defs = Arc::new(definitions(&st));
    let now = chrono::Utc::now().timestamp();
    *st.checks.write().unwrap() = defs
        .iter()
        .map(|d| CheckState { id: d.id, name: d.name, group: d.group, what: d.what.clone(), status: "waiting", ms: None, detail: String::new(), since: now, last_run: 0, fails: 0, loss: None })
        .collect();
    let mut tick = tokio::time::interval(EVERY);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        let results = futures_util::future::join_all(defs.iter().map(|d| {
            let st = st.clone();
            async move { run_check(&st, d.id).await }
        }))
        .await;
        let now = chrono::Utc::now().timestamp();
        for (d, r) in defs.iter().zip(results) {
            let (prior_status, prior_fails) = {
                let checks = st.checks.read().unwrap();
                let c = checks.iter().find(|c| c.id == d.id).expect("every definition has a state");
                (c.status, c.fails)
            };
            let (status, fails, incident) = next_status(prior_status, prior_fails, r.ok, r.ms, d.slow_ms);
            let store = st.store.clone();
            let (id, name, ok_now, ms, detail) = (d.id, d.name, r.ok, r.ms, r.detail.clone());
            let _ = tokio::task::spawn_blocking(move || {
                store.add_check(now, id, ok_now, ms);
                match incident {
                    Some(true) => store.open_incident(id, name, now, &detail),
                    Some(false) => store.close_incident(id, now),
                    None => {}
                }
            })
            .await;
            match incident {
                Some(true) => tracing::warn!(check = d.id, "down: {}", r.detail),
                Some(false) => tracing::info!(check = d.id, "back up"),
                None => {}
            }
            let mut checks = st.checks.write().unwrap();
            if let Some(c) = checks.iter_mut().find(|c| c.id == d.id) {
                if c.status != status {
                    c.since = now;
                }
                c.status = status;
                c.fails = fails;
                c.ms = Some(r.ms);
                c.detail = r.detail;
                c.loss = r.loss;
                c.last_run = now;
            }
        }
    }
}

// ---------- TLS ----------

#[derive(Debug)]
struct AnyCert(Arc<rustls::crypto::CryptoProvider>);

/// This only reads what a server presents, so an expired certificate can still be reported as expired. Whether it's
/// trusted is what the regular HTTP checks find out.
impl rustls::client::danger::ServerCertVerifier for AnyCert {
    fn verify_server_cert(
        &self,
        _: &rustls::pki_types::CertificateDer<'_>,
        _: &[rustls::pki_types::CertificateDer<'_>],
        _: &rustls::pki_types::ServerName<'_>,
        _: &[u8],
        _: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        m: &[u8],
        c: &rustls::pki_types::CertificateDer<'_>,
        d: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(m, c, d, &self.0.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        m: &[u8],
        c: &rustls::pki_types::CertificateDer<'_>,
        d: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(m, c, d, &self.0.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

fn describe_cert(der: &[u8]) -> Result<Value, String> {
    let (_, cert) = x509_parser::parse_x509_certificate(der).map_err(|e| e.to_string())?;
    let not_after = cert.validity().not_after.timestamp();
    Ok(json!({
        "subject": cert.subject().to_string(),
        "issuer": cert.issuer().to_string(),
        "not_before": cert.validity().not_before.timestamp(),
        "not_after": not_after,
        "days_left": (not_after - chrono::Utc::now().timestamp()) / 86400,
    }))
}

pub async fn tls_info(host: &str, port: u16) -> Result<Value, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AnyCert(provider)))
        .with_no_client_auth();
    let name = rustls::pki_types::ServerName::try_from(host.to_string()).map_err(|e| e.to_string())?;
    let connect = async {
        let tcp = TcpStream::connect((host, port)).await.map_err(|e| e.to_string())?;
        let tls = tokio_rustls::TlsConnector::from(Arc::new(config)).connect(name, tcp).await.map_err(|e| e.to_string())?;
        let (_, conn) = tls.get_ref();
        let protocol = conn.protocol_version().map(|p| format!("{p:?}"));
        let cert = conn.peer_certificates().and_then(|c| c.first()).ok_or("no certificate presented")?;
        let mut info = describe_cert(cert.as_ref())?;
        info["protocol"] = json!(protocol);
        Ok::<Value, String>(info)
    };
    tokio::time::timeout(TIMEOUT, connect).await.map_err(|_| "no answer in 10 s".to_string())?
}

fn split_https(url: &str) -> Option<(String, u16)> {
    let rest = url.strip_prefix("https://")?;
    let host_port = rest.split('/').next()?;
    match host_port.rsplit_once(':') {
        Some((h, p)) => Some((h.to_string(), p.parse().ok()?)),
        None => Some((host_port.to_string(), 443)),
    }
}

/// The certificate of `<data>/acme`, for when the direct address can't be reached from inside (no NAT hairpin).
async fn cached_acme_cert(st: &AppState, host: &str) -> Option<Value> {
    let pem = tokio::fs::read(st.cfg.app_data.join("acme").join(format!("{host}.crt.pem"))).await.ok()?;
    let (_, block) = x509_parser::pem::parse_x509_pem(&pem).ok()?;
    let mut info = describe_cert(&block.contents).ok()?;
    info["from_file"] = json!(true);
    Some(info)
}

pub async fn keep_certs(st: AppState) {
    let mut tick = tokio::time::interval(Duration::from_secs(3600));
    loop {
        tick.tick().await;
        let mut targets = vec![("Public address", st.cfg.public_url.clone())];
        if let Some(d) = &st.cfg.direct_url {
            targets.push(("Direct address", d.clone()));
        }
        let mut out = vec![];
        for (label, url) in targets {
            let Some((host, port)) = split_https(&url) else { continue };
            let mut entry = json!({ "label": label, "host": host, "port": port });
            match tls_info(&host, port).await {
                Ok(info) => entry["cert"] = info,
                Err(e) => match cached_acme_cert(&st, &host).await {
                    Some(info) => entry["cert"] = info,
                    None => entry["error"] = json!(e),
                },
            }
            out.push(entry);
        }
        *st.certs.write().unwrap() = Value::Array(out);
    }
}

/// The public IP and the Cloudflare location this machine goes through.
pub async fn keep_trace(st: AppState) {
    if !st.cfg.probe_internet {
        return;
    }
    let mut tick = tokio::time::interval(Duration::from_secs(300));
    loop {
        tick.tick().await;
        let mut v = json!({ "checked": chrono::Utc::now().timestamp() });
        match st.http.get("https://1.1.1.1/cdn-cgi/trace").send().await {
            Ok(r) => {
                // The server's clock against Cloudflare's.
                if let Some(date) = r.headers().get("date").and_then(|d| d.to_str().ok()).and_then(|d| chrono::DateTime::parse_from_rfc2822(d).ok()) {
                    v["clock_offset_s"] = json!(chrono::Utc::now().timestamp() - date.timestamp());
                }
                let text = r.text().await.unwrap_or_default();
                for line in text.lines() {
                    if let Some((k, val)) = line.split_once('=') {
                        match k {
                            "ip" => v["ip"] = json!(val),
                            "colo" => v["colo"] = json!(val),
                            "loc" => v["country"] = json!(val),
                            "warp" => v["warp"] = json!(val),
                            _ => {}
                        }
                    }
                }
            }
            Err(e) => v["error"] = json!(cause(&e)),
        }
        // What the direct address points at, to compare with the public IP.
        if let Some((host, port)) = st.cfg.direct_url.as_deref().and_then(split_https) {
            let addrs = tokio::net::lookup_host((host.as_str(), port)).await.map(|a| a.map(|s| s.ip().to_string()).collect::<Vec<_>>()).unwrap_or_default();
            v["direct_host"] = json!(host);
            v["direct_ips"] = json!(addrs);
        }
        *st.trace.write().unwrap() = v;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_failure_is_a_blip_two_are_an_incident() {
        let (s, f, inc) = next_status("up", 0, false, 10.0, 100.0);
        assert_eq!((s, f, inc), ("up", 1, None));
        let (s, f, inc) = next_status(s, f, false, 10.0, 100.0);
        assert_eq!((s, f, inc), ("down", 2, Some(true)));
        let (s, f, inc) = next_status(s, f, false, 10.0, 100.0);
        assert_eq!((s, f, inc), ("down", 3, None), "the incident is already open");
        let (s, f, inc) = next_status(s, f, true, 10.0, 100.0);
        assert_eq!((s, f, inc), ("up", 0, Some(false)));
    }

    #[test]
    fn slow_is_not_down() {
        assert_eq!(next_status("up", 0, true, 500.0, 100.0), ("slow", 0, None));
        assert_eq!(next_status("waiting", 0, true, 5.0, 100.0), ("up", 0, None));
    }

    #[test]
    fn https_urls_split_into_host_and_port() {
        assert_eq!(split_https("https://mc.example.com:8443"), Some(("mc.example.com".into(), 8443)));
        assert_eq!(split_https("https://a.example.com/x"), Some(("a.example.com".into(), 443)));
        assert_eq!(split_https("http://localhost:7700"), None);
    }
}
