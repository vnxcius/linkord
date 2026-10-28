use axum::extract::{Multipart, Path, State};
use axum::routing::{delete, patch, post};
use axum::{Json, Router};
use serde::Deserialize;
use sqlx::PgPool;

use crate::auth::AuthUser;
use crate::error::{bad, ApiError, ApiResult};
use crate::gateway::guild_members;
use crate::id::Id;
use crate::models::{kind, prefixed, Channel, Emoji, Guild, GuildRow, Member, Role, User, CHANNEL_COLS, ROLE_COLS, USER_COLS};
use crate::perms::{self, guild_perms};
use crate::state::AppState;
use crate::{uploads, voice};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/guilds", post(create))
        .route("/guilds/{id}", patch(update).delete(remove))
        .route("/guilds/{id}/icon", post(upload_icon))
        .route("/guilds/{id}/members/@me", delete(leave).patch(update_me))
        .route("/guilds/{id}/members/{user}", delete(kick).patch(update_member))
}

#[derive(sqlx::FromRow)]
struct MemberRow {
    #[sqlx(flatten)]
    user: User,
    nickname: Option<String>,
    joined_at: chrono::DateTime<chrono::Utc>,
    roles: Vec<Id>,
}

async fn load_members(db: &PgPool, guild: Id, only: Option<Id>) -> ApiResult<Vec<Member>> {
    let rows = sqlx::query_as::<_, MemberRow>(&format!(
        "SELECT {}, m.nickname, m.joined_at,
                COALESCE(array_agg(mr.role_id) FILTER (WHERE mr.role_id IS NOT NULL), '{{}}') AS roles
         FROM members m JOIN users u ON u.id = m.user_id
         LEFT JOIN member_roles mr ON mr.guild_id = m.guild_id AND mr.user_id = m.user_id
         WHERE m.guild_id = $1 AND ($2::BIGINT IS NULL OR m.user_id = $2)
         GROUP BY u.id, m.nickname, m.joined_at ORDER BY m.joined_at",
        prefixed(USER_COLS, "u")
    ))
    .bind(guild)
    .bind(only)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(|r| Member { user: r.user, nickname: r.nickname, joined_at: r.joined_at, roles: r.roles }).collect())
}

pub async fn load_member(db: &PgPool, guild: Id, user: Id) -> ApiResult<Member> {
    load_members(db, guild, Some(user)).await?.pop().ok_or(ApiError::NotFound)
}

pub async fn load_roles(db: &PgPool, guild: Id) -> ApiResult<Vec<Role>> {
    Ok(sqlx::query_as::<_, Role>(&format!("SELECT {ROLE_COLS} FROM roles WHERE guild_id = $1 ORDER BY position DESC, id"))
        .bind(guild)
        .fetch_all(db)
        .await?)
}

pub async fn load_emojis(db: &PgPool, guild: Id) -> ApiResult<Vec<Emoji>> {
    Ok(sqlx::query_as::<_, Emoji>("SELECT id, guild_id, name, animated FROM emojis WHERE guild_id = $1 ORDER BY name")
        .bind(guild)
        .fetch_all(db)
        .await?)
}

pub async fn load_guild(db: &PgPool, id: Id) -> ApiResult<Guild> {
    let guild = sqlx::query_as::<_, GuildRow>("SELECT id, name, icon, owner_id FROM guilds WHERE id = $1")
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or(ApiError::NotFound)?;
    // Archived threads stay out of the sidebar; they are still reachable by link/search.
    let channels = sqlx::query_as::<_, Channel>(&format!(
        "SELECT {CHANNEL_COLS} FROM channels WHERE guild_id = $1 AND NOT (kind = $2 AND archived) ORDER BY position, id"
    ))
    .bind(id)
    .bind(kind::THREAD)
    .fetch_all(db)
    .await?;
    Ok(Guild {
        guild,
        channels,
        members: load_members(db, id, None).await?,
        roles: load_roles(db, id).await?,
        emojis: load_emojis(db, id).await?,
    })
}

/// Loads the guild row if `me` is a member.
pub async fn guild_for(db: &PgPool, id: Id, me: Id) -> ApiResult<GuildRow> {
    sqlx::query_as::<_, GuildRow>(
        "SELECT g.id, g.name, g.icon, g.owner_id FROM guilds g JOIN members m ON m.guild_id = g.id AND m.user_id = $2 WHERE g.id = $1",
    )
    .bind(id)
    .bind(me)
    .fetch_optional(db)
    .await?
    .ok_or(ApiError::NotFound)
}

fn guild_name(name: &str) -> ApiResult<String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(bad("server name must be 1-100 characters"));
    }
    Ok(name.to_string())
}

#[derive(Deserialize)]
struct NewGuild {
    name: String,
    /// A Discord template link or code to copy channels and roles from.
    #[serde(default)]
    template: Option<String>,
}

async fn create(State(st): State<AppState>, AuthUser(me): AuthUser, Json(body): Json<NewGuild>) -> ApiResult<Json<Guild>> {
    st.limits.check(format!("guild-create:{me}"), 3.0, 1.0 / 60.0)?;
    let name = guild_name(&body.name)?;
    let template = match body.template.as_deref().filter(|t| !t.trim().is_empty()) {
        Some(t) => super::templates::fetch(&st, me, t).await?,
        None => super::templates::default_template(&name),
    };
    let id = Id::new();
    let mut tx = st.db.begin().await?;
    sqlx::query("INSERT INTO guilds (id, name, owner_id) VALUES ($1, $2, $3)").bind(id).bind(&name).bind(me).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO members (guild_id, user_id) VALUES ($1, $2)").bind(id).bind(me).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO roles (id, guild_id, name, permissions, position) VALUES ($1, $1, '@everyone', $2, 0)")
        .bind(id)
        .bind(perms::DEFAULT)
        .execute(&mut *tx)
        .await?;
    super::templates::apply(&mut tx, id, &template).await?;
    tx.commit().await?;
    let guild = load_guild(&st.db, id).await?;
    st.hub.send(&[me], "GUILD_CREATE", &guild);
    Ok(Json(guild))
}

#[derive(Deserialize)]
struct GuildUpdate {
    name: Option<String>,
}

async fn update(State(st): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<Id>, Json(body): Json<GuildUpdate>) -> ApiResult<Json<GuildRow>> {
    guild_perms(&st.db, id, me).await?.require(perms::MANAGE_GUILD)?;
    if let Some(n) = body.name {
        sqlx::query("UPDATE guilds SET name = $2 WHERE id = $1").bind(id).bind(guild_name(&n)?).execute(&st.db).await?;
    }
    announce_update(&st, id, me).await
}

async fn announce_update(st: &AppState, id: Id, me: Id) -> ApiResult<Json<GuildRow>> {
    let g = guild_for(&st.db, id, me).await?;
    st.hub.send(&guild_members(&st.db, id).await?, "GUILD_UPDATE", &g);
    Ok(Json(g))
}

async fn upload_icon(State(st): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<Id>, mut mp: Multipart) -> ApiResult<Json<GuildRow>> {
    guild_perms(&st.db, id, me).await?.require(perms::MANAGE_GUILD)?;
    let field = mp.next_field().await.map_err(|e| bad(e.body_text()))?.ok_or_else(|| bad("missing file"))?;
    let ct = field.content_type().unwrap_or_default().to_string();
    if !uploads::is_image(&ct) {
        return Err(bad("must be a png, jpeg, gif or webp image"));
    }
    let name = field.file_name().unwrap_or("icon").to_string();
    let bytes = uploads::read_field(field, uploads::MAX_IMAGE).await?;
    uploads::reserve(&st, me, bytes.len()).await?;
    let url = uploads::save(&st, &format!("icons/{id}"), &name, &bytes).await?;
    sqlx::query("UPDATE guilds SET icon = $2 WHERE id = $1").bind(id).bind(url).execute(&st.db).await?;
    announce_update(&st, id, me).await
}

async fn remove(State(st): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<Id>) -> ApiResult<()> {
    if !guild_perms(&st.db, id, me).await?.owner {
        return Err(ApiError::Forbidden);
    }
    let members = guild_members(&st.db, id).await?;
    for u in &members {
        leave_voice_in(&st, *u, id).await;
    }
    sqlx::query("DELETE FROM guilds WHERE id = $1").bind(id).execute(&st.db).await?;
    st.hub.send(&members, "GUILD_DELETE", &serde_json::json!({ "id": id }));
    Ok(())
}

async fn leave_voice_in(st: &AppState, user: Id, guild: Id) {
    if st.voice.for_guilds(&[guild]).iter().any(|v| v.user_id == user) {
        voice::leave(st, user).await;
    }
}

pub async fn remove_member(st: &AppState, guild: Id, user: Id) -> ApiResult<()> {
    leave_voice_in(st, user, guild).await;
    sqlx::query("DELETE FROM members WHERE guild_id = $1 AND user_id = $2").bind(guild).bind(user).execute(&st.db).await?;
    st.hub.send(&[user], "GUILD_DELETE", &serde_json::json!({ "id": guild }));
    st.hub.send(&guild_members(&st.db, guild).await?, "GUILD_MEMBER_REMOVE", &serde_json::json!({ "guild_id": guild, "user_id": user }));
    Ok(())
}

async fn leave(State(st): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<Id>) -> ApiResult<()> {
    if guild_perms(&st.db, id, me).await?.owner {
        return Err(bad("the owner cannot leave; delete the server instead"));
    }
    remove_member(&st, id, me).await
}

/// Checks that `me` outranks `target` (owner outranks everyone; nobody outranks the owner).
async fn outranks(db: &PgPool, guild: Id, me: Id, target: Id) -> ApiResult<()> {
    let mine = guild_perms(db, guild, me).await?;
    let theirs = guild_perms(db, guild, target).await?;
    if theirs.owner || (!mine.owner && mine.top <= theirs.top) {
        return Err(bad("you can only manage members below your highest role"));
    }
    Ok(())
}

async fn kick(State(st): State<AppState>, AuthUser(me): AuthUser, Path((id, user)): Path<(Id, Id)>) -> ApiResult<()> {
    guild_perms(&st.db, id, me).await?.require(perms::KICK_MEMBERS)?;
    if user == me {
        return Err(bad("you cannot kick yourself"));
    }
    outranks(&st.db, id, me, user).await?;
    remove_member(&st, id, user).await
}

fn nickname(n: Option<String>) -> ApiResult<Option<String>> {
    let n = n.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
    if n.as_ref().is_some_and(|n| n.chars().count() > 32) {
        return Err(bad("nickname must be at most 32 characters"));
    }
    Ok(n)
}

async fn announce_member(st: &AppState, guild: Id, user: Id) -> ApiResult<Json<Member>> {
    let member = load_member(&st.db, guild, user).await?;
    st.hub.send(&guild_members(&st.db, guild).await?, "GUILD_MEMBER_UPDATE", &serde_json::json!({ "guild_id": guild, "member": member }));
    Ok(Json(member))
}

#[derive(Deserialize)]
struct SelfMemberUpdate {
    nickname: Option<String>,
}

async fn update_me(State(st): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<Id>, Json(body): Json<SelfMemberUpdate>) -> ApiResult<Json<Member>> {
    guild_perms(&st.db, id, me).await?.require(perms::CHANGE_NICKNAME)?;
    sqlx::query("UPDATE members SET nickname = $3 WHERE guild_id = $1 AND user_id = $2")
        .bind(id)
        .bind(me)
        .bind(nickname(body.nickname)?)
        .execute(&st.db)
        .await?;
    announce_member(&st, id, me).await
}

#[derive(Deserialize)]
struct MemberUpdate {
    /// Absent: unchanged. Empty string: cleared.
    nickname: Option<String>,
    roles: Option<Vec<Id>>,
}

async fn update_member(
    State(st): State<AppState>,
    AuthUser(me): AuthUser,
    Path((id, user)): Path<(Id, Id)>,
    Json(body): Json<MemberUpdate>,
) -> ApiResult<Json<Member>> {
    let mine = guild_perms(&st.db, id, me).await?;
    let current = load_member(&st.db, id, user).await?;
    if body.nickname.is_some() {
        if user == me {
            mine.require(perms::CHANGE_NICKNAME)?;
        } else {
            mine.require(perms::MANAGE_NICKNAMES)?;
            outranks(&st.db, id, me, user).await?;
        }
        sqlx::query("UPDATE members SET nickname = $3 WHERE guild_id = $1 AND user_id = $2")
            .bind(id)
            .bind(user)
            .bind(nickname(body.nickname)?)
            .execute(&st.db)
            .await?;
    }
    if let Some(wanted) = body.roles {
        mine.require(perms::MANAGE_ROLES)?;
        let roles = load_roles(&st.db, id).await?;
        // Only roles below my highest role can be added or removed.
        let changed = wanted.iter().filter(|r| !current.roles.contains(r)).chain(current.roles.iter().filter(|r| !wanted.contains(r)));
        for rid in changed {
            let role = roles.iter().find(|r| r.id == *rid && r.id != id).ok_or_else(|| bad("unknown role"))?;
            if !mine.owner && role.position >= mine.top {
                return Err(bad("you can only assign roles below your highest role"));
            }
        }
        let mut tx = st.db.begin().await?;
        sqlx::query("DELETE FROM member_roles WHERE guild_id = $1 AND user_id = $2").bind(id).bind(user).execute(&mut *tx).await?;
        for rid in &wanted {
            sqlx::query("INSERT INTO member_roles (guild_id, user_id, role_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING")
                .bind(id)
                .bind(user)
                .bind(rid)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
    }
    announce_member(&st, id, user).await
}
