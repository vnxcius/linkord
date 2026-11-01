use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use rand::distributions::{Alphanumeric, DistString};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::api::guilds::{load_guild, load_member};
use crate::perms::{self, guild_perms};
use crate::auth::AuthUser;
use crate::error::{bad, ApiError, ApiResult};
use crate::gateway::guild_members;
use crate::id::Id;
use crate::models::{Guild, GuildRow, User, GUILD_COLS};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/guilds/{id}/invites", post(create).get(list))
        .route("/invites/{code}", get(preview).post(accept).delete(revoke))
}

#[derive(Serialize, sqlx::FromRow)]
struct Invite {
    code: String,
    guild_id: Id,
    creator_id: Id,
    uses: i32,
    max_uses: Option<i32>,
    expires_at: Option<DateTime<Utc>>,
}

#[derive(Deserialize)]
struct NewInvite {
    max_uses: Option<i32>,
    /// Seconds until expiry. Omit for an invite that never expires.
    max_age: Option<i64>,
}

async fn create(State(st): State<AppState>, AuthUser(me): AuthUser, Path(gid): Path<Id>, Json(body): Json<NewInvite>) -> ApiResult<Json<Invite>> {
    guild_perms(&st.db, gid, me).await?.require(perms::CREATE_INVITE)?;
    st.limits.check(format!("invite:{me}"), 5.0, 0.1)?;
    let code = Alphanumeric.sample_string(&mut rand::thread_rng(), 8);
    let invite = sqlx::query_as::<_, Invite>(
        "INSERT INTO invites (code, guild_id, creator_id, max_uses, expires_at)
         VALUES ($1, $2, $3, $4, CASE WHEN $5::BIGINT IS NULL THEN NULL ELSE now() + make_interval(secs => $5) END)
         RETURNING code, guild_id, creator_id, uses, max_uses, expires_at",
    )
    .bind(code)
    .bind(gid)
    .bind(me)
    .bind(body.max_uses.filter(|n| *n > 0))
    .bind(body.max_age.filter(|n| *n > 0))
    .fetch_one(&st.db)
    .await?;
    Ok(Json(invite))
}

/// Server settings → Invites: the active invites with who made them.
async fn list(State(st): State<AppState>, AuthUser(me): AuthUser, Path(gid): Path<Id>) -> ApiResult<Json<Vec<serde_json::Value>>> {
    guild_perms(&st.db, gid, me).await?.require(perms::MANAGE_GUILD)?;
    let invites = sqlx::query_as::<_, Invite>(
        "SELECT code, guild_id, creator_id, uses, max_uses, expires_at FROM invites
         WHERE guild_id = $1 AND (expires_at IS NULL OR expires_at > now()) AND (max_uses IS NULL OR uses < max_uses)
         ORDER BY expires_at NULLS LAST",
    )
    .bind(gid)
    .fetch_all(&st.db)
    .await?;
    let mut out = Vec::with_capacity(invites.len());
    for inv in invites {
        let inviter = User::get(&st.db, inv.creator_id).await.ok();
        out.push(json!({ "invite": inv, "inviter": inviter }));
    }
    Ok(Json(out))
}

/// Server managers can revoke any invite; anyone can revoke their own.
async fn revoke(State(st): State<AppState>, AuthUser(me): AuthUser, Path(code): Path<String>) -> ApiResult<()> {
    let (gid, creator): (Id, Id) = sqlx::query_as("SELECT guild_id, creator_id FROM invites WHERE code = $1")
        .bind(&code)
        .fetch_optional(&st.db)
        .await?
        .ok_or(ApiError::NotFound)?;
    if creator != me {
        guild_perms(&st.db, gid, me).await?.require(perms::MANAGE_GUILD)?;
    }
    sqlx::query("DELETE FROM invites WHERE code = $1").bind(&code).execute(&st.db).await?;
    Ok(())
}

async fn valid_invite(st: &AppState, code: &str) -> ApiResult<Invite> {
    sqlx::query_as::<_, Invite>(
        "SELECT code, guild_id, creator_id, uses, max_uses, expires_at FROM invites
         WHERE code = $1 AND (expires_at IS NULL OR expires_at > now()) AND (max_uses IS NULL OR uses < max_uses)",
    )
    .bind(code)
    .fetch_optional(&st.db)
    .await?
    .ok_or(ApiError::NotFound)
}

/// Whether a new account may be created through this invite.
pub async fn is_valid(st: &AppState, code: &str) -> ApiResult<bool> {
    match valid_invite(st, code).await {
        Ok(_) => Ok(true),
        Err(ApiError::NotFound) => Ok(false),
        Err(e) => Err(e),
    }
}

async fn preview(State(st): State<AppState>, AuthUser(_): AuthUser, Path(code): Path<String>) -> ApiResult<Json<serde_json::Value>> {
    let inv = valid_invite(&st, &code).await?;
    let guild = sqlx::query_as::<_, GuildRow>(&format!("SELECT {GUILD_COLS} FROM guilds WHERE id = $1")).bind(inv.guild_id).fetch_one(&st.db).await?;
    let members = guild_members(&st.db, inv.guild_id).await?;
    // Invisible people don't count: this answers anyone holding the link.
    let invisible: Vec<Id> = sqlx::query_scalar("SELECT id FROM users WHERE id = ANY($1) AND status = 'invisible'").bind(&members).fetch_all(&st.db).await?;
    let online_count = members.iter().filter(|u| st.hub.is_online(**u) && !invisible.contains(u)).count();
    let inviter = User::get(&st.db, inv.creator_id).await?.outline();
    Ok(Json(json!({ "code": inv.code, "guild": guild, "member_count": members.len(), "online_count": online_count, "inviter": inviter })))
}

async fn accept(State(st): State<AppState>, AuthUser(me): AuthUser, Path(code): Path<String>) -> ApiResult<Json<Guild>> {
    st.limits.check(format!("join:{me}"), 5.0, 0.1)?;
    let inv = valid_invite(&st, &code).await?;
    let banned: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM guild_bans WHERE guild_id = $1 AND user_id = $2)").bind(inv.guild_id).bind(me).fetch_one(&st.db).await?;
    if banned {
        return Err(bad("you are banned from this server"));
    }
    let already: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM members WHERE guild_id = $1 AND user_id = $2)").bind(inv.guild_id).bind(me).fetch_one(&st.db).await?;
    let mut joined = false;
    if !already {
        // Taking a use and joining happen together: a one-use invite lets in exactly one person.
        let mut tx = st.db.begin().await?;
        let took = sqlx::query("UPDATE invites SET uses = uses + 1 WHERE code = $1 AND (expires_at IS NULL OR expires_at > now()) AND (max_uses IS NULL OR uses < max_uses)")
            .bind(&code)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        if took == 0 {
            return Err(ApiError::NotFound);
        }
        joined = sqlx::query("INSERT INTO members (guild_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING").bind(inv.guild_id).bind(me).execute(&mut *tx).await?.rows_affected() > 0;
        if joined {
            tx.commit().await?;
        }
    }
    let guild = load_guild(&st.db, inv.guild_id, me).await?;
    if joined {
        let member = load_member(&st.db, inv.guild_id, me).await?;
        let others: Vec<Id> = guild.members.iter().map(|m| m.user.id).filter(|u| *u != me).collect();
        st.hub.send(&others, "GUILD_MEMBER_ADD", &json!({ "guild_id": inv.guild_id, "member": member, "status": st.hub.presence(&member.user) }));
        st.hub.send(&[me], "GUILD_CREATE", &guild);
        crate::api::guilds::welcome(&st, &guild.guild, me).await;
    }
    Ok(Json(guild))
}
