package com.linkord.core

import kotlinx.collections.immutable.persistentMapOf
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** WhatsApp-style ticks on your DMs: sent, delivered (a device of theirs got it), read. */
class ReceiptsTest {
    private val me = User("1", "link", "Link")
    private val zelda = User("2", "zelda", "Zelda")
    private val impa = User("3", "impa", "Impa")
    private fun mine(id: String, channel: String = "dm") = Message(id, channelId = channel, author = me, content = "m$id")

    private val base = State().copy(
        me = me,
        channels = persistentMapOf(
            "dm" to Channel("dm", kind = Kind.DM),
            "group" to Channel("group", kind = Kind.GROUP_DM),
            "text" to Channel("text", guildId = "g", kind = Kind.TEXT),
        ),
    )

    @Test
    fun aMessageGoesFromSentToDeliveredToRead() {
        var st = base.withReceipt("dm", zelda.id)
        assertEquals(Tick.SENT, st.tickFor(mine("10")))
        st = st.withReceipt("dm", zelda.id, delivered = "10")
        assertEquals(Tick.DELIVERED, st.tickFor(mine("10")))
        // Older messages are delivered too; a newer one isn't yet.
        assertEquals(Tick.DELIVERED, st.tickFor(mine("9")))
        assertEquals(Tick.SENT, st.tickFor(mine("11")))
        st = st.withReceipt("dm", zelda.id, read = "11")
        // Read counts as delivered even without a delivered position that far.
        assertEquals(Tick.READ, st.tickFor(mine("11")))
    }

    @Test
    fun positionsNeverGoBack() {
        val st = base.withReceipt("dm", zelda.id, read = "20").withReceipt("dm", zelda.id, read = "15", delivered = "18")
        assertEquals("20", st.receipts["dm"]!![zelda.id]!!.readId)
        assertEquals("18", st.receipts["dm"]!![zelda.id]!!.deliveredId)
        // Ids compare as numbers, not text ("9" is older than "10").
        assertEquals("100", base.withReceipt("dm", zelda.id, read = "100").withReceipt("dm", zelda.id, read = "99").receipts["dm"]!![zelda.id]!!.readId)
    }

    @Test
    fun aGroupIsReadOnlyOnceEveryoneReadIt() {
        val st = base.withReceipt("group", zelda.id, read = "10").withReceipt("group", impa.id, delivered = "10")
        assertEquals(Tick.DELIVERED, st.tickFor(mine("10", "group")))
        assertEquals(Tick.READ, st.withReceipt("group", impa.id, read = "10").tickFor(mine("10", "group")))
    }

    @Test
    fun onlyYourSentMessagesInDmsHaveTicks() {
        val st = base.withReceipt("dm", zelda.id, read = "10")
        assertNull(st.tickFor(Message("10", channelId = "dm", author = zelda, content = "hi")))
        assertNull(st.tickFor(mine("10", "text")))
        assertNull(st.tickFor(mine("10").copy(pending = true)))
    }
}
