//! Stream previews: the picture people see when they hover someone who's live (like Discord's). The streamer's
//! app sends a small JPEG of its own stream now and then; it's kept in memory only while they stream, and only
//! people who can see the voice channel can fetch it.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use axum::Router;

use crate::api::channels::channel_for;
use crate::auth::AuthUser;
use crate::error::{bad, ApiError, ApiResult};
use crate::id::Id;
use crate::state::AppState;

/// A 480 px wide JPEG is around 30-60 KB; this leaves room for busy pictures.
const MAX_BYTES: usize = 300 * 1024;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/voice/preview", put(upload))
        .route("/users/{id}/stream-preview", get(fetch))
}

/// The streamer's app: the latest picture of what it's streaming (raw JPEG body).
async fn upload(State(st): State<AppState>, AuthUser(me): AuthUser, body: Bytes) -> ApiResult<()> {
    st.limits.check(format!("preview:{me}"), 3.0, 0.2)?;
    if crate::voice::streaming_in(&st, me).is_none() {
        return Err(bad("you aren't streaming"));
    }
    if body.len() > MAX_BYTES || !body.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Err(bad("send a JPEG of up to 300 KB"));
    }
    st.previews.insert(me, (body, chrono::Utc::now().timestamp_millis()));
    Ok(())
}

/// Someone's stream preview, for whoever can see the channel they stream in.
async fn fetch(State(st): State<AppState>, AuthUser(me): AuthUser, Path(user): Path<Id>) -> ApiResult<Response> {
    let channel = crate::voice::streaming_in(&st, user).ok_or(ApiError::NotFound)?;
    channel_for(&st, channel, me).await?;
    let (jpeg, at) = st.previews.get(&user).map(|p| p.clone()).ok_or(ApiError::NotFound)?;
    Ok((
        [
            (header::CONTENT_TYPE, "image/jpeg".to_string()),
            (header::CACHE_CONTROL, "no-store".to_string()),
            (header::HeaderName::from_static("x-preview-at"), at.to_string()),
        ],
        jpeg,
    )
        .into_response())
}
