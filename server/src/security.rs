//! Response headers for what isn't an API answer: people's files and the web client.

use axum::body::Body;
use axum::extract::{FromRequestParts, Request, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::http::header::{self, HeaderValue};
use axum::middleware::Next;
use axum::response::Response;

use crate::direct::PublicBase;
use crate::ratelimit::ClientIp;
use crate::state::AppState;

/// Pictures, video and audio play inline; anything else downloads.
fn safe_inline(mime: &str) -> bool {
    (mime.starts_with("image/") && mime != "image/svg+xml") || mime.starts_with("video/") || mime.starts_with("audio/")
}

/// Files people uploaded are not trustworthy, and this origin holds everyone's session. Whatever a file is, it can't
/// run here: the CSP sandboxes it even when it's opened directly. <img>, <video> and <audio> ignore both headers.
pub async fn upload_headers(req: Request, next: Next) -> Response {
    // Forget attachments when they're deleted or moderated: browsers may keep them for a while, shared caches may not.
    let private = req.uri().path().starts_with("/attachments/") || req.uri().path().starts_with("/member-profiles/");
    let mut res = next.run(req).await;
    let mime = res.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    let inline = safe_inline(&mime);
    let h = res.headers_mut();
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'none'; style-src 'unsafe-inline'; sandbox"));
    if !inline {
        h.insert(header::CONTENT_DISPOSITION, HeaderValue::from_static("attachment"));
    }
    if private {
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=3600"));
    }
    res
}

/// Matches the desktop app's CSP (tauri.conf.json), with what the web client needs on top; the frame-src list is
/// lib/video-links.ts PLAYER_ORIGINS plus Kick and the stream chats, CHAT_ORIGINS (tests/video-links.test.mjs checks both).
const WEB_CSP: &str = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' data: blob: https: wss:; \
    img-src 'self' data: blob: https:; media-src 'self' blob: mediastream: https:; style-src 'self' 'unsafe-inline'; \
    font-src 'self' data:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; \
    frame-src https://www.youtube.com https://www.tiktok.com https://www.instagram.com https://player.vimeo.com https://clips.twitch.tv \
    https://player.twitch.tv https://streamable.com https://www.dailymotion.com https://player.kick.com https://www.twitch.tv https://kick.com";

pub async fn web_headers(req: Request, next: Next) -> Response {
    // Only the tunnel's address: direct access has its own host, where other ports may not speak HTTPS.
    let https = req.extensions().get::<PublicBase>().is_none() && req.headers().get("x-forwarded-proto").is_some_and(|v| v == "https");
    // Files without a hash in their name that must never be stale: the service worker and the app manifest (Cloudflare
    // otherwise keeps them for hours and phones never see a new service worker).
    let fresh = matches!(req.uri().path(), "/sw.js" | "/manifest.webmanifest" | "/index.html" | "/");
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    if fresh {
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    }
    h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(WEB_CSP));
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(header::REFERRER_POLICY, HeaderValue::from_static("strict-origin-when-cross-origin"));
    if https {
        h.insert(header::STRICT_TRANSPORT_SECURITY, HeaderValue::from_static("max-age=15552000"));
    }
    res
}

/// Every API request counts against its address, on top of the tighter limits of expensive routes. Generous: a client
/// starting up or a whole household behind one address doesn't come near it. Requests with no address (tests, the
/// machine itself) don't count.
pub async fn api_limit(State(st): State<AppState>, req: Request, next: Next) -> Response {
    let (mut parts, body) = req.into_parts();
    let Ok(ClientIp(ip)) = ClientIp::from_request_parts(&mut parts, &()).await;
    if ip != "local" {
        if let Err(e) = st.limits.check(format!("api:{ip}"), 300.0, 30.0) {
            return e.into_response();
        }
    }
    let limit = body_limit(parts.uri.path());
    let declared = parts.headers.get(header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<usize>().ok());
    if declared.is_some_and(|n| n > limit) {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    }
    next.run(Request::from_parts(parts, Body::new(http_body_util::Limited::new(body, limit)))).await
}

/// New websockets from one address, before anyone has identified. Same exception as `api_limit`.
pub fn socket_limit(st: &AppState, ip: &str) -> crate::error::ApiResult<()> {
    if ip == "local" {
        return Ok(());
    }
    st.limits.check(format!("ws:{ip}"), 60.0, 2.0)
}

/// The largest request body a route takes (the path has no /api prefix here): a little JSON unless it receives files.
fn body_limit(path: &str) -> usize {
    use crate::uploads::{MESSAGE_BODY, UPLOAD_BODY};
    const JSON: usize = 1024 * 1024;
    let tail = path.rsplit('/').next().unwrap_or("");
    if path.starts_with("/channels/") && tail == "messages" {
        MESSAGE_BODY
    } else if matches!(tail, "avatar" | "banner" | "nameplate" | "icon" | "emojis" | "soundboard" | "profile-song") {
        UPLOAD_BODY
    } else {
        JSON
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_file_routes_take_large_bodies() {
        assert_eq!(body_limit("/channels/123/messages"), crate::uploads::MESSAGE_BODY);
        assert_eq!(body_limit("/guilds/1/members/@me/banner"), crate::uploads::UPLOAD_BODY);
        assert_eq!(body_limit("/users/@me/profile-song"), crate::uploads::UPLOAD_BODY);
        assert_eq!(body_limit("/voice/preview"), 1024 * 1024);
        assert_eq!(body_limit("/guilds/1"), 1024 * 1024);
    }

    #[test]
    fn only_media_shows_inline() {
        for mime in ["image/png", "video/webm", "audio/ogg"] {
            assert!(safe_inline(mime), "{mime}");
        }
        for mime in ["text/html", "image/svg+xml", "application/javascript", "application/pdf", ""] {
            assert!(!safe_inline(mime), "{mime}");
        }
    }
}
