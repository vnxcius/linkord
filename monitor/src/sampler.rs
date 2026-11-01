//! Reads the machine and the app's counters every 5 s into `live`, and saves a row of history every 10 s.

use std::collections::HashMap;
use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use sysinfo::{Disks, Networks, ProcessRefreshKind, ProcessesToUpdate, System};

use crate::state::AppState;

const TICK: Duration = Duration::from_secs(5);
const SAVE_EVERY: i64 = 10;

/// Virtual interfaces would count the same traffic twice in the machine's total.
pub fn is_virtual_interface(name: &str) -> bool {
    let n = name.to_lowercase();
    n == "lo" || n.starts_with("veth") || n.starts_with("br-") || n.starts_with("docker") || n.contains("loopback") || n.starts_with("vethernet")
}

/// Snap images, container layers and the like aren't disks anyone has to look after.
fn is_real_disk(mount: &str, fs: &str) -> bool {
    !(mount.starts_with("/snap") || mount.starts_with("/var/lib/docker") || mount.starts_with("/run") || mount.starts_with("/boot/efi") || fs == "squashfs" || fs == "overlay" || fs == "tmpfs")
}

/// Percentile from cumulative-free histogram counts: the upper bound of the bucket it lands in, interpolated.
pub fn percentile(bounds: &[f64], counts: &[u64], p: f64) -> Option<f64> {
    let total: u64 = counts.iter().sum();
    if total == 0 {
        return None;
    }
    let target = total as f64 * p;
    let mut seen = 0.0;
    for (i, c) in counts.iter().enumerate() {
        let next = seen + *c as f64;
        if next >= target && *c > 0 {
            let low = if i == 0 { 0.0 } else { bounds[i - 1] };
            // The last bucket has no upper bound: report its lower one.
            let Some(high) = bounds.get(i) else { return Some(low) };
            return Some(low + (high - low) * ((target - seen) / *c as f64));
        }
        seen = next;
    }
    bounds.last().copied()
}

#[derive(Default)]
struct Previous {
    at: Option<Instant>,
    requests: u64,
    status: Vec<u64>,
    histogram: Vec<u64>,
    routes: HashMap<String, (u64, u64)>,
    voice_packets: u64,
    voice_bytes: u64,
    media_packets: u64,
    media_bytes: u64,
    queue_drops: u64,
    stale_media: u64,
}

fn u(v: &Value) -> u64 {
    v.as_u64().unwrap_or(0)
}

fn u_list(v: &Value) -> Vec<u64> {
    v.as_array().map(|a| a.iter().map(u).collect()).unwrap_or_default()
}

/// The app's counters, with rates since the last reading.
async fn read_app(st: &AppState, prev: &mut Previous) -> Option<Value> {
    let url = st.cfg.internal_url.as_ref()?;
    let token = tokio::fs::read_to_string(st.cfg.app_data.join("internal-token")).await.ok()?;
    let res = st.http.get(format!("{url}/metrics")).bearer_auth(token.trim()).timeout(Duration::from_secs(3)).send().await.ok()?;
    let mut m: Value = res.error_for_status().ok()?.json().await.ok()?;

    let now = Instant::now();
    let dt = prev.at.map(|t| now.duration_since(t).as_secs_f64()).unwrap_or(0.0);
    let requests = u(&m["http"]["requests"]);
    // A restart resets the counters: treat the first reading after it like the very first one.
    let fresh = dt == 0.0 || requests < prev.requests;
    let rate = |cur: u64, old: u64| if fresh { 0.0 } else { cur.saturating_sub(old) as f64 / dt };

    let status = u_list(&m["http"]["status"]);
    let histogram = u_list(&m["http"]["histogram"]);
    let bounds: Vec<f64> = u_list(&m["http"]["buckets"]).into_iter().map(|b| b as f64).collect();
    let window: Vec<u64> = if fresh { vec![0; histogram.len()] } else { histogram.iter().zip(prev.histogram.iter().chain(std::iter::repeat(&0))).map(|(c, o)| c.saturating_sub(*o)).collect() };
    let at = |i: usize| rate(status.get(i).copied().unwrap_or(0), prev.status.get(i).copied().unwrap_or(0));

    let voice = m["voice"].clone();
    m["rates"] = json!({
        "req": rate(requests, prev.requests),
        "ok": at(2) + at(3) + at(1),
        "client_err": at(4),
        "server_err": at(5),
        "p50": percentile(&bounds, &window, 0.50),
        "p95": percentile(&bounds, &window, 0.95),
        "p99": percentile(&bounds, &window, 0.99),
        "voice_pps": rate(u(&voice["voice_packets"]), prev.voice_packets),
        "voice_bps": rate(u(&voice["voice_bytes"]), prev.voice_bytes),
        "media_pps": rate(u(&voice["media_packets"]), prev.media_packets),
        "media_bps": rate(u(&voice["media_bytes"]), prev.media_bytes),
        "queue_drops": rate(u(&voice["queue_drops"]), prev.queue_drops),
        "stale_media": rate(u(&voice["stale_media"]), prev.stale_media),
    });

    // Busiest routes right now, for the performance tab.
    let mut seen = HashMap::new();
    if let Some(routes) = m["http"]["routes"].as_array_mut() {
        for r in routes.iter_mut() {
            let (name, count, total) = (r["route"].as_str().unwrap_or("").to_string(), u(&r["count"]), u(&r["total_ms"]));
            let (oc, ot) = prev.routes.get(&name).copied().unwrap_or((0, 0));
            r["rate"] = json!(rate(count, oc));
            let delta = count.saturating_sub(oc);
            r["recent_avg_ms"] = if !fresh && delta > 0 { json!(total.saturating_sub(ot) as f64 / delta as f64) } else { Value::Null };
            r["avg_ms"] = json!(total as f64 / count.max(1) as f64);
            seen.insert(name, (count, total));
        }
    }

    *prev = Previous {
        at: Some(now),
        requests,
        status,
        histogram,
        routes: seen,
        voice_packets: u(&voice["voice_packets"]),
        voice_bytes: u(&voice["voice_bytes"]),
        media_packets: u(&voice["media_packets"]),
        media_bytes: u(&voice["media_bytes"]),
        queue_drops: u(&voice["queue_drops"]),
        stale_media: u(&voice["stale_media"]),
    };
    Some(m)
}

#[cfg(target_os = "linux")]
fn open_files(pid: u32) -> Option<usize> {
    std::fs::read_dir(format!("/proc/{pid}/fd")).ok().map(|d| d.count())
}

#[cfg(not(target_os = "linux"))]
fn open_files(_pid: u32) -> Option<usize> {
    None
}

/// The disk holding `path`: the longest mount point it starts with.
pub fn disk_of<'a>(disks: &'a [Value], path: &Path) -> Option<&'a Value> {
    let path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let text = path.to_string_lossy().replace("\\\\?\\", "").to_lowercase();
    disks
        .iter()
        .filter(|d| text.starts_with(&d["mount"].as_str().unwrap_or("\u{0}").to_lowercase()))
        .max_by_key(|d| d["mount"].as_str().map_or(0, str::len))
}

pub async fn run(st: AppState) {
    let mut sys = System::new();
    let mut networks = Networks::new_with_refreshed_list();
    let mut disks = Disks::new_with_refreshed_list();
    let cores_known = {
        sys.refresh_cpu_all();
        sys.cpus().len().max(1)
    };
    let refresh = ProcessRefreshKind::nothing().with_cpu().with_memory().with_disk_usage();
    let own_pid = std::process::id();
    let mut prev = Previous::default();
    let mut last_at = Instant::now();
    let mut tick = tokio::time::interval(TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_saved = 0;
    let mut disk_list_age = 0u32;
    loop {
        tick.tick().await;
        let dt = last_at.elapsed().as_secs_f64().max(0.001);
        last_at = Instant::now();

        sys.refresh_cpu_all();
        sys.refresh_memory();
        sys.refresh_processes_specifics(ProcessesToUpdate::All, true, refresh);
        networks.refresh(true);
        disk_list_age += 1;
        // New mounts are rare; only the numbers change every tick.
        if disk_list_age % 60 == 0 {
            disks = Disks::new_with_refreshed_list();
        } else {
            disks.refresh(true);
        }

        let load = System::load_average();
        let cores: Vec<f64> = sys.cpus().iter().map(|c| c.cpu_usage() as f64).collect();

        let mut interfaces = vec![];
        let (mut rx_total, mut tx_total) = (0.0, 0.0);
        for (name, data) in networks.iter() {
            let (rx, tx) = (data.received() as f64 / dt, data.transmitted() as f64 / dt);
            if !is_virtual_interface(name) {
                rx_total += rx;
                tx_total += tx;
            }
            interfaces.push(json!({
                "name": name,
                "rx": rx,
                "tx": tx,
                "rx_total": data.total_received(),
                "tx_total": data.total_transmitted(),
                "errors": data.total_errors_on_received() + data.total_errors_on_transmitted(),
                "ips": data.ip_networks().iter().map(|n| n.addr.to_string()).collect::<Vec<_>>(),
                "virtual": is_virtual_interface(name),
            }));
        }
        interfaces.sort_by(|a, b| {
            let t = |v: &Value| u(&v["rx_total"]) + u(&v["tx_total"]);
            t(b).cmp(&t(a))
        });

        let mut disk_rows = vec![];
        let (mut read_total, mut write_total) = (0.0, 0.0);
        for d in disks.iter() {
            let mount = d.mount_point().to_string_lossy().to_string();
            let fs = d.file_system().to_string_lossy().to_string();
            if !is_real_disk(&mount, &fs) || d.total_space() == 0 {
                continue;
            }
            let usage = d.usage();
            let (read, written) = (usage.read_bytes as f64 / dt, usage.written_bytes as f64 / dt);
            read_total += read;
            write_total += written;
            disk_rows.push(json!({
                "name": d.name().to_string_lossy(),
                "mount": mount,
                "fs": fs,
                "kind": d.kind().to_string(),
                "total": d.total_space(),
                "free": d.available_space(),
                "used": d.total_space() - d.available_space(),
                "read": read,
                "write": written,
            }));
        }
        let data_disk = disk_of(&disk_rows, &st.cfg.app_data).cloned();

        let app = read_app(&st, &mut prev).await;
        let app_pid = app.as_ref().and_then(|a| a["pid"].as_u64()).map(|p| p as u32);
        let wanted = st.cfg.app_process.to_lowercase();

        let mut procs = vec![];
        let mut app_proc = None;
        let (mut pg_cpu, mut pg_rss, mut pg_seen) = (0.0, 0u64, false);
        let mut own = None;
        let cores_n = cores_known as f64;
        for (pid, p) in sys.processes() {
            if p.thread_kind().is_some() {
                continue;
            }
            let name = p.name().to_string_lossy().to_string();
            let lower = name.to_lowercase();
            let usage = p.disk_usage();
            let row = json!({
                "pid": pid.as_u32(),
                "name": name,
                // Share of the whole machine, so it adds up to the CPU figure.
                "cpu": p.cpu_usage() as f64 / cores_n,
                "mem": p.memory(),
                "read": usage.read_bytes as f64 / dt,
                "write": usage.written_bytes as f64 / dt,
                "run_time": p.run_time(),
            });
            let is_app = match app_pid {
                Some(id) => id == pid.as_u32(),
                None => lower == wanted || lower == format!("{wanted}.exe"),
            };
            if is_app {
                app_proc = Some(json!({
                    "pid": pid.as_u32(),
                    "cpu": p.cpu_usage() as f64 / cores_n,
                    "mem": p.memory(),
                    "virtual_mem": p.virtual_memory(),
                    "read": usage.read_bytes as f64 / dt,
                    "write": usage.written_bytes as f64 / dt,
                    "threads": p.tasks().map(|t| t.len()),
                    "open_files": open_files(pid.as_u32()),
                    "run_time": p.run_time(),
                }));
            }
            if lower == "postgres" || lower == "postgres.exe" {
                pg_seen = true;
                pg_cpu += p.cpu_usage() as f64 / cores_n;
                pg_rss += p.memory();
            }
            if pid.as_u32() == own_pid {
                own = Some(json!({ "cpu": p.cpu_usage() as f64 / cores_n, "mem": p.memory() }));
            }
            procs.push(row);
        }
        procs.sort_by(|a, b| b["cpu"].as_f64().unwrap_or(0.0).total_cmp(&a["cpu"].as_f64().unwrap_or(0.0)));
        let mut by_mem = procs.clone();
        by_mem.sort_by_key(|p| std::cmp::Reverse(u(&p["mem"])));
        procs.truncate(12);
        by_mem.truncate(12);

        let live = json!({
            "ts": chrono::Utc::now().timestamp(),
            "host": {
                "name": System::host_name(),
                "os": System::long_os_version(),
                "kernel": System::kernel_version(),
                "arch": System::cpu_arch(),
                "cpu_model": sys.cpus().first().map(|c| c.brand().trim().to_string()),
                "cores": cores_known,
                "uptime": System::uptime(),
                "processes": sys.processes().len(),
            },
            // Windows has no load average: leave it out rather than show a zero that means nothing.
            "cpu": { "total": sys.global_cpu_usage(), "cores": cores, "load": if cfg!(windows) { Value::Null } else { json!([load.one, load.five, load.fifteen]) } },
            "memory": { "total": sys.total_memory(), "used": sys.used_memory(), "available": sys.available_memory(), "swap_total": sys.total_swap(), "swap_used": sys.used_swap() },
            "interfaces": interfaces,
            "net": { "rx": rx_total, "tx": tx_total },
            "disks": disk_rows,
            "data_disk": data_disk,
            "disk_io": { "read": read_total, "write": write_total },
            "app": app,
            "app_process": app_proc,
            "postgres_process": if pg_seen { json!({ "cpu": pg_cpu, "mem": pg_rss }) } else { Value::Null },
            "monitor_process": own,
            "top_cpu": procs,
            "top_mem": by_mem,
        });

        let now = live["ts"].as_i64().unwrap_or(0);
        let slot = now / SAVE_EVERY * SAVE_EVERY;
        if slot != last_saved {
            last_saved = slot;
            let row = sample_row(&st, &live);
            let store = st.store.clone();
            let _ = tokio::task::spawn_blocking(move || store.add_sample(slot, &row)).await;
        }
        *st.live.write().unwrap() = live;
    }
}

/// The numbers kept over time, out of one reading. Missing parts (app down, ...) stay empty so charts show a gap.
fn sample_row(st: &AppState, l: &Value) -> Vec<(&'static str, f64)> {
    let mut row: Vec<(&'static str, f64)> = vec![];
    let mut put = |k: &'static str, v: &Value| {
        if let Some(n) = v.as_f64() {
            row.push((k, n));
        }
    };
    put("cpu", &l["cpu"]["total"]);
    put("load1", &l["cpu"]["load"][0]);
    put("mem_used", &l["memory"]["used"]);
    put("mem_total", &l["memory"]["total"]);
    put("swap_used", &l["memory"]["swap_used"]);
    put("net_rx", &l["net"]["rx"]);
    put("net_tx", &l["net"]["tx"]);
    put("disk_read", &l["disk_io"]["read"]);
    put("disk_write", &l["disk_io"]["write"]);
    put("disk_used", &l["data_disk"]["used"]);
    put("disk_total", &l["data_disk"]["total"]);
    put("app_cpu", &l["app_process"]["cpu"]);
    put("app_rss", &l["app_process"]["mem"]);
    put("app_threads", &l["app_process"]["threads"]);
    put("pg_cpu", &l["postgres_process"]["cpu"]);
    put("pg_rss", &l["postgres_process"]["mem"]);
    put("monitor_cpu", &l["monitor_process"]["cpu"]);
    put("monitor_rss", &l["monitor_process"]["mem"]);
    let a = &l["app"];
    let r = &a["rates"];
    put("req_rate", &r["req"]);
    put("err_rate", &r["server_err"]);
    put("client_err_rate", &r["client_err"]);
    put("lat_p50", &r["p50"]);
    put("lat_p95", &r["p95"]);
    put("lat_p99", &r["p99"]);
    put("in_flight", &a["http"]["in_flight"]);
    put("ws_sessions", &a["gateway"]["attached"]);
    put("ws_online", &a["gateway"]["online_users"]);
    put("voice_users", &a["voice"]["users"]);
    put("voice_calls", &a["voice"]["calls"]);
    put("voice_streams", &a["voice"]["streams"]);
    put("voice_pps", &r["voice_pps"]);
    put("voice_bps", &r["voice_bps"]);
    put("media_pps", &r["media_pps"]);
    put("media_bps", &r["media_bps"]);
    put("queue_drops", &r["queue_drops"]);
    put("stale_media", &r["stale_media"]);
    put("rt_lag", &a["runtime"]["lag_max_ms"]);
    put("rt_tasks", &a["runtime"]["tasks"]);
    put("rt_queued", &a["runtime"]["queued"]);
    put("pool_size", &a["db_pool"]["size"]);
    put("pool_idle", &a["db_pool"]["idle"]);
    {
        let pg = st.pg_quick.read().unwrap();
        put("pg_conns", &pg["connections"]);
        put("pg_size", &pg["size"]);
        put("pg_hit", &pg["cache_hit"]);
        put("pg_tps", &pg["tps"]);
        put("pg_slow", &pg["slow"]);
    }
    {
        let storage = st.storage.read().unwrap();
        put("uploads_bytes", &storage["uploads_bytes"]);
    }
    let checks = st.checks.read().unwrap();
    if let Some(net) = checks.iter().find(|c| c.id == "internet") {
        if let Some(ms) = net.ms {
            put("net_latency", &json!(ms));
        }
        put("net_loss", &json!(net.loss.unwrap_or(0.0)));
    }
    drop(checks);
    put("app_up", &json!(if l["app"].is_null() { 0.0 } else { 1.0 }));
    row
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentiles_interpolate_inside_a_bucket() {
        let bounds = [10.0, 100.0, 1000.0];
        assert_eq!(percentile(&bounds, &[0, 0, 0, 0], 0.5), None);
        assert_eq!(percentile(&bounds, &[10, 0, 0, 0], 0.5), Some(5.0));
        assert_eq!(percentile(&bounds, &[0, 10, 0, 0], 1.0), Some(100.0));
        // Above the last bound there's no upper end: the lower one is all that's known.
        assert_eq!(percentile(&bounds, &[0, 0, 0, 5], 0.5), Some(1000.0));
    }

    #[test]
    fn virtual_interfaces_stay_out_of_the_total() {
        assert!(is_virtual_interface("lo"));
        assert!(is_virtual_interface("veth12ab"));
        assert!(is_virtual_interface("docker0"));
        assert!(is_virtual_interface("Loopback Pseudo-Interface 1"));
        assert!(!is_virtual_interface("eth0"));
        assert!(!is_virtual_interface("enp3s0"));
    }

    #[test]
    fn the_longest_mount_point_wins() {
        let disks = vec![json!({ "mount": "/" }), json!({ "mount": "/home" })];
        assert_eq!(disk_of(&disks, Path::new("/home/x/data")).unwrap()["mount"], "/home");
        assert_eq!(disk_of(&disks, Path::new("/var/lib")).unwrap()["mount"], "/");
    }
}
