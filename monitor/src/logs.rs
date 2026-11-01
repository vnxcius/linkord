//! The app's log, read straight from its daily files (`<data>/logs/YYYY-MM-DD.jsonl`, already redacted by the server
//! as it writes them), so reading them never touches the app. Today's file is followed for the live view.

use std::collections::{BTreeMap, HashMap};
use std::convert::Infallible;
use std::io::SeekFrom;
use std::path::PathBuf;
use std::time::Duration;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::Json;
use futures_util::Stream;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::state::AppState;

fn today() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}

fn valid_day(day: &str) -> bool {
    day.len() == 10 && day.bytes().enumerate().all(|(i, b)| if i == 4 || i == 7 { b == b'-' } else { b.is_ascii_digit() })
}

fn day_file(st: &AppState, day: &str) -> PathBuf {
    st.cfg.logs_dir().join(format!("{day}.jsonl"))
}

fn rank(level: &str) -> u8 {
    match level.to_ascii_lowercase().as_str() {
        "error" => 4,
        "warn" => 3,
        "info" => 2,
        "debug" => 1,
        _ => 0,
    }
}

/// The days there are logs for, newest first, with their size.
pub async fn days(State(st): State<AppState>) -> Json<Vec<Value>> {
    let mut out = vec![];
    if let Ok(mut rd) = tokio::fs::read_dir(st.cfg.logs_dir()).await {
        while let Ok(Some(e)) = rd.next_entry().await {
            let name = e.file_name().to_string_lossy().into_owned();
            if let Some(day) = name.strip_suffix(".jsonl") {
                let size = e.metadata().await.map(|m| m.len()).unwrap_or(0);
                out.push(json!({ "day": day, "size": size }));
            }
        }
    }
    out.sort_by(|a, b| b["day"].as_str().cmp(&a["day"].as_str()));
    Json(out)
}

#[derive(Deserialize)]
pub struct DayQuery {
    day: String,
    /// Minimum level: error | warn | info | debug.
    level: Option<String>,
    /// Text to look for (anywhere in the line).
    q: Option<String>,
    target: Option<String>,
    /// Newest lines first; `before` = how many matching lines (from the end) to skip.
    #[serde(default)]
    before: usize,
    limit: Option<usize>,
}

/// Filters one day's text, newest first. Also returns the areas seen that day, for the filter.
pub fn filter_lines(text: &str, q: &DayQuery) -> (Vec<Value>, bool, Vec<String>) {
    let min = q.level.as_deref().map(rank).unwrap_or(0);
    let needle = q.q.as_deref().map(str::to_lowercase).filter(|s| !s.is_empty());
    let limit = q.limit.unwrap_or(300).clamp(1, 1000);
    let mut areas = std::collections::BTreeSet::new();
    let mut skipped = 0;
    let mut out = vec![];
    let mut more = false;
    for v in text.lines().rev().filter_map(|l| serde_json::from_str::<Value>(l).ok()) {
        if let Some(t) = v["target"].as_str() {
            areas.insert(t.to_string());
        }
        if rank(v["level"].as_str().unwrap_or("")) < min
            || !q.target.as_deref().is_none_or(|t| t.is_empty() || v["target"].as_str() == Some(t))
            || !needle.as_ref().is_none_or(|n| v.to_string().to_lowercase().contains(n.as_str()))
        {
            continue;
        }
        if skipped < q.before {
            skipped += 1;
        } else if out.len() < limit {
            out.push(v);
        } else {
            more = true;
        }
    }
    (out, more, areas.into_iter().collect())
}

pub async fn read_day(State(st): State<AppState>, Query(q): Query<DayQuery>) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if !valid_day(&q.day) {
        return Err((StatusCode::BAD_REQUEST, Json(json!({ "error": "Unknown day." }))));
    }
    let text = tokio::fs::read_to_string(day_file(&st, &q.day)).await.unwrap_or_default();
    let (lines, more, areas) = tokio::task::spawn_blocking(move || filter_lines(&text, &q)).await.unwrap_or_default();
    Ok(Json(json!({ "lines": lines, "more": more, "areas": areas })))
}

/// Numbers and ids out, so the same error from different requests groups together.
pub fn group_key(msg: &str) -> String {
    let mut out = String::with_capacity(msg.len());
    let mut in_number = false;
    for c in msg.chars() {
        if c.is_ascii_digit() {
            if !in_number {
                out.push('#');
            }
            in_number = true;
        } else {
            in_number = false;
            out.push(c);
        }
    }
    out.chars().take(160).collect()
}

/// Counts for one day: lines per hour by level, per area, and the most repeated problems.
pub fn summarize(text: &str) -> Value {
    let mut hours = vec![[0u64; 3]; 24];
    let mut areas: BTreeMap<String, u64> = BTreeMap::new();
    let mut problems: HashMap<String, (u64, String, String, String)> = HashMap::new();
    let (mut errors, mut warns, mut total) = (0u64, 0u64, 0u64);
    for v in text.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()) {
        total += 1;
        let level = v["level"].as_str().unwrap_or("").to_ascii_lowercase();
        let target = v["target"].as_str().unwrap_or("").to_string();
        let time = v["t"].as_str().unwrap_or("");
        let hour: usize = time.get(11..13).and_then(|h| h.parse().ok()).unwrap_or(0).min(23);
        let slot = match level.as_str() {
            "error" => {
                errors += 1;
                2
            }
            "warn" => {
                warns += 1;
                1
            }
            _ => 0,
        };
        hours[hour][slot] += 1;
        *areas.entry(target.clone()).or_default() += 1;
        if slot > 0 {
            let msg = v["msg"].as_str().unwrap_or("");
            let e = problems.entry(format!("{level}|{target}|{}", group_key(msg))).or_insert_with(|| (0, level.clone(), target.clone(), msg.to_string()));
            e.0 += 1;
            e.3 = msg.to_string();
        }
    }
    let mut top: Vec<_> = problems.into_values().collect();
    top.sort_by(|a, b| b.0.cmp(&a.0));
    top.truncate(12);
    let mut area_list: Vec<_> = areas.into_iter().collect();
    area_list.sort_by(|a, b| b.1.cmp(&a.1));
    json!({
        "total": total,
        "errors": errors,
        "warnings": warns,
        "hours": hours.iter().map(|h| json!({ "info": h[0], "warn": h[1], "error": h[2] })).collect::<Vec<_>>(),
        "areas": area_list.into_iter().map(|(name, count)| json!({ "name": name, "count": count })).collect::<Vec<_>>(),
        "problems": top.into_iter().map(|(count, level, target, msg)| json!({ "count": count, "level": level, "target": target, "msg": msg })).collect::<Vec<_>>(),
    })
}

#[derive(Deserialize)]
pub struct StatsQuery {
    day: Option<String>,
}

pub async fn stats(State(st): State<AppState>, Query(q): Query<StatsQuery>) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let day = q.day.unwrap_or_else(today);
    if !valid_day(&day) {
        return Err((StatusCode::BAD_REQUEST, Json(json!({ "error": "Unknown day." }))));
    }
    let text = tokio::fs::read_to_string(day_file(&st, &day)).await.unwrap_or_default();
    let v = tokio::task::spawn_blocking(move || summarize(&text)).await.unwrap_or(Value::Null);
    Ok(Json(v))
}

/// The latest warnings and errors, for the margin. Yesterday's too, right after midnight UTC.
pub async fn recent_problems(st: &AppState, limit: usize) -> Vec<Value> {
    let now = chrono::Utc::now();
    let mut out = vec![];
    for day in [now, now - chrono::Duration::days(1)] {
        let text = tokio::fs::read_to_string(day_file(st, &day.format("%Y-%m-%d").to_string())).await.unwrap_or_default();
        let q = DayQuery { day: String::new(), level: Some("warn".into()), q: None, target: None, before: 0, limit: Some(limit) };
        let (lines, _, _) = filter_lines(&text, &q);
        out.extend(lines);
        if out.len() >= limit {
            break;
        }
    }
    out.truncate(limit);
    out
}

/// Counts problems in the last `seconds` from today's file.
pub async fn count_recent(st: &AppState, seconds: i64) -> (u64, u64) {
    let cutoff = (chrono::Utc::now() - chrono::Duration::seconds(seconds)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let text = tokio::fs::read_to_string(day_file(st, &today())).await.unwrap_or_default();
    let (mut errors, mut warns) = (0, 0);
    for line in text.lines().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if v["t"].as_str().unwrap_or("") < cutoff.as_str() {
            break;
        }
        match rank(v["level"].as_str().unwrap_or("")) {
            4 => errors += 1,
            3 => warns += 1,
            _ => {}
        }
    }
    (errors, warns)
}

struct Tail {
    st: AppState,
    day: String,
    pos: u64,
    partial: Vec<u8>,
    ready: std::collections::VecDeque<String>,
}

impl Tail {
    /// Whatever was appended since the last look.
    async fn poll(&mut self) {
        let day = today();
        if day != self.day {
            self.day = day;
            self.pos = 0;
            self.partial.clear();
        }
        let path = day_file(&self.st, &self.day);
        let Ok(mut file) = tokio::fs::File::open(&path).await else { return };
        let Ok(meta) = file.metadata().await else { return };
        if meta.len() < self.pos {
            self.pos = 0;
        }
        if meta.len() == self.pos || file.seek(SeekFrom::Start(self.pos)).await.is_err() {
            return;
        }
        let mut buf = Vec::with_capacity((meta.len() - self.pos) as usize);
        if file.read_to_end(&mut buf).await.is_err() {
            return;
        }
        self.pos += buf.len() as u64;
        self.partial.extend_from_slice(&buf);
        // A line still being written stays for the next look.
        while let Some(end) = self.partial.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.partial.drain(..=end).collect();
            let text = String::from_utf8_lossy(&line).trim().to_string();
            if !text.is_empty() {
                self.ready.push_back(text);
            }
        }
    }
}

/// New lines as they're written, one JSON line per event (server-sent events).
pub async fn live(State(st): State<AppState>) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let day = today();
    let pos = tokio::fs::metadata(day_file(&st, &day)).await.map(|m| m.len()).unwrap_or(0);
    let tail = Tail { st, day, pos, partial: vec![], ready: Default::default() };
    let stream = futures_util::stream::unfold(tail, |mut tail| async move {
        loop {
            if let Some(line) = tail.ready.pop_front() {
                return Some((Ok(Event::default().data(line)), tail));
            }
            tokio::time::sleep(Duration::from_millis(700)).await;
            tail.poll().await;
        }
    });
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: &str = r#"{"t":"2026-11-01T10:00:00.000Z","level":"INFO","target":"http","msg":"request"}
{"t":"2026-11-01T11:00:00.000Z","level":"WARN","target":"voice","msg":"slow peer 123"}
{"t":"2026-11-01T11:30:00.000Z","level":"WARN","target":"voice","msg":"slow peer 456"}
not json
{"t":"2026-11-01T12:00:00.000Z","level":"ERROR","target":"http","msg":"request failed"}"#;

    fn query(level: Option<&str>, q: Option<&str>, target: Option<&str>, before: usize, limit: Option<usize>) -> DayQuery {
        DayQuery { day: "2026-11-01".into(), level: level.map(str::to_string), q: q.map(str::to_string), target: target.map(str::to_string), before, limit }
    }

    #[test]
    fn filters_newest_first() {
        let (lines, more, areas) = filter_lines(DAY, &query(Some("warn"), None, None, 0, None));
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0]["level"], "ERROR");
        assert!(!more);
        assert_eq!(areas, ["http", "voice"]);
        let (lines, _, _) = filter_lines(DAY, &query(None, Some("PEER 456"), None, 0, None));
        assert_eq!(lines.len(), 1);
        let (lines, _, _) = filter_lines(DAY, &query(None, None, Some("http"), 0, None));
        assert_eq!(lines.len(), 2);
    }

    #[test]
    fn pages_through_older_lines() {
        let (first, more, _) = filter_lines(DAY, &query(None, None, None, 0, Some(2)));
        assert_eq!((first.len(), more), (2, true));
        let (rest, more, _) = filter_lines(DAY, &query(None, None, None, 2, Some(2)));
        assert_eq!((rest.len(), more), (2, false));
        assert_eq!(rest[1]["msg"], "request");
    }

    #[test]
    fn repeated_problems_group_together() {
        let s = summarize(DAY);
        assert_eq!(s["total"], 4);
        assert_eq!(s["errors"], 1);
        assert_eq!(s["warnings"], 2);
        assert_eq!(s["hours"][11]["warn"], 2);
        assert_eq!(s["problems"][0]["count"], 2);
        assert_eq!(s["problems"][0]["msg"], "slow peer 456", "the latest wording is what's shown");
    }

    #[test]
    fn only_real_days_reach_the_file_system() {
        assert!(valid_day("2026-11-01"));
        assert!(!valid_day("../../secret"));
        assert!(!valid_day("2026-11-0x"));
    }
}
