package com.linkord.core

/** The site a profile link goes to, if it's one with a mark (web: lib/brand-icons.ts brandOf). Subdomains count. */
fun brandOf(url: String): Brand? {
    val u = url.trim()
    if (u.isEmpty()) return null
    val full = if (Regex("^[a-z][a-z0-9+.-]*://", RegexOption.IGNORE_CASE).containsMatchIn(u)) u else "https://$u"
    val host = runCatching { java.net.URI(full).host }.getOrNull()?.lowercase()?.trimEnd('.') ?: return null
    return BrandIcons.all.firstOrNull { b -> b.hosts.any { host == it || host.endsWith(".$it") } }
}

/** "instagram.com/someone": the address without its scheme, www or trailing slash (web: ProfileWidgets shortLink). */
fun shortLink(url: String): String {
    val u = runCatching { java.net.URI(url) }.getOrNull()
    val host = u?.host ?: return url
    val s = host.removePrefix("www.") + (u.rawPath ?: "").trimEnd('/')
    return if (s.length > 42) s.take(41) + "…" else s
}

/** A link's name when it has none of its own: the site's ("Instagram"), else its address (web: linkName). */
fun linkName(url: String, label: String): String = label.ifBlank { brandOf(url)?.name ?: shortLink(url) }
