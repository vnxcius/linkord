package com.linkord.app.data

import android.net.Uri

/** A link to something in Linkord (invite, message, clip) on any address this server has or had. */
sealed interface AppLink {
    data class Invite(val code: String) : AppLink
    data class Channel(val guild: String, val channel: String, val message: String?) : AppLink
    data class Clip(val slug: String) : AppLink
    /** Someone's profile (a friend request's notification). */
    data class Profile(val userId: String) : AppLink
}

object Links {
    /** What [url] points to, if it's one of this server's own links ([known]: its addresses, see Session.knownServers). */
    fun parse(url: String, known: List<String>): AppLink? {
        val uri = runCatching { Uri.parse(url) }.getOrNull() ?: return null
        val origin = "${uri.scheme}://${uri.authority}"
        if (known.none { it.equals(origin, ignoreCase = true) }) return null
        val p = uri.pathSegments
        return when {
            p.size == 2 && p[0] == "invite" -> AppLink.Invite(p[1])
            p.size >= 3 && p[0] == "channels" -> AppLink.Channel(p[1], p[2], p.getOrNull(3))
            p.size == 2 && p[0] == "clip" -> AppLink.Clip(p[1])
            else -> null
        }
    }
}
