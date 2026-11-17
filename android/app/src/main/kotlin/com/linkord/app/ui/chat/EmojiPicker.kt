package com.linkord.app.ui.chat

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import coil3.compose.AsyncImage
import com.linkord.app.session
import com.linkord.app.ui.components.Kicker
import com.linkord.app.ui.components.LIcon
import com.linkord.core.Emoji
import com.linkord.core.EmojiData
import com.linkord.core.EmojiEntry
import com.linkord.core.EmojiGroup
import com.linkord.core.State
import com.linkord.core.t
import com.linkord.designsystem.Linkord
import com.linkord.designsystem.LinkordIcons
import com.linkord.designsystem.emojiText
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** A cell in the picker's grid. */
private sealed interface Cell {
    val key: String
    data class Header(val title: String, override val key: String) : Cell
    data class Unicode(val e: EmojiEntry, override val key: String) : Cell
    data class Custom(val e: Emoji, override val key: String) : Cell
}

/** A tab in the category bar: where its section starts in the grid. */
private class Tab(val id: String, val label: String, val start: Int, val icon: @Composable () -> Unit)

/**
 * The emoji picker, like WhatsApp's: a search box, a bar of categories (Recent, the servers' own emoji, then every
 * Unicode category) that follows the scrolling and jumps on a tap, and the whole list in one grid. A long press on an
 * emoji that has skin tones offers them; the one chosen is kept for next time. [onPick] gets the character, or
 * "name:id" for a server's emoji (what reactions use; the composer turns it into <:name:id>).
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun EmojiPicker(
    st: State,
    guildId: String?,
    modifier: Modifier = Modifier,
    height: Dp = 380.dp,
    /** The search box got or lost focus (the composer's panel makes room for the keyboard then). */
    onSearchFocus: (Boolean) -> Unit = {},
    onPick: (String) -> Unit,
) {
    val ctx = LocalContext.current
    val session = ctx.session
    val c = Linkord.colors
    val scope = rememberCoroutineScope()
    val haptics = LocalHapticFeedback.current
    val groups by produceState<List<EmojiGroup>?>(null) { value = withContext(Dispatchers.IO) { EmojiData.load { ctx.assets.open("emoji/emoji-list.json").bufferedReader().readText() } } }
    var query by remember { mutableStateOf("") }
    var recent by remember { mutableStateOf(session.prefs.recentEmoji) }
    var tones by remember { mutableStateOf(session.prefs.emojiTones) }
    var toneFor by remember { mutableStateOf<String?>(null) }

    fun pick(value: String) {
        recent = (listOf(value) + recent.filter { it != value }).take(RECENT)
        session.prefs.recentEmoji = recent
        onPick(value)
    }

    // Server emoji: this server's first, then the others you're in (like the web picker).
    val servers = remember(st.emojis, st.guilds, guildId) {
        st.emojis.filterValues { it.isNotEmpty() }.entries
            .sortedBy { if (it.key == guildId) 0 else 1 }
            .map { (gid, list) -> (st.guilds[gid]?.name ?: t("Server")) to list }
    }
    val customById = remember(servers) { servers.flatMap { it.second }.associateBy { it.id } }
    // Each emoji by its character and by each of its toned forms (a toned one in Recent).
    val byChar = remember(groups) { groups.orEmpty().flatMap { it.emojis }.flatMap { e -> (listOf(e.char) + e.tones.orEmpty()).map { it to e } }.toMap() }

    // The grid's cells and where each tab's section starts.
    val (cells, tabs) = remember(groups, servers, recent, query.isBlank()) {
        val cells = mutableListOf<Cell>()
        val tabs = mutableListOf<Tab>()
        val recentCells = recent.mapNotNull { r ->
            val id = r.substringAfterLast(':', "")
            when {
                id.isNotEmpty() && id.all { it.isDigit() } -> customById[id]?.let { Cell.Custom(it, "r:$r") }
                else -> byChar[r]?.let { Cell.Unicode(it, "r:$r") }
            }
        }
        if (recentCells.isNotEmpty()) {
            tabs += Tab("recent", t("Recent"), cells.size) { LIcon(LinkordIcons.Clock, size = 20.dp) }
            cells += Cell.Header(t("Recent"), "h:recent")
            cells += recentCells
        }
        servers.forEachIndexed { i, (name, list) ->
            if (i == 0) {
                val first = list.first()
                tabs += Tab("servers", t("Server"), cells.size) { AsyncImage(session.api.emojiUrl(first.id, first.animated), null, Modifier.size(20.dp)) }
            }
            cells += Cell.Header(name, "h:s$i")
            list.forEach { cells += Cell.Custom(it, "c:${it.id}") }
        }
        for (g in groups.orEmpty()) {
            val label = t(g.id)
            tabs += Tab(g.id, label, cells.size) { Text(emojiText(EmojiData.GROUPS[g.id] ?: "❔"), fontSize = 18.sp) }
            cells += Cell.Header(label, "h:${g.id}")
            g.emojis.forEach { cells += Cell.Unicode(it, "u:${it.char}") }
        }
        cells to tabs
    }
    val grid = rememberLazyGridState()
    val searchGrid = rememberLazyGridState()
    val popupLift = with(androidx.compose.ui.platform.LocalDensity.current) { 54.dp.roundToPx() }
    val active by remember(tabs) { derivedStateOf { tabs.lastOrNull { it.start <= grid.firstVisibleItemIndex }?.id } }

    Column(modifier.fillMaxWidth().height(height)) {
        // Search.
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp).clip(RoundedCornerShape(12.dp)).background(c.raised).padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            LIcon(LinkordIcons.Search, size = 18.dp, tint = c.text3)
            Spacer(Modifier.width(8.dp))
            Box(Modifier.weight(1f)) {
                if (query.isEmpty()) Text(t("Find the perfect emoji"), style = Linkord.type.body, color = c.text3)
                BasicTextField(
                    query, { query = it }, singleLine = true, textStyle = Linkord.type.body.copy(color = c.text), cursorBrush = SolidColor(c.text),
                    modifier = Modifier.fillMaxWidth().onFocusChanged { onSearchFocus(it.isFocused) },
                )
            }
            if (query.isNotEmpty()) Box(Modifier.size(22.dp).clip(RoundedCornerShape(11.dp)).clickable { query = "" }, contentAlignment = Alignment.Center) {
                LIcon(LinkordIcons.Close, size = 16.dp, tint = c.text3)
            }
        }
        if (query.isBlank()) {
            // Categories: the one in view is marked by its own bar underneath.
            Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp)) {
                for (tab in tabs) {
                    val on = tab.id == active
                    Column(
                        Modifier.weight(1f).clip(RoundedCornerShape(8.dp)).clickable { scope.launch { grid.scrollToItem(tab.start) } }.padding(top = 6.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Box(Modifier.height(24.dp).alpha(if (on) 1f else 0.45f), contentAlignment = Alignment.Center) { tab.icon() }
                        Spacer(Modifier.height(5.dp))
                        Box(Modifier.width(18.dp).height(3.dp).clip(RoundedCornerShape(2.dp)).background(if (on) c.brand else androidx.compose.ui.graphics.Color.Transparent))
                    }
                }
            }
            Box(Modifier.fillMaxWidth().height(1.dp).background(c.line))
        }

        val results = if (query.isBlank()) null else remember(query, groups, servers) {
            val q = query.trim().lowercase().removePrefix(":")
            servers.flatMap { it.second }.filter { it.name.lowercase().contains(q) }.map { Cell.Custom(it, "c:${it.id}") } +
                EmojiData.search(groups.orEmpty(), q).map { Cell.Unicode(it, "u:${it.char}") }
        }
        val shown = results ?: cells
        if (results != null && results.isEmpty()) {
            Text(t("No emoji found"), style = Linkord.type.small, color = c.text3, modifier = Modifier.padding(20.dp))
        }
        LazyVerticalGrid(
            GridCells.Adaptive(44.dp), Modifier.fillMaxWidth().weight(1f), state = if (results == null) grid else searchGrid,
            contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp),
        ) {
            items(shown, key = { it.key }, span = { if (it is Cell.Header) GridItemSpan(maxLineSpan) else GridItemSpan(1) }, contentType = { it::class }) { cell ->
                when (cell) {
                    is Cell.Header -> Kicker(cell.title, Modifier.padding(start = 6.dp, top = 12.dp, bottom = 6.dp))
                    is Cell.Custom -> Box(
                        Modifier.size(44.dp).clip(RoundedCornerShape(10.dp)).clickable { pick("${cell.e.name}:${cell.e.id}") },
                        contentAlignment = Alignment.Center,
                    ) { AsyncImage(session.api.emojiUrl(cell.e.id, cell.e.animated), ":${cell.e.name}:", modifier = Modifier.size(30.dp)) }
                    is Cell.Unicode -> {
                        val e = cell.e
                        // In Recent, what was picked (a toned one stays toned); elsewhere the tone chosen for it.
                        val shownChar = if (cell.key.startsWith("r:")) cell.key.removePrefix("r:") else tones[e.char] ?: e.char
                        Box(
                            Modifier.size(44.dp).clip(RoundedCornerShape(10.dp)).combinedClickable(
                                onClick = { pick(shownChar) },
                                onLongClick = if (e.tones != null) {
                                    { haptics.performHapticFeedback(HapticFeedbackType.LongPress); toneFor = cell.key }
                                } else null,
                            ),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(emojiText(shownChar), fontSize = 26.sp, maxLines = 1, overflow = TextOverflow.Clip)
                            if (e.tones != null && !cell.key.startsWith("r:")) Box(
                                Modifier.align(Alignment.BottomEnd).padding(5.dp).size(4.dp).clip(RoundedCornerShape(2.dp)).background(c.text3.copy(alpha = 0.6f)),
                            )
                            // Skin tones, above the emoji: the plain one and the five tones.
                            val variants = e.tones // a local: core's property can't be smart-cast here
                            if (toneFor == cell.key && variants != null) Popup(
                                alignment = Alignment.TopCenter, offset = IntOffset(0, -popupLift),
                                onDismissRequest = { toneFor = null }, properties = PopupProperties(focusable = true),
                            ) {
                                Row(
                                    Modifier.clip(RoundedCornerShape(14.dp)).background(c.raised2).padding(4.dp),
                                    horizontalArrangement = Arrangement.spacedBy(2.dp),
                                ) {
                                    for (v in listOf(e.char) + variants) Box(
                                        Modifier.size(44.dp).clip(RoundedCornerShape(10.dp)).background(if (v == shownChar) c.active else androidx.compose.ui.graphics.Color.Transparent)
                                            .clickable {
                                                toneFor = null
                                                tones = if (v == e.char) tones - e.char else tones + (e.char to v)
                                                session.prefs.emojiTones = tones
                                                pick(v)
                                            },
                                        contentAlignment = Alignment.Center,
                                    ) { Text(emojiText(v), fontSize = 26.sp) }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/** Emoji kept in the Recent tab. */
private const val RECENT = 32
