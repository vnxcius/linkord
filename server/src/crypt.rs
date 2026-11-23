//! Encryption at rest for what people type: message text, link previews, forwarded copies and private notes are
//! stored as AES-256-GCM ciphertext, so a leaked database (a dump, a backup, the monitor's role) doesn't leak them.
//! The key is <data>/message.key (hex, created on first start; keep a copy off the machine). The server
//! still reads everything in memory (push, link previews, bots, search), so this doesn't protect against someone
//! on the machine itself. Names, ids, times and flags stay plaintext (the monitor reads those).
//!
//! Stored text is `lk1:` + base64url(nonce ‖ ciphertext ‖ tag). Empty text and empty embed lists stay as they are.
//! Anything without the prefix is read as it is (rows from before, sealed by [`seal_existing`] after a start).

use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{bail, Context};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine as _;
use rand::RngCore;
use serde::Deserialize;
use serde_json::Value;
use sqlx::postgres::{PgTypeInfo, PgValueRef};
use sqlx::types::Json;
use sqlx::{PgPool, Postgres};

use crate::id::Id;
use crate::models::Forwarded;

const PREFIX: &str = "lk1:";
const KEY_FILE: &str = "message.key";

static KEY: OnceLock<Aes256Gcm> = OnceLock::new();

fn key() -> &'static Aes256Gcm {
    KEY.get().expect("crypt::init runs before anything reads or writes messages")
}

/// Loads the key (creating it on a first start) and checks it opens what the database already holds. Refuses to
/// start with a missing or wrong key rather than mix keys: restore message.key from the backup instead.
pub async fn init(data_dir: &Path, db: &PgPool) -> anyhow::Result<()> {
    let path = data_dir.join(KEY_FILE);
    let (bytes, created) = match std::fs::read_to_string(&path) {
        Ok(hex) => (hex::decode(hex.trim()).context("message.key isn't hex")?, false),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let mut k = [0u8; 32];
            rand::rngs::OsRng.fill_bytes(&mut k);
            std::fs::create_dir_all(data_dir)?;
            // create_new: two slots starting at once can't each write their own key.
            match write_new(&path, &hex::encode(k)) {
                Ok(()) => (k.to_vec(), true),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (hex::decode(std::fs::read_to_string(&path)?.trim())?, false),
                Err(e) => return Err(e).context("writing message.key"),
            }
        }
        Err(e) => return Err(e).context("reading message.key"),
    };
    if bytes.len() != 32 {
        bail!("message.key must hold 32 bytes (64 hex characters)");
    }
    let _ = KEY.set(Aes256Gcm::new_from_slice(&bytes)?);

    let sample: Option<String> = sqlx::query_scalar(
        "(SELECT content FROM messages WHERE content LIKE 'lk1:%' LIMIT 1) UNION ALL (SELECT note FROM user_notes WHERE note LIKE 'lk1:%' LIMIT 1) LIMIT 1",
    )
    .fetch_optional(db)
    .await?;
    if let Some(s) = sample {
        if created {
            let _ = std::fs::remove_file(&path);
            bail!("message.key is missing but the database holds encrypted messages: restore it from the backup into {}", path.display());
        }
        if try_open(&s).is_none() {
            bail!("message.key doesn't open the database's messages: restore the right one from the backup into {}", path.display());
        }
    }
    if created {
        tracing::warn!("crypt: created message.key; back it up off this machine (losing it loses every message)");
    }
    Ok(())
}

fn write_new(path: &Path, contents: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)?.write_all(contents.as_bytes())
}

/// Text as stored: sealed, or empty as it was.
pub fn seal(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    let mut nonce = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let ct = key().encrypt(Nonce::from_slice(&nonce), text.as_bytes()).expect("AES-GCM encryption doesn't fail");
    let mut out = Vec::with_capacity(12 + ct.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    format!("{PREFIX}{}", B64.encode(out))
}

fn try_open(stored: &str) -> Option<String> {
    let raw = B64.decode(stored.strip_prefix(PREFIX)?).ok()?;
    if raw.len() < 12 + 16 {
        return None;
    }
    let (nonce, ct) = raw.split_at(12);
    String::from_utf8(key().decrypt(Nonce::from_slice(nonce), ct).ok()?).ok()
}

/// Stored text back to what was typed. Text without the prefix is from before encryption and comes back as it is.
pub fn open(stored: &str) -> String {
    if !stored.starts_with(PREFIX) {
        return stored.to_string();
    }
    try_open(stored).unwrap_or_else(|| {
        // init checked the key, so this is a damaged row (or old plaintext that began with the prefix).
        tracing::warn!("crypt: a stored text didn't open");
        stored.to_string()
    })
}

/// JSON as stored: sealed into a JSON string, unless it's empty (`[]`, `null`), which stays as it is so SQL can
/// still tell "no embeds".
pub fn seal_json(v: &Value) -> Value {
    match v {
        Value::Null => Value::Null,
        Value::Array(a) if a.is_empty() => v.clone(),
        _ => Value::String(seal(&v.to_string())),
    }
}

pub fn open_json(v: Value) -> Value {
    match v {
        Value::String(s) if s.starts_with(PREFIX) => match try_open(&s).and_then(|t| serde_json::from_str(&t).ok()) {
            Some(v) => v,
            None => {
                tracing::warn!("crypt: a stored value didn't open");
                Value::Array(vec![])
            }
        },
        v => v,
    }
}

/// A TEXT column read back as typed: `#[sqlx(try_from = "crate::crypt::Sealed")]` on a String field, or
/// `query_scalar::<_, Sealed>`.
pub struct Sealed(pub String);

impl sqlx::Type<Postgres> for Sealed {
    fn type_info() -> PgTypeInfo {
        <String as sqlx::Type<Postgres>>::type_info()
    }
    fn compatible(ty: &PgTypeInfo) -> bool {
        <String as sqlx::Type<Postgres>>::compatible(ty)
    }
}

impl<'r> sqlx::Decode<'r, Postgres> for Sealed {
    fn decode(value: PgValueRef<'r>) -> Result<Self, sqlx::error::BoxDynError> {
        Ok(Sealed(open(&<String as sqlx::Decode<Postgres>>::decode(value)?)))
    }
}

impl From<Sealed> for String {
    fn from(s: Sealed) -> String {
        s.0
    }
}

/// A JSONB column read back as stored before sealing: `#[sqlx(try_from = "crate::crypt::SealedJson")]` on a
/// `Json<Value>` field.
pub struct SealedJson(pub Value);

impl sqlx::Type<Postgres> for SealedJson {
    fn type_info() -> PgTypeInfo {
        <Json<Value> as sqlx::Type<Postgres>>::type_info()
    }
    fn compatible(ty: &PgTypeInfo) -> bool {
        <Json<Value> as sqlx::Type<Postgres>>::compatible(ty)
    }
}

impl<'r> sqlx::Decode<'r, Postgres> for SealedJson {
    fn decode(value: PgValueRef<'r>) -> Result<Self, sqlx::error::BoxDynError> {
        Ok(SealedJson(open_json(<Json<Value> as sqlx::Decode<Postgres>>::decode(value)?.0)))
    }
}

impl From<SealedJson> for Json<Value> {
    fn from(s: SealedJson) -> Json<Value> {
        Json(s.0)
    }
}

/// serde `deserialize_with` for sealed text inside a JSONB value (a forward's copy).
pub fn de_open<'de, D: serde::Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Ok(open(&String::deserialize(d)?))
}

/// serde `deserialize_with` for sealed JSON inside a JSONB value.
pub fn de_open_json<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Value, D::Error> {
    Ok(open_json(Value::deserialize(d)?))
}

/// Seals what was stored before encryption, in batches, a minute after start (so a server it took over from has
/// stopped writing), then rewrites the tables so the plaintext doesn't linger in dead rows.
pub fn spawn_seal_existing(db: PgPool) {
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(60)).await;
        match seal_existing(&db).await {
            Ok(0) => {}
            Ok(n) => {
                tracing::info!(rows = n, "crypt: sealed rows from before encryption");
                if let Err(e) = sqlx::query("VACUUM (FULL) messages, user_notes").execute(&db).await {
                    tracing::warn!(error = %e, "crypt: couldn't rewrite the tables after sealing");
                }
            }
            Err(e) => tracing::warn!(error = %e, "crypt: sealing old rows stopped (it tries again on the next start)"),
        }
    });
}

async fn seal_existing(db: &PgPool) -> anyhow::Result<u64> {
    let mut done = 0;
    let mut after = Id(0);
    loop {
        let rows: Vec<(Id, String, Json<Value>, Option<Json<Value>>)> = sqlx::query_as(
            "SELECT id, content, embeds, forwarded FROM messages WHERE id > $1 AND (
                (content <> '' AND content NOT LIKE 'lk1:%')
                OR (jsonb_typeof(embeds) = 'array' AND embeds <> '[]')
                OR (forwarded IS NOT NULL AND ((forwarded->>'content' <> '' AND forwarded->>'content' NOT LIKE 'lk1:%')
                    OR (jsonb_typeof(forwarded->'embeds') = 'array' AND forwarded->'embeds' <> '[]'))))
             ORDER BY id LIMIT 500",
        )
        .bind(after)
        .fetch_all(db)
        .await?;
        let Some(last) = rows.last() else { break };
        after = last.0;
        for (id, content, embeds, forwarded) in rows {
            let new_content = if content.starts_with(PREFIX) { content.clone() } else { seal(&content) };
            let new_forwarded = match &forwarded {
                Some(f) => Some(Json(serde_json::to_value(serde_json::from_value::<Forwarded>(f.0.clone())?.sealed())?)),
                None => None,
            };
            // Guarded on what was read, so an edit in between wins (it's sealed already).
            let r = sqlx::query(
                "UPDATE messages SET content = $2, embeds = $3, forwarded = $4
                 WHERE id = $1 AND content = $5 AND embeds = $6 AND forwarded IS NOT DISTINCT FROM $7",
            )
            .bind(id)
            .bind(&new_content)
            .bind(Json(seal_json(&embeds.0)))
            .bind(&new_forwarded)
            .bind(&content)
            .bind(&embeds)
            .bind(&forwarded)
            .execute(db)
            .await?;
            done += r.rows_affected();
        }
    }
    let notes: Vec<(Id, Id, String)> =
        sqlx::query_as("SELECT user_id, target_id, note FROM user_notes WHERE note <> '' AND note NOT LIKE 'lk1:%'").fetch_all(db).await?;
    for (user, target, note) in notes {
        let r = sqlx::query("UPDATE user_notes SET note = $3 WHERE user_id = $1 AND target_id = $2 AND note = $4")
            .bind(user)
            .bind(target)
            .bind(seal(&note))
            .bind(&note)
            .execute(db)
            .await?;
        done += r.rows_affected();
    }
    Ok(done)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_key() {
        let _ = KEY.set(Aes256Gcm::new_from_slice(&[7u8; 32]).unwrap());
    }

    #[test]
    fn text_round_trips_and_differs_each_time() {
        with_key();
        let a = seal("hello <@123> https://x.y");
        let b = seal("hello <@123> https://x.y");
        assert!(a.starts_with(PREFIX) && a != b);
        assert!(!a.contains("hello"));
        assert_eq!(open(&a), "hello <@123> https://x.y");
        assert_eq!(seal(""), "");
    }

    #[test]
    fn plaintext_from_before_reads_as_it_is() {
        with_key();
        assert_eq!(open("old message"), "old message");
        assert_eq!(open("lk1:not really"), "lk1:not really");
    }

    #[test]
    fn tampering_doesnt_open() {
        with_key();
        let s = seal("secret");
        let i = PREFIX.len() + 5;
        let c = if &s[i..i + 1] == "A" { "B" } else { "A" };
        let s = format!("{}{c}{}", &s[..i], &s[i + 1..]);
        assert!(try_open(&s).is_none());
    }

    #[test]
    fn json_round_trips_but_empty_stays() {
        with_key();
        let v = serde_json::json!([{ "url": "https://example.com", "title": "Hi" }]);
        let s = seal_json(&v);
        assert!(s.is_string());
        assert_eq!(open_json(s), v);
        assert_eq!(seal_json(&serde_json::json!([])), serde_json::json!([]));
        assert_eq!(open_json(v.clone()), v);
    }
}
