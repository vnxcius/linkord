//! Discord server templates (discord.new/<code>): fetched from Discord's public API and turned into a
//! new Linkord server with the same categories, channels, roles and role permission overwrites (member
//! overwrites can't carry over). New servers without a template use `default_template`.

use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use sqlx::{Postgres, Transaction};

use crate::error::{bad, ApiResult};
use crate::auth::AuthUser;
use crate::id::Id;
use crate::models::kind;
use crate::perms;
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new().route("/guild-templates/{code}", get(preview))
}

const MAX_CHANNELS: usize = 500;
const MAX_ROLES: usize = 250;

/// Accepts a bare code or any of Discord's template links.
pub fn template_code(input: &str) -> Option<String> {
    let s = input.trim().trim_end_matches('/');
    let code = match s.rsplit_once('/') {
        Some((head, code)) => {
            let head = head.trim_start_matches("https://").trim_start_matches("http://").trim_start_matches("www.");
            let ok = head == "discord.new" || ["discord.com/template", "discordapp.com/template", "ptb.discord.com/template", "canary.discord.com/template"].contains(&head);
            if !ok {
                return None;
            }
            code
        }
        None => s,
    };
    let valid = (2..=64).contains(&code.len()) && code.chars().all(|c| c.is_ascii_alphanumeric());
    valid.then(|| code.to_string())
}

#[derive(Deserialize)]
struct DiscordTemplate {
    name: String,
    #[serde(default)]
    description: Option<String>,
    serialized_source_guild: SourceGuild,
}

#[derive(Deserialize)]
struct SourceGuild {
    #[serde(default)]
    roles: Vec<SourceRole>,
    #[serde(default)]
    channels: Vec<SourceChannel>,
}

#[derive(Deserialize)]
struct SourceRole {
    id: i64,
    name: String,
    #[serde(default)]
    color: i32,
    #[serde(default)]
    hoist: bool,
    #[serde(default)]
    mentionable: bool,
    #[serde(default)]
    permissions: String,
}

#[derive(Deserialize)]
struct SourceChannel {
    id: i64,
    #[serde(rename = "type")]
    kind: i32,
    name: String,
    #[serde(default)]
    position: i32,
    #[serde(default)]
    topic: Option<String>,
    #[serde(default)]
    parent_id: Option<i64>,
    #[serde(default)]
    permission_overwrites: Vec<SourceOverwrite>,
}

#[derive(Deserialize)]
struct SourceOverwrite {
    id: i64,
    #[serde(rename = "type", default)]
    kind: i16,
    #[serde(default)]
    allow: String,
    #[serde(default)]
    deny: String,
}

#[derive(Serialize)]
pub struct TemplateRole {
    pub name: String,
    pub color: Option<i32>,
    pub hoist: bool,
    pub mentionable: bool,
    #[serde(skip)]
    pub permissions: i64,
    /// Its id in the template, which overwrites refer to.
    #[serde(skip)]
    source_id: i64,
}

#[derive(Serialize)]
pub struct TemplateChannel {
    pub kind: i16,
    pub name: String,
    pub topic: String,
    /// Index of its category in `channels`.
    pub parent: Option<usize>,
    /// Role overwrites: (index in `roles`, None = @everyone), allow, deny.
    #[serde(skip)]
    pub overwrites: Vec<(Option<usize>, i64, i64)>,
}

/// A template reduced to what Linkord can represent.
#[derive(Serialize)]
pub struct Template {
    pub name: String,
    pub description: String,
    /// Highest role first.
    pub roles: Vec<TemplateRole>,
    /// In sidebar order: channels without a category, then each category followed by its channels.
    pub channels: Vec<TemplateChannel>,
    #[serde(skip)]
    pub everyone: i64,
}

/// Discord channel types Linkord can stand in for: text-like ones become text, stage becomes voice.
fn linkord_kind(discord: i32) -> Option<i16> {
    match discord {
        0 | 5 | 15 | 16 => Some(kind::TEXT),
        2 | 13 => Some(kind::VOICE),
        _ => None,
    }
}

fn convert(t: DiscordTemplate) -> Template {
    let src = t.serialized_source_guild;
    let perm = |p: &str| p.parse::<i64>().unwrap_or(0) & perms::ALL;
    let everyone = src.roles.iter().find(|r| r.id == 0).map(|r| perm(&r.permissions)).unwrap_or(perms::DEFAULT);
    // Discord lists roles lowest first, @everyone (id 0) at the bottom.
    let roles = src
        .roles
        .iter()
        .filter(|r| r.id != 0 && !r.name.trim().is_empty())
        .rev()
        .take(MAX_ROLES)
        .map(|r| TemplateRole {
            name: r.name.trim().chars().take(100).collect(),
            color: (r.color != 0).then_some(r.color),
            hoist: r.hoist,
            mentionable: r.mentionable,
            permissions: perm(&r.permissions),
            source_id: r.id,
        })
        .collect::<Vec<_>>();
    let role_index = |id: i64| roles.iter().position(|r| r.source_id == id);
    let overwrites = |c: &SourceChannel| -> Vec<(Option<usize>, i64, i64)> {
        c.permission_overwrites
            .iter()
            .filter(|o| o.kind == 0)
            .filter_map(|o| {
                let target = if o.id == 0 { None } else { Some(role_index(o.id)?) };
                let allow = o.allow.parse::<i64>().unwrap_or(0) & perms::CHANNEL;
                Some((target, allow, o.deny.parse::<i64>().unwrap_or(0) & perms::CHANNEL & !allow))
            })
            .collect()
    };

    // Discord's sidebar order: uncategorized channels, then categories; text before voice inside each.
    let is_category = |id: i64| src.channels.iter().any(|c| c.id == id && c.kind == 4);
    let usable: Vec<(i16, &SourceChannel)> = src.channels.iter().filter_map(|c| Some((linkord_kind(c.kind)?, c))).collect();
    let in_category = |parent: Option<i64>| {
        let mut list: Vec<_> = usable.iter().filter(|(_, c)| c.parent_id.filter(|p| is_category(*p)) == parent).collect();
        list.sort_by_key(|(k, c)| (*k == kind::VOICE, c.position, c.id));
        list
    };
    let mut categories: Vec<&SourceChannel> = src.channels.iter().filter(|c| c.kind == 4).collect();
    categories.sort_by_key(|c| (c.position, c.id));

    let mut channels: Vec<TemplateChannel> = Vec::new();
    let push = |k: i16, c: &SourceChannel, parent: Option<usize>, out: &mut Vec<TemplateChannel>| {
        if out.len() >= MAX_CHANNELS {
            return None;
        }
        let name = super::channels::channel_name(&c.name, k).ok()?;
        let topic = c.topic.as_deref().unwrap_or("").trim().chars().take(1024).collect();
        out.push(TemplateChannel { kind: k, name, topic, parent, overwrites: overwrites(c) });
        Some(out.len() - 1)
    };
    for (k, c) in in_category(None) {
        push(*k, c, None, &mut channels);
    }
    for cat in categories {
        let Some(at) = push(kind::CATEGORY, cat, None, &mut channels) else { continue };
        for (k, c) in in_category(Some(cat.id)) {
            push(*k, c, Some(at), &mut channels);
        }
    }

    Template {
        name: t.name.trim().chars().take(100).collect(),
        description: t.description.unwrap_or_default(),
        roles,
        channels,
        everyone,
    }
}

/// What a new server starts with: Discord's default categories, a text and a voice channel.
pub fn default_template(name: &str) -> Template {
    let ch = |kind, name: &str, parent| TemplateChannel { kind, name: name.into(), topic: String::new(), parent, overwrites: vec![] };
    Template {
        name: name.into(),
        description: String::new(),
        roles: vec![],
        channels: vec![
            ch(kind::CATEGORY, "Text Channels", None),
            ch(kind::TEXT, "general", Some(0)),
            ch(kind::CATEGORY, "Voice Channels", None),
            ch(kind::VOICE, "Campfire", Some(2)),
        ],
        everyone: perms::DEFAULT,
    }
}

pub async fn fetch(st: &AppState, me: Id, input: &str) -> ApiResult<Template> {
    let code = template_code(input).ok_or_else(|| bad("that is not a Discord template link"))?;
    st.limits.check(format!("template:{me}"), 10.0, 1.0 / 6.0)?;
    let res = st
        .http
        .get(format!("https://discord.com/api/v10/guilds/templates/{code}"))
        .send()
        .await
        .map_err(|_| bad("could not reach Discord to load the template"))?;
    if res.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(bad("that Discord template does not exist or has expired"));
    }
    if !res.status().is_success() {
        return Err(bad("could not reach Discord to load the template"));
    }
    let t = res.json::<DiscordTemplate>().await.map_err(|_| bad("could not read that Discord template"))?;
    Ok(convert(t))
}

async fn preview(State(st): State<AppState>, AuthUser(me): AuthUser, Path(code): Path<String>) -> ApiResult<Json<Template>> {
    Ok(Json(fetch(&st, me, &code).await?))
}

/// Fills a just-created guild (whose @everyone role id is the guild id) from the template.
pub async fn apply(tx: &mut Transaction<'_, Postgres>, guild: Id, t: &Template) -> ApiResult<()> {
    sqlx::query("UPDATE roles SET permissions = $2 WHERE id = $1").bind(guild).bind(t.everyone).execute(&mut **tx).await?;
    let n = t.roles.len();
    let role_ids: Vec<Id> = t.roles.iter().map(|_| Id::new()).collect();
    for (i, r) in t.roles.iter().enumerate() {
        sqlx::query("INSERT INTO roles (id, guild_id, name, color, permissions, position, hoist, mentionable) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)")
            .bind(role_ids[i])
            .bind(guild)
            .bind(&r.name)
            .bind(r.color)
            .bind(r.permissions)
            .bind((n - i) as i32)
            .bind(r.hoist)
            .bind(r.mentionable)
            .execute(&mut **tx)
            .await?;
    }
    let mut ids = Vec::with_capacity(t.channels.len());
    for (pos, c) in t.channels.iter().enumerate() {
        let id = Id::new();
        sqlx::query("INSERT INTO channels (id, guild_id, kind, name, topic, position, parent_id) VALUES ($1, $2, $3, $4, $5, $6, $7)")
            .bind(id)
            .bind(guild)
            .bind(c.kind)
            .bind(&c.name)
            .bind(&c.topic)
            .bind(pos as i32)
            .bind(c.parent.map(|i: usize| ids[i]))
            .execute(&mut **tx)
            .await?;
        for (target, allow, deny) in &c.overwrites {
            sqlx::query("INSERT INTO channel_overwrites (channel_id, target_id, kind, allow, deny) VALUES ($1, $2, 0, $3, $4) ON CONFLICT DO NOTHING")
                .bind(id)
                .bind(target.map(|i| role_ids[i]).unwrap_or(guild))
                .bind(allow)
                .bind(deny)
                .execute(&mut **tx)
                .await?;
        }
        ids.push(id);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes() {
        assert_eq!(template_code("https://discord.new/aBc123").as_deref(), Some("aBc123"));
        assert_eq!(template_code("discord.com/template/aBc123/").as_deref(), Some("aBc123"));
        assert_eq!(template_code("aBc123").as_deref(), Some("aBc123"));
        assert_eq!(template_code("https://evil.example/aBc123"), None);
        assert_eq!(template_code("https://discord.new/a b"), None);
    }

    #[test]
    fn keeps_categories_in_sidebar_order() {
        let t: DiscordTemplate = serde_json::from_value(serde_json::json!({
            "name": "Gaming", "description": null,
            "serialized_source_guild": {
                "roles": [
                    { "id": 0, "name": "@everyone", "permissions": "2048", "color": 0, "hoist": false, "mentionable": false },
                    { "id": 1, "name": "Member", "permissions": "1024", "color": 0, "hoist": false, "mentionable": false },
                    { "id": 2, "name": "Mod", "permissions": "8", "color": 3447003, "hoist": true, "mentionable": true },
                ],
                "channels": [
                    { "id": 10, "type": 4, "name": "Voice", "position": 1 },
                    { "id": 11, "type": 4, "name": "Info", "position": 0 },
                    { "id": 12, "type": 2, "name": "Lounge", "position": 0, "parent_id": 10 },
                    { "id": 13, "type": 0, "name": "General Chat", "position": 1, "parent_id": 11, "topic": "hi" },
                    { "id": 14, "type": 5, "name": "news", "position": 0, "parent_id": 11, "permission_overwrites": [
                        { "id": 0, "type": 0, "allow": "0", "deny": "2048" },
                        { "id": 2, "type": 0, "allow": "2056", "deny": "0" },
                        { "id": 99, "type": 1, "allow": "2048", "deny": "0" },
                    ] },
                    { "id": 15, "type": 0, "name": "welcome", "position": 0 },
                ],
            },
        }))
        .unwrap();
        let t = convert(t);
        let names: Vec<_> = t.channels.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["welcome", "Info", "news", "general-chat", "Voice", "Lounge"]);
        assert_eq!(t.channels.iter().map(|c| c.parent).collect::<Vec<_>>(), [None, None, Some(1), Some(1), None, Some(4)]);
        assert_eq!(t.channels[3].topic, "hi");
        assert_eq!(t.roles.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), ["Mod", "Member"]);
        assert_eq!(t.roles[0].color, Some(3447003));
        assert_eq!(t.roles[1].color, None);
        assert_eq!(t.everyone, perms::SEND_MESSAGES);
        // "news": @everyone can't send, Mod (index 0) can; Administrator isn't a channel permission; members dropped.
        assert_eq!(t.channels[2].overwrites, [(None, 0, perms::SEND_MESSAGES), (Some(0), perms::SEND_MESSAGES, 0)]);
    }
}
