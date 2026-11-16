package com.linkord.core

import kotlinx.collections.immutable.toPersistentMap

/** One line of the channel reorder list: a category header or a channel (text/voice). */
data class OrderRow(val id: String, val kind: Int) {
    val category: Boolean get() = kind == Kind.CATEGORY
}

/** A server's channels as the list shows them: loose channels first, then each category followed by its channels. */
fun State.orderRows(guildId: String): List<OrderRow> {
    val l = channelLayout(guildId)
    return l.top.map { OrderRow(it.id, it.kind) } +
        l.categories.flatMap { g -> listOf(OrderRow(g.category.id, g.category.kind)) + g.channels.map { OrderRow(it.id, it.kind) } }
}

/**
 * Puts rows back in the shape the channel list draws (channelLayout): a channel belongs to the category above it,
 * and within each group text channels come before voice ones (the list always sorts them that way).
 */
fun normalizeOrder(rows: List<OrderRow>): List<OrderRow> {
    val out = ArrayList<OrderRow>(rows.size)
    var group = ArrayList<OrderRow>()
    fun flush() {
        out += group.sortedBy { if (it.kind == Kind.VOICE) 1 else 0 }
        group = ArrayList()
    }
    for (r in rows) {
        if (r.category) {
            flush()
            out += r
        } else group += r
    }
    flush()
    return out
}

/** What PUT /guilds/{id}/channels takes: every row's id in order, and the new category of each channel that moved. */
data class ChannelOrderChange(val ids: List<String>, val parents: Map<String, String?>)

fun State.channelOrderChange(guildId: String, rows: List<OrderRow>): ChannelOrderChange {
    val before = HashMap<String, String?>()
    val l = channelLayout(guildId)
    l.top.forEach { before[it.id] = null }
    l.categories.forEach { g -> g.channels.forEach { before[it.id] = g.category.id } }
    val parents = LinkedHashMap<String, String?>()
    var cat: String? = null
    for (r in rows) {
        if (r.category) cat = r.id
        else if (before[r.id] != cat) parents[r.id] = cat
    }
    return ChannelOrderChange(rows.map { it.id }, parents)
}

/** True when [rows] would change anything (order or categories). */
fun State.orderChanged(guildId: String, rows: List<OrderRow>): Boolean =
    rows.map { it.id } != orderRows(guildId).map { it.id } || channelOrderChange(guildId, rows).parents.isNotEmpty()

/**
 * Shows a saved order right away: positions in list order and the new categories (the server numbers them the same
 * way, and its CHANNEL_UPDATE events follow).
 */
fun State.withChannelOrder(change: ChannelOrderChange): State {
    val m = channels.toMutableMap()
    change.ids.forEachIndexed { i, id ->
        val ch = m[id] ?: return@forEachIndexed
        m[id] = ch.copy(position = i, parentId = if (id in change.parents) change.parents[id] else ch.parentId)
    }
    return copy(channels = m.toPersistentMap())
}
