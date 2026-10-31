use axum::extract::{Multipart, Path, State};
use axum::routing::{patch, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::api::guilds::load_emojis;
use crate::auth::AuthUser;
use crate::error::{bad, ApiResult};
use crate::gateway::guild_members;
use crate::id::Id;
use crate::models::Emoji;
use crate::perms::{self, guild_perms};
use crate::state::AppState;
use crate::uploads;

const MAX_EMOJIS: usize = 100;
const MAX_EMOJI_BYTES: usize = 256 * 1024;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/guilds/{id}/emojis", post(create))
        .route("/guilds/{id}/emojis/{emoji}", patch(rename).delete(remove))
}

fn emoji_name(n: &str) -> ApiResult<String> {
    let n = n.trim().trim_matches(':');
    if !(2..=32).contains(&n.len()) || !n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(bad("emoji names are 2-32 letters, numbers or underscores"));
    }
    Ok(n.to_string())
}

async fn announce(st: &AppState, gid: Id) -> ApiResult<()> {
    let emojis = load_emojis(&st.db, gid).await?;
    st.hub.send(&guild_members(&st.db, gid).await?, "GUILD_EMOJIS_UPDATE", &json!({ "guild_id": gid, "emojis": emojis }));
    Ok(())
}

/// Multipart with a `name` text field and the image file.
async fn create(State(st): State<AppState>, AuthUser(me): AuthUser, Path(gid): Path<Id>, mut mp: Multipart) -> ApiResult<Json<Emoji>> {
    guild_perms(&st.db, gid, me).await?.require(perms::MANAGE_EMOJIS)?;
    if load_emojis(&st.db, gid).await?.len() >= MAX_EMOJIS {
        return Err(bad(format!("servers can have up to {MAX_EMOJIS} emoji")));
    }
    let mut name = None;
    let mut image = None;
    while let Some(field) = mp.next_field().await.map_err(|e| bad(e.body_text()))? {
        if field.name() == Some("name") {
            name = Some(emoji_name(&field.text().await.map_err(|e| bad(e.body_text()))?)?);
        } else if field.file_name().is_some() {
            let ct = field.content_type().unwrap_or_default().to_string();
            if !uploads::is_image(&ct) {
                return Err(bad("emoji must be a png, jpeg, gif or webp image"));
            }
            image = Some((ct == "image/gif", uploads::read_field(field, MAX_EMOJI_BYTES).await?));
        }
    }
    let name = name.ok_or_else(|| bad("missing name"))?;
    let (animated, bytes) = image.ok_or_else(|| bad("missing image"))?;
    uploads::reserve(&st, me, bytes.len()).await?;
    let id = Id::new();
    let path = st.cfg.uploads_dir().join("emojis").join(format!("{id}.{}", if animated { "gif" } else { "png" }));
    tokio::fs::create_dir_all(path.parent().unwrap()).await?;
    tokio::fs::write(&path, &bytes).await?;
    let emoji = sqlx::query_as::<_, Emoji>(
        "INSERT INTO emojis (id, guild_id, name, animated, creator_id) VALUES ($1, $2, $3, $4, $5) RETURNING id, guild_id, name, animated",
    )
    .bind(id)
    .bind(gid)
    .bind(name)
    .bind(animated)
    .bind(me)
    .fetch_one(&st.db)
    .await?;
    announce(&st, gid).await?;
    Ok(Json(emoji))
}

#[derive(Deserialize)]
struct Rename {
    name: String,
}

async fn rename(State(st): State<AppState>, AuthUser(me): AuthUser, Path((gid, eid)): Path<(Id, Id)>, Json(body): Json<Rename>) -> ApiResult<()> {
    guild_perms(&st.db, gid, me).await?.require(perms::MANAGE_EMOJIS)?;
    sqlx::query("UPDATE emojis SET name = $3 WHERE id = $1 AND guild_id = $2")
        .bind(eid)
        .bind(gid)
        .bind(emoji_name(&body.name)?)
        .execute(&st.db)
        .await?;
    announce(&st, gid).await
}

async fn remove(State(st): State<AppState>, AuthUser(me): AuthUser, Path((gid, eid)): Path<(Id, Id)>) -> ApiResult<()> {
    guild_perms(&st.db, gid, me).await?.require(perms::MANAGE_EMOJIS)?;
    sqlx::query("DELETE FROM emojis WHERE id = $1 AND guild_id = $2").bind(eid).bind(gid).execute(&st.db).await?;
    announce(&st, gid).await
}
