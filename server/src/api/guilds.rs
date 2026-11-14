use axum::extract::{Multipart, Path, State};
use axum::routing::{delete, get, patch, post, put};
use axum::{Json, Router};
use serde::Deserialize;
use sqlx::PgPool;

use crate::auth::AuthUser;
use crate::error::{bad, ApiError, ApiResult};
use crate::gateway::guild_members;
use crate::id::Id;
use crate::models::{kind, prefixed, Channel, Emoji, Guild, GuildRow, Member, Role, User, CHANNEL_COLS, GUILD_COLS, ROLE_COLS, USER_COLS};
use crate::perms::{self, guild_perms};
use crate::state::AppState;
use crate::{uploads, voice};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/guilds", post(create))
        .route("/guilds/{id}", patch(update).delete(remove))
        .route("/guilds/{id}/icon", post(upload_icon))
        .route("/guilds/{id}/banner", post(upload_banner).delete(remove_banner))
        .route("/guilds/{id}/members/@me", delete(leave).patch(update_me))
        .route(
            "/guilds/{id}/members/@me/avatar",
            post(|st, me, id, mp| upload_member_image(st, me, id, mp, "avatar")).delete(|st, me, id| clear_member_image(st, me, id, "avatar")),
        )
        .route(
            "/guilds/{id}/members/@me/banner",
            post(|st, me, id, mp| upload_member_image(st, me, id, mp, "banner")).delete(|st, me, id| clear_member_image(st, me, id, "banner")),
        )
        .route("/guilds/{id}/members/{user}", delete(kick).patch(update_member))
        .route("/guilds/{id}/bans", get(bans))
        .route("/guilds/{id}/bans/{user}", put(ban).delete(unban))
}

#[derive(sqlx::FromRow)]
struct MemberRow {
    #[sqlx(flatten)]
    user: User,
    nickname: Option<String>,
    member_avatar: Option<String>,
    member_banner: Option<String>,
    member_bio: Option<String>,
    joined_at: chrono::DateTime<chrono::Utc>,
    roles: Vec<Id>,
}

async fn load_members(db: &PgPool, guild: Id, only: Option<Id>) -> ApiResult<Vec<Member>> {
    let rows = sqlx::query_as::<_, MemberRow>(&format!(
        "SELECT {}, m.nickname, m.avatar AS member_avatar, m.banner AS member_banner, m.bio AS member_bio, m.joined_at,
                COALESCE(array_agg(mr.role_id) FILTER (WHERE mr.role_id IS NOT NULL), '{{}}') AS roles
         FROM members m JOIN users u ON u.id = m.user_id
         LEFT JOIN member_roles mr ON mr.guild_id = m.guild_id AND mr.user_id = m.user_id
         WHERE m.guild_id = $1 AND ($2::BIGINT IS NULL OR m.user_id = $2)
         GROUP BY u.id, m.nickname, m.avatar, m.banner, m.bio, m.joined_at ORDER BY m.joined_at",
        prefixed(USER_COLS, "u")
    ))
    .bind(guild)
    .bind(only)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| Member {
            user: r.user,
            nickname: r.nickname,
            avatar: r.member_avatar,
            banner: r.member_banner,
            bio: r.member_bio,
            joined_at: r.joined_at,
            roles: r.roles,
        })
        .collect())
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

/// The server as `viewer` gets it: only the channels they can see, with their overwrites.
pub async fn load_guild(db: &PgPool, id: Id, viewer: Id) -> ApiResult<Guild> {
    let guild = sqlx::query_as::<_, GuildRow>(&format!("SELECT {GUILD_COLS} FROM guilds WHERE id = $1"))
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
    let ctx = crate::perms::GuildCtx::load(db, id).await?;
    let visible = ctx.visible_channels(viewer);
    let channels = channels
        .into_iter()
        .filter(|c| visible.contains(&c.id))
        .map(|mut c| {
            if c.kind != kind::THREAD {
                c.permission_overwrites = Some(ctx.overwrites(c.id));
            }
            c
        })
        .collect();
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
    sqlx::query_as::<_, GuildRow>(&format!(
        "SELECT {} FROM guilds g JOIN members m ON m.guild_id = g.id AND m.user_id = $2 WHERE g.id = $1",
        prefixed(GUILD_COLS, "g")
    ))
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
}

async fn create(State(st): State<AppState>, AuthUser(me): AuthUser, Json(body): Json<NewGuild>) -> ApiResult<Json<Guild>> {
    st.limits.check(format!("guild-create:{me}"), 3.0, 1.0 / 60.0)?;
    tracing::info!(user = %me, "server created");
    let name = guild_name(&body.name)?;
    let template = super::templates::default_template();
    let id = Id::new();
    let mut tx = st.db.begin().await?;
    sqlx::query("INSERT INTO guilds (id, name, owner_id) VALUES ($1, $2, $3)").bind(id).bind(&name).bind(me).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO members (guild_id, user_id) VALUES ($1, $2)").bind(id).bind(me).execute(&mut *tx).await?;
    // Kass, the music bot, comes with every server (kick him to remove him), unless its creator turned that off
    // (Settings -> Kass).
    let with_kass: bool = sqlx::query_scalar("SELECT kass_new_servers FROM users WHERE id = $1").bind(me).fetch_one(&mut *tx).await?;
    match crate::music::bot_id(&st) {
        Some(bot) if with_kass => {
            sqlx::query("INSERT INTO members (guild_id, user_id) VALUES ($1, $2)").bind(id).bind(bot).execute(&mut *tx).await?;
        }
        _ => {
            sqlx::query("UPDATE guilds SET music_bot = false WHERE id = $1").bind(id).execute(&mut *tx).await?;
        }
    }
    sqlx::query("INSERT INTO roles (id, guild_id, name, permissions, position) VALUES ($1, $1, '@everyone', $2, 0)")
        .bind(id)
        .bind(perms::DEFAULT)
        .execute(&mut *tx)
        .await?;
    super::templates::apply(&mut tx, id, &template).await?;
    tx.commit().await?;
    let guild = load_guild(&st.db, id, me).await?;
    st.hub.send(&[me], "GUILD_CREATE", &guild);
    Ok(Json(guild))
}

#[derive(Deserialize)]
struct GuildUpdate {
    name: Option<String>,
    /// Channel for "joined the server" messages; null = the first text channel.
    #[serde(default, deserialize_with = "double_option")]
    system_channel_id: Option<Option<Id>>,
    join_messages: Option<bool>,
    /// AFK voice channel; null turns moving idle people off.
    #[serde(default, deserialize_with = "double_option")]
    afk_channel_id: Option<Option<Id>>,
    /// Seconds without talking before someone is moved to the AFK channel.
    afk_timeout: Option<i32>,
}

/// Tells "missing" (leave as it is) apart from `null` (clear it).
fn double_option<'de, T: Deserialize<'de>, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(d).map(Some)
}

/// Channel kinds an id must be in this server: for the system channel (text) and the AFK channel (voice).
async fn guild_channel_of_kind(db: &PgPool, guild: Id, channel: Id, k: i16) -> ApiResult<()> {
    let ok: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM channels WHERE id = $1 AND guild_id = $2 AND kind = $3)")
        .bind(channel)
        .bind(guild)
        .bind(k)
        .fetch_one(db)
        .await?;
    if ok {
        Ok(())
    } else {
        Err(bad("unknown channel"))
    }
}

/// Seconds of silence the AFK channel can be set to, like Discord's choices.
const AFK_TIMEOUTS: [i32; 5] = [60, 300, 900, 1800, 3600];

async fn update(State(st): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<Id>, Json(body): Json<GuildUpdate>) -> ApiResult<Json<GuildRow>> {
    guild_perms(&st.db, id, me).await?.require(perms::MANAGE_GUILD)?;
    if let Some(n) = body.name {
        sqlx::query("UPDATE guilds SET name = $2 WHERE id = $1").bind(id).bind(guild_name(&n)?).execute(&st.db).await?;
    }
    if let Some(ch) = body.system_channel_id {
        if let Some(c) = ch {
            guild_channel_of_kind(&st.db, id, c, kind::TEXT).await?;
        }
        sqlx::query("UPDATE guilds SET system_channel_id = $2 WHERE id = $1").bind(id).bind(ch).execute(&st.db).await?;
    }
    if let Some(on) = body.join_messages {
        sqlx::query("UPDATE guilds SET join_messages = $2 WHERE id = $1").bind(id).bind(on).execute(&st.db).await?;
    }
    if let Some(ch) = body.afk_channel_id {
        if let Some(c) = ch {
            guild_channel_of_kind(&st.db, id, c, kind::VOICE).await?;
        }
        sqlx::query("UPDATE guilds SET afk_channel_id = $2 WHERE id = $1").bind(id).bind(ch).execute(&st.db).await?;
    }
    if let Some(t) = body.afk_timeout {
        if !AFK_TIMEOUTS.contains(&t) {
            return Err(bad("unknown AFK timeout"));
        }
        sqlx::query("UPDATE guilds SET afk_timeout = $2 WHERE id = $1").bind(id).bind(t).execute(&st.db).await?;
    }
    announce_update(&st, id, me).await
}

/// "<user> joined the server." in the server's system channel (the first text channel unless set).
pub async fn welcome(st: &AppState, g: &GuildRow, user: Id) {
    tracing::info!(user = %user, guild = %g.id, "joined a server");
    if !g.join_messages {
        return;
    }
    let channel = match g.system_channel_id {
        Some(c) => Some(c),
        None => sqlx::query_scalar(
            "SELECT c.id FROM channels c LEFT JOIN channels p ON p.id = c.parent_id
             WHERE c.guild_id = $1 AND c.kind = $2 ORDER BY (c.parent_id IS NOT NULL), p.position, c.position, c.id LIMIT 1",
        )
        .bind(g.id)
        .bind(kind::TEXT)
        .fetch_optional(&st.db)
        .await
        .ok()
        .flatten(),
    };
    if let Some(c) = channel {
        if let Err(e) = crate::api::messages::post_system_message(st, c, user, crate::models::message_type::JOIN, None).await {
            tracing::warn!("join message failed: {e}");
        }
    }
}

pub async fn announce_update(st: &AppState, id: Id, me: Id) -> ApiResult<Json<GuildRow>> {
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
    let bytes = uploads::read_field(field, uploads::MAX_IMAGE).await?;
    let name = uploads::image_name("icon", &bytes)?;
    uploads::reserve(&st, me, bytes.len()).await?;
    let url = uploads::save(&st, &format!("icons/{id}"), &name, &bytes).await?;
    sqlx::query("UPDATE guilds SET icon = $2 WHERE id = $1").bind(id).bind(url).execute(&st.db).await?;
    announce_update(&st, id, me).await
}

/// The picture at the top of the channel list, behind the server name.
async fn upload_banner(State(st): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<Id>, mut mp: Multipart) -> ApiResult<Json<GuildRow>> {
    guild_perms(&st.db, id, me).await?.require(perms::MANAGE_GUILD)?;
    let field = mp.next_field().await.map_err(|e| bad(e.body_text()))?.ok_or_else(|| bad("missing file"))?;
    if !uploads::is_image(field.content_type().unwrap_or_default()) {
        return Err(bad("must be a png, jpeg, gif or webp image"));
    }
    let bytes = uploads::read_field(field, 8 * 1024 * 1024).await?;
    let name = uploads::image_name("banner", &bytes)?;
    uploads::reserve(&st, me, bytes.len()).await?;
    let url = uploads::save(&st, &format!("banners/{id}"), &name, &bytes).await?;
    sqlx::query("UPDATE guilds SET banner = $2 WHERE id = $1").bind(id).bind(url).execute(&st.db).await?;
    announce_update(&st, id, me).await
}

async fn remove_banner(State(st): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<Id>) -> ApiResult<Json<GuildRow>> {
    guild_perms(&st.db, id, me).await?.require(perms::MANAGE_GUILD)?;
    sqlx::query("UPDATE guilds SET banner = NULL WHERE id = $1").bind(id).execute(&st.db).await?;
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
    // Their server profile goes with the membership.
    let _ = tokio::fs::remove_dir_all(st.cfg.uploads_dir().join("member-profiles").join(guild.to_string()).join(user.to_string())).await;
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
    if crate::music::bot_id(&st) == Some(user) {
        crate::music::removed_from(&st, id).await;
    }
    remove_member(&st, id, user).await
}

/// Removes someone and keeps them out: invites stop working for them until they're unbanned.
async fn ban(State(st): State<AppState>, AuthUser(me): AuthUser, Path((id, user)): Path<(Id, Id)>) -> ApiResult<()> {
    guild_perms(&st.db, id, me).await?.require(perms::KICK_MEMBERS)?;
    if user == me {
        return Err(bad("you cannot ban yourself"));
    }
    if crate::music::bot_id(&st) == Some(user) {
        return Err(bad("Kass can't be banned; remove him from the server instead"));
    }
    if crate::steve::bot_id(&st) == Some(user) {
        return Err(bad("Steve can't be banned; remove him from the server instead"));
    }
    let member: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM members WHERE guild_id = $1 AND user_id = $2)").bind(id).bind(user).fetch_one(&st.db).await?;
    if member {
        outranks(&st.db, id, me, user).await?;
    }
    sqlx::query("INSERT INTO guild_bans (guild_id, user_id, banned_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING").bind(id).bind(user).bind(me).execute(&st.db).await?;
    tracing::info!(guild = %id, user = %user, by = %me, "banned from a server");
    if member {
        remove_member(&st, id, user).await?;
    }
    Ok(())
}

async fn unban(State(st): State<AppState>, AuthUser(me): AuthUser, Path((id, user)): Path<(Id, Id)>) -> ApiResult<()> {
    guild_perms(&st.db, id, me).await?.require(perms::KICK_MEMBERS)?;
    sqlx::query("DELETE FROM guild_bans WHERE guild_id = $1 AND user_id = $2").bind(id).bind(user).execute(&st.db).await?;
    Ok(())
}

async fn bans(State(st): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<Id>) -> ApiResult<Json<Vec<crate::models::User>>> {
    guild_perms(&st.db, id, me).await?.require(perms::KICK_MEMBERS)?;
    let ids: Vec<Id> = sqlx::query_scalar("SELECT user_id FROM guild_bans WHERE guild_id = $1 ORDER BY created_at DESC LIMIT 500").bind(id).fetch_all(&st.db).await?;
    let mut users = Vec::with_capacity(ids.len());
    for user in ids {
        users.push(crate::models::User::get(&st.db, user).await?);
    }
    Ok(Json(users))
}

fn nickname(n: Option<String>) -> ApiResult<Option<String>> {
    let n = n.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
    if n.as_ref().is_some_and(|n| n.chars().count() > 32) {
        return Err(bad("nickname must be at most 32 characters"));
    }
    Ok(n)
}

pub async fn announce_member(st: &AppState, guild: Id, user: Id) -> ApiResult<Json<Member>> {
    let member = load_member(&st.db, guild, user).await?;
    st.hub.send(&guild_members(&st.db, guild).await?, "GUILD_MEMBER_UPDATE", &serde_json::json!({ "guild_id": guild, "member": member }));
    Ok(Json(member))
}

#[derive(Deserialize)]
struct SelfMemberUpdate {
    nickname: Option<String>,
    /// Server profile about me. Absent: unchanged; empty: back to the account's own.
    bio: Option<String>,
}

async fn update_me(State(st): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<Id>, Json(body): Json<SelfMemberUpdate>) -> ApiResult<Json<Member>> {
    let mine = guild_perms(&st.db, id, me).await?;
    if body.nickname.is_some() {
        mine.require(perms::CHANGE_NICKNAME)?;
        sqlx::query("UPDATE members SET nickname = $3 WHERE guild_id = $1 AND user_id = $2")
            .bind(id)
            .bind(me)
            .bind(nickname(body.nickname)?)
            .execute(&st.db)
            .await?;
    }
    if let Some(bio) = body.bio {
        if bio.chars().count() > 190 {
            return Err(bad("bio must be at most 190 characters"));
        }
        let bio = Some(bio).filter(|b| !b.trim().is_empty());
        sqlx::query("UPDATE members SET bio = $3 WHERE guild_id = $1 AND user_id = $2").bind(id).bind(me).bind(bio).execute(&st.db).await?;
    }
    announce_member(&st, id, me).await
}

/// Server profile picture or banner (`which`): the same files and cropping as the account's own (users.rs).
async fn upload_member_image(
    State(st): State<AppState>,
    AuthUser(me): AuthUser,
    Path(id): Path<Id>,
    mp: Multipart,
    which: &'static str,
) -> ApiResult<Json<Member>> {
    guild_perms(&st.db, id, me).await?;
    let (name, bytes) = crate::api::users::read_image(&st, mp, which).await?;
    uploads::reserve(&st, me, bytes.len()).await?;
    let dir = format!("member-profiles/{id}/{me}/{which}s");
    // One picture (and one banner) per server: the previous file goes.
    let _ = tokio::fs::remove_dir_all(st.cfg.uploads_dir().join(&dir)).await;
    let url = uploads::save(&st, &dir, &name, &bytes).await?;
    sqlx::query(&format!("UPDATE members SET {which} = $3 WHERE guild_id = $1 AND user_id = $2")).bind(id).bind(me).bind(&url).execute(&st.db).await?;
    announce_member(&st, id, me).await
}

async fn clear_member_image(State(st): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<Id>, which: &'static str) -> ApiResult<Json<Member>> {
    guild_perms(&st.db, id, me).await?;
    sqlx::query(&format!("UPDATE members SET {which} = NULL WHERE guild_id = $1 AND user_id = $2")).bind(id).bind(me).execute(&st.db).await?;
    let _ = tokio::fs::remove_dir_all(st.cfg.uploads_dir().join(format!("member-profiles/{id}/{me}/{which}s"))).await;
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
        let before = crate::gateway::visibility(&st.db, id).await?;
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
        let member = announce_member(&st, id, user).await?;
        crate::gateway::announce_visibility(&st, id, before).await?;
        return Ok(member);
    }
    announce_member(&st, id, user).await
}
