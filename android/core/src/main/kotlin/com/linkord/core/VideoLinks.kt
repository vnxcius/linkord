package com.linkord.core

import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder

/**
 * A video site's own player for a link (YouTube, TikTok, Reels...), like the web client's lib/video-links.ts: keep the
 * URL shapes in step with it (and with `video_site` in server/src/embeds.rs). [src] starts playing on load.
 */
data class LinkPlayer(val provider: String, val src: String, val vertical: Boolean, val color: Long)

/** "1m30s", "90", "90s" -> seconds. */
private fun parseStart(t: String?): Int {
    if (t.isNullOrEmpty()) return 0
    if (t.all { it.isDigit() }) return t.toIntOrNull() ?: 0
    val m = Regex("^(?:(\\d+)h)?(?:(\\d+)m)?(?:(\\d+)s)?$").find(t) ?: return 0
    return (m.groupValues[1].toIntOrNull() ?: 0) * 3600 + (m.groupValues[2].toIntOrNull() ?: 0) * 60 + (m.groupValues[3].toIntOrNull() ?: 0)
}

private val ID = Regex("^[\\w-]+$")
private val DIGITS = Regex("^\\d+$")

private fun query(uri: URI): Map<String, String> = uri.rawQuery.orEmpty().split('&').filter { it.isNotEmpty() }.associate {
    val (k, v) = (it.split('=', limit = 2) + "").let { p -> p[0] to p[1] }
    URLDecoder.decode(k, "UTF-8") to URLDecoder.decode(v, "UTF-8")
}

/** [hostname]: the page's host, which Twitch needs to be told (the app's players load from the server's origin). */
fun videoPlayer(raw: String, hostname: String): LinkPlayer? {
    val u = runCatching { URI(raw) }.getOrNull() ?: return null
    if (u.scheme != "https" && u.scheme != "http") return null
    val host = (u.host ?: return null).lowercase().replace(Regex("^(www|m)\\."), "")
    val seg = u.rawPath.orEmpty().split('/').filter { it.isNotEmpty() }
    val q = query(u)
    fun valid(id: String?) = id != null && ID.matches(id)

    if (host == "youtube.com" || host == "music.youtube.com" || host == "youtu.be" || host == "youtube-nocookie.com") {
        var id: String? = null
        var vertical = false
        if (host == "youtu.be") id = seg.getOrNull(0)
        else if (seg.getOrNull(0) == "watch") id = q["v"]
        else if (seg.getOrNull(0) in listOf("shorts", "live", "embed")) {
            id = seg.getOrNull(1)
            vertical = seg[0] == "shorts"
        }
        if (!valid(id)) return null
        val start = parseStart(q["t"] ?: q["start"])
        return LinkPlayer("YouTube", "https://www.youtube.com/embed/$id?autoplay=1&rel=0" + (if (start > 0) "&start=$start" else ""), vertical, 0xFFFF0033)
    }
    if (host == "tiktok.com" || host.endsWith(".tiktok.com")) {
        val i = seg.indexOf("video")
        val id = if (i >= 0) seg.getOrNull(i + 1) else if (seg.getOrNull(0) == "embed") seg.lastOrNull() else null
        if (!valid(id) || !DIGITS.matches(id!!)) return null
        return LinkPlayer("TikTok", "https://www.tiktok.com/player/v1/$id?autoplay=1&rel=0&description=1&music_info=1", true, 0xFF25F4EE)
    }
    if (host == "instagram.com") {
        // Only reels: a /p/ post is usually a photo, and a play button on it would be a lie.
        val i = seg.indexOfFirst { it == "reel" || it == "reels" || it == "tv" }
        val id = if (i >= 0) seg.getOrNull(i + 1) else null
        if (!valid(id)) return null
        return LinkPlayer("Instagram", "https://www.instagram.com/reel/$id/embed/", true, 0xFFE1306C)
    }
    if (host == "vimeo.com" && DIGITS.matches(seg.getOrNull(0) ?: "")) {
        return LinkPlayer("Vimeo", "https://player.vimeo.com/video/${seg[0]}?autoplay=1", false, 0xFF1AB7EA)
    }
    if (host == "twitch.tv" || host == "clips.twitch.tv") {
        // Twitch refuses to play unless told which site embeds it.
        val parent = "parent=" + URLEncoder.encode(hostname, "UTF-8")
        val clip = if (host == "clips.twitch.tv") seg.getOrNull(0) else if (seg.getOrNull(1) == "clip") seg.getOrNull(2) else null
        val src = when {
            valid(clip) -> "https://clips.twitch.tv/embed?clip=$clip&$parent&autoplay=true"
            seg.getOrNull(0) == "videos" && DIGITS.matches(seg.getOrNull(1) ?: "") -> "https://player.twitch.tv/?video=${seg[1]}&$parent&autoplay=true"
            seg.size == 1 && Regex("^\\w{3,25}$").matches(seg[0]) -> "https://player.twitch.tv/?channel=${seg[0]}&$parent&autoplay=true"
            else -> null
        } ?: return null
        return LinkPlayer("Twitch", src, false, 0xFF9146FF)
    }
    if (host == "streamable.com" && seg.size == 1 && valid(seg[0])) {
        return LinkPlayer("Streamable", "https://streamable.com/e/${seg[0]}?autoplay=1", false, 0xFF0F90FA)
    }
    if (host == "dailymotion.com" || host == "dai.ly") {
        val id = if (host == "dai.ly") seg.getOrNull(0) else if (seg.getOrNull(0) == "video") seg.getOrNull(1) else null
        if (!valid(id)) return null
        return LinkPlayer("Dailymotion", "https://www.dailymotion.com/embed/video/$id?autoplay=1", false, 0xFF0A0AFF)
    }
    return null
}

/** Invite codes in a message: links to /invite/<code> on any address of this server (web InviteCard.tsx), at most 3. */
fun inviteCodes(content: String, origins: List<String>): List<String> {
    if (origins.isEmpty()) return emptyList()
    val re = Regex("(?:${origins.joinToString("|") { Regex.escape(it.trimEnd('/')) }})/invite/([A-Za-z0-9]+)")
    return re.findAll(content).map { it.groupValues[1] }.distinct().take(3).toList()
}
