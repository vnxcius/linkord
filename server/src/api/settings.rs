//! Settings that follow the user across devices: notification mutes, favorite GIFs, and similar.

use axum::extract::State;
use axum::routing::patch;
use axum::{Json, Router};
use serde_json::{Map, Value};
use sqlx::PgPool;

use crate::auth::AuthUser;
use crate::error::{bad, ApiResult};
use crate::id::Id;
use crate::state::AppState;

const MAX_BYTES: usize = 32 * 1024;
const KEYS: &[&str] = &["muted_guilds", "muted_channels", "favorite_gifs", "guild_order", "guild_folders", "collapsed_categories"];

pub fn routes() -> Router<AppState> {
    Router::new().route("/users/@me/settings", patch(update))
}

pub async fn load(db: &PgPool, me: Id) -> ApiResult<Value> {
    let v: Option<sqlx::types::Json<Value>> = sqlx::query_scalar("SELECT data FROM user_settings WHERE user_id = $1").bind(me).fetch_optional(db).await?;
    Ok(v.map(|j| j.0).unwrap_or_else(|| Value::Object(Map::new())))
}

/// Shallow merge: each given key replaces the stored value; `null` removes it.
async fn update(State(st): State<AppState>, AuthUser(me): AuthUser, Json(patch): Json<Map<String, Value>>) -> ApiResult<Json<Value>> {
    let mut data = match load(&st.db, me).await? {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    for (k, v) in patch {
        if !KEYS.contains(&k.as_str()) {
            return Err(bad(format!("unknown setting {k}")));
        }
        if v.is_null() {
            data.remove(&k);
        } else {
            data.insert(k, v);
        }
    }
    let data = Value::Object(data);
    if serde_json::to_vec(&data).map_err(anyhow::Error::from)?.len() > MAX_BYTES {
        return Err(bad("settings are too large"));
    }
    sqlx::query("INSERT INTO user_settings (user_id, data) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data")
        .bind(me)
        .bind(sqlx::types::Json(&data))
        .execute(&st.db)
        .await?;
    st.hub.send(&[me], "USER_SETTINGS_UPDATE", &data);
    Ok(Json(data))
}
