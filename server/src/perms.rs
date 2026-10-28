//! Guild permissions. Bit values follow Discord's so they're familiar; only the ones linkord uses exist.

use sqlx::PgPool;

use crate::error::{ApiError, ApiResult};
use crate::id::Id;

pub const CREATE_INVITE: i64 = 1 << 0;
pub const KICK_MEMBERS: i64 = 1 << 1;
pub const ADMINISTRATOR: i64 = 1 << 3;
pub const MANAGE_CHANNELS: i64 = 1 << 4;
pub const MANAGE_GUILD: i64 = 1 << 5;
pub const ADD_REACTIONS: i64 = 1 << 6;
pub const SEND_MESSAGES: i64 = 1 << 11;
pub const MANAGE_MESSAGES: i64 = 1 << 13;
pub const ATTACH_FILES: i64 = 1 << 15;
pub const MENTION_EVERYONE: i64 = 1 << 17;
pub const CONNECT: i64 = 1 << 20;
pub const SPEAK: i64 = 1 << 21;
pub const CHANGE_NICKNAME: i64 = 1 << 26;
pub const MANAGE_NICKNAMES: i64 = 1 << 27;
pub const MANAGE_ROLES: i64 = 1 << 28;
pub const MANAGE_EMOJIS: i64 = 1 << 30;
pub const MANAGE_THREADS: i64 = 1 << 34;
pub const CREATE_THREADS: i64 = 1 << 35;

pub const ALL: i64 = CREATE_INVITE
    | KICK_MEMBERS
    | ADMINISTRATOR
    | MANAGE_CHANNELS
    | MANAGE_GUILD
    | ADD_REACTIONS
    | SEND_MESSAGES
    | MANAGE_MESSAGES
    | ATTACH_FILES
    | MENTION_EVERYONE
    | CONNECT
    | SPEAK
    | CHANGE_NICKNAME
    | MANAGE_NICKNAMES
    | MANAGE_ROLES
    | MANAGE_EMOJIS
    | MANAGE_THREADS
    | CREATE_THREADS;

/// What @everyone gets in a new server.
pub const DEFAULT: i64 = CREATE_INVITE | ADD_REACTIONS | SEND_MESSAGES | ATTACH_FILES | CONNECT | SPEAK | CHANGE_NICKNAME | CREATE_THREADS;

/// What participants can do in DMs and group DMs.
pub const DM: i64 = ADD_REACTIONS | SEND_MESSAGES | ATTACH_FILES;

#[derive(Debug, Clone, Copy)]
pub struct Perms {
    pub bits: i64,
    /// Position of the member's highest role; they can only manage roles below it. Owner: i32::MAX.
    pub top: i32,
    pub owner: bool,
}

impl Perms {
    pub fn dm() -> Perms {
        Perms { bits: DM, top: 0, owner: false }
    }

    pub fn has(&self, p: i64) -> bool {
        self.bits & ADMINISTRATOR != 0 || self.bits & p == p
    }

    pub fn require(&self, p: i64) -> ApiResult<()> {
        if self.has(p) {
            Ok(())
        } else {
            Err(ApiError::Forbidden)
        }
    }
}

/// The user's permissions in a guild. NotFound if they are not a member.
pub async fn guild_perms(db: &PgPool, guild: Id, user: Id) -> ApiResult<Perms> {
    let (owner_id, bits, top): (Id, i64, i32) = sqlx::query_as(
        "SELECT g.owner_id,
            (SELECT COALESCE(bit_or(r.permissions), 0) FROM roles r
              WHERE r.guild_id = g.id
                AND (r.id = g.id OR r.id IN (SELECT role_id FROM member_roles WHERE guild_id = g.id AND user_id = $2)))::BIGINT,
            (SELECT COALESCE(MAX(r.position), 0) FROM roles r JOIN member_roles mr ON mr.role_id = r.id
              WHERE mr.guild_id = g.id AND mr.user_id = $2)
         FROM guilds g JOIN members m ON m.guild_id = g.id AND m.user_id = $2 WHERE g.id = $1",
    )
    .bind(guild)
    .bind(user)
    .fetch_optional(db)
    .await?
    .ok_or(ApiError::NotFound)?;
    if owner_id == user {
        return Ok(Perms { bits: ALL, top: i32::MAX, owner: true });
    }
    Ok(Perms { bits, top, owner: false })
}
