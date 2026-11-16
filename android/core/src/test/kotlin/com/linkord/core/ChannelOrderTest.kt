package com.linkord.core

import kotlinx.collections.immutable.persistentMapOf
import kotlinx.collections.immutable.toPersistentMap
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Reordering channels on the phone: rows, the request PUT /guilds/{id}/channels gets, and the local update. */
class ChannelOrderTest {
    private val g = "g"
    private val st = State(
        guilds = persistentMapOf(g to GuildInfo(g)),
        channels = listOf(
            Channel("loose", g, Kind.TEXT, "loose", position = 0),
            Channel("cat1", g, Kind.CATEGORY, "One", position = 1),
            Channel("a", g, Kind.TEXT, "a", position = 2, parentId = "cat1"),
            Channel("v", g, Kind.VOICE, "v", position = 3, parentId = "cat1"),
            Channel("cat2", g, Kind.CATEGORY, "Two", position = 4),
            Channel("b", g, Kind.TEXT, "b", position = 5, parentId = "cat2"),
        ).associateBy { it.id }.toPersistentMap(),
    )

    private fun ids(rows: List<OrderRow>) = rows.map { it.id }

    @Test
    fun rowsFollowTheChannelList() {
        assertEquals(listOf("loose", "cat1", "a", "v", "cat2", "b"), ids(st.orderRows(g)))
        assertFalse(st.orderChanged(g, st.orderRows(g)))
    }

    @Test
    fun aChannelBelongsToTheCategoryAboveIt() {
        val rows = st.orderRows(g).toMutableList()
        val b = rows.removeAt(5)
        rows.add(1, b) // b above every category: no category
        val loose = rows.removeAt(0)
        rows.add(rows.indexOfFirst { it.id == "cat2" } + 1, loose) // loose into Two
        val change = st.channelOrderChange(g, normalizeOrder(rows))
        assertEquals(listOf("b", "cat1", "a", "v", "cat2", "loose"), change.ids)
        assertEquals(mapOf("b" to null, "loose" to "cat2"), change.parents)
        val after = st.withChannelOrder(change)
        assertEquals(listOf("b"), after.channelLayout(g).top.map { it.id })
        assertEquals(listOf("loose"), after.channelLayout(g).categories[1].channels.map { it.id })
    }

    @Test
    fun voiceStaysBelowTextInItsGroup() {
        val rows = st.orderRows(g).toMutableList()
        val v = rows.removeAt(3)
        rows.add(2, v) // v above a
        assertEquals(listOf("loose", "cat1", "a", "v", "cat2", "b"), ids(normalizeOrder(rows)))
    }

    @Test
    fun movingACategoryMovesItsChannels() {
        val rows = st.orderRows(g)
        val moved = rows.take(1) + rows.subList(4, 6) + rows.subList(1, 4)
        assertEquals(listOf("loose", "cat2", "b", "cat1", "a", "v"), ids(moved))
        assertTrue(st.orderChanged(g, moved))
        val change = st.channelOrderChange(g, moved)
        assertTrue(change.parents.isEmpty())
        assertEquals(listOf("cat2", "cat1"), st.withChannelOrder(change).channelLayout(g).categories.map { it.category.id })
    }
}
