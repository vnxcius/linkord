//! What a new server starts with (`default_template`), and filling a just-created server from it (`apply`).

use sqlx::{Postgres, Transaction};

use crate::error::ApiResult;
use crate::id::Id;
use crate::models::kind;
use crate::perms;

pub struct TemplateChannel {
    pub kind: i16,
    pub name: String,
    /// Index of its category in `channels`.
    pub parent: Option<usize>,
}

pub struct Template {
    /// In sidebar order: channels without a category, then each category followed by its channels.
    pub channels: Vec<TemplateChannel>,
    /// The @everyone role's permissions.
    pub everyone: i64,
}

/// Two categories, a text and a voice channel.
pub fn default_template() -> Template {
    let ch = |kind, name: &str, parent| TemplateChannel { kind, name: name.into(), parent };
    Template {
        channels: vec![
            ch(kind::CATEGORY, "Text Channels", None),
            ch(kind::TEXT, "general", Some(0)),
            ch(kind::CATEGORY, "Voice Channels", None),
            ch(kind::VOICE, "Campfire", Some(2)),
        ],
        everyone: perms::DEFAULT,
    }
}

/// Fills a just-created guild (whose @everyone role id is the guild id) from the template.
pub async fn apply(tx: &mut Transaction<'_, Postgres>, guild: Id, t: &Template) -> ApiResult<()> {
    sqlx::query("UPDATE roles SET permissions = $2 WHERE id = $1").bind(guild).bind(t.everyone).execute(&mut **tx).await?;
    let mut ids = Vec::with_capacity(t.channels.len());
    for (pos, c) in t.channels.iter().enumerate() {
        let id = Id::new();
        sqlx::query("INSERT INTO channels (id, guild_id, kind, name, topic, position, parent_id) VALUES ($1, $2, $3, $4, '', $5, $6)")
            .bind(id)
            .bind(guild)
            .bind(c.kind)
            .bind(&c.name)
            .bind(pos as i32)
            .bind(c.parent.map(|i: usize| ids[i]))
            .execute(&mut **tx)
            .await?;
        ids.push(id);
    }
    Ok(())
}
