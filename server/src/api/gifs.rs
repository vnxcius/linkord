//! GIF search, proxied through the server so the API key stays private. Optional: without
//! GIPHY_API_KEY the picker only shows favorites.

use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::auth::AuthUser;
use crate::error::{bad, ApiResult};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new().route("/gifs/search", get(search)).route("/gifs/trending", get(trending))
}

#[derive(Serialize)]
pub struct Gif {
    id: String,
    /// Sent in chat; renders as an image embed.
    url: String,
    preview: String,
    width: u32,
    height: u32,
}

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
}

async fn giphy(st: &AppState, endpoint: &str, q: Option<&str>) -> ApiResult<Json<Vec<Gif>>> {
    let key = st.cfg.giphy_api_key.as_deref().ok_or_else(|| bad("GIF search is not enabled on this server"))?;
    let mut req = st.http.get(format!("https://api.giphy.com/v1/gifs/{endpoint}")).query(&[("api_key", key), ("limit", "30"), ("rating", "pg-13")]);
    if let Some(q) = q {
        req = req.query(&[("q", q)]);
    }
    let body: Value = req.send().await.map_err(anyhow::Error::from)?.error_for_status().map_err(anyhow::Error::from)?.json().await.map_err(anyhow::Error::from)?;
    let gifs = body["data"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|g| {
                    let orig = &g["images"]["original"];
                    let small = &g["images"]["fixed_width"];
                    Some(Gif {
                        id: g["id"].as_str()?.to_string(),
                        url: orig["url"].as_str()?.split('?').next()?.to_string(),
                        preview: small["webp"].as_str().or(small["url"].as_str())?.to_string(),
                        width: small["width"].as_str()?.parse().ok()?,
                        height: small["height"].as_str()?.parse().ok()?,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(Json(gifs))
}

async fn search(State(st): State<AppState>, AuthUser(me): AuthUser, Query(q): Query<SearchQuery>) -> ApiResult<Json<Vec<Gif>>> {
    st.limits.check(format!("gif:{me}"), 10.0, 1.0)?;
    let q = q.q.trim();
    if q.is_empty() || q.len() > 50 {
        return Err(bad("search for 1-50 characters"));
    }
    giphy(&st, "search", Some(q)).await
}

async fn trending(State(st): State<AppState>, AuthUser(me): AuthUser) -> ApiResult<Json<Vec<Gif>>> {
    st.limits.check(format!("gif:{me}"), 10.0, 1.0)?;
    giphy(&st, "trending", None).await
}
