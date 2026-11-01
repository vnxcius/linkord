//! The monitor's own history, in SQLite: it must survive the app's database being down, and this way nothing is
//! added to Postgres. Samples every 10 s, thinned to one a minute after 48 h and dropped after 30 days. Check
//! results are 5-minute buckets for 90 days; incidents are kept for a year.

use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection};
use serde_json::{json, Value};

/// Every number tracked over time. A new name here gets its column at startup.
pub const SERIES: &[&str] = &[
    "cpu", "load1", "mem_used", "mem_total", "swap_used", "net_rx", "net_tx", "disk_read", "disk_write", "disk_used", "disk_total",
    "app_up", "app_cpu", "app_rss", "app_threads", "pg_cpu", "pg_rss", "monitor_cpu", "monitor_rss",
    "req_rate", "err_rate", "client_err_rate", "lat_p50", "lat_p95", "lat_p99", "in_flight",
    "ws_sessions", "ws_online", "voice_users", "voice_calls", "voice_streams", "voice_pps", "voice_bps", "media_pps", "media_bps", "queue_drops", "stale_media",
    "rt_lag", "rt_tasks", "rt_queued", "pool_size", "pool_idle",
    "pg_conns", "pg_size", "pg_hit", "pg_tps", "pg_slow",
    "net_latency", "net_loss", "uploads_bytes",
];

#[derive(Clone)]
pub struct Store(Arc<Mutex<Connection>>);

impl Store {
    pub fn open(dir: &Path) -> anyhow::Result<Store> {
        std::fs::create_dir_all(dir)?;
        let db = Connection::open(dir.join("monitor.sqlite"))?;
        db.pragma_update(None, "journal_mode", "WAL")?;
        db.pragma_update(None, "synchronous", "NORMAL")?;
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS samples (ts INTEGER PRIMARY KEY);
             CREATE TABLE IF NOT EXISTS check_buckets (
                bucket INTEGER NOT NULL, id TEXT NOT NULL, ok INTEGER NOT NULL, fail INTEGER NOT NULL,
                ms_sum REAL NOT NULL, ms_max REAL NOT NULL, PRIMARY KEY (bucket, id)
             ) WITHOUT ROWID;
             CREATE TABLE IF NOT EXISTS incidents (
                id INTEGER PRIMARY KEY, check_id TEXT NOT NULL, name TEXT NOT NULL, started INTEGER NOT NULL, ended INTEGER, error TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS speedtests (
                ts INTEGER PRIMARY KEY, down_mbps REAL, up_mbps REAL, latency_ms REAL, colo TEXT
             );",
        )?;
        let existing: Vec<String> = {
            let mut q = db.prepare("SELECT name FROM pragma_table_info('samples')")?;
            let names = q.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
            names
        };
        for key in SERIES {
            if !existing.iter().any(|c| c == key) {
                db.execute_batch(&format!("ALTER TABLE samples ADD COLUMN {key} REAL"))?;
            }
        }
        // Whatever was open when the monitor stopped isn't known to have ended; close it at the last thing we saw.
        db.execute("UPDATE incidents SET ended = COALESCE((SELECT MAX(ts) FROM samples), started) WHERE ended IS NULL", [])?;
        Ok(Store(Arc::new(Mutex::new(db))))
    }

    pub fn add_sample(&self, ts: i64, values: &[(&'static str, f64)]) {
        let values: Vec<_> = values.iter().filter(|(k, v)| SERIES.contains(k) && v.is_finite()).collect();
        let sql = if values.is_empty() {
            "INSERT OR REPLACE INTO samples (ts) VALUES (?)".to_string()
        } else {
            let cols = values.iter().map(|(k, _)| *k).collect::<Vec<_>>().join(",");
            let marks = vec!["?"; values.len()].join(",");
            format!("INSERT OR REPLACE INTO samples (ts,{cols}) VALUES (?,{marks})")
        };
        let mut args: Vec<rusqlite::types::Value> = vec![ts.into()];
        args.extend(values.iter().map(|(_, v)| rusqlite::types::Value::Real(*v)));
        if let Err(e) = self.0.lock().unwrap().execute(&sql, rusqlite::params_from_iter(args)) {
            tracing::warn!("saving a sample failed: {e}");
        }
    }

    /// Up to `points` averaged buckets per series, with the worst value of each bucket too.
    pub fn series(&self, keys: &[&str], from: i64, to: i64, points: i64) -> rusqlite::Result<Value> {
        let keys: Vec<&str> = keys.iter().copied().filter(|k| SERIES.contains(k)).collect();
        let step = ((to - from) / points.max(1)).max(10);
        if keys.is_empty() {
            return Ok(json!({ "step": step, "ts": [], "series": {} }));
        }
        let cols: Vec<String> = keys.iter().map(|k| format!("AVG({k}), MAX({k})")).collect();
        let sql = format!("SELECT (ts / {step}) * {step} AS b, {} FROM samples WHERE ts >= ?1 AND ts <= ?2 GROUP BY b ORDER BY b", cols.join(", "));
        let db = self.0.lock().unwrap();
        let mut q = db.prepare(&sql)?;
        let mut rows = q.query(params![from, to])?;
        let mut ts = vec![];
        let mut avg: Vec<Vec<Option<f64>>> = vec![vec![]; keys.len()];
        let mut max: Vec<Vec<Option<f64>>> = vec![vec![]; keys.len()];
        while let Some(r) = rows.next()? {
            ts.push(r.get::<_, i64>(0)?);
            for i in 0..keys.len() {
                avg[i].push(r.get(1 + i * 2)?);
                max[i].push(r.get(2 + i * 2)?);
            }
        }
        let series: serde_json::Map<String, Value> = keys.iter().enumerate().map(|(i, k)| (k.to_string(), json!({ "avg": avg[i], "max": max[i] }))).collect();
        Ok(json!({ "step": step, "ts": ts, "series": series }))
    }

    pub fn add_check(&self, ts: i64, id: &str, ok: bool, ms: f64) {
        let bucket = ts / 300 * 300;
        let r = self.0.lock().unwrap().execute(
            "INSERT INTO check_buckets (bucket, id, ok, fail, ms_sum, ms_max) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT (bucket, id) DO UPDATE SET ok = ok + ?3, fail = fail + ?4, ms_sum = ms_sum + ?5, ms_max = MAX(ms_max, ?5)",
            params![bucket, id, ok as i64, !ok as i64, ms],
        );
        if let Err(e) = r {
            tracing::warn!("saving a check failed: {e}");
        }
    }

    /// One entry per check: uptime over 24 h / 7 d / 30 d, only counting time the monitor was actually watching.
    pub fn uptime(&self, now: i64) -> rusqlite::Result<Value> {
        let db = self.0.lock().unwrap();
        let mut q = db.prepare(
            "SELECT id,
                SUM(CASE WHEN bucket >= ?1 THEN ok ELSE 0 END), SUM(CASE WHEN bucket >= ?1 THEN fail ELSE 0 END),
                SUM(CASE WHEN bucket >= ?2 THEN ok ELSE 0 END), SUM(CASE WHEN bucket >= ?2 THEN fail ELSE 0 END),
                SUM(ok), SUM(fail)
             FROM check_buckets WHERE bucket >= ?3 GROUP BY id",
        )?;
        let pct = |ok: i64, fail: i64| if ok + fail == 0 { Value::Null } else { json!(ok as f64 * 100.0 / (ok + fail) as f64) };
        let rows = q.query_map(params![now - 86400, now - 7 * 86400, now - 30 * 86400], |r| {
            Ok((
                r.get::<_, String>(0)?,
                json!({
                    "d1": pct(r.get(1)?, r.get(2)?),
                    "d7": pct(r.get(3)?, r.get(4)?),
                    "d30": pct(r.get(5)?, r.get(6)?),
                }),
            ))
        })?;
        let mut out = serde_json::Map::new();
        for row in rows {
            let (id, v) = row?;
            out.insert(id, v);
        }
        Ok(Value::Object(out))
    }

    /// A check's history in `count` equal slots ending now, for the status bars: ok/fail counts and average ms.
    pub fn check_history(&self, id: &str, from: i64, to: i64, count: i64) -> rusqlite::Result<Value> {
        let step = ((to - from) / count).max(300);
        let db = self.0.lock().unwrap();
        let mut q = db.prepare(
            "SELECT (bucket - ?2) / ?4 AS slot, SUM(ok), SUM(fail), SUM(ms_sum), MAX(ms_max) FROM check_buckets
             WHERE id = ?1 AND bucket >= ?2 AND bucket <= ?3 GROUP BY slot ORDER BY slot",
        )?;
        let rows = q.query_map(params![id, from, to, step], |r| {
            let (ok, fail): (i64, i64) = (r.get(1)?, r.get(2)?);
            let sum: f64 = r.get(3)?;
            Ok(json!({ "slot": r.get::<_, i64>(0)?, "ok": ok, "fail": fail, "ms": sum / (ok + fail).max(1) as f64, "max": r.get::<_, f64>(4)? }))
        })?;
        Ok(json!({ "step": step, "from": from, "slots": rows.collect::<Result<Vec<_>, _>>()? }))
    }

    pub fn open_incident(&self, check: &str, name: &str, started: i64, error: &str) {
        let _ = self.0.lock().unwrap().execute("INSERT INTO incidents (check_id, name, started, error) VALUES (?1, ?2, ?3, ?4)", params![check, name, started, error]);
    }

    pub fn close_incident(&self, check: &str, ended: i64) {
        let _ = self.0.lock().unwrap().execute("UPDATE incidents SET ended = ?2 WHERE check_id = ?1 AND ended IS NULL", params![check, ended]);
    }

    pub fn incidents(&self, limit: i64) -> rusqlite::Result<Value> {
        let db = self.0.lock().unwrap();
        let mut q = db.prepare("SELECT check_id, name, started, ended, error FROM incidents ORDER BY started DESC LIMIT ?1")?;
        let rows = q.query_map([limit], |r| {
            Ok(json!({ "check": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?, "started": r.get::<_, i64>(2)?, "ended": r.get::<_, Option<i64>>(3)?, "error": r.get::<_, String>(4)? }))
        })?;
        Ok(Value::Array(rows.collect::<Result<_, _>>()?))
    }

    pub fn add_speedtest(&self, ts: i64, down: Option<f64>, up: Option<f64>, latency: Option<f64>, colo: Option<&str>) {
        let _ = self.0.lock().unwrap().execute("INSERT OR REPLACE INTO speedtests (ts, down_mbps, up_mbps, latency_ms, colo) VALUES (?1, ?2, ?3, ?4, ?5)", params![ts, down, up, latency, colo]);
    }

    pub fn speedtests(&self, limit: i64) -> rusqlite::Result<Value> {
        let db = self.0.lock().unwrap();
        let mut q = db.prepare("SELECT ts, down_mbps, up_mbps, latency_ms, colo FROM speedtests ORDER BY ts DESC LIMIT ?1")?;
        let rows = q.query_map([limit], |r| {
            Ok(json!({ "ts": r.get::<_, i64>(0)?, "down": r.get::<_, Option<f64>>(1)?, "up": r.get::<_, Option<f64>>(2)?, "latency": r.get::<_, Option<f64>>(3)?, "colo": r.get::<_, Option<String>>(4)? }))
        })?;
        Ok(Value::Array(rows.collect::<Result<_, _>>()?))
    }

    /// Thins and drops old rows; hourly.
    pub fn prune(&self, now: i64) {
        let db = self.0.lock().unwrap();
        let _ = db.execute("DELETE FROM samples WHERE ts < ?1 AND ts % 60 >= 10", [now - 48 * 3600]);
        let _ = db.execute("DELETE FROM samples WHERE ts < ?1", [now - 30 * 86400]);
        let _ = db.execute("DELETE FROM check_buckets WHERE bucket < ?1", [now - 90 * 86400]);
        let _ = db.execute("DELETE FROM incidents WHERE started < ?1 AND ended IS NOT NULL", [now - 365 * 86400]);
        let _ = db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    }

    /// Disk used by the history, in bytes.
    pub fn size(&self) -> i64 {
        let db = self.0.lock().unwrap();
        db.query_row("SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()", [], |r| r.get(0)).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> Store {
        let dir = std::env::temp_dir().join(format!("linkord-monitor-test-{}", rand::random::<u64>()));
        Store::open(&dir).unwrap()
    }

    #[test]
    fn series_are_averaged_into_buckets() {
        let s = temp();
        for i in 0..6 {
            s.add_sample(1020 + i * 10, &[("cpu", (i * 10) as f64), ("not_a_series", 1.0)]);
        }
        let v = s.series(&["cpu", "nope"], 1020, 1080, 2).unwrap();
        assert_eq!(v["step"], 30);
        assert_eq!(v["series"]["cpu"]["max"].as_array().unwrap().last().unwrap(), 50.0);
        assert!(v["series"].get("nope").is_none());
    }

    #[test]
    fn uptime_only_counts_what_was_measured() {
        let s = temp();
        let now = 1_000_000;
        for ok in [true, true, true, false] {
            s.add_check(now - 60, "app", ok, 10.0);
        }
        let v = s.uptime(now).unwrap();
        assert_eq!(v["app"]["d1"], 75.0);
        assert!(v.get("never-run").is_none());
    }

    #[test]
    fn old_samples_thin_out_then_go() {
        let s = temp();
        let now = 100 * 86400;
        s.add_sample(now - 3 * 86400 + 5, &[("cpu", 1.0)]); // within the first 10 s of a minute: kept
        s.add_sample(now - 3 * 86400 + 25, &[("cpu", 1.0)]); // thinned
        s.add_sample(now - 40 * 86400, &[("cpu", 1.0)]); // too old
        s.add_sample(now - 100, &[("cpu", 1.0)]); // recent
        s.prune(now);
        let v = s.series(&["cpu"], 0, now, 100_000).unwrap();
        assert_eq!(v["ts"].as_array().unwrap().len(), 2);
    }
}
