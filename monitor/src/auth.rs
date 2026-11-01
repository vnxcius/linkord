//! The dashboard's own login: one password, an HMAC-signed cookie, no database. It keeps working when Discord or the
//! app are down. The signature's key is a random secret kept on disk plus the password, so a stolen cookie doesn't help
//! guess the password, and changing the password or logging out signs everyone out.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::state::AppState;

const COOKIE: &str = "linkord_monitor";
const SESSION_DAYS: i64 = 14;
/// Wrong passwords allowed per minute, in total: there is one account.
const ATTEMPTS: usize = 8;

fn sign(password: &str, expires: i64) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(password.as_bytes()).expect("hmac takes any key");
    mac.update(format!("linkord-monitor:{expires}").as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

pub fn session_value(password: &str, expires: i64) -> String {
    format!("{expires}.{}", sign(password, expires))
}

/// Compares through hashes, so timing says nothing about the secret.
fn same(a: &str, b: &str) -> bool {
    Sha256::digest(a.as_bytes()) == Sha256::digest(b.as_bytes())
}

pub fn valid_session(password: &str, value: &str, now: i64) -> bool {
    let Some((expires, sig)) = value.split_once('.') else { return false };
    let Ok(expires) = expires.parse::<i64>() else { return false };
    expires > now && same(&sign(password, expires), sig)
}

fn session_from(headers: &HeaderMap) -> Option<String> {
    let cookies = headers.get(header::COOKIE)?.to_str().ok()?;
    cookies.split(';').find_map(|c| c.trim().strip_prefix(&format!("{COOKIE}=")).map(str::to_string))
}

fn signing_key(st: &AppState) -> String {
    format!("{}:{}", st.session_secret.read().unwrap(), st.cfg.password)
}

/// The random part of the signing key, created on first use.
pub fn load_secret(dir: &std::path::Path) -> anyhow::Result<String> {
    let path = dir.join("session-secret");
    if let Ok(s) = std::fs::read_to_string(&path) {
        if !s.trim().is_empty() {
            return Ok(s.trim().to_string());
        }
    }
    write_secret(&path)
}

fn write_secret(path: &std::path::Path) -> anyhow::Result<String> {
    use std::io::Write;
    let mut bytes = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut bytes);
    let secret = hex::encode(bytes);
    let _ = std::fs::remove_file(path);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(path)?;
    file.write_all(secret.as_bytes())?;
    Ok(secret)
}

pub fn signed_in(st: &AppState, headers: &HeaderMap) -> bool {
    session_from(headers).is_some_and(|v| valid_session(&signing_key(st), &v, chrono::Utc::now().timestamp()))
}

/// Which addresses this dashboard answers as. A web page can point its own hostname at 127.0.0.1 (DNS rebinding) and
/// so reach a service on loopback, but it can't change the name the browser asks for. IP addresses and localhost are
/// always fine; other names (a tunnel hostname) go in LINKORD_MONITOR_HOSTS.
pub async fn check_host(State(st): State<AppState>, req: Request, next: Next) -> Response {
    let host = req.headers().get(header::HOST).and_then(|v| v.to_str().ok()).map(str::to_owned).or_else(|| req.uri().authority().map(|a| a.to_string())).unwrap_or_default();
    if host_allowed(&host, &st.cfg.allowed_hosts) {
        next.run(req).await
    } else {
        tracing::warn!("refused a request for another host name");
        (StatusCode::MISDIRECTED_REQUEST, "Unknown host. Add it to LINKORD_MONITOR_HOSTS to use this name.").into_response()
    }
}

fn host_allowed(host: &str, allowed: &[String]) -> bool {
    let name = match host.strip_prefix('[') {
        Some(v6) => return v6.split(']').next().is_some_and(|ip| ip.parse::<std::net::Ipv6Addr>().is_ok()),
        None => host.rsplit_once(':').map_or(host, |(n, _)| n),
    }
    .to_ascii_lowercase();
    name == "localhost" || name.parse::<std::net::Ipv4Addr>().is_ok() || allowed.iter().any(|a| a.eq_ignore_ascii_case(&name))
}

/// API calls need the session; anything that changes something also needs a header no cross-site form can send.
pub async fn require(State(st): State<AppState>, req: Request, next: Next) -> Response {
    if !signed_in(&st, req.headers()) {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "Sign in first." }))).into_response();
    }
    if req.method() != Method::GET && req.method() != Method::HEAD && !req.headers().contains_key("x-monitor") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Missing x-monitor header." }))).into_response();
    }
    next.run(req).await
}

#[derive(Default)]
pub struct Attempts(Mutex<Vec<Instant>>);

impl Attempts {
    fn allowed(&self) -> bool {
        let mut a = self.0.lock().unwrap();
        a.retain(|t| t.elapsed() < Duration::from_secs(60));
        a.len() < ATTEMPTS
    }

    fn failed(&self) {
        self.0.lock().unwrap().push(Instant::now());
    }
}

#[derive(Deserialize)]
pub struct Login {
    password: String,
}

fn cookie(headers: &HeaderMap, value: &str, max_age: i64) -> String {
    // Behind a tunnel the browser is on https; straight on the LAN or through SSH it isn't.
    let secure = headers.get("x-forwarded-proto").and_then(|v| v.to_str().ok()) == Some("https");
    format!("{COOKIE}={value}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}{}", if secure { "; Secure" } else { "" })
}

pub async fn login(State(st): State<AppState>, headers: HeaderMap, Json(body): Json<Login>) -> Response {
    if !st.attempts.allowed() {
        return (StatusCode::TOO_MANY_REQUESTS, Json(json!({ "error": "Too many attempts. Try again in a minute." }))).into_response();
    }
    if !same(&body.password, &st.cfg.password) {
        st.attempts.failed();
        tracing::warn!("wrong dashboard password");
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "Wrong password." }))).into_response();
    }
    let expires = chrono::Utc::now().timestamp() + SESSION_DAYS * 86400;
    let value = session_value(&signing_key(&st), expires);
    ([(header::SET_COOKIE, cookie(&headers, &value, SESSION_DAYS * 86400))], Json(json!({ "ok": true }))).into_response()
}

pub async fn logout(State(st): State<AppState>, headers: HeaderMap) -> Response {
    // There's one account: a new secret ends every session, including a cookie someone copied.
    if signed_in(&st, &headers) {
        match write_secret(&st.cfg.data_dir.join("session-secret")) {
            Ok(secret) => *st.session_secret.write().unwrap() = secret,
            Err(e) => tracing::warn!("couldn't renew the session secret: {e}"),
        }
    }
    ([(header::SET_COOKIE, cookie(&headers, "", 0))], Json(json!({ "ok": true }))).into_response()
}

pub async fn session(State(st): State<AppState>, headers: HeaderMap) -> Json<serde_json::Value> {
    Json(json!({ "signed_in": signed_in(&st, &headers) }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_addresses_and_known_names() {
        let allowed = vec!["monitor.example.com".to_string()];
        for ok in ["localhost:7710", "LOCALHOST", "127.0.0.1:7710", "192.168.0.50:7710", "[::1]:7710", "monitor.example.com", "Monitor.Example.com:443"] {
            assert!(host_allowed(ok, &allowed), "{ok}");
        }
        for no in ["evil.example", "evil.example:7710", "localhost.evil.example", "", "[evil]:7710"] {
            assert!(!host_allowed(no, &allowed), "{no}");
        }
    }

    #[test]
    fn sessions_expire_and_depend_on_the_password() {
        let value = session_value("hunter2hunter2", 1000);
        assert!(valid_session("hunter2hunter2", &value, 999));
        assert!(!valid_session("hunter2hunter2", &value, 1000), "expired");
        assert!(!valid_session("another-password", &value, 999), "password changed");
        assert!(!valid_session("hunter2hunter2", "2000.deadbeef", 999), "forged");
        assert!(!valid_session("hunter2hunter2", "garbage", 999));
        // The expiry is part of what's signed.
        let (_, sig) = value.split_once('.').unwrap();
        assert!(!valid_session("hunter2hunter2", &format!("99999.{sig}"), 999));
    }
}
