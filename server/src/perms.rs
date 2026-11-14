//! Server and channel permissions, computed the way Discord does it. Bit values follow Discord's so they're
//! familiar; only the ones pottira uses exist.
//!
//! A member's server permissions are @everyone's plus those of all their roles (Administrator or owning the
//! server = everything). In a channel, its overwrites then apply in order: @everyone's, all of the member's
//! roles' together (denies first, then allows), then the member's own. Without View Channel the member has no
//! permissions there at all. Threads use their parent channel's overwrites. A channel in a category is "synced"
//! when its overwrites equal the category's; changing the category's overwrites changes synced channels too.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use sqlx::PgPool;

use crate::error::{ApiError, ApiResult};
use crate::id::Id;
use crate::models::kind;

pub const CREATE_INVITE: i64 = 1 << 0;
pub const KICK_MEMBERS: i64 = 1 << 1;
pub const ADMINISTRATOR: i64 = 1 << 3;
pub const MANAGE_CHANNELS: i64 = 1 << 4;
pub const MANAGE_GUILD: i64 = 1 << 5;
pub const ADD_REACTIONS: i64 = 1 << 6;
/// "Video": stream your screen or turn on your camera in voice channels.
pub const STREAM: i64 = 1 << 9;
pub const VIEW_CHANNEL: i64 = 1 << 10;
pub const SEND_MESSAGES: i64 = 1 << 11;
pub const MANAGE_MESSAGES: i64 = 1 << 13;
pub const ATTACH_FILES: i64 = 1 << 15;
pub const READ_MESSAGE_HISTORY: i64 = 1 << 16;
pub const MENTION_EVERYONE: i64 = 1 << 17;
pub const CONNECT: i64 = 1 << 20;
pub const SPEAK: i64 = 1 << 21;
/// Drag people between voice channels and disconnect them from calls.
pub const MOVE_MEMBERS: i64 = 1 << 24;
pub const CHANGE_NICKNAME: i64 = 1 << 26;
pub const MANAGE_NICKNAMES: i64 = 1 << 27;
/// In a channel: "Manage Permissions" (edit its overwrites).
pub const MANAGE_ROLES: i64 = 1 << 28;
pub const MANAGE_EMOJIS: i64 = 1 << 30;
pub const MANAGE_THREADS: i64 = 1 << 34;
pub const CREATE_THREADS: i64 = 1 << 35;
pub const USE_SOUNDBOARD: i64 = 1 << 42;

pub const ALL: i64 = CREATE_INVITE
    | KICK_MEMBERS
    | ADMINISTRATOR
    | MANAGE_CHANNELS
    | MANAGE_GUILD
    | ADD_REACTIONS
    | STREAM
    | VIEW_CHANNEL
    | SEND_MESSAGES
    | MANAGE_MESSAGES
    | ATTACH_FILES
    | READ_MESSAGE_HISTORY
    | MENTION_EVERYONE
    | CONNECT
    | SPEAK
    | MOVE_MEMBERS
    | CHANGE_NICKNAME
    | MANAGE_NICKNAMES
    | MANAGE_ROLES
    | MANAGE_EMOJIS
    | MANAGE_THREADS
    | CREATE_THREADS
    | USE_SOUNDBOARD;

/// Permissions a channel overwrite can allow or deny (the rest only exist server-wide).
pub const CHANNEL: i64 = CREATE_INVITE
    | MANAGE_CHANNELS
    | ADD_REACTIONS
    | STREAM
    | VIEW_CHANNEL
    | SEND_MESSAGES
    | MANAGE_MESSAGES
    | ATTACH_FILES
    | READ_MESSAGE_HISTORY
    | MENTION_EVERYONE
    | CONNECT
    | SPEAK
    | MOVE_MEMBERS
    | MANAGE_ROLES
    | MANAGE_THREADS
    | CREATE_THREADS
    | USE_SOUNDBOARD;

/// What @everyone gets in a new server.
pub const DEFAULT: i64 = CREATE_INVITE
    | ADD_REACTIONS
    | STREAM
    | VIEW_CHANNEL
    | SEND_MESSAGES
    | ATTACH_FILES
    | READ_MESSAGE_HISTORY
    | CONNECT
    | SPEAK
    | CHANGE_NICKNAME
    | CREATE_THREADS
    | USE_SOUNDBOARD;

/// What participants can do in DMs and group DMs.
pub const DM: i64 = VIEW_CHANNEL | READ_MESSAGE_HISTORY | ADD_REACTIONS | SEND_MESSAGES | ATTACH_FILES | STREAM | CONNECT | SPEAK | USE_SOUNDBOARD;

pub const OVERWRITE_ROLE: i16 = 0;
pub const OVERWRITE_MEMBER: i16 = 1;

/// A channel's permission overwrite for a role (`type` 0; the @everyone role's id is the server's) or a member (1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, sqlx::FromRow)]
pub struct Overwrite {
    pub id: Id,
    #[serde(rename = "type")]
    #[sqlx(rename = "kind")]
    pub kind: i16,
    pub allow: i64,
    pub deny: i64,
}

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

/// Discord's overwrite algorithm. `base` = the member's server permissions, `roles` = their role ids (without
/// @everyone), `ows` = the channel's overwrites.
pub fn apply_overwrites(base: i64, guild: Id, user: Id, roles: &[Id], ows: &[Overwrite]) -> i64 {
    if base & ADMINISTRATOR != 0 {
        return ALL;
    }
    let mut p = base;
    if let Some(o) = ows.iter().find(|o| o.kind == OVERWRITE_ROLE && o.id == guild) {
        p = (p & !o.deny) | o.allow;
    }
    let (mut allow, mut deny) = (0, 0);
    for o in ows.iter().filter(|o| o.kind == OVERWRITE_ROLE && o.id != guild && roles.contains(&o.id)) {
        allow |= o.allow;
        deny |= o.deny;
    }
    p = (p & !deny) | allow;
    if let Some(o) = ows.iter().find(|o| o.kind == OVERWRITE_MEMBER && o.id == user) {
        p = (p & !o.deny) | o.allow;
    }
    if p & VIEW_CHANNEL == 0 {
        return 0;
    }
    p
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

/// The channel whose overwrites apply: a thread's parent, otherwise the channel itself.
async fn overwrite_source(db: &PgPool, channel: Id) -> ApiResult<Id> {
    let (k, parent): (i16, Option<Id>) =
        sqlx::query_as("SELECT kind, parent_id FROM channels WHERE id = $1").bind(channel).fetch_optional(db).await?.ok_or(ApiError::NotFound)?;
    Ok(match (k, parent) {
        (kind::THREAD, Some(p)) => p,
        _ => channel,
    })
}

pub async fn load_overwrites(db: &PgPool, channel: Id) -> ApiResult<Vec<Overwrite>> {
    Ok(sqlx::query_as::<_, Overwrite>("SELECT target_id AS id, kind, allow, deny FROM channel_overwrites WHERE channel_id = $1 ORDER BY kind, target_id")
        .bind(channel)
        .fetch_all(db)
        .await?)
}

/// The user's permissions in a server channel (or thread). NotFound if they aren't a member; zero bits if they
/// can't see it.
pub async fn channel_perms(db: &PgPool, guild: Id, channel: Id, user: Id) -> ApiResult<Perms> {
    let base = guild_perms(db, guild, user).await?;
    if base.owner || base.bits & ADMINISTRATOR != 0 {
        return Ok(Perms { bits: ALL, ..base });
    }
    let roles: Vec<Id> = sqlx::query_scalar("SELECT role_id FROM member_roles WHERE guild_id = $1 AND user_id = $2")
        .bind(guild)
        .bind(user)
        .fetch_all(db)
        .await?;
    let ows = load_overwrites(db, overwrite_source(db, channel).await?).await?;
    Ok(Perms { bits: apply_overwrites(base.bits, guild, user, &roles, &ows), ..base })
}

#[derive(Debug, Clone)]
struct ChanInfo {
    kind: i16,
    parent: Option<Id>,
    archived: bool,
}

/// Everything needed to compute anyone's permissions in any channel of one server, loaded at once (for
/// audiences and the channel lists people get).
pub struct GuildCtx {
    pub guild: Id,
    owner: Id,
    roles: HashMap<Id, (i64, i32)>,
    members: HashMap<Id, Vec<Id>>,
    channels: HashMap<Id, ChanInfo>,
    overwrites: HashMap<Id, Vec<Overwrite>>,
}

impl GuildCtx {
    pub async fn load(db: &PgPool, guild: Id) -> ApiResult<GuildCtx> {
        let owner: Id = sqlx::query_scalar("SELECT owner_id FROM guilds WHERE id = $1").bind(guild).fetch_optional(db).await?.ok_or(ApiError::NotFound)?;
        let roles = sqlx::query_as::<_, (Id, i64, i32)>("SELECT id, permissions, position FROM roles WHERE guild_id = $1")
            .bind(guild)
            .fetch_all(db)
            .await?
            .into_iter()
            .map(|(id, p, pos)| (id, (p, pos)))
            .collect();
        let mut members: HashMap<Id, Vec<Id>> =
            sqlx::query_scalar::<_, Id>("SELECT user_id FROM members WHERE guild_id = $1").bind(guild).fetch_all(db).await?.into_iter().map(|u| (u, vec![])).collect();
        for (u, r) in sqlx::query_as::<_, (Id, Id)>("SELECT user_id, role_id FROM member_roles WHERE guild_id = $1").bind(guild).fetch_all(db).await? {
            if let Some(list) = members.get_mut(&u) {
                list.push(r);
            }
        }
        let channels = sqlx::query_as::<_, (Id, i16, Option<Id>, bool)>("SELECT id, kind, parent_id, archived FROM channels WHERE guild_id = $1")
            .bind(guild)
            .fetch_all(db)
            .await?
            .into_iter()
            .map(|(id, kind, parent, archived)| (id, ChanInfo { kind, parent, archived }))
            .collect();
        let mut overwrites: HashMap<Id, Vec<Overwrite>> = HashMap::new();
        for (ch, o) in sqlx::query_as::<_, (Id, Id, i16, i64, i64)>(
            "SELECT o.channel_id, o.target_id, o.kind, o.allow, o.deny FROM channel_overwrites o JOIN channels c ON c.id = o.channel_id
             WHERE c.guild_id = $1 ORDER BY o.kind, o.target_id",
        )
        .bind(guild)
        .fetch_all(db)
        .await?
        .into_iter()
        .map(|(ch, id, kind, allow, deny)| (ch, Overwrite { id, kind, allow, deny }))
        {
            overwrites.entry(ch).or_default().push(o);
        }
        Ok(GuildCtx { guild, owner, roles, members, channels, overwrites })
    }

    pub fn kind_of(&self, channel: Id) -> Option<i16> {
        self.channels.get(&channel).map(|c| c.kind)
    }

    pub fn members(&self) -> impl Iterator<Item = Id> + '_ {
        self.members.keys().copied()
    }

    /// The channel's own overwrites (as stored; threads have none).
    pub fn overwrites(&self, channel: Id) -> Vec<Overwrite> {
        self.overwrites.get(&channel).cloned().unwrap_or_default()
    }

    pub fn base(&self, user: Id) -> i64 {
        if user == self.owner {
            return ALL;
        }
        let Some(mine) = self.members.get(&user) else { return 0 };
        let mut bits = self.roles.get(&self.guild).map(|r| r.0).unwrap_or(0);
        for r in mine {
            bits |= self.roles.get(r).map(|r| r.0).unwrap_or(0);
        }
        bits
    }

    pub fn in_channel(&self, user: Id, channel: Id) -> i64 {
        if !self.members.contains_key(&user) {
            return 0;
        }
        let base = self.base(user);
        if user == self.owner || base & ADMINISTRATOR != 0 {
            return ALL;
        }
        let source = match self.channels.get(&channel) {
            Some(ChanInfo { kind: kind::THREAD, parent: Some(p), .. }) => *p,
            Some(_) => channel,
            None => return 0,
        };
        let ows = self.overwrites.get(&source).map(|v| v.as_slice()).unwrap_or(&[]);
        apply_overwrites(base, self.guild, user, &self.members[&user], ows)
    }

    pub fn can(&self, user: Id, channel: Id, p: i64) -> bool {
        let bits = self.in_channel(user, channel);
        bits & ADMINISTRATOR != 0 || bits & p == p
    }

    /// Members who can see the channel.
    pub fn viewers(&self, channel: Id) -> Vec<Id> {
        self.members().filter(|u| self.can(*u, channel, VIEW_CHANNEL)).collect()
    }

    /// The channels the user gets in their channel list: those they can see (archived threads left out), and
    /// categories that hold one of them even when the category itself is hidden, like Discord.
    pub fn visible_channels(&self, user: Id) -> HashSet<Id> {
        let mut out: HashSet<Id> = self
            .channels
            .iter()
            .filter(|(id, c)| !(c.kind == kind::THREAD && c.archived) && self.can(user, **id, VIEW_CHANNEL))
            .map(|(id, _)| *id)
            .collect();
        let parents: Vec<Id> = out
            .iter()
            .filter_map(|id| self.channels.get(id))
            .filter(|c| c.kind != kind::THREAD)
            .filter_map(|c| c.parent)
            .filter(|p| self.channels.get(p).is_some_and(|c| c.kind == kind::CATEGORY))
            .collect();
        out.extend(parents);
        out
    }

    /// Channels whose messages the user may read (search).
    pub fn readable_channels(&self, user: Id) -> Vec<Id> {
        self.channels.keys().copied().filter(|c| self.can(user, *c, VIEW_CHANNEL | READ_MESSAGE_HISTORY)).collect()
    }

    /// Who sees which channels; diffed before/after a permission change (see `gateway::announce_visibility`).
    pub fn visibility(&self) -> HashMap<Id, HashSet<Id>> {
        self.members().map(|u| (u, self.visible_channels(u))).collect()
    }
}

/// Members who can see a server channel.
pub async fn channel_viewers(db: &PgPool, guild: Id, channel: Id) -> ApiResult<Vec<Id>> {
    Ok(GuildCtx::load(db, guild).await?.viewers(channel))
}

#[cfg(test)]
mod tests {
    use super::*;

    const G: Id = Id(1);
    const U: Id = Id(2);
    const R1: Id = Id(10);
    const R2: Id = Id(11);

    fn ow(id: Id, kind: i16, allow: i64, deny: i64) -> Overwrite {
        Overwrite { id, kind, allow, deny }
    }

    #[test]
    fn no_overwrites_keeps_base() {
        assert_eq!(apply_overwrites(DEFAULT, G, U, &[], &[]), DEFAULT);
    }

    #[test]
    fn everyone_deny_hides_channel() {
        let ows = [ow(G, OVERWRITE_ROLE, 0, VIEW_CHANNEL)];
        assert_eq!(apply_overwrites(DEFAULT, G, U, &[], &ows), 0);
    }

    #[test]
    fn role_allow_beats_everyone_deny() {
        let ows = [ow(G, OVERWRITE_ROLE, 0, VIEW_CHANNEL), ow(R1, OVERWRITE_ROLE, VIEW_CHANNEL, 0)];
        assert_ne!(apply_overwrites(DEFAULT, G, U, &[R1], &ows) & VIEW_CHANNEL, 0);
        assert_eq!(apply_overwrites(DEFAULT, G, U, &[], &ows), 0);
    }

    #[test]
    fn role_allow_beats_other_role_deny() {
        // Allows of all roles are applied after all denies, so any role allowing wins.
        let ows = [ow(R1, OVERWRITE_ROLE, 0, SEND_MESSAGES), ow(R2, OVERWRITE_ROLE, SEND_MESSAGES, 0)];
        assert_ne!(apply_overwrites(DEFAULT, G, U, &[R1, R2], &ows) & SEND_MESSAGES, 0);
        assert_eq!(apply_overwrites(DEFAULT, G, U, &[R1], &ows) & SEND_MESSAGES, 0);
    }

    #[test]
    fn member_overwrite_is_last() {
        let ows = [ow(R1, OVERWRITE_ROLE, SEND_MESSAGES, 0), ow(U, OVERWRITE_MEMBER, 0, SEND_MESSAGES)];
        assert_eq!(apply_overwrites(DEFAULT, G, U, &[R1], &ows) & SEND_MESSAGES, 0);
        let ows = [ow(G, OVERWRITE_ROLE, 0, VIEW_CHANNEL), ow(U, OVERWRITE_MEMBER, VIEW_CHANNEL, 0)];
        assert_ne!(apply_overwrites(DEFAULT, G, U, &[], &ows) & VIEW_CHANNEL, 0);
    }

    #[test]
    fn administrator_ignores_overwrites() {
        let ows = [ow(U, OVERWRITE_MEMBER, 0, VIEW_CHANNEL)];
        assert_eq!(apply_overwrites(ADMINISTRATOR, G, U, &[], &ows), ALL);
    }
}
