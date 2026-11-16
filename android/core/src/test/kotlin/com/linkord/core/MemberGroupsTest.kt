package com.linkord.core

import kotlinx.collections.immutable.persistentMapOf
import org.junit.Assert.assertEquals
import org.junit.Test

/** The member list groups like the web's: hoisted roles (online only, highest first), Online, Offline. */
class MemberGroupsTest {
    private val g = "1"

    @Test
    fun hoistedRolesGetTheirOwnGroups() {
        val st = State(
            guilds = persistentMapOf(g to GuildInfo(g, ownerId = "99")),
            roles = persistentMapOf(g to persistentMapOf(
                g to Role(g, g, "@everyone"),
                "admins" to Role("admins", g, "Admins", position = 3, hoist = true),
                "mods" to Role("mods", g, "Mods", position = 2, hoist = true),
                "fans" to Role("fans", g, "Fans", position = 1),
            )),
            members = persistentMapOf(g to persistentMapOf(
                "a" to MemberInfo(roles = listOf("admins", "mods")),
                "b" to MemberInfo(roles = listOf("mods")),
                "c" to MemberInfo(roles = listOf("fans")),
                "d" to MemberInfo(roles = listOf("mods")),
                "e" to MemberInfo(),
            )),
            users = persistentMapOf(
                "a" to User("a", "ana"), "b" to User("b", "bia"), "c" to User("c", "caio"), "d" to User("d", "duda"), "e" to User("e", "edu"),
            ),
            presences = persistentMapOf("a" to "online", "b" to "idle", "c" to "online", "e" to "dnd"),
        )
        val groups = st.memberGroups(g, listOf("e", "d", "c", "b", "a"))
        // ana is in both hoisted roles: only under the higher one. duda is offline: never under a role. Fans isn't hoisted.
        assertEquals(listOf("Admins", "Mods", "Online", "Offline"), groups.map { it.title })
        assertEquals(listOf(listOf("a"), listOf("b"), listOf("c", "e"), listOf("d")), groups.map { it.ids })
        // In a DM there are no roles: just Online and Offline.
        assertEquals(listOf("Online", "Offline"), st.memberGroups(null, listOf("a", "d")).map { it.title })
    }
}
