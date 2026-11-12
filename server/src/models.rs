use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::types::Json;
use sqlx::{FromRow, PgPool};

use crate::error::{ApiError, ApiResult};
use crate::id::Id;

pub const USER_COLS: &str = "id, username, display_name, avatar, banner, nameplate, accent_color, bio, pronouns, birthday, status, bot, needs_username";

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct User {
    pub id: Id,
    pub username: String,
    pub display_name: Option<String>,
    pub avatar: Option<String>,
    pub banner: Option<String>,
    pub nameplate: Option<String>,
    pub accent_color: Option<i32>,
    pub bio: String,
    /// Free text like "she/her", up to 40 characters ('' = none).
    pub pronouns: String,
    /// 'MM-DD', or 'YYYY-MM-DD' when they show the year too (clients show a cake on the day).
    pub birthday: Option<String>,
    /// A bot account (music.rs), shown with a BOT tag.
    pub bot: bool,
    /// The user's chosen status. Only sent to the user themselves; others see presence.
    #[serde(skip)]
    pub status: String,
    /// Signed up with a username someone else had: must pick another (only sent to the user themselves).
    #[serde(skip)]
    pub needs_username: bool,
}

/// Same as [`User`] but includes the private status field (for the user's own client).
#[derive(Serialize)]
pub struct SelfUser<'a> {
    #[serde(flatten)]
    pub user: &'a User,
    pub status: &'a str,
    pub needs_username: bool,
}

impl User {
    /// What someone with no connection to this person sees.
    pub fn outline(self) -> User {
        User { banner: None, nameplate: None, accent_color: None, bio: String::new(), pronouns: String::new(), birthday: None, ..self }
    }

    pub fn me(&self) -> SelfUser<'_> {
        SelfUser { user: self, status: &self.status, needs_username: self.needs_username }
    }

    pub async fn get(db: &PgPool, id: Id) -> ApiResult<User> {
        sqlx::query_as::<_, User>(&format!("SELECT {USER_COLS} FROM users WHERE id = $1"))
            .bind(id)
            .fetch_optional(db)
            .await?
            .ok_or(ApiError::NotFound)
    }

    pub async fn get_many(db: &PgPool, ids: &[Id]) -> ApiResult<Vec<User>> {
        Ok(sqlx::query_as::<_, User>(&format!("SELECT {USER_COLS} FROM users WHERE id = ANY($1)"))
            .bind(ids)
            .fetch_all(db)
            .await?)
    }
}

/// Prefixes each column in a comma-separated list, for joins.
pub fn prefixed(cols: &str, alias: &str) -> String {
    cols.split(", ").map(|c| format!("{alias}.{c}")).collect::<Vec<_>>().join(", ")
}

/// Discord-style username: 2-32 chars of a-z, 0-9, `_` and `.`, no consecutive dots.
pub fn validate_username(name: &str) -> Result<(), &'static str> {
    if !(2..=32).contains(&name.len()) {
        return Err("username must be 2-32 characters");
    }
    if !name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '.') {
        return Err("username may only contain lowercase letters, numbers, '_' and '.'");
    }
    if name.contains("..") {
        return Err("username cannot contain consecutive dots");
    }
    Ok(())
}

pub mod kind {
    pub const TEXT: i16 = 0;
    pub const DM: i16 = 1;
    pub const VOICE: i16 = 2;
    pub const GROUP_DM: i16 = 3;
    pub const CATEGORY: i16 = 4;
    pub const THREAD: i16 = 11;

    pub fn is_private(k: i16) -> bool {
        k == DM || k == GROUP_DM
    }

    /// Voice channels have their own chat, like Discord's text in voice.
    pub fn has_messages(k: i16) -> bool {
        matches!(k, TEXT | DM | GROUP_DM | THREAD | VOICE)
    }
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Channel {
    pub id: Id,
    pub guild_id: Option<Id>,
    pub kind: i16,
    pub name: String,
    pub topic: String,
    pub position: i32,
    pub parent_id: Option<Id>,
    pub last_message_id: Option<Id>,
    pub owner_id: Option<Id>,
    pub thread_message_id: Option<Id>,
    pub archived: bool,
    pub message_count: i32,
    /// Server channels and categories: their permission overwrites (perms.rs). Left out of events that don't
    /// change them (clients keep what they have), and of threads (they follow their parent).
    #[sqlx(skip)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_overwrites: Option<Vec<crate::perms::Overwrite>>,
}

pub const CHANNEL_COLS: &str =
    "id, guild_id, kind, name, topic, position, parent_id, last_message_id, owner_id, thread_message_id, archived, message_count";

impl Channel {
    pub async fn get(db: &PgPool, id: Id) -> ApiResult<Channel> {
        sqlx::query_as::<_, Channel>(&format!("SELECT {CHANNEL_COLS} FROM channels WHERE id = $1"))
            .bind(id)
            .fetch_optional(db)
            .await?
            .ok_or(ApiError::NotFound)
    }

    /// The channel with its permission overwrites filled in (server channels and categories).
    pub async fn with_overwrites(mut self, db: &PgPool) -> ApiResult<Channel> {
        if self.guild_id.is_some() && self.kind != kind::THREAD {
            self.permission_overwrites = Some(crate::perms::load_overwrites(db, self.id).await?);
        }
        Ok(self)
    }
}

/// DM or group DM with its participants.
#[derive(Serialize)]
pub struct DmChannel {
    #[serde(flatten)]
    pub channel: Channel,
    pub recipients: Vec<User>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct GuildRow {
    pub id: Id,
    pub name: String,
    pub icon: Option<String>,
    pub owner_id: Id,
    /// Where "joined the server" messages go; None = the first text channel.
    pub system_channel_id: Option<Id>,
    pub join_messages: bool,
    /// Picture behind the server name at the top of the channel list.
    pub banner: Option<String>,
    /// Voice channel idle people are moved to, after `afk_timeout` seconds.
    pub afk_channel_id: Option<Id>,
    pub afk_timeout: i32,
}

pub const GUILD_COLS: &str = "id, name, icon, owner_id, system_channel_id, join_messages, banner, afk_channel_id, afk_timeout";

/// Message types (Discord's numbers).
pub mod message_type {
    pub const DEFAULT: i16 = 0;
    /// "<user> pinned a message to this channel"; reply_to is the pinned message.
    pub const PINNED: i16 = 6;
    /// "<user> joined the server."
    pub const JOIN: i16 = 7;
    /// "Join my League of Legends lobby" (league.rs): embeds[0] = {type: "league_invite", league: the lobby then}.
    pub const LEAGUE_INVITE: i16 = 8;
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Role {
    pub id: Id,
    pub guild_id: Id,
    pub name: String,
    pub color: Option<i32>,
    pub permissions: i64,
    pub position: i32,
    pub hoist: bool,
    pub mentionable: bool,
}

pub const ROLE_COLS: &str = "id, guild_id, name, color, permissions, position, hoist, mentionable";

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Emoji {
    pub id: Id,
    pub guild_id: Id,
    pub name: String,
    pub animated: bool,
}

#[derive(Serialize, Clone)]
pub struct Member {
    pub user: User,
    pub nickname: Option<String>,
    /// Server profile: picture, banner and about me used only in this server (absent = the account's own).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub banner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bio: Option<String>,
    pub joined_at: DateTime<Utc>,
    pub roles: Vec<Id>,
}

#[derive(Serialize)]
pub struct Guild {
    #[serde(flatten)]
    pub guild: GuildRow,
    pub channels: Vec<Channel>,
    pub members: Vec<Member>,
    pub roles: Vec<Role>,
    pub emojis: Vec<Emoji>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Attachment {
    pub id: Id,
    pub filename: String,
    pub url: String,
    pub size: u64,
    pub content_type: String,
    /// Voice messages: length in seconds and a base64 waveform (one byte of loudness per bar), like Discord's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_secs: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waveform: Option<String>,
    /// Images: size in pixels, so clients can keep their place in the chat before the picture loads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
}

#[derive(Debug, Clone, FromRow)]
pub struct MessageRow {
    pub id: Id,
    pub channel_id: Id,
    pub author_id: Id,
    pub content: String,
    pub reply_to: Option<Id>,
    pub attachments: Json<Vec<Attachment>>,
    pub embeds: Json<serde_json::Value>,
    pub mention_everyone: bool,
    pub pinned_at: Option<DateTime<Utc>>,
    pub thread_id: Option<Id>,
    pub edited_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub forwarded: Option<Json<Forwarded>>,
    pub interaction: Option<Json<InteractionRow>>,
    #[sqlx(rename = "type")]
    pub kind: i16,
}

pub const MESSAGE_COLS: &str =
    "id, channel_id, author_id, content, reply_to, attachments, embeds, mention_everyone, pinned_at, thread_id, edited_at, created_at, forwarded, interaction, type";

/// The slash command a bot message answers, as stored.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct InteractionRow {
    pub name: String,
    pub user_id: Id,
}

/// The slash command a bot message answers, with who used it.
#[derive(Serialize, Clone)]
pub struct Interaction {
    pub name: String,
    pub user: User,
}

/// A forwarded message's copy of the original (Discord's message snapshot): content, attachments and embeds as
/// they were, plus where the original was so people who can see that channel can jump to it.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Forwarded {
    pub message_id: Id,
    pub channel_id: Id,
    pub guild_id: Option<Id>,
    pub content: String,
    pub attachments: Vec<Attachment>,
    pub embeds: serde_json::Value,
    pub created_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edited_at: Option<DateTime<Utc>>,
}

#[derive(Serialize, Clone)]
pub struct Reaction {
    pub emoji: String,
    pub users: Vec<Id>,
}

#[derive(Serialize, Clone)]
pub struct MessageRef {
    pub id: Id,
    pub author: User,
    pub content: String,
}

#[derive(Serialize, Clone)]
pub struct Message {
    pub id: Id,
    /// 0 for normal messages; see [`message_type`].
    #[serde(rename = "type")]
    pub kind: i16,
    pub channel_id: Id,
    pub author: User,
    pub content: String,
    pub reply_to: Option<Id>,
    pub referenced_message: Option<MessageRef>,
    pub attachments: Vec<Attachment>,
    pub embeds: serde_json::Value,
    pub reactions: Vec<Reaction>,
    pub mention_everyone: bool,
    pub pinned: bool,
    pub thread_id: Option<Id>,
    pub edited_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forwarded: Option<Forwarded>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interaction: Option<Interaction>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nonce: Option<String>,
    /// A bot's answer only the person who used the command sees: never stored or sent to anyone else.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub ephemeral: bool,
}
