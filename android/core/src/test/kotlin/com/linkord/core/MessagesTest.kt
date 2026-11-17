package com.linkord.core

import kotlinx.collections.immutable.persistentListOf
import kotlinx.collections.immutable.persistentMapOf
import kotlinx.collections.immutable.toPersistentList
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * The message list across a reconnect: after a READY every channel is stale until reloaded, and what was sent or
 * received meanwhile must neither stay grey, be lost, nor show up twice.
 */
class MessagesTest {
    private val me = User("1", "link", "Link")
    private val zelda = User("2", "zelda", "Zelda")
    private fun post(id: String, author: User = zelda, nonce: String? = null, pending: Boolean = false) =
        Message(id, channelId = "c1", author = author, content = "m$id", nonce = nonce, pending = pending)

    private fun state(b: ChannelMessages) = State().copy(messages = persistentMapOf("c1" to b))
    private fun State.ids() = bucket("c1").list.map { it.id }

    @Test
    fun aSendConfirmedWhileTheChannelIsStaleReplacesItsGreyCopy() {
        // READY made the channel stale; the send's answer comes back before the reload.
        var st = state(ChannelMessages(persistentListOf(post("10"), post("pending-n1", me, "n1", pending = true)), loaded = false))
        st = st.receive(post("11", me, "n1"))
        assertEquals(listOf("10", "11"), st.ids())
        assertFalse(st.bucket("c1").list.any { it.pending })

        // The reload's page has it too (without the nonce): one copy, not two.
        st = st.mergeLatest("c1", listOf(post("10"), post("11", me)))
        assertEquals(listOf("10", "11"), st.ids())
    }

    @Test
    fun aSendConfirmedAfterThePageWasTakenIsKeptByTheReload() {
        var st = state(ChannelMessages(persistentListOf(post("10"), post("pending-n1", me, "n1", pending = true)), loaded = false, loading = true))
        st = st.receive(post("11", me, "n1"))
        // The page was read on the server before message 11 existed.
        st = st.mergeLatest("c1", listOf(post("9"), post("10")))
        assertEquals(listOf("9", "10", "11"), st.ids())
    }

    @Test
    fun messagesArrivingDuringTheReloadAreKeptAndDeletedOnesDoNotComeBack() {
        // 12 was on screen before the disconnect and deleted meanwhile; 13 arrives while the page is on its way.
        var st = state(ChannelMessages(persistentListOf(post("10"), post("12")), loaded = false, loading = true))
        st = st.receive(post("13"))
        st = st.mergeLatest("c1", listOf(post("10"), post("11")))
        assertEquals(listOf("10", "11", "13"), st.ids())
    }

    @Test
    fun aStaleChannelNobodyIsReloadingIgnoresOthersMessages() {
        val st = state(ChannelMessages(listOf(post("10")).toPersistentList(), loaded = false))
        assertEquals(listOf("10"), st.receive(post("11")).ids())
    }

    @Test
    fun unsentMessagesStayAtTheEndThroughAReload() {
        var st = state(ChannelMessages(persistentListOf(post("10"), post("pending-n2", me, "n2", pending = true)), loaded = false, loading = true))
        st = st.mergeLatest("c1", listOf(post("10"), post("11")))
        assertEquals(listOf("10", "11", "pending-n2"), st.ids())
    }
}
