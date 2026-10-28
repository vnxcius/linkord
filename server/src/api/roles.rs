use axum::extract::{Path, State};
use axum::routing::{patch, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::api::guilds::load_roles;
use crate::auth::AuthUser;
use crate::error::{bad, ApiError, ApiResult};
use crate::gateway::guild_members;
use crate::id::Id;
use crate::models::{Role, ROLE_COLS};
use crate::perms::{self, guild_perms, Perms};
use crate::state::AppState;

const MAX_ROLES: usize = 100;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/guilds/{id}/roles", post(create).put(reorder))
        .route("/guilds/{id}/roles/{role}", patch(update).delete(remove))
}

#[derive(Deserialize, Default)]
struct RoleBody {
    name: Option<String>,
    color: Option<Option<i32>>,
    permissions: Option<i64>,
    hoist: Option<bool>,
    mentionable: Option<bool>,
}

fn role_name(n: &str) -> ApiResult<String> {
    let n = n.trim();
    if n.is_empty() || n.chars().count() > 100 || n == "@everyone" {
        return Err(bad("role name must be 1-100 characters"));
    }
    Ok(n.to_string())
}

/// Managers can't hand out permissions they don't hold themselves.
fn check_grant(mine: &Perms, wanted: i64) -> ApiResult<i64> {
    let wanted = wanted & perms::ALL;
    if !mine.has(perms::ADMINISTRATOR) && wanted & !mine.bits != 0 {
        return Err(bad("you cannot grant permissions you don't have"));
    }
    Ok(wanted)
}

async fn announce(st: &AppState, guild: Id, event: &str, data: serde_json::Value) -> ApiResult<()> {
    st.hub.send(&guild_members(&st.db, guild).await?, event, &data);
    Ok(())
}

async fn create(State(st): State<AppState>, AuthUser(me): AuthUser, Path(gid): Path<Id>, Json(body): Json<RoleBody>) -> ApiResult<Json<Role>> {
    let mine = guild_perms(&st.db, gid, me).await?;
    mine.require(perms::MANAGE_ROLES)?;
    if load_roles(&st.db, gid).await?.len() >= MAX_ROLES {
        return Err(bad("this server has too many roles"));
    }
    let name = role_name(body.name.as_deref().unwrap_or("new role"))?;
    let permissions = check_grant(&mine, body.permissions.unwrap_or(0))?;
    // New roles go just above @everyone, like Discord, so the creator can always manage them.
    let mut tx = st.db.begin().await?;
    sqlx::query("UPDATE roles SET position = position + 1 WHERE guild_id = $1 AND position >= 1").bind(gid).execute(&mut *tx).await?;
    let role = sqlx::query_as::<_, Role>(&format!(
        "INSERT INTO roles (id, guild_id, name, color, permissions, position, hoist, mentionable)
         VALUES ($1, $2, $3, $4, $5, 1, $6, $7) RETURNING {ROLE_COLS}"
    ))
    .bind(Id::new())
    .bind(gid)
    .bind(name)
    .bind(body.color.flatten())
    .bind(permissions)
    .bind(body.hoist.unwrap_or(false))
    .bind(body.mentionable.unwrap_or(false))
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    announce(&st, gid, "GUILD_ROLES_UPDATE", json!({ "guild_id": gid, "roles": load_roles(&st.db, gid).await? })).await?;
    Ok(Json(role))
}

async fn editable(st: &AppState, gid: Id, me: Id, rid: Id) -> ApiResult<(Perms, Role)> {
    let mine = guild_perms(&st.db, gid, me).await?;
    mine.require(perms::MANAGE_ROLES)?;
    let role = load_roles(&st.db, gid).await?.into_iter().find(|r| r.id == rid).ok_or(ApiError::NotFound)?;
    if !mine.owner && role.id != gid && role.position >= mine.top {
        return Err(bad("you can only edit roles below your highest role"));
    }
    Ok((mine, role))
}

async fn update(State(st): State<AppState>, AuthUser(me): AuthUser, Path((gid, rid)): Path<(Id, Id)>, Json(body): Json<RoleBody>) -> ApiResult<Json<Role>> {
    let (mine, role) = editable(&st, gid, me, rid).await?;
    let everyone = rid == gid;
    let name = match body.name {
        Some(n) if !everyone => role_name(&n)?,
        _ => role.name.clone(),
    };
    let permissions = match body.permissions {
        Some(p) => check_grant(&mine, p)?,
        None => role.permissions,
    };
    let role = sqlx::query_as::<_, Role>(&format!(
        "UPDATE roles SET name = $2, color = $3, permissions = $4, hoist = $5, mentionable = $6 WHERE id = $1 RETURNING {ROLE_COLS}"
    ))
    .bind(rid)
    .bind(name)
    .bind(if everyone { None } else { body.color.unwrap_or(role.color) })
    .bind(permissions)
    .bind(!everyone && body.hoist.unwrap_or(role.hoist))
    .bind(!everyone && body.mentionable.unwrap_or(role.mentionable))
    .fetch_one(&st.db)
    .await?;
    announce(&st, gid, "GUILD_ROLE_UPDATE", json!({ "guild_id": gid, "role": role })).await?;
    Ok(Json(role))
}

async fn remove(State(st): State<AppState>, AuthUser(me): AuthUser, Path((gid, rid)): Path<(Id, Id)>) -> ApiResult<()> {
    if rid == gid {
        return Err(bad("the @everyone role cannot be deleted"));
    }
    editable(&st, gid, me, rid).await?;
    sqlx::query("DELETE FROM roles WHERE id = $1").bind(rid).execute(&st.db).await?;
    announce(&st, gid, "GUILD_ROLES_UPDATE", json!({ "guild_id": gid, "roles": load_roles(&st.db, gid).await? })).await?;
    // Members lost the role; clients drop unknown role ids on GUILD_ROLES_UPDATE.
    Ok(())
}

#[derive(Deserialize)]
struct Reorder {
    /// All roles except @everyone, highest first.
    ids: Vec<Id>,
}

async fn reorder(State(st): State<AppState>, AuthUser(me): AuthUser, Path(gid): Path<Id>, Json(body): Json<Reorder>) -> ApiResult<Json<Vec<Role>>> {
    guild_perms(&st.db, gid, me).await?.require(perms::ADMINISTRATOR)?;
    let roles = load_roles(&st.db, gid).await?;
    let mut expected: Vec<Id> = roles.iter().map(|r| r.id).filter(|r| *r != gid).collect();
    let mut given = body.ids.clone();
    expected.sort();
    given.sort();
    if expected != given {
        return Err(bad("reorder must list every role exactly once"));
    }
    let n = body.ids.len() as i32;
    let mut tx = st.db.begin().await?;
    for (i, rid) in body.ids.iter().enumerate() {
        sqlx::query("UPDATE roles SET position = $2 WHERE id = $1").bind(rid).bind(n - i as i32).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    let roles = load_roles(&st.db, gid).await?;
    announce(&st, gid, "GUILD_ROLES_UPDATE", json!({ "guild_id": gid, "roles": roles })).await?;
    Ok(Json(roles))
}
