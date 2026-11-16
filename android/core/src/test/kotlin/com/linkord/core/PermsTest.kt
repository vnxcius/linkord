package com.linkord.core

import kotlinx.collections.immutable.persistentMapOf
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The client's permission checks follow the server's (perms.rs): roles add up, then channel overwrites apply in order. */
class PermsTest {
    private val g = "1"
    private val mod = "2"
    private val ch = "10"
    private val thread = "11"

    private fun state(overwrites: List<Overwrite>, myRoles: List<String> = emptyList(), owner: String = "99") = State(
        me = User(id = "5", username = "me"),
        guilds = persistentMapOf(g to GuildInfo(g, ownerId = owner)),
        roles = persistentMapOf(g to persistentMapOf(
            g to Role(g, g, "@everyone", permissions = Perm.VIEW_CHANNEL or Perm.SEND_MESSAGES),
            mod to Role(mod, g, "mod", permissions = Perm.MANAGE_MESSAGES, position = 1),
        )),
        members = persistentMapOf(g to persistentMapOf("5" to MemberInfo(roles = myRoles))),
        channels = persistentMapOf(
            ch to Channel(ch, g, Kind.TEXT, permissionOverwrites = overwrites),
            thread to Channel(thread, g, Kind.THREAD, parentId = ch),
        ),
    )

    @Test
    fun rolesAddUp() {
        val st = state(emptyList(), listOf(mod))
        assertTrue(st.can(g, Perm.MANAGE_MESSAGES))
        assertTrue(st.can(g, Perm.SEND_MESSAGES))
        assertFalse(st.can(g, Perm.KICK_MEMBERS))
    }

    @Test
    fun overwritesApplyInOrder() {
        // @everyone can't talk here, the mod role can, but this member is denied again.
        val ows = listOf(
            Overwrite(g, 0, deny = Perm.SEND_MESSAGES),
            Overwrite(mod, 0, allow = Perm.SEND_MESSAGES),
        )
        assertFalse(state(ows).can(g, Perm.SEND_MESSAGES, ch))
        assertTrue(state(ows, listOf(mod)).can(g, Perm.SEND_MESSAGES, ch))
        assertFalse(state(ows + Overwrite("5", 1, deny = Perm.SEND_MESSAGES), listOf(mod)).can(g, Perm.SEND_MESSAGES, ch))
        // Server-wide it's still allowed.
        assertTrue(state(ows).can(g, Perm.SEND_MESSAGES))
    }

    @Test
    fun noViewMeansNothing() {
        val st = state(listOf(Overwrite(g, 0, deny = Perm.VIEW_CHANNEL)))
        assertEquals(0L, st.channelPerms(ch, "5"))
        // A thread follows its channel.
        assertEquals(0L, st.channelPerms(thread, "5"))
    }

    @Test
    fun ownerAndAdministratorHaveEverything() {
        val ows = listOf(Overwrite(g, 0, deny = Perm.VIEW_CHANNEL))
        assertTrue(state(ows, owner = "5").can(g, Perm.MANAGE_ROLES, ch))
        val admin = state(ows).let { s -> s.copy(roles = s.roles.put(g, s.roles[g]!!.put(mod, Role(mod, g, "admin", permissions = Perm.ADMINISTRATOR, position = 1)))) }
        assertTrue(admin.copy(members = persistentMapOf(g to persistentMapOf("5" to MemberInfo(roles = listOf(mod))))).can(g, Perm.SEND_MESSAGES, ch))
        assertEquals(Int.MAX_VALUE, state(ows, owner = "5").topRole(g, "5"))
        assertEquals(1, state(ows, listOf(mod)).topRole(g, "5"))
    }
}
