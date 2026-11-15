//! Restarts without dropping anyone: a new server process takes over from the running one.
//!
//! The new process starts next to the old one and does everything that can fail first (database, migrations, bots).
//! Then it connects to the old one's handover socket (`<data>/run/handover.sock`) and asks to take over:
//! 1. the old process freezes its gateway (events from then on are kept for the new one), takes a snapshot of what
//!    only lives in memory (gateway sessions, voice calls, watch together, activities, Kass's queue...) and sends it,
//!    together with its listening sockets (SCM_RIGHTS: the same sockets, so no connection is ever refused);
//! 2. the new process restores the snapshot (everyone in a call is "detached", waiting to reconnect), starts
//!    accepting and says it's ready;
//! 3. the old process stops accepting, closes every websocket with 4100 ("server restarting") so clients reconnect
//!    at once (to the new process) and resume their gateway and voice sessions, finishes the requests it was serving
//!    (forwarding their gateway events to the new process) and stops.
//!
//! If the new process fails before it's ready, the old one simply carries on.
//! A plain stop (SIGTERM, Ctrl+C) without a successor writes the snapshot to `<data>/run/snapshot.json` instead;
//! a process starting within two minutes restores it, so a quick restart keeps calls going too.
//!
//! Taking over needs LINKORD_TAKEOVER=1: a stray `cargo run` with the production settings must not replace it.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::watch;

use crate::config::Config;
use crate::state::AppState;

/// Saved snapshots older than this are ignored: the calls in them are long over.
const SNAPSHOT_MAX_AGE_MS: i64 = 120_000;
/// How long the old process waits for the new one to say it's ready.
const READY_TIMEOUT: Duration = Duration::from_secs(30);
/// How long requests that were already running get to finish after a handover or stop.
pub const DRAIN_TIMEOUT: Duration = Duration::from_secs(60);

static FROZEN: AtomicBool = AtomicBool::new(false);
static RETIRED: AtomicBool = AtomicBool::new(false);

/// This process handed over (or is stopping): websockets end without cleanup, background loops stop, and leaving a
/// call changes nothing (the state already went to the next process).
pub fn retired() -> bool {
    RETIRED.load(Ordering::Relaxed)
}

/// A snapshot is being taken or sent: background loops skip a round, so the snapshot stays what the next process gets.
pub fn paused() -> bool {
    FROZEN.load(Ordering::Relaxed) || retired()
}

fn stop_tx() -> &'static watch::Sender<bool> {
    static S: OnceLock<watch::Sender<bool>> = OnceLock::new();
    S.get_or_init(|| watch::channel(false).0)
}

/// Resolves once this process should stop accepting connections (handed over, or stopping).
pub async fn stop_accepting() {
    let mut rx = stop_tx().subscribe();
    let _ = rx.wait_for(|v| *v).await;
}

fn stop_now() {
    RETIRED.store(true, Ordering::Relaxed);
    stop_tx().send_replace(true);
}

/// The whole snapshot. Each part is kept as JSON on its own, so a part an older or newer version can't read is only
/// that part lost, never the handover.
#[derive(Serialize, Deserialize, Default)]
pub struct Snapshot {
    /// Unix ms.
    pub taken_at: i64,
    pub version: String,
    /// The old process's id parity (id.rs); the new one takes the other.
    pub parity: u8,
    #[serde(default)]
    pub parts: serde_json::Map<String, Value>,
}

impl Snapshot {
    fn take(st: &AppState) -> Snapshot {
        let mut parts = serde_json::Map::new();
        parts.insert("hub".into(), st.hub.snapshot_state());
        parts.insert("voice".into(), crate::voice::snapshot(st));
        parts.insert("watches".into(), crate::watch::snapshot(st));
        parts.insert("activities".into(), crate::activities::snapshot(st));
        parts.insert("previews".into(), crate::previews::snapshot(st));
        parts.insert("music".into(), crate::music::snapshot(st));
        parts.insert("auth".into(), crate::auth::snapshot(st));
        parts.insert("steve".into(), crate::steve::snapshot(st));
        Snapshot { taken_at: now_ms(), version: env!("CARGO_PKG_VERSION").into(), parity: crate::id::parity(), parts }
    }

    pub fn age_ms(&self) -> i64 {
        now_ms() - self.taken_at
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Puts a snapshot back. Gateway and auth first; voice before music (Kass rejoins his own detached seat).
pub async fn restore(st: &AppState, mut snap: Snapshot) {
    let age = snap.age_ms().max(0);
    let mut part = |name: &str| snap.parts.remove(name).unwrap_or(Value::Null);
    let (hub, voice, watches, activities, previews, music, auth, steve) =
        (part("hub"), part("voice"), part("watches"), part("activities"), part("previews"), part("music"), part("auth"), part("steve"));
    report("hub", st.hub.restore_state(hub, age));
    report("auth", crate::auth::restore(st, auth, age));
    report("voice", crate::voice::restore(st, voice, age));
    report("watches", crate::watch::restore(st, watches));
    report("activities", crate::activities::restore(st, activities, age));
    report("previews", crate::previews::restore(st, previews));
    report("steve", crate::steve::restore(st, steve));
    report("music", crate::music::restore(st, music, age).await);
    tracing::info!(from = %snap.version, age_ms = age, "handover: state restored");
}

fn report(part: &str, r: anyhow::Result<()>) {
    if let Err(e) = r {
        tracing::warn!("handover: couldn't restore {part}: {e:#}");
    }
}

fn run_dir(cfg: &Config) -> PathBuf {
    cfg.data_dir.join("run")
}

fn snapshot_file(cfg: &Config) -> PathBuf {
    run_dir(cfg).join("snapshot.json")
}

/// A snapshot a stopped process left, if it's recent. It's used once.
pub fn saved_snapshot(cfg: &Config) -> Option<Snapshot> {
    let path = snapshot_file(cfg);
    let bytes = std::fs::read(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    let snap: Snapshot = match serde_json::from_slice(&bytes) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!("handover: ignoring the saved snapshot: {e}");
            return None;
        }
    };
    if snap.age_ms() > SNAPSHOT_MAX_AGE_MS {
        tracing::info!(age_ms = snap.age_ms(), "handover: the saved snapshot is too old, starting fresh");
        return None;
    }
    Some(snap)
}

fn write_snapshot(cfg: &Config, snap: &Snapshot) -> anyhow::Result<()> {
    let dir = run_dir(cfg);
    std::fs::create_dir_all(&dir)?;
    let tmp = dir.join("snapshot.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(snap)?)?;
    std::fs::rename(tmp, snapshot_file(cfg))?;
    Ok(())
}

/// Closes every client websocket with 4100, so clients reconnect right away and resume.
fn close_sockets(st: &AppState) {
    st.hub.close_all_restarting();
    crate::voice::close_all_restarting(st);
    crate::steve::close_restarting(st);
}

/// Stopping without a successor (SIGTERM, Ctrl+C): saves the snapshot for the next start, then stops accepting.
async fn stop_alone(st: &AppState) {
    let _events = st.hub.freeze();
    FROZEN.store(true, Ordering::Relaxed);
    let snap = Snapshot::take(st);
    match write_snapshot(&st.cfg, &snap) {
        Ok(()) => tracing::info!("handover: stopping, state saved for the next start"),
        Err(e) => tracing::warn!("handover: stopping, couldn't save the state: {e:#}"),
    }
    stop_now();
    close_sockets(st);
}

/// Waits for SIGTERM / Ctrl+C. Before a handover: save and stop. After one: the old process only finishes its requests.
pub async fn on_signal(st: AppState) {
    wait_signal().await;
    if retired() {
        tracing::info!("handover: stop requested after handing over");
        signaled().store(true, Ordering::Relaxed);
        return;
    }
    signaled().store(true, Ordering::Relaxed);
    stop_alone(&st).await;
}

fn signaled() -> &'static AtomicBool {
    static S: AtomicBool = AtomicBool::new(false);
    &S
}

async fn wait_signal() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM handler");
        tokio::select! {
            _ = term.recv() => {}
            _ = tokio::signal::ctrl_c() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

/// Records that this process is the one serving (`<data>/run/live`: slot, pid, version), for deploy scripts: the
/// deploy stops the old container once the new slot is written here.
pub fn mark_live(cfg: &Config) {
    let slot = std::env::var("LINKORD_SLOT").unwrap_or_default();
    let line = serde_json::json!({ "slot": slot, "pid": std::process::id(), "version": env!("CARGO_PKG_VERSION"), "since": now_ms() });
    let dir = run_dir(cfg);
    let _ = std::fs::create_dir_all(&dir);
    let tmp = dir.join("live.tmp");
    if std::fs::write(&tmp, line.to_string()).and_then(|_| std::fs::rename(&tmp, dir.join("live"))).is_err() {
        tracing::warn!("handover: couldn't write {}", dir.join("live").display());
    }
}

/// After the servers stopped: tells the next process we're done, then (LINKORD_AFTER_HANDOVER=wait, as in Docker,
/// where an exit would get the old container restarted) waits to be stopped.
pub async fn finish() {
    drained_tx().send_replace(true);
    // Lets the successor connection send its last events.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let wait = std::env::var("LINKORD_AFTER_HANDOVER").is_ok_and(|v| v == "wait");
    if wait && retired() && !signaled().load(Ordering::Relaxed) {
        tracing::info!("handover: done; waiting to be stopped");
        wait_signal().await;
    }
}

fn drained_tx() -> &'static watch::Sender<bool> {
    static S: OnceLock<watch::Sender<bool>> = OnceLock::new();
    S.get_or_init(|| watch::channel(false).0)
}

/// Runs a server until it stops accepting and its requests finish (at most DRAIN_TIMEOUT after the stop).
pub async fn until_drained<F: std::future::Future>(server: F) {
    tokio::pin!(server);
    tokio::select! {
        _ = &mut server => {}
        _ = async { stop_accepting().await; tokio::time::sleep(DRAIN_TIMEOUT).await } => {
            tracing::warn!("handover: requests still running after {}s, stopping anyway", DRAIN_TIMEOUT.as_secs());
        }
    }
}

// ---------- listening sockets ----------

static INHERITED: Mutex<Vec<(String, Listener)>> = Mutex::new(Vec::new());
/// Copies of this process's listening sockets, to hand over.
static KEPT: Mutex<Vec<(String, Listener)>> = Mutex::new(Vec::new());

#[cfg(unix)]
type Listener = std::os::fd::OwnedFd;
#[cfg(not(unix))]
type Listener = std::net::TcpListener;

/// The listening socket `name` for `addr`: the one the previous process handed over if it listens there, a new one
/// otherwise. Non-blocking, ready for tokio.
pub fn listener(name: &str, addr: &str) -> std::io::Result<std::net::TcpListener> {
    let inherited = {
        let mut list = INHERITED.lock().unwrap();
        list.iter().position(|(n, _)| n == name).map(|i| list.remove(i).1)
    };
    let listener = match inherited.map(to_std).filter(|l| same_addr(l, addr)) {
        Some(l) => {
            tracing::info!("handover: listening on {addr} (taken over)");
            l
        }
        None => std::net::TcpListener::bind(addr)?,
    };
    listener.set_nonblocking(true)?;
    KEPT.lock().unwrap().push((name.into(), keep(&listener)?));
    Ok(listener)
}

fn same_addr(l: &std::net::TcpListener, addr: &str) -> bool {
    let wanted: Option<std::net::SocketAddr> = addr.parse().ok();
    let same = l.local_addr().ok().is_some_and(|a| Some(a) == wanted);
    if !same {
        tracing::info!("handover: the address changed to {addr}; not using the old socket");
    }
    same
}

#[cfg(unix)]
fn to_std(fd: Listener) -> std::net::TcpListener {
    std::net::TcpListener::from(fd)
}
#[cfg(not(unix))]
fn to_std(l: Listener) -> std::net::TcpListener {
    l
}

#[cfg(unix)]
fn keep(l: &std::net::TcpListener) -> std::io::Result<Listener> {
    use std::os::fd::AsFd;
    l.as_fd().try_clone_to_owned()
}
#[cfg(not(unix))]
fn keep(l: &std::net::TcpListener) -> std::io::Result<Listener> {
    l.try_clone()
}

// ---------- the handover itself (Unix only: it passes sockets between processes) ----------

/// What the new process got from the old one.
pub struct Incoming {
    pub snapshot: Snapshot,
    #[cfg(unix)]
    conn: tokio::net::UnixStream,
}

fn socket_path(cfg: &Config) -> PathBuf {
    run_dir(cfg).join("handover.sock")
}

/// Called early by a starting process: takes over from a running one if there is one. Err = there is one and it
/// can't be taken over (so this process must not start).
#[cfg(unix)]
pub async fn take_over(cfg: &Config) -> anyhow::Result<Option<Incoming>> {
    use anyhow::Context;
    let path = socket_path(cfg);
    let Ok(mut conn) = tokio::net::UnixStream::connect(&path).await else { return Ok(None) };
    if !std::env::var("LINKORD_TAKEOVER").is_ok_and(|v| v == "1") {
        anyhow::bail!("another linkord server is running on {} (set LINKORD_TAKEOVER=1 to take over from it)", cfg.data_dir.display());
    }
    tracing::info!("handover: taking over from the running server");
    write_frame(&mut conn, &serde_json::json!({ "op": "hello", "version": env!("CARGO_PKG_VERSION") })).await?;
    let fds = tokio::time::timeout(Duration::from_secs(20), recv_fds(&conn)).await.context("waiting for the old server")??;
    let state: Value = tokio::time::timeout(Duration::from_secs(20), read_frame(&mut conn)).await.context("waiting for the old server")??;
    let names: Vec<String> = serde_json::from_value(state["listeners"].clone()).unwrap_or_default();
    if names.len() != fds.len() {
        anyhow::bail!("handover: got {} sockets for {} names", fds.len(), names.len());
    }
    *INHERITED.lock().unwrap() = names.into_iter().zip(fds).collect();
    let snapshot: Snapshot = serde_json::from_value(state["snapshot"].clone()).unwrap_or_else(|e| {
        tracing::warn!("handover: couldn't read the old server's state, starting without it: {e}");
        Snapshot { parity: state["snapshot"]["parity"].as_u64().unwrap_or(0) as u8, ..Default::default() }
    });
    Ok(Some(Incoming { snapshot, conn }))
}

#[cfg(not(unix))]
pub async fn take_over(_cfg: &Config) -> anyhow::Result<Option<Incoming>> {
    Ok(None)
}

impl Incoming {
    /// The new process accepts now: the old one can stop. Its last requests' gateway events arrive here afterwards.
    #[cfg(unix)]
    pub async fn ready(mut self, st: AppState) {
        if let Err(e) = write_frame(&mut self.conn, &serde_json::json!({ "op": "ready" })).await {
            tracing::warn!("handover: couldn't tell the old server: {e}");
            return;
        }
        tracing::info!("handover: serving; the old server is finishing its requests");
        tokio::spawn(async move {
            loop {
                match read_frame(&mut self.conn).await {
                    Ok(v) if v["op"] == "event" => {
                        let users: Vec<crate::id::Id> = serde_json::from_value(v["users"].clone()).unwrap_or_default();
                        if let Some(body) = v["body"].as_str() {
                            st.hub.send_raw(&users, body);
                        }
                    }
                    Ok(v) if v["op"] == "done" => {
                        tracing::info!("handover: the old server is done");
                        break;
                    }
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
        });
    }

    #[cfg(not(unix))]
    pub async fn ready(self, _st: AppState) {}
}

/// Lets a future process take over from this one.
#[cfg(unix)]
pub async fn serve_successors(st: AppState) {
    let path = socket_path(&st.cfg);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // Whoever had it before is gone or handed over to us (we checked it at startup).
    let _ = std::fs::remove_file(&path);
    let listener = match tokio::net::UnixListener::bind(&path) {
        Ok(l) => l,
        Err(e) => return tracing::warn!("handover: can't listen on {}: {e} (restarts will drop calls)", path.display()),
    };
    loop {
        let conn = tokio::select! {
            c = listener.accept() => c,
            _ = stop_accepting() => return,
        };
        let Ok((conn, _)) = conn else { continue };
        if hand_over(&st, conn).await {
            return;
        }
    }
}

#[cfg(not(unix))]
pub async fn serve_successors(_st: AppState) {}

/// One take-over attempt; true if it went through (this process is retired now).
#[cfg(unix)]
async fn hand_over(st: &AppState, mut conn: tokio::net::UnixStream) -> bool {
    match tokio::time::timeout(Duration::from_secs(5), read_frame(&mut conn)).await {
        Ok(Ok(v)) if v["op"] == "hello" => tracing::info!(to = v["version"].as_str().unwrap_or("?"), "handover: a new server is taking over"),
        _ => return false,
    }
    let mut events = st.hub.freeze();
    FROZEN.store(true, Ordering::Relaxed);
    let snap = Snapshot::take(st);
    let (names, fds): (Vec<String>, Vec<std::os::fd::RawFd>) = {
        use std::os::fd::AsRawFd;
        KEPT.lock().unwrap().iter().map(|(n, fd)| (n.clone(), fd.as_raw_fd())).unzip()
    };
    let sent = async {
        send_fds(&conn, &fds).await?;
        write_frame(&mut conn, &serde_json::json!({ "listeners": names, "snapshot": snap })).await?;
        anyhow::Ok(())
    }
    .await;
    // Events go nowhere until the new server is ready (or we take them back).
    let mut held = Vec::new();
    let ready = match sent {
        Ok(()) => {
            let wait = tokio::time::timeout(READY_TIMEOUT, async {
                loop {
                    tokio::select! {
                        f = read_frame(&mut conn) => return f.ok().is_some_and(|v| v["op"] == "ready"),
                        Some(e) = events.recv() => held.push(e),
                    }
                }
            });
            wait.await.unwrap_or(false)
        }
        Err(e) => {
            tracing::warn!("handover: sending the state failed: {e:#}");
            false
        }
    };
    if !ready {
        tracing::error!("handover: the new server didn't take over; carrying on");
        while let Ok(e) = events.try_recv() {
            held.push(e);
        }
        st.hub.unfreeze(held);
        FROZEN.store(false, Ordering::Relaxed);
        return false;
    }
    stop_now();
    close_sockets(st);
    tracing::info!("handover: handed over; finishing the requests already running");
    tokio::spawn(async move {
        let mut drained = drained_tx().subscribe();
        let mut ok = true;
        for (users, body) in held {
            ok = ok && write_frame(&mut conn, &serde_json::json!({ "op": "event", "users": users, "body": body })).await.is_ok();
        }
        while ok {
            tokio::select! {
                Some((users, body)) = events.recv() => {
                    ok = write_frame(&mut conn, &serde_json::json!({ "op": "event", "users": users, "body": body })).await.is_ok();
                }
                _ = async { drained.wait_for(|d| *d).await.map(|_| ()) } => break,
            }
        }
        while let Ok((users, body)) = events.try_recv() {
            let _ = write_frame(&mut conn, &serde_json::json!({ "op": "event", "users": users, "body": body })).await;
        }
        let _ = write_frame(&mut conn, &serde_json::json!({ "op": "done" })).await;
    });
    true
}

#[cfg(unix)]
const MAX_FRAME: usize = 512 * 1024 * 1024;

#[cfg(unix)]
async fn write_frame(conn: &mut tokio::net::UnixStream, v: &Value) -> anyhow::Result<()> {
    use tokio::io::AsyncWriteExt;
    let body = serde_json::to_vec(v)?;
    conn.write_u32(body.len() as u32).await?;
    conn.write_all(&body).await?;
    Ok(())
}

#[cfg(unix)]
async fn read_frame(conn: &mut tokio::net::UnixStream) -> anyhow::Result<Value> {
    use tokio::io::AsyncReadExt;
    let len = conn.read_u32().await? as usize;
    anyhow::ensure!(len <= MAX_FRAME, "frame too big");
    let mut body = vec![0; len];
    conn.read_exact(&mut body).await?;
    Ok(serde_json::from_slice(&body)?)
}

/// Sends one byte carrying the sockets (SCM_RIGHTS).
#[cfg(unix)]
async fn send_fds(conn: &tokio::net::UnixStream, fds: &[std::os::fd::RawFd]) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;
    loop {
        conn.writable().await?;
        match conn.try_io(tokio::io::Interest::WRITABLE, || unsafe { sendmsg_fds(conn.as_raw_fd(), fds) }) {
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
            r => return r,
        }
    }
}

#[cfg(unix)]
async fn recv_fds(conn: &tokio::net::UnixStream) -> std::io::Result<Vec<std::os::fd::OwnedFd>> {
    use std::os::fd::AsRawFd;
    loop {
        conn.readable().await?;
        match conn.try_io(tokio::io::Interest::READABLE, || unsafe { recvmsg_fds(conn.as_raw_fd()) }) {
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
            r => return r,
        }
    }
}

#[cfg(unix)]
const MAX_FDS: usize = 8;

#[cfg(unix)]
unsafe fn sendmsg_fds(sock: std::os::fd::RawFd, fds: &[std::os::fd::RawFd]) -> std::io::Result<()> {
    assert!(fds.len() <= MAX_FDS);
    let mut byte = [b'F'];
    let mut iov = libc::iovec { iov_base: byte.as_mut_ptr().cast(), iov_len: 1 };
    let space = libc::CMSG_SPACE((MAX_FDS * size_of::<libc::c_int>()) as u32) as usize;
    let mut control = vec![0u8; space];
    let mut msg: libc::msghdr = std::mem::zeroed();
    msg.msg_iov = &mut iov;
    msg.msg_iovlen = 1;
    if !fds.is_empty() {
        msg.msg_control = control.as_mut_ptr().cast();
        msg.msg_controllen = libc::CMSG_SPACE((fds.len() * size_of::<libc::c_int>()) as u32) as _;
        let cmsg = libc::CMSG_FIRSTHDR(&msg);
        (*cmsg).cmsg_level = libc::SOL_SOCKET;
        (*cmsg).cmsg_type = libc::SCM_RIGHTS;
        (*cmsg).cmsg_len = libc::CMSG_LEN((fds.len() * size_of::<libc::c_int>()) as u32) as _;
        std::ptr::copy_nonoverlapping(fds.as_ptr(), libc::CMSG_DATA(cmsg).cast::<libc::c_int>(), fds.len());
    }
    if libc::sendmsg(sock, &msg, 0) < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(unix)]
unsafe fn recvmsg_fds(sock: std::os::fd::RawFd) -> std::io::Result<Vec<std::os::fd::OwnedFd>> {
    use std::os::fd::FromRawFd;
    let mut byte = [0u8];
    let mut iov = libc::iovec { iov_base: byte.as_mut_ptr().cast(), iov_len: 1 };
    let space = libc::CMSG_SPACE((MAX_FDS * size_of::<libc::c_int>()) as u32) as usize;
    let mut control = vec![0u8; space];
    let mut msg: libc::msghdr = std::mem::zeroed();
    msg.msg_iov = &mut iov;
    msg.msg_iovlen = 1;
    msg.msg_control = control.as_mut_ptr().cast();
    msg.msg_controllen = space as _;
    let n = libc::recvmsg(sock, &mut msg, libc::MSG_CMSG_CLOEXEC);
    if n < 0 {
        return Err(std::io::Error::last_os_error());
    }
    if n == 0 {
        return Err(std::io::ErrorKind::UnexpectedEof.into());
    }
    let mut fds = Vec::new();
    let mut cmsg = libc::CMSG_FIRSTHDR(&msg);
    while !cmsg.is_null() {
        if (*cmsg).cmsg_level == libc::SOL_SOCKET && (*cmsg).cmsg_type == libc::SCM_RIGHTS {
            let count = ((*cmsg).cmsg_len as usize - libc::CMSG_LEN(0) as usize) / size_of::<libc::c_int>();
            let data = libc::CMSG_DATA(cmsg).cast::<libc::c_int>();
            for i in 0..count {
                fds.push(std::os::fd::OwnedFd::from_raw_fd(*data.add(i)));
            }
        }
        cmsg = libc::CMSG_NXTHDR(&msg, cmsg);
    }
    Ok(fds)
}

/// The handover socket of a data directory, for tests and scripts.
#[allow(dead_code)]
pub fn socket_for(data_dir: &Path) -> PathBuf {
    data_dir.join("run").join("handover.sock")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn passes_listening_sockets() {
        let (a, b) = tokio::net::UnixStream::pair().unwrap();
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        use std::os::fd::AsRawFd;
        send_fds(&a, &[l.as_raw_fd()]).await.unwrap();
        let mut got = recv_fds(&b).await.unwrap();
        assert_eq!(got.len(), 1);
        drop(l);
        // The socket survives the sender closing its copy and still accepts on the same address.
        let l2 = std::net::TcpListener::from(got.remove(0));
        assert_eq!(l2.local_addr().unwrap(), addr);
        let _c = std::net::TcpStream::connect(addr).unwrap();
        l2.accept().unwrap();
    }

    #[test]
    fn snapshot_parts_survive_unknown_fields() {
        let s: Snapshot = serde_json::from_str(r#"{"taken_at":1,"version":"x","parity":1,"parts":{"hub":{"sessions":[]}},"later":true}"#).unwrap();
        assert_eq!(s.parity, 1);
        assert!(s.parts.contains_key("hub"));
    }
}
