//! A second way in that skips Cloudflare: `https://<POTTIRA_DIRECT_HOST>:<port>` pointing straight at this
//! machine's public IP, for friends whose ISP blocks Cloudflare's shared addresses. The main site keeps going
//! through the tunnel.
//!
//! This listener terminates TLS itself with a Let's Encrypt certificate. The owner's router keeps port 443 for
//! itself and port 80 isn't reachable, so the certificate is validated over DNS (DNS-01): the server creates the
//! `_acme-challenge` TXT record through the Cloudflare API (CLOUDFLARE_API_TOKEN, "Edit zone DNS" for the zone),
//! removes it afterwards, and renews 30 days before expiry. Certificates are cached under data/acme.
//!
//! Requests here can't be trusted to carry honest proxy headers, so the client IP comes from the connection.
//! Every request also records which public address it came in on, so login redirects, OAuth callbacks and
//! update links send people back to the address that works for them.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context};
use axum::extract::{ConnectInfo, FromRequestParts, Request, State};
use axum::http::header::HOST;
use axum::http::request::Parts;
use axum::http::HeaderValue;
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::Router;
use axum_server::tls_rustls::RustlsConfig;
use chrono::Utc;
use instant_acme::{Account, AccountCredentials, AuthorizationStatus, ChallengeType, Identifier, LetsEncrypt, NewAccount, NewOrder, OrderStatus, RetryPolicy};
use serde_json::{json, Value};

use crate::state::AppState;

/// Renew when the certificate has fewer days left than this.
const RENEW_BEFORE_DAYS: i64 = 30;
const CF_API: &str = "https://api.cloudflare.com/client/v4";

/// The public origin a request came in on (e.g. `https://pottira.example.com`), without a trailing slash.
#[derive(Clone)]
pub struct PublicBase(pub Arc<str>);

impl FromRequestParts<AppState> for PublicBase {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, st: &AppState) -> Result<Self, Self::Rejection> {
        Ok(parts.extensions.get::<PublicBase>().cloned().unwrap_or_else(|| PublicBase(st.cfg.public_url.as_str().into())))
    }
}

impl std::fmt::Display for PublicBase {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// The origin for the direct host: keeps a non-default port the client used (`mc.example.com:8443`).
fn direct_base(host_header: Option<&str>, direct_host: &str, tls: bool) -> String {
    let scheme = if tls { "https" } else { "http" };
    match host_header {
        Some(h) if h == direct_host || h.strip_prefix(direct_host).is_some_and(|rest| rest.starts_with(':') && rest[1..].chars().all(|c| c.is_ascii_digit())) => {
            format!("{scheme}://{h}")
        }
        _ => format!("{scheme}://{direct_host}"),
    }
}

/// The host the client asked for: HTTP/1.1 sends a Host header; HTTP/2 (what browsers use over TLS) puts the
/// authority in the URI instead.
fn request_host<B>(req: &axum::http::Request<B>) -> Option<String> {
    req.headers().get(HOST).and_then(|v| v.to_str().ok()).map(str::to_owned).or_else(|| req.uri().authority().map(|a| a.to_string()))
}

async fn direct_request(State(st): State<AppState>, ConnectInfo(peer): ConnectInfo<SocketAddr>, mut req: Request, next: Next) -> Response {
    let host = request_host(&req);
    let base = direct_base(host.as_deref(), &st.cfg.direct_host, st.cfg.direct_tls);
    let headers = req.headers_mut();
    headers.remove("x-forwarded-for");
    if let Ok(ip) = HeaderValue::from_str(&peer.ip().to_canonical().to_string()) {
        headers.insert("cf-connecting-ip", ip);
    }
    req.extensions_mut().insert(PublicBase(base.into()));
    next.run(req).await
}

/// Serves `app` on POTTIRA_DIRECT_BIND (if set) until the process ends.
pub async fn serve(st: AppState, app: Router) -> anyhow::Result<()> {
    let cfg = st.cfg.clone();
    let Some(bind) = cfg.direct_bind.clone() else { return Ok(()) };
    let addr: SocketAddr = bind.parse()?;
    let app = app.layer(middleware::from_fn_with_state(st.clone(), direct_request)).into_make_service_with_connect_info::<SocketAddr>();
    let conns = ConnLimit::default();
    // Taken (or inherited, handover.rs) before waiting for a certificate, so the next process can always have it.
    let listener = crate::handover::listener("direct", &addr.to_string()).with_context(|| format!("binding {addr}"))?;
    let handle = axum_server::Handle::new();
    let stopper = handle.clone();
    tokio::spawn(async move {
        crate::handover::stop_accepting().await;
        stopper.graceful_shutdown(Some(crate::handover::DRAIN_TIMEOUT));
    });
    if !cfg.direct_tls {
        tracing::info!("direct access (plain HTTP) on {addr} for {}", cfg.direct_host);
        let mut server = axum_server::from_tcp(listener)?.handle(handle).acceptor(Limited { inner: axum_server::accept::DefaultAcceptor::new(), conns });
        harden(server.http_builder());
        server.serve(app).await?;
        return Ok(());
    }
    let token = cfg.cloudflare_token.clone().context("direct access needs CLOUDFLARE_API_TOKEN for its certificate (or POTTIRA_DIRECT_TLS=off)")?;
    let _ = rustls::crypto::ring::default_provider().install_default();

    // Get a certificate before listening; keep trying (Cloudflare or Let's Encrypt briefly down, token not set up yet).
    let mut wait = Duration::from_secs(60);
    let (cert, key) = loop {
        match current_cert(&st, &token).await {
            Ok(pair) => break pair,
            Err(e) => tracing::warn!("direct access certificate: {e:#} (retrying in {}s)", wait.as_secs()),
        }
        tokio::time::sleep(wait).await;
        wait = (wait * 2).min(Duration::from_secs(3600));
    };
    let tls = RustlsConfig::from_pem(cert.into_bytes(), key.into_bytes()).await?;
    let renew = tls.clone();
    let renew_st = st.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(12 * 3600)).await;
            match current_cert(&renew_st, &token).await {
                Ok((cert, key)) => {
                    if let Err(e) = renew.reload_from_pem(cert.into_bytes(), key.into_bytes()).await {
                        tracing::warn!("direct access certificate reload: {e}");
                    }
                }
                Err(e) => tracing::warn!("direct access certificate renewal: {e:#}"),
            }
        }
    });
    tracing::info!("direct access on {addr} for https://{}", cfg.direct_host);
    let acceptor = axum_server::tls_rustls::RustlsAcceptor::new(tls);
    let mut server = axum_server::from_tcp(listener)?.handle(handle).acceptor(Limited { inner: acceptor, conns });
    harden(server.http_builder());
    server.serve(app).await?;
    Ok(())
}

// ---------- connections ----------
// Nothing stands in front of this listener, unlike the tunnel: it has to shed slow and abandoned connections itself.

/// Connections held open by one address, and in total.
const MAX_CONNS_PER_IP: usize = 128;
const MAX_CONNS: usize = 4096;
const HEADER_TIMEOUT: Duration = Duration::from_secs(15);

fn harden(http: &mut hyper_util::server::conn::auto::Builder<hyper_util::rt::TokioExecutor>) {
    use hyper_util::rt::TokioTimer;
    http.http1().timer(TokioTimer::new()).header_read_timeout(HEADER_TIMEOUT);
    http.http2().timer(TokioTimer::new()).keep_alive_interval(Duration::from_secs(30)).keep_alive_timeout(Duration::from_secs(20)).max_concurrent_streams(200);
}

#[derive(Clone, Default)]
struct ConnLimit(Arc<dashmap::DashMap<std::net::IpAddr, usize>>, Arc<std::sync::atomic::AtomicUsize>);

/// Lives as long as the connection.
struct ConnSlot(ConnLimit, std::net::IpAddr);

impl ConnLimit {
    fn take(&self, ip: std::net::IpAddr) -> Option<ConnSlot> {
        use std::sync::atomic::Ordering::Relaxed;
        if self.1.load(Relaxed) >= MAX_CONNS {
            return None;
        }
        let mut n = self.0.entry(ip).or_insert(0);
        if *n >= MAX_CONNS_PER_IP {
            return None;
        }
        *n += 1;
        drop(n);
        self.1.fetch_add(1, Relaxed);
        Some(ConnSlot(self.clone(), ip))
    }
}

impl Drop for ConnSlot {
    fn drop(&mut self) {
        self.0 .1.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
        let empty = self.0 .0.get_mut(&self.1).is_some_and(|mut n| {
            *n -= 1;
            *n == 0
        });
        if empty {
            self.0 .0.remove_if(&self.1, |_, n| *n == 0);
        }
    }
}

#[derive(Clone)]
struct Limited<A> {
    inner: A,
    conns: ConnLimit,
}

/// The connection's service, which keeps its slot taken.
#[derive(Clone)]
struct Slotted<S> {
    inner: S,
    _slot: Arc<ConnSlot>,
}

impl<S, R> tower::Service<R> for Slotted<S>
where
    S: tower::Service<R>,
{
    type Response = S::Response;
    type Error = S::Error;
    type Future = S::Future;

    fn poll_ready(&mut self, cx: &mut std::task::Context<'_>) -> std::task::Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: R) -> Self::Future {
        self.inner.call(req)
    }
}

impl<A, S> axum_server::accept::Accept<tokio::net::TcpStream, S> for Limited<A>
where
    A: axum_server::accept::Accept<tokio::net::TcpStream, S> + Clone + Send + 'static,
    A::Future: Send + 'static,
    A::Stream: Send + 'static,
    A::Service: Send + 'static,
    S: Send + 'static,
{
    type Stream = A::Stream;
    type Service = Slotted<A::Service>;
    type Future = std::pin::Pin<Box<dyn std::future::Future<Output = std::io::Result<(Self::Stream, Self::Service)>> + Send>>;

    fn accept(&self, stream: tokio::net::TcpStream, service: S) -> Self::Future {
        let inner = self.inner.clone();
        let conns = self.conns.clone();
        Box::pin(async move {
            let ip = stream.peer_addr()?.ip().to_canonical();
            let slot = conns.take(ip).ok_or_else(|| std::io::Error::other("too many connections"))?;
            let (stream, service) = inner.accept(stream, service).await?;
            Ok((stream, Slotted { inner: service, _slot: Arc::new(slot) }))
        })
    }
}

// ---------- certificate (ACME DNS-01 through Cloudflare) ----------

struct Files {
    cert: PathBuf,
    key: PathBuf,
    account: PathBuf,
}

fn files(st: &AppState) -> Files {
    let dir = st.cfg.data_dir.join("acme");
    // Staging certificates (untrusted, for testing) never mix with real ones.
    let tag = if st.cfg.acme_staging { "-staging" } else { "" };
    let host = &st.cfg.direct_host;
    Files { cert: dir.join(format!("{host}{tag}.crt.pem")), key: dir.join(format!("{host}{tag}.key.pem")), account: dir.join(format!("account{tag}.json")) }
}

/// Days until the first certificate in a PEM chain expires.
fn days_left(pem: &str) -> Option<i64> {
    let (_, block) = x509_parser::pem::parse_x509_pem(pem.as_bytes()).ok()?;
    let cert = block.parse_x509().ok()?;
    Some((cert.validity().not_after.timestamp() - Utc::now().timestamp()) / 86400)
}

/// The cached certificate while it has more than RENEW_BEFORE_DAYS left, otherwise a fresh one.
async fn current_cert(st: &AppState, token: &str) -> anyhow::Result<(String, String)> {
    let f = files(st);
    if let (Ok(cert), Ok(key)) = (tokio::fs::read_to_string(&f.cert).await, tokio::fs::read_to_string(&f.key).await) {
        if days_left(&cert).is_some_and(|d| d > RENEW_BEFORE_DAYS) {
            return Ok((cert, key));
        }
    }
    tracing::info!("direct access: requesting a certificate for {}", st.cfg.direct_host);
    let (cert, key) = issue(st, token).await?;
    tokio::fs::create_dir_all(f.cert.parent().unwrap()).await?;
    tokio::fs::write(&f.cert, &cert).await?;
    write_private(&f.key, &key).await?;
    tracing::info!("direct access: certificate issued, {} days left", days_left(&cert).unwrap_or(0));
    Ok((cert, key))
}

async fn write_private(path: &PathBuf, data: &str) -> std::io::Result<()> {
    tokio::fs::write(path, data).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).await?;
    }
    Ok(())
}

async fn account(st: &AppState) -> anyhow::Result<Account> {
    let f = files(st);
    if let Ok(saved) = tokio::fs::read_to_string(&f.account).await {
        let creds: AccountCredentials = serde_json::from_str(&saved)?;
        return Ok(Account::builder()?.from_credentials(creds).await?);
    }
    let directory = if st.cfg.acme_staging { LetsEncrypt::Staging } else { LetsEncrypt::Production };
    let (account, creds) = Account::builder()?
        .create(&NewAccount { contact: &[], terms_of_service_agreed: true, only_return_existing: false }, directory.url().to_owned(), None)
        .await?;
    tokio::fs::create_dir_all(f.account.parent().unwrap()).await?;
    write_private(&f.account, &serde_json::to_string(&creds)?).await?;
    Ok(account)
}

async fn issue(st: &AppState, token: &str) -> anyhow::Result<(String, String)> {
    let cf = Cloudflare::for_host(st, token, &st.cfg.direct_host).await?;
    let account = account(st).await?;
    let mut order = account.new_order(&NewOrder::new(&[Identifier::Dns(st.cfg.direct_host.clone())])).await?;
    let mut records = Vec::new();
    let result = complete_order(st, &cf, &mut order, &mut records).await;
    // Always clean up the challenge records, whatever happened.
    for id in records {
        if let Err(e) = cf.delete(&id).await {
            tracing::warn!("direct access: removing a challenge record: {e:#}");
        }
    }
    result
}

async fn complete_order(st: &AppState, cf: &Cloudflare<'_>, order: &mut instant_acme::Order, records: &mut Vec<String>) -> anyhow::Result<(String, String)> {
    let mut auths = order.authorizations();
    while let Some(auth) = auths.next().await {
        let mut auth = auth?;
        match auth.status {
            AuthorizationStatus::Valid => continue,
            AuthorizationStatus::Pending => {}
            other => bail!("authorization is {other:?}"),
        }
        let mut challenge = auth.challenge(ChallengeType::Dns01).context("Let's Encrypt offered no DNS challenge")?;
        let name = format!("_acme-challenge.{}", challenge.identifier());
        let value = challenge.key_authorization().dns_value();
        records.push(cf.add_txt(&name, &value).await?);
        wait_until_visible(st, &name, &value).await;
        challenge.set_ready().await?;
    }
    let status = order.poll_ready(&RetryPolicy::default()).await?;
    if status != OrderStatus::Ready {
        bail!("order is {status:?} (DNS validation failed?)");
    }
    let key = order.finalize().await?;
    let cert = order.poll_certificate(&RetryPolicy::default()).await?;
    Ok((cert, key))
}

/// Waits (up to two minutes) until public DNS serves the new TXT value, so validation doesn't race it.
async fn wait_until_visible(st: &AppState, name: &str, value: &str) {
    for _ in 0..40 {
        let answer: Option<Value> = async {
            st.http.get("https://cloudflare-dns.com/dns-query").query(&[("name", name), ("type", "TXT")]).header("accept", "application/dns-json").send().await.ok()?.json().await.ok()
        }
        .await;
        let found = answer.as_ref().and_then(|a| a["Answer"].as_array()).is_some_and(|rows| rows.iter().any(|r| r["data"].as_str().is_some_and(|d| d.trim_matches('"') == value)));
        if found {
            return;
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
    tracing::warn!("direct access: {name} not visible in DNS yet, trying anyway");
}

struct Cloudflare<'a> {
    st: &'a AppState,
    token: &'a str,
    zone: String,
}

impl<'a> Cloudflare<'a> {
    async fn call(token: &str, req: reqwest::RequestBuilder) -> anyhow::Result<Value> {
        let v: Value = req.bearer_auth(token).send().await?.json().await?;
        if v["success"].as_bool() != Some(true) {
            bail!("Cloudflare API: {}", v["errors"]);
        }
        Ok(v)
    }

    /// Finds the zone that holds `host` (tries mc.example.com, then example.com).
    async fn for_host(st: &'a AppState, token: &'a str, host: &str) -> anyhow::Result<Cloudflare<'a>> {
        let labels: Vec<&str> = host.split('.').collect();
        for i in 0..labels.len().saturating_sub(1) {
            let name = labels[i..].join(".");
            let v = Self::call(token, st.http.get(format!("{CF_API}/zones")).query(&[("name", name.as_str())])).await?;
            if let Some(id) = v["result"][0]["id"].as_str() {
                return Ok(Cloudflare { st, token, zone: id.to_string() });
            }
        }
        bail!("no Cloudflare zone for {host} (does the API token cover it?)")
    }

    async fn add_txt(&self, name: &str, value: &str) -> anyhow::Result<String> {
        let req = self.st.http.post(format!("{CF_API}/zones/{}/dns_records", self.zone)).json(&json!({ "type": "TXT", "name": name, "content": value, "ttl": 60 }));
        let v = Self::call(self.token, req).await?;
        v["result"]["id"].as_str().map(str::to_owned).context("Cloudflare returned no record id")
    }

    async fn delete(&self, id: &str) -> anyhow::Result<()> {
        Self::call(self.token, self.st.http.delete(format!("{CF_API}/zones/{}/dns_records/{id}", self.zone))).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{direct_base, request_host};

    #[test]
    fn host_from_the_header_or_the_http2_authority() {
        let h1 = axum::http::Request::builder().uri("/api/downloads").header("host", "mc.example.com:8443").body(()).unwrap();
        assert_eq!(request_host(&h1).as_deref(), Some("mc.example.com:8443"));
        // HTTP/2: no Host header, the authority comes in the URI.
        let h2 = axum::http::Request::builder().uri("https://mc.example.com:8443/api/downloads").body(()).unwrap();
        assert_eq!(request_host(&h2).as_deref(), Some("mc.example.com:8443"));
    }

    #[test]
    fn base_keeps_a_port_only_for_the_direct_host() {
        assert_eq!(direct_base(Some("mc.example.com"), "mc.example.com", true), "https://mc.example.com");
        assert_eq!(direct_base(Some("mc.example.com:8443"), "mc.example.com", true), "https://mc.example.com:8443");
        // Anything else (an IP, another name, junk) falls back to the configured host.
        assert_eq!(direct_base(Some("203.0.113.4:443"), "mc.example.com", true), "https://mc.example.com");
        assert_eq!(direct_base(Some("mc.example.com.evil.com"), "mc.example.com", true), "https://mc.example.com");
        assert_eq!(direct_base(Some("mc.example.com:84x"), "mc.example.com", true), "https://mc.example.com");
        assert_eq!(direct_base(None, "mc.example.com", false), "http://mc.example.com");
    }
}
