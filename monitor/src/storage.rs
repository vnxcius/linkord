//! What's taking up the disk. Walking the folders is slow on purpose (it pauses as it goes) and only happens every
//! 10 minutes, so it can't compete with the app for the disk.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

use crate::state::AppState;

const EVERY: Duration = Duration::from_secs(600);

#[derive(Default, Clone, Copy)]
struct Tally {
    bytes: u64,
    files: u64,
}

fn walk(path: &Path, tally: &mut Tally, visited: &mut u32) {
    let Ok(entries) = std::fs::read_dir(path) else { return };
    for entry in entries.flatten() {
        *visited += 1;
        if (*visited).is_multiple_of(2000) {
            std::thread::sleep(Duration::from_millis(5));
        }
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            walk(&entry.path(), tally, visited);
        } else if kind.is_file() {
            tally.bytes += entry.metadata().map(|m| m.len()).unwrap_or(0);
            tally.files += 1;
        }
    }
}

fn measure(path: &Path) -> Tally {
    let mut tally = Tally::default();
    let mut visited = 0;
    walk(path, &mut tally, &mut visited);
    tally
}

/// Friendly names for what's inside the app's folders.
fn describe(dir: &str) -> &str {
    match dir {
        "attachments" => "Message attachments",
        "avatars" => "Profile pictures",
        "banners" => "Profile and server banners",
        "icons" => "Server icons",
        "emojis" => "Custom emoji",
        "sounds" => "Soundboard sounds",
        "member-profiles" => "Server profiles",
        "profile-songs" => "Profile songs",
        "nameplates" => "Uploaded nameplates",
        "bots" => "Bot pictures",
        other => other,
    }
}

fn scan(st_uploads: PathBuf, data: PathBuf, extras: Vec<(&'static str, PathBuf)>) -> Value {
    let mut uploads = vec![];
    let mut uploads_bytes = 0;
    let mut uploads_files = 0;
    if let Ok(entries) = std::fs::read_dir(&st_uploads) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let tally = measure(&entry.path());
            uploads_bytes += tally.bytes;
            uploads_files += tally.files;
            uploads.push(json!({ "name": describe(&name), "dir": name, "bytes": tally.bytes, "files": tally.files }));
        }
    }
    uploads.sort_by_key(|u| std::cmp::Reverse(u["bytes"].as_u64().unwrap_or(0)));

    let mut app = vec![json!({ "name": "Uploads", "bytes": uploads_bytes, "files": uploads_files })];
    for (name, dir) in [("Logs", "logs"), ("Desktop updates", "updates"), ("Tools (yt-dlp)", "bin"), ("Certificates", "acme")] {
        let tally = measure(&data.join(dir));
        app.push(json!({ "name": name, "bytes": tally.bytes, "files": tally.files }));
    }
    for (name, path) in extras {
        let tally = measure(&path);
        app.push(json!({ "name": name, "bytes": tally.bytes, "files": tally.files }));
    }
    json!({
        "scanned": chrono::Utc::now().timestamp(),
        "uploads_bytes": uploads_bytes,
        "uploads_files": uploads_files,
        "uploads": uploads,
        "app": app,
    })
}

pub async fn keep(st: AppState) {
    let mut tick = tokio::time::interval(EVERY);
    loop {
        tick.tick().await;
        let (uploads, data) = (st.cfg.uploads_dir(), st.cfg.app_data.clone());
        let extras = vec![("Default nameplates", st.cfg.nameplates_dir.clone()), ("Default sounds", st.cfg.sounds_dir.clone())];
        if let Ok(v) = tokio::task::spawn_blocking(move || scan(uploads, data, extras)).await {
            *st.storage.write().unwrap() = v;
        }
    }
}

/// Least-squares growth of a series, in units per day.
pub fn growth_per_day(points: &[(f64, f64)]) -> Option<f64> {
    if points.len() < 2 {
        return None;
    }
    let n = points.len() as f64;
    let (sx, sy) = points.iter().fold((0.0, 0.0), |(x, y), p| (x + p.0, y + p.1));
    let (mx, my) = (sx / n, sy / n);
    let (mut num, mut den) = (0.0, 0.0);
    for (x, y) in points {
        num += (x - mx) * (y - my);
        den += (x - mx) * (x - mx);
    }
    if den == 0.0 {
        return None;
    }
    Some(num / den * 86400.0)
}

/// Storage tab: disks, the app's folders, growth and how long the free space lasts at that rate.
pub async fn overview(st: &AppState) -> Value {
    let live = st.live.read().unwrap().clone();
    let scan = st.storage.read().unwrap().clone();
    let store = st.store.clone();
    let now = chrono::Utc::now().timestamp();
    let history = tokio::task::spawn_blocking(move || {
        let size = store.size();
        (size, store.series(&["disk_used", "pg_size", "uploads_bytes"], now - 14 * 86400, now, 200))
    })
    .await;
    let (db_file, series) = history.unwrap_or((0, Err(rusqlite::Error::InvalidQuery)));
    let series = series.unwrap_or(Value::Null);
    let trend = |key: &str| -> Option<f64> {
        let ts = series["ts"].as_array()?;
        let values = series["series"][key]["avg"].as_array()?;
        let points: Vec<(f64, f64)> = ts.iter().zip(values).filter_map(|(t, v)| Some((t.as_f64()?, v.as_f64()?))).collect();
        // A few hours say little about the trend.
        let span = points.last()?.0 - points.first()?.0;
        if span < 6.0 * 3600.0 {
            return None;
        }
        growth_per_day(&points)
    };
    let disk_growth = trend("disk_used");
    let free = live["data_disk"]["free"].as_f64();
    let days_left = match (disk_growth, free) {
        (Some(g), Some(f)) if g > 1024.0 * 1024.0 => Some(f / g),
        _ => None,
    };
    json!({
        "disks": live["disks"],
        "data_disk": live["data_disk"],
        "scan": scan,
        "database_bytes": st.pg_quick.read().unwrap()["size"],
        "monitor_bytes": db_file,
        "growth": {
            "disk_per_day": disk_growth,
            "database_per_day": trend("pg_size"),
            "uploads_per_day": trend("uploads_bytes"),
            "days_until_full": days_left,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::growth_per_day;

    #[test]
    fn growth_is_per_day() {
        let g = growth_per_day(&[(0.0, 100.0), (86400.0, 200.0), (172800.0, 300.0)]).unwrap();
        assert!((g - 100.0).abs() < 1e-9);
        assert_eq!(growth_per_day(&[(0.0, 1.0)]), None);
        assert_eq!(growth_per_day(&[(5.0, 1.0), (5.0, 2.0)]), None);
    }
}
