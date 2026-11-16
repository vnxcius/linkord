//! The Android app (android/): App Links verification. Android opens https://<this server>/invite/..., /channels/...
//! and /clip/... links in the app once this file lists the release signing certificate (LINKORD_ANDROID_CERTS: SHA-256
//! fingerprints, "AB:CD:..."; comma-separated to allow a key rotation). Unset = 404, links open in the browser.
//! App Links ignore ports, so the direct address (direct.rs, :8443) can't be verified; its links stay in the browser.

use axum::extract::State;
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;

use crate::error::ApiError;
use crate::state::AppState;

/// The release app's id (android/app/build.gradle.kts applicationId).
pub const PACKAGE: &str = "com.linkord.app";

pub fn page_routes() -> Router<AppState> {
    Router::new().route("/.well-known/assetlinks.json", get(asset_links))
}

async fn asset_links(State(st): State<AppState>) -> Response {
    if st.cfg.android_certs.is_empty() {
        return ApiError::NotFound.into_response();
    }
    let body = serde_json::json!([{
        "relation": ["delegate_permission/common.handle_all_urls"],
        "target": { "namespace": "android_app", "package_name": PACKAGE, "sha256_cert_fingerprints": st.cfg.android_certs },
    }]);
    ([(CONTENT_TYPE, "application/json"), (CACHE_CONTROL, "public, max-age=3600")], body.to_string()).into_response()
}

/// "ab:cd:..." or "abcd..." -> "AB:CD:...", the form Android compares; anything else is dropped.
pub fn normalize_cert(raw: &str) -> Option<String> {
    let hex: String = raw.chars().filter(|c| *c != ':' && !c.is_whitespace()).collect();
    if hex.len() != 64 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(hex.to_uppercase().as_bytes().chunks(2).map(|p| std::str::from_utf8(p).unwrap()).collect::<Vec<_>>().join(":"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn certs() {
        let colon = "AB:".repeat(31) + "AB";
        assert_eq!(super::normalize_cert(&"ab".repeat(32)).as_deref(), Some(colon.as_str()));
        assert_eq!(super::normalize_cert(&colon.to_lowercase()).as_deref(), Some(colon.as_str()));
        assert_eq!(super::normalize_cert("nope"), None);
    }
}
