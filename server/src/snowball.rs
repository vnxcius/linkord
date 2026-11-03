//! Snowball fights: POST /channels/{id}/snowball throws one at someone who can see the channel. Nothing is stored but the
//! score (user_stats snowballs_thrown / snowballs_taken): everyone looking at the channel gets SNOWBALL and draws it.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::api::channels::channel_for;
use crate::api::relationships::blocked_between;
use crate::auth::AuthUser;
use crate::error::{bad, ApiResult};
use crate::id::Id;
use crate::models::User;
use crate::perms;
use crate::state::AppState;

const THROWN: &str = "snowballs_thrown";
const TAKEN: &str = "snowballs_taken";
const LEADERBOARD: i64 = 5;

pub fn routes() -> Router<AppState> {
    Router::new().route("/channels/{id}/snowball", post(throw))
}

#[derive(Deserialize)]
struct Throw {
    target: Id,
    /// The message it lands on (thrown from a message's menu); otherwise the client picks their latest.
    message_id: Option<Id>,
}

async fn throw(State(st): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<Id>, Json(body): Json<Throw>) -> ApiResult<StatusCode> {
    st.limits.check(format!("snowball:{me}"), 5.0, 0.5)?;
    let a = channel_for(&st, id, me).await?;
    a.require(perms::SEND_MESSAGES)?;
    if body.target == me {
        return Err(bad("you can't throw a snowball at yourself"));
    }
    let to = match a.ch.guild_id {
        Some(g) => perms::channel_viewers(&st.db, g, id).await?,
        None => crate::api::dms::recipients(&st.db, id).await?,
    };
    if !to.contains(&body.target) {
        return Err(bad("they can't see this channel"));
    }
    if blocked_between(&st.db, me, body.target).await? {
        return Err(bad("you can't throw a snowball at them"));
    }
    if let Some(message) = body.message_id {
        let found: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM messages WHERE id = $1 AND channel_id = $2)")
            .bind(message)
            .bind(id)
            .fetch_one(&st.db)
            .await?;
        if !found {
            return Err(bad("that message isn't in this channel"));
        }
    }
    crate::stats::bump(&st, me, THROWN);
    crate::stats::bump(&st, body.target, TAKEN);
    st.hub.send(&to, "SNOWBALL", &json!({ "channel_id": id, "from": me, "to": body.target, "message_id": body.message_id }));
    Ok(StatusCode::NO_CONTENT)
}

/// For someone's profile: their score, and the best throwers among the people the viewer shares a server with.
pub async fn profile(st: &AppState, viewer: Id, user: Id) -> ApiResult<serde_json::Value> {
    let score = |key: &'static str| {
        sqlx::query_scalar::<_, i64>("SELECT value FROM user_stats WHERE user_id = $1 AND key = $2").bind(user).bind(key).fetch_optional(&st.db)
    };
    let thrown = score(THROWN).await?.unwrap_or(0);
    let taken = score(TAKEN).await?.unwrap_or(0);
    let rows: Vec<(Id, i64)> = sqlx::query_as(
        "SELECT user_id, value FROM user_stats
         WHERE key = $1 AND value > 0 AND user_id IN (
             SELECT user_id FROM members WHERE guild_id IN (SELECT guild_id FROM members WHERE user_id = $2)
         )
         ORDER BY value DESC, user_id LIMIT $3",
    )
    .bind(THROWN)
    .bind(viewer)
    .bind(LEADERBOARD)
    .fetch_all(&st.db)
    .await?;
    let mut top = Vec::with_capacity(rows.len());
    for (id, value) in rows {
        top.push(json!({ "user": User::get(&st.db, id).await?, "thrown": value }));
    }
    Ok(json!({ "thrown": thrown, "taken": taken, "top": top }))
}
