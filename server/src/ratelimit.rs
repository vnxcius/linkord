//! In-memory token buckets. One server process, so no shared store is needed.

use std::time::{Duration, Instant};

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use dashmap::DashMap;

use crate::error::{ApiError, ApiResult};

#[derive(Default)]
pub struct RateLimiter {
    buckets: DashMap<String, (f64, Instant)>,
}

impl RateLimiter {
    /// Allows `burst` actions at once, refilling at `per_sec`.
    pub fn check(&self, key: String, burst: f64, per_sec: f64) -> ApiResult<()> {
        let now = Instant::now();
        let mut entry = self.buckets.entry(key).or_insert((burst, now));
        let (tokens, last) = *entry;
        let tokens = (tokens + now.duration_since(last).as_secs_f64() * per_sec).min(burst);
        if tokens < 1.0 {
            *entry = (tokens, now);
            return Err(ApiError::RateLimited(((1.0 - tokens) / per_sec).max(0.1)));
        }
        *entry = (tokens - 1.0, now);
        Ok(())
    }

    /// Drops buckets that have been full for a while.
    pub fn sweep(&self) {
        self.buckets.retain(|_, (_, last)| last.elapsed() < Duration::from_secs(600));
    }
}

/// Client address. The server only listens on localhost behind the tunnel, so the proxy header is trusted.
pub struct ClientIp(pub String);

/// One bucket per IPv6 /64: a single home or server can use any address in one.
fn bucket_ip(ip: String) -> String {
    match ip.parse::<std::net::Ipv6Addr>() {
        Ok(v6) if v6.to_ipv4_mapped().is_none() => {
            let s = v6.segments();
            format!("{:x}:{:x}:{:x}:{:x}::/64", s[0], s[1], s[2], s[3])
        }
        _ => ip,
    }
}

impl<S: Send + Sync> FromRequestParts<S> for ClientIp {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Self::Rejection> {
        let h = |name: &str| parts.headers.get(name).and_then(|v| v.to_str().ok()).map(|v| v.split(',').next().unwrap_or("").trim().to_string());
        Ok(ClientIp(bucket_ip(h("cf-connecting-ip").or_else(|| h("x-forwarded-for")).unwrap_or_else(|| "local".into()))))
    }
}
