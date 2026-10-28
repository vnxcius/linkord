//! Link previews. Fetched by the server after a message is sent, then pushed as a MESSAGE_UPDATE.
//! Fetches are guarded so a message can't make the server talk to private or local addresses.

use std::net::{IpAddr, SocketAddr};
use std::time::{Duration, Instant};

use reqwest::header::{CONTENT_TYPE, LOCATION};
use reqwest::Url;
use serde_json::{json, Value};

use crate::api::messages::hydrate;
use crate::gateway::channel_audience;
use crate::id::Id;
use crate::models::{Channel, MessageRow, MESSAGE_COLS};
use crate::state::AppState;

const MAX_EMBEDS: usize = 3;
const MAX_BODY: usize = 1024 * 1024;
const CACHE_TTL: Duration = Duration::from_secs(3600);

pub fn spawn(st: AppState, ch: Channel, message: Id, content: String) {
    // Invite links to this server get the client's own invite card instead of a page preview.
    let mut invites = vec![format!("{}/invite/", st.cfg.public_url)];
    if !st.cfg.direct_host.is_empty() {
        invites.push(format!("https://{}/invite/", st.cfg.direct_host));
    }
    let urls: Vec<String> = extract_urls(&content).into_iter().filter(|u| !invites.iter().any(|i| u.starts_with(i))).collect();
    if urls.is_empty() {
        return;
    }
    tokio::spawn(async move {
        let mut embeds = Vec::new();
        for url in urls {
            if let Some(e) = cached_embed(&st, &url).await {
                embeds.push(e);
            }
        }
        if embeds.is_empty() {
            return;
        }
        // Only store if the message wasn't edited meanwhile.
        let row = sqlx::query_as::<_, MessageRow>(&format!(
            "UPDATE messages SET embeds = $2 WHERE id = $1 AND content = $3 RETURNING {MESSAGE_COLS}"
        ))
        .bind(message)
        .bind(sqlx::types::Json(&embeds))
        .bind(&content)
        .fetch_optional(&st.db)
        .await;
        if let Ok(Some(row)) = row {
            if let (Ok(Some(msg)), Ok(audience)) = (hydrate(&st, vec![row]).await.map(|mut v| v.pop()), channel_audience(&st.db, &ch).await) {
                st.hub.send(&audience, "MESSAGE_UPDATE", &msg);
            }
        }
    });
}

/// Links outside code blocks, spoilers and `<suppressed>` brackets.
fn extract_urls(content: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut in_code = false;
    for (i, part) in content.split("```").enumerate() {
        in_code = i % 2 == 1;
        if in_code {
            continue;
        }
        for word in part.split_whitespace() {
            if word.starts_with('<') || word.contains("||") || word.contains('`') {
                continue;
            }
            let w = word.trim_end_matches(|c: char| ".,:;!?)'\"]".contains(c));
            if (w.starts_with("https://") || w.starts_with("http://")) && w.len() < 2000 && !out.iter().any(|u| u == w) {
                out.push(w.to_string());
            }
            if out.len() == MAX_EMBEDS {
                return out;
            }
        }
    }
    let _ = in_code;
    out
}

async fn cached_embed(st: &AppState, url: &str) -> Option<Value> {
    if let Some(hit) = st.embed_cache.get(url) {
        if hit.0.elapsed() < CACHE_TTL {
            return hit.1.clone();
        }
    }
    let e = fetch_embed(url).await;
    st.embed_cache.insert(url.to_string(), (Instant::now(), e.clone()));
    if st.embed_cache.len() > 5000 {
        st.embed_cache.retain(|_, v| v.0.elapsed() < CACHE_TTL);
    }
    e
}

fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                || v4.is_multicast()
                || o[0] == 0
                || (o[0] == 100 && (64..128).contains(&o[1]))
                || (o[0] == 192 && o[1] == 0 && o[2] == 0)
                || (o[0] == 198 && (18..20).contains(&o[1]))
                || o[0] >= 240)
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public(IpAddr::V4(v4));
            }
            let s = v6.segments();
            !(v6.is_loopback() || v6.is_unspecified() || v6.is_multicast() || (s[0] & 0xfe00) == 0xfc00 || (s[0] & 0xffc0) == 0xfe80)
        }
    }
}

/// GET that follows up to 3 redirects, re-checking every hop resolves only to public addresses.
async fn safe_get(url: &str) -> Option<reqwest::Response> {
    let mut current = Url::parse(url).ok()?;
    for _ in 0..4 {
        if !matches!(current.scheme(), "http" | "https") {
            return None;
        }
        let host = current.host_str()?.trim_start_matches('[').trim_end_matches(']').to_string();
        let port = current.port_or_known_default()?;
        let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), port)).await.ok()?.collect();
        if addrs.is_empty() || addrs.iter().any(|a| !is_public(a.ip())) {
            return None;
        }
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(6))
            .resolve_to_addrs(&host, &addrs)
            .user_agent("Mozilla/5.0 (compatible; LinkordBot/0.1; link previews)")
            .build()
            .ok()?;
        let resp = client.get(current.clone()).send().await.ok()?;
        if resp.status().is_redirection() {
            current = current.join(resp.headers().get(LOCATION)?.to_str().ok()?).ok()?;
            continue;
        }
        return resp.status().is_success().then_some(resp);
    }
    None
}

async fn fetch_embed(url: &str) -> Option<Value> {
    let resp = safe_get(url).await;
    let target = match &resp {
        Some(r) => r.url().clone(),
        None => Url::parse(url).ok()?,
    };
    let embed = match resp {
        Some(r) => page_embed(url, r).await,
        None => None,
    };
    match video_site(&target) {
        Some(site) => Some(video_embed(url, &target, site, embed).await),
        None => embed,
    }
}

/// Video links always get an embed so the client can show its inline player, even when the page
/// has no preview metadata (TikTok and Instagram serve none to crawlers).
async fn video_embed(url: &str, target: &Url, site: &str, embed: Option<Value>) -> Value {
    let mut e = embed.filter(|e| e["type"] == "link");
    // TikTok pages only carry a generic "TikTok - Make Your Day" title.
    if site == "TikTok" {
        e = tiktok_oembed(url, target).await.or(e);
    }
    let mut e = e.unwrap_or_else(|| json!({ "type": "link", "url": url }));
    // Login walls title every page with just the site's name.
    if e["title"].as_str().is_some_and(|t| t.eq_ignore_ascii_case(site)) {
        e["title"] = Value::Null;
    }
    if e["site_name"].is_null() {
        e["site_name"] = json!(site);
    }
    e["large_image"] = json!(true);
    // Short links (vm.tiktok.com, youtu.be...) only reveal the video id after the redirect.
    if target.as_str() != url {
        e["resolved_url"] = json!(target.as_str());
    }
    e
}

/// TikTok's public oEmbed endpoint has the title, author and thumbnail its pages leave out.
async fn tiktok_oembed(url: &str, target: &Url) -> Option<Value> {
    let api = Url::parse_with_params("https://www.tiktok.com/oembed", &[("url", target.as_str())]).ok()?;
    let body = safe_get(api.as_str()).await?.bytes().await.ok()?;
    let o: Value = serde_json::from_slice(&body).ok()?;
    let s = |k: &str| o[k].as_str().filter(|s| !s.is_empty()).map(str::to_string);
    Some(json!({
        "type": "link",
        "url": url,
        "title": s("title").map(|t| truncate(&t, 256)),
        "author": s("author_name").map(|a| truncate(&a, 100)),
        "image": s("thumbnail_url"),
    }))
}

/// Sites the client has an inline player for, when the link points at a video.
/// Keep in sync with app/src/lib/video-links.ts.
fn video_site(url: &Url) -> Option<&'static str> {
    let host = url.host_str()?;
    let host = host.strip_prefix("www.").or_else(|| host.strip_prefix("m.")).unwrap_or(host);
    let seg: Vec<&str> = url.path_segments().map(|s| s.filter(|p| !p.is_empty()).collect()).unwrap_or_default();
    let first = seg.first().copied().unwrap_or("");
    let numeric = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let (site, ok) = match host {
        "youtube.com" | "music.youtube.com" => ("YouTube", ["watch", "shorts", "live", "embed"].contains(&first)),
        "youtu.be" => ("YouTube", !first.is_empty()),
        h if h == "tiktok.com" || h.ends_with(".tiktok.com") => ("TikTok", seg.contains(&"video")),
        "instagram.com" => ("Instagram", seg.iter().any(|s| matches!(*s, "reel" | "reels" | "tv"))),
        "vimeo.com" => ("Vimeo", numeric(first)),
        "twitch.tv" | "clips.twitch.tv" => ("Twitch", !first.is_empty()),
        "streamable.com" => ("Streamable", seg.len() == 1),
        "dailymotion.com" => ("Dailymotion", first == "video"),
        "dai.ly" => ("Dailymotion", !first.is_empty()),
        _ => return None,
    };
    ok.then_some(site)
}

async fn page_embed(url: &str, mut resp: reqwest::Response) -> Option<Value> {
    let ct = resp.headers().get(CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_lowercase();
    if ct.starts_with("image/") {
        return Some(json!({ "type": "image", "url": url }));
    }
    if ct.starts_with("video/") {
        return Some(json!({ "type": "video", "url": url }));
    }
    if !ct.starts_with("text/html") {
        return None;
    }
    let mut body = Vec::new();
    while let Ok(Some(chunk)) = resp.chunk().await {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_BODY {
            break;
        }
    }
    let html = String::from_utf8_lossy(&body);
    let base = resp.url().clone();
    let meta = |keys: &[&str]| keys.iter().find_map(|k| meta_content(&html, k)).filter(|s| !s.is_empty());
    let title = meta(&["og:title", "twitter:title"]).or_else(|| tag_text(&html, "title"));
    let image = meta(&["og:image", "og:image:url", "twitter:image"]).and_then(|i| base.join(&i).ok()).map(|u| u.to_string());
    if title.is_none() && image.is_none() {
        return None;
    }
    let color = meta(&["theme-color"]).and_then(|c| i64::from_str_radix(c.trim_start_matches('#'), 16).ok());
    Some(json!({
        "type": "link",
        "url": url,
        "title": title.map(|t| truncate(&t, 256)),
        "description": meta(&["og:description", "twitter:description", "description"]).map(|d| truncate(&d, 350)),
        "site_name": meta(&["og:site_name"]).map(|s| truncate(&s, 100)),
        "image": image,
        "large_image": meta(&["twitter:card"]).is_some_and(|c| c == "summary_large_image"),
        "color": color,
    }))
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        s.chars().take(n - 1).collect::<String>() + "…"
    }
}

fn decode_entities(s: &str) -> String {
    s.replace("&quot;", "\"").replace("&#39;", "'").replace("&#x27;", "'").replace("&lt;", "<").replace("&gt;", ">").replace("&nbsp;", " ").replace("&amp;", "&")
}

/// Value of an attribute inside a single tag's text, e.g. `content="..."`.
fn attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_lowercase();
    let mut from = 0;
    while let Some(pos) = lower[from..].find(name) {
        let start = from + pos;
        from = start + name.len();
        let before_ok = start == 0 || lower.as_bytes()[start - 1].is_ascii_whitespace();
        let rest = tag[from..].trim_start();
        if !before_ok || !rest.starts_with('=') {
            continue;
        }
        let rest = rest[1..].trim_start();
        let (quote, rest) = match rest.chars().next()? {
            q @ ('"' | '\'') => (q, &rest[1..]),
            _ => (' ', rest),
        };
        let end = rest.find(|c| c == quote || (quote == ' ' && c == '>')).unwrap_or(rest.len());
        return Some(decode_entities(rest[..end].trim()));
    }
    None
}

fn meta_content(html: &str, key: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let mut from = 0;
    while let Some(pos) = lower[from..].find("<meta") {
        let start = from + pos;
        let end = lower[start..].find('>').map(|e| start + e)?;
        let tag = &html[start..end];
        if attr(tag, "property").or_else(|| attr(tag, "name")).is_some_and(|k| k.eq_ignore_ascii_case(key)) {
            return attr(tag, "content");
        }
        from = end;
    }
    None
}

fn tag_text(html: &str, tag: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let open = lower.find(&format!("<{tag}"))?;
    let start = open + lower[open..].find('>')? + 1;
    let end = start + lower[start..].find(&format!("</{tag}"))?;
    Some(decode_entities(html[start..end].trim())).filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_meta() {
        let html = r#"<html><head><title>Fallback</title><meta property="og:title" content="Hello &amp; welcome"><META name='description' content='Desc'></head>"#;
        assert_eq!(meta_content(html, "og:title").as_deref(), Some("Hello & welcome"));
        assert_eq!(meta_content(html, "description").as_deref(), Some("Desc"));
        assert_eq!(tag_text(html, "title").as_deref(), Some("Fallback"));
    }

    #[test]
    fn blocks_private_addresses() {
        for ip in ["127.0.0.1", "10.1.2.3", "192.168.0.50", "172.17.0.1", "169.254.1.1", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"] {
            assert!(!is_public(ip.parse().unwrap()), "{ip}");
        }
        assert!(is_public("1.1.1.1".parse().unwrap()));
        assert!(is_public("2606:4700::1111".parse().unwrap()));
    }

    #[test]
    fn finds_links() {
        let urls = extract_urls("see https://a.com/x, and <https://hidden.com> ||https://spoiler.com|| ```https://code.com``` http://b.org.");
        assert_eq!(urls, vec!["https://a.com/x", "http://b.org"]);
    }

    #[test]
    fn recognises_video_links() {
        let site = |u: &str| video_site(&Url::parse(u).unwrap());
        assert_eq!(site("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), Some("YouTube"));
        assert_eq!(site("https://youtu.be/dQw4w9WgXcQ?t=42"), Some("YouTube"));
        assert_eq!(site("https://m.youtube.com/shorts/aqz-KE-bpKQ"), Some("YouTube"));
        assert_eq!(site("https://www.tiktok.com/@scout2015/video/6718335390845095173"), Some("TikTok"));
        assert_eq!(site("https://www.instagram.com/reel/C8fLEo2yGmT/"), Some("Instagram"));
        assert_eq!(site("https://vimeo.com/76979871"), Some("Vimeo"));
        assert_eq!(site("https://clips.twitch.tv/SomeClipSlug"), Some("Twitch"));
        assert_eq!(site("https://www.youtube.com/@channel"), None);
        assert_eq!(site("https://www.instagram.com/p/C8fLEo2yGmT/"), None);
        assert_eq!(site("https://www.tiktok.com/@scout2015"), None);
        assert_eq!(site("https://vimeo.com/about"), None);
        assert_eq!(site("https://example.com/watch?v=x"), None);
    }
}

