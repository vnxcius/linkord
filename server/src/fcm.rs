//! Firebase Cloud Messaging for the Android app (android/): the phone's way to get notifications while Linkord is
//! closed. The notification itself is the same as for Web Push (push.rs): encrypted for that one device (RFC 8291),
//! so Google carries a sealed blob in a data message and only sees that a phone got something, and when.
//!
//! Settings (server/.env), both files from the Firebase console:
//! - LINKORD_FCM_CREDENTIALS: the service account key (Project settings -> Service accounts -> Generate new private key).
//!   Sends are signed with it (OAuth 2 JWT bearer, RS256) for an access token kept until it nearly expires.
//! - LINKORD_FCM_CLIENT: google-services.json (the Android apps' public ids). The app asks for its part at
//!   GET /api/push/fcm?package=..., so the APK carries no Firebase settings and works with whatever project the server
//!   names.
//! Unset = no FCM: the Android app then simply doesn't register.

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::extract::Query;
use axum::routing::get;
use axum::{Json, Router};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD as B64};
use base64::Engine as _;
use rsa::pkcs1v15::SigningKey;
use rsa::pkcs8::DecodePrivateKey;
use rsa::signature::{SignatureEncoding, Signer};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

/// Subscriptions are stored like Web Push ones, the endpoint being `fcm:<registration token>`.
pub const PREFIX: &str = "fcm:";

#[derive(Deserialize)]
struct Credentials {
    project_id: String,
    client_email: String,
    private_key: String,
    #[serde(default = "default_token_uri")]
    token_uri: String,
}

fn default_token_uri() -> String {
    "https://oauth2.googleapis.com/token".into()
}

struct Fcm {
    creds: Credentials,
    key: SigningKey<sha2::Sha256>,
    /// The Android apps' public settings: (package name, app id, api key).
    apps: Vec<(String, String, String)>,
    project_number: String,
    /// Where messages go (tests point LINKORD_FCM_URL at a mock).
    base: String,
    token: Mutex<Option<(String, Instant)>>,
}

static FCM: OnceLock<Option<Fcm>> = OnceLock::new();

fn fcm() -> Option<&'static Fcm> {
    FCM.get().and_then(|f| f.as_ref())
}

pub fn enabled() -> bool {
    fcm().is_some()
}

/// Reads the two files. Missing or broken = FCM off (logged), never a failed start.
pub fn init() {
    let load = || -> anyhow::Result<Option<Fcm>> {
        let (Ok(creds_path), Ok(client_path)) = (std::env::var("LINKORD_FCM_CREDENTIALS"), std::env::var("LINKORD_FCM_CLIENT")) else {
            return Ok(None);
        };
        if creds_path.trim().is_empty() || client_path.trim().is_empty() {
            return Ok(None);
        }
        let creds: Credentials = serde_json::from_str(&std::fs::read_to_string(creds_path.trim())?)?;
        let key = SigningKey::<sha2::Sha256>::new(rsa::RsaPrivateKey::from_pkcs8_pem(&creds.private_key)?);
        let client: Value = serde_json::from_str(&std::fs::read_to_string(client_path.trim())?)?;
        let project_number = client["project_info"]["project_number"].as_str().unwrap_or_default().to_string();
        let apps = client["client"]
            .as_array()
            .map(|list| {
                list.iter()
                    .filter_map(|c| {
                        Some((
                            c["client_info"]["android_client_info"]["package_name"].as_str()?.to_string(),
                            c["client_info"]["mobilesdk_app_id"].as_str()?.to_string(),
                            c["api_key"][0]["current_key"].as_str()?.to_string(),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let base = std::env::var("LINKORD_FCM_URL").ok().filter(|u| !u.is_empty()).unwrap_or_else(|| "https://fcm.googleapis.com".into());
        Ok(Some(Fcm { creds, key, apps, project_number, base, token: Mutex::new(None) }))
    };
    let f = match load() {
        Ok(f) => f,
        Err(e) => {
            tracing::warn!("fcm: settings unreadable, Android notifications off: {e}");
            None
        }
    };
    if let Some(f) = &f {
        tracing::info!(project = %f.creds.project_id, apps = f.apps.len(), "fcm: on");
    }
    let _ = FCM.set(f);
}

pub fn routes() -> Router<AppState> {
    Router::new().route("/push/fcm", get(client_config))
}

#[derive(Deserialize)]
struct ConfigQuery {
    package: String,
}

/// The Firebase settings an Android build needs to start (public values, the same that would be in the APK).
async fn client_config(Query(q): Query<ConfigQuery>) -> ApiResult<Json<Value>> {
    let f = fcm().ok_or(ApiError::NotFound)?;
    let (_, app_id, api_key) = f.apps.iter().find(|a| a.0 == q.package).ok_or(ApiError::NotFound)?;
    Ok(Json(json!({ "project_id": f.creds.project_id, "app_id": app_id, "api_key": api_key, "sender_id": f.project_number })))
}

/// A token is what the Firebase SDK gives a device: letters, digits and `:_-`.
pub fn valid_token(token: &str) -> bool {
    !token.is_empty() && token.len() <= 4096 && token.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '-'))
}

/// An access token for the messaging API, signed with the service account; reused until five minutes before it ends.
async fn access_token(st: &AppState, f: &Fcm) -> anyhow::Result<String> {
    if let Some((t, until)) = f.token.lock().unwrap().clone() {
        if Instant::now() < until {
            return Ok(t);
        }
    }
    let now = chrono::Utc::now().timestamp();
    let header = B64.encode(br#"{"alg":"RS256","typ":"JWT"}"#);
    let claims = B64.encode(
        json!({
            "iss": f.creds.client_email, "scope": "https://www.googleapis.com/auth/firebase.messaging",
            "aud": f.creds.token_uri, "iat": now, "exp": now + 3600,
        })
        .to_string(),
    );
    let input = format!("{header}.{claims}");
    let jwt = format!("{input}.{}", B64.encode(f.key.sign(input.as_bytes()).to_bytes()));
    let res: Value = st
        .http
        .post(&f.creds.token_uri)
        .form(&[("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"), ("assertion", jwt.as_str())])
        .timeout(Duration::from_secs(10))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let token = res["access_token"].as_str().ok_or_else(|| anyhow::anyhow!("no access_token"))?.to_string();
    let life = res["expires_in"].as_u64().unwrap_or(3600).saturating_sub(300);
    *f.token.lock().unwrap() = Some((token.clone(), Instant::now() + Duration::from_secs(life)));
    Ok(token)
}

/// What became of one notification.
pub enum Sent {
    Ok,
    /// The token is gone (app uninstalled, data cleared): forget the subscription.
    Gone,
    Failed,
}

/// Sends one encrypted notification (push.rs encrypt's output) to a device as a data message.
/// No collapse key: a phone that was offline gets every message it missed (the app stacks them per conversation),
/// not only the last one per channel. FCM keeps up to 100 per phone.
pub async fn send(st: &AppState, token: &str, sealed: &[u8], ttl: u32, urgent: bool) -> Sent {
    let Some(f) = fcm() else { return Sent::Failed };
    let bearer = match access_token(st, f).await {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!("fcm: couldn't get an access token: {e}");
            return Sent::Failed;
        }
    };
    let android = json!({ "priority": if urgent { "HIGH" } else { "NORMAL" }, "ttl": format!("{ttl}s") });
    let body = json!({ "message": { "token": token, "data": { "p": STANDARD.encode(sealed) }, "android": android } });
    let url = format!("{}/v1/projects/{}/messages:send", f.base, f.creds.project_id);
    match st.http.post(url).bearer_auth(bearer).json(&body).timeout(Duration::from_secs(10)).send().await {
        Ok(r) if r.status().is_success() => Sent::Ok,
        Ok(r) => {
            let status = r.status().as_u16();
            let text = r.text().await.unwrap_or_default();
            // UNREGISTERED: the app is gone from that phone; a token Google doesn't recognise any more is the same.
            if status == 404 || text.contains("UNREGISTERED") || (status == 400 && text.contains("registration token")) {
                return Sent::Gone;
            }
            let why: String = text.chars().take(200).collect();
            tracing::warn!(status, why, "fcm: refused a notification");
            Sent::Failed
        }
        Err(e) => {
            tracing::warn!("fcm: couldn't reach FCM: {}", e.without_url());
            Sent::Failed
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn tokens() {
        assert!(super::valid_token("cXy-1_2:APA91b"));
        assert!(!super::valid_token(""));
        assert!(!super::valid_token("a/b"));
        assert!(!super::valid_token("https://evil"));
    }
}
