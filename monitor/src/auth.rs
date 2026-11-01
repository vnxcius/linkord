//! The dashboard's own login: one password, an HMAC-signed cookie, no database. It keeps working when Discord or the
//! app are down, and changing the password signs everyone out.

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

pub fn signed_in(st: &AppState, headers: &HeaderMap) -> bool {
    session_from(headers).is_some_and(|v| valid_session(&st.cfg.password, &v, chrono::Utc::now().timestamp()))
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
    let value = session_value(&st.cfg.password, expires);
    ([(header::SET_COOKIE, cookie(&headers, &value, SESSION_DAYS * 86400))], Json(json!({ "ok": true }))).into_response()
}

pub async fn logout(headers: HeaderMap) -> Response {
    ([(header::SET_COOKIE, cookie(&headers, "", 0))], Json(json!({ "ok": true }))).into_response()
}

pub async fn session(State(st): State<AppState>, headers: HeaderMap) -> Json<serde_json::Value> {
    Json(json!({ "signed_in": signed_in(&st, &headers) }))
}

#[cfg(test)]
mod tests {
    use super::*;

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
