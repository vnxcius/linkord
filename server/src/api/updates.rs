//! Desktop auto-update feed for the Tauri updater. `app/publish-windows.sh` drops the signed
//! installer and `latest.json` into `<data>/updates/`; installers are served from /api/updates/download.
//! `app/publish-linux.sh` adds the signed Linux packages and `linux.json`; Linux apps get both as one static
//! manifest (`linux-x86_64-deb` / `-rpm`) and the updater picks the one it was installed from. /api/downloads
//! lists what the web client's download page offers. `changelog.json` (newest first, appended by publish-windows.sh)
//! feeds the patch notes page.
//!
//! Releases reach apps at once (owner, 2026-11-12): `watch` notices a new version in latest.json / linux.json and
//! sends APP_UPDATE {version} to everyone connected; desktop apps check the feed then and show the banner. Apps also
//! check whenever their gateway connects (READY), so whoever was offline gets it on their next connection.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::direct::PublicBase;
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/updates/{target}/{arch}/{current}", get(check))
        .route("/downloads", get(downloads))
        .route("/changelog", get(changelog))
}

#[derive(Deserialize)]
struct Platform {
    signature: String,
    file: String,
}

#[derive(Deserialize)]
struct Latest {
    version: String,
    #[serde(default)]
    notes: String,
    pub_date: String,
    platforms: std::collections::HashMap<String, Platform>,
}

fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let mut it = v.trim_start_matches('v').split(['.', '-', '+']).map(|p| p.parse::<u64>());
    Some((it.next()?.ok()?, it.next()?.ok()?, it.next()?.ok()?))
}

async fn check(State(st): State<AppState>, base: PublicBase, Path((target, arch, current)): Path<(String, String, String)>) -> Response {
    if target == "linux" {
        return check_linux(&st, &base, &arch, &current).await;
    }
    let Ok(raw) = tokio::fs::read(st.cfg.data_dir.join("updates/latest.json")).await else {
        return StatusCode::NO_CONTENT.into_response();
    };
    let Ok(latest) = serde_json::from_slice::<Latest>(&raw) else {
        tracing::warn!("updates/latest.json is malformed");
        return StatusCode::NO_CONTENT.into_response();
    };
    let newer = matches!((parse_version(&latest.version), parse_version(&current)), (Some(l), Some(c)) if l > c);
    let Some(p) = latest.platforms.get(&format!("{target}-{arch}")).filter(|_| newer) else {
        return StatusCode::NO_CONTENT.into_response();
    };
    Json(json!({
        "version": latest.version,
        "notes": latest.notes,
        "pub_date": latest.pub_date,
        "url": format!("{base}/api/updates/download/{}", urlencoding::encode(&p.file)),
        "signature": p.signature,
    }))
    .into_response()
}

#[derive(Deserialize)]
struct LinuxPackages {
    version: String,
    #[serde(default)]
    notes: String,
    #[serde(default)]
    pub_date: Option<String>,
    deb: Option<String>,
    deb_signature: Option<String>,
    rpm: Option<String>,
    rpm_signature: Option<String>,
}

async fn check_linux(st: &AppState, base: &PublicBase, arch: &str, current: &str) -> Response {
    let Some(linux) = tokio::fs::read(st.cfg.data_dir.join("updates/linux.json")).await.ok().and_then(|raw| serde_json::from_slice::<LinuxPackages>(&raw).ok()) else {
        return StatusCode::NO_CONTENT.into_response();
    };
    let newer = matches!((parse_version(&linux.version), parse_version(current)), (Some(l), Some(c)) if l > c);
    let mut platforms = serde_json::Map::new();
    for (kind, file, signature) in [("deb", &linux.deb, &linux.deb_signature), ("rpm", &linux.rpm, &linux.rpm_signature)] {
        if let (Some(file), Some(signature)) = (file, signature) {
            let url = format!("{base}/api/updates/download/{}", urlencoding::encode(file));
            platforms.insert(format!("linux-{arch}-{kind}"), json!({ "url": url, "signature": signature }));
        }
    }
    if !newer || arch != "x86_64" || platforms.is_empty() {
        return StatusCode::NO_CONTENT.into_response();
    }
    let mut out = json!({ "version": linux.version, "notes": linux.notes, "platforms": platforms });
    if let Some(date) = linux.pub_date {
        out["pub_date"] = date.into();
    }
    Json(out).into_response()
}

/// Latest installers per platform, for the web client's download page: version, link, size, release date and
/// notes. Missing ones are omitted.
async fn downloads(State(st): State<AppState>, base: PublicBase) -> Json<serde_json::Value> {
    let dir = st.cfg.data_dir.join("updates");
    let entry = |file: &str, version: &str, notes: &str, date: Option<&str>| {
        let dir = dir.clone();
        let (file, version, notes, date) = (file.to_string(), version.to_string(), notes.to_string(), date.map(str::to_string));
        let url = format!("{base}/api/updates/download/{}", urlencoding::encode(&file));
        async move {
            let size = tokio::fs::metadata(dir.join(&file)).await.ok().map(|m| m.len());
            json!({ "version": version, "url": url, "size": size, "date": date, "notes": notes })
        }
    };
    let mut out = serde_json::Map::new();
    if let Some(latest) = tokio::fs::read(dir.join("latest.json")).await.ok().and_then(|raw| serde_json::from_slice::<Latest>(&raw).ok()) {
        if let Some(p) = latest.platforms.get("windows-x86_64") {
            out.insert("windows".into(), entry(&p.file, &latest.version, &latest.notes, Some(&latest.pub_date)).await);
        }
    }
    if let Some(linux) = tokio::fs::read(dir.join("linux.json")).await.ok().and_then(|raw| serde_json::from_slice::<LinuxPackages>(&raw).ok()) {
        for (kind, file) in [("deb", &linux.deb), ("rpm", &linux.rpm)] {
            if let Some(file) = file {
                out.insert(kind.into(), entry(file, &linux.version, &linux.notes, linux.pub_date.as_deref()).await);
            }
        }
    }
    Json(out.into())
}

#[cfg(test)]
mod tests {
    #[test]
    fn versions() {
        assert!(super::parse_version("0.1.10") > super::parse_version("0.1.9"));
        assert_eq!(super::parse_version("v1.2.3"), Some((1, 2, 3)));
    }
}

#[derive(Deserialize, serde::Serialize)]
struct Release {
    version: String,
    date: Option<String>,
    /// One change per line.
    notes: String,
}

/// Patch notes, newest first. Before the first changelog entry, the latest release's notes stand in.
async fn changelog(State(st): State<AppState>) -> Json<Vec<Release>> {
    let dir = st.cfg.data_dir.join("updates");
    if let Some(list) = tokio::fs::read(dir.join("changelog.json")).await.ok().and_then(|raw| serde_json::from_slice::<Vec<Release>>(&raw).ok()) {
        return Json(list);
    }
    let latest = tokio::fs::read(dir.join("latest.json")).await.ok().and_then(|raw| serde_json::from_slice::<Latest>(&raw).ok());
    Json(latest.map(|l| vec![Release { version: l.version, date: Some(l.pub_date), notes: l.notes }]).unwrap_or_default())
}

/// The versions the feeds offer now ("" when a feed is missing or being written).
async fn feed_versions(st: &AppState) -> [String; 2] {
    let dir = st.cfg.data_dir.join("updates");
    let mut out = [String::new(), String::new()];
    for (i, name) in ["latest.json", "linux.json"].iter().enumerate() {
        if let Ok(raw) = tokio::fs::read(dir.join(name)).await {
            if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&raw) {
                out[i] = v["version"].as_str().unwrap_or_default().to_string();
            }
        }
    }
    out
}

/// Background task: every few seconds, has a feed's version changed? Then tell every app (APP_UPDATE).
pub async fn watch(st: AppState) {
    let mut last = feed_versions(&st).await;
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        let now = feed_versions(&st).await;
        for i in 0..2 {
            // A feed caught mid-write reads as "": wait for it to be whole rather than announce nothing.
            if now[i].is_empty() || now[i] == last[i] {
                continue;
            }
            let users = st.hub.users();
            tracing::info!(version = %now[i], feed = i, users = users.len(), "updates: new release, telling every app");
            st.hub.send(&users, "APP_UPDATE", &json!({ "version": now[i], "linux": i == 1 }));
            last[i] = now[i].clone();
        }
    }
}
