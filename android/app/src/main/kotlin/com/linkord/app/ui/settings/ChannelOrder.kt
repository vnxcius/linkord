package com.linkord.app.ui.settings

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import com.linkord.app.session
import com.linkord.app.ui.LocalNav
import com.linkord.app.ui.chat.ScreenScaffold
import com.linkord.app.ui.components.Kicker
import com.linkord.app.ui.components.LIcon
import com.linkord.core.Kind
import com.linkord.core.OrderRow
import com.linkord.core.channelOrderChange
import com.linkord.core.normalizeOrder
import com.linkord.core.orderChanged
import com.linkord.core.orderRows
import com.linkord.core.t
import com.linkord.core.withChannelOrder
import com.linkord.designsystem.Linkord
import com.linkord.designsystem.LinkordIcons
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonNull
import kotlin.math.abs
import kotlin.math.roundToInt

/** Every row has this height, so where a held row lands is plain arithmetic (no measuring rows off screen). */
private val ROW = 52.dp

/**
 * The channel list, reordered by dragging: hold a row (or grab its handle) and move it. A channel goes in the
 * category above it; a category moves with its channels. Saved with Save Changes, like Server Settings.
 */
@Composable
fun ChannelOrderScreen(guildId: String) {
    val session = LocalContext.current.session
    val st by session.store.state.collectAsState()
    val nav = LocalNav.current
    val c = Linkord.colors
    val scope = rememberCoroutineScope()
    val haptics = LocalHapticFeedback.current
    val rowH = with(LocalDensity.current) { ROW.roundToPx() }
    val motion = Linkord.motion
    val rows = remember(guildId) { mutableStateListOf<OrderRow>().apply { addAll(session.store.s.orderRows(guildId)) } }
    // The order the rows were loaded from: while they still match it, changes made elsewhere are taken in.
    var base by remember(guildId) { mutableStateOf(rows.toList()) }
    val list = rememberLazyListState()
    var dragKey by remember { mutableStateOf<String?>(null) }
    var dragDelta by remember { mutableFloatStateOf(0f) }
    var dragStartY by remember { mutableFloatStateOf(0f) }
    var dragStartScroll by remember { mutableFloatStateOf(0f) }
    // After letting go, the rows glide from where they were held into their places.
    val settle = remember { Animatable(0f) }
    var settleFrom by remember { mutableStateOf(mapOf<String, Float>()) }
    var busy by remember { mutableStateOf(false) }
    var leaving by remember { mutableStateOf(false) }

    LaunchedEffect(st.channels) {
        if (dragKey != null) return@LaunchedEffect
        val now = st.orderRows(guildId)
        if (rows.toList() == base && now != base) {
            rows.clear()
            rows.addAll(now)
            base = now
        } else rows.removeAll { st.channels[it.id]?.guildId != guildId }
    }

    fun scrolled() = (list.firstVisibleItemIndex * rowH + list.firstVisibleItemScrollOffset).toFloat()
    /** Top of the held row in list coordinates: where it was picked up, plus the finger, plus any auto-scroll. */
    fun heldTop() = dragStartY + dragDelta + (scrolled() - dragStartScroll)
    /** Where a row's block ends: a channel is alone, a category takes the channels under it. */
    fun blockEnd(start: Int): Int {
        if (!rows[start].category) return start + 1
        var e = start + 1
        while (e < rows.size && !rows[e].category) e++
        return e
    }
    fun heldRange(): IntRange? {
        val s = rows.indexOfFirst { it.id == dragKey }
        return if (s < 0) null else s until blockEnd(s)
    }
    /** Moves the held row (or category block) to the slot under the finger. */
    fun follow() {
        val range = heldRange() ?: return
        val s = range.first
        val top = heldTop()
        if (!rows[s].category) {
            val t = (top / rowH).roundToInt().coerceIn(0, rows.size - 1)
            if (t == s) return
            rows.add(t, rows.removeAt(s))
        } else {
            val block = rows.subList(s, range.last + 1).toList()
            val rest = rows.filterIndexed { i, _ -> i !in range }
            // A category can only sit after the loose channels: before another category, or at the end.
            val slots = rest.indices.filter { rest[it].category } + rest.size
            val t = slots.minBy { abs(it * rowH - top) }
            if (t == s) return
            rows.removeRange(s, range.last + 1)
            rows.addAll(t, block)
        }
        haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
    }
    fun start(id: String) {
        val i = rows.indexOfFirst { it.id == id }
        if (i < 0 || busy) return
        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
        dragKey = id
        dragDelta = 0f
        dragStartY = (i * rowH).toFloat()
        dragStartScroll = scrolled()
    }
    fun end() {
        val range = heldRange() ?: return run { dragKey = null }
        val held = range.map { rows[it].id }
        val heldY = held.withIndex().associate { (k, id) -> id to heldTop() + k * rowH }
        val tidy = normalizeOrder(rows.toList())
        if (tidy != rows.toList()) {
            rows.clear()
            rows.addAll(tidy)
        }
        settleFrom = held.associateWith { id -> heldY.getValue(id) - rows.indexOfFirst { it.id == id } * rowH }
        dragKey = null
        scope.launch {
            settle.snapTo(1f)
            settle.animateTo(0f, motion.standard())
            settleFrom = emptyMap()
        }
    }
    // Holding a row near the top or bottom edge scrolls the list.
    LaunchedEffect(dragKey) {
        if (dragKey == null) return@LaunchedEffect
        while (isActive && dragKey != null) {
            withFrameNanos { }
            val view = list.layoutInfo.viewportSize.height.toFloat()
            val y = heldTop() - scrolled()
            val edge = rowH * 1.5f
            val speed = when {
                y < edge -> -(edge - y) / edge * 28f
                y + rowH > view - edge -> (y + rowH - (view - edge)) / edge * 28f
                else -> 0f
            }.coerceIn(-28f, 28f)
            if (speed != 0f && list.scrollBy(speed) != 0f) follow()
        }
    }

    val live = rows.filter { st.channels[it.id] != null }
    val dirty = st.orderChanged(guildId, live)
    fun reset() {
        val now = st.orderRows(guildId)
        rows.clear()
        rows.addAll(now)
        base = now
    }
    fun save(thenLeave: Boolean = false) {
        if (busy) return
        val before = session.store.s
        val order = rows.filter { before.channels[it.id] != null }
        val change = before.channelOrderChange(guildId, order)
        busy = true
        // Shown at once; put back if the server says no.
        session.store.update { it.withChannelOrder(change) }
        base = order
        scope.launch {
            runCatching {
                session.api.send("PUT", "/guilds/$guildId/channels", mapOf("ids" to change.ids, "parents" to change.parents.mapValues { it.value ?: JsonNull }))
            }.onSuccess {
                session.toast(t("Saved"))
                if (thenLeave) nav.pop()
            }.onFailure { e ->
                session.store.update { cur -> cur.copy(channels = change.ids.fold(cur.channels) { m, id -> before.channels[id]?.let { m.putting(id, it) } ?: m }) }
                base = before.orderRows(guildId)
                session.toast(session.describe(e))
            }
            busy = false
        }
    }
    fun back() = if (dirty) leaving = true else nav.pop()
    BackHandler(enabled = dirty) { leaving = true }

    ScreenScaffold(t("Channels"), onBack = ::back) {
        Box(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize()) {
                Text(
                    t("Hold a channel and drag it, or drag it by its handle. A channel goes in the category above it; a category takes its channels along."),
                    style = Linkord.type.small, color = c.text3, modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 10.dp),
                )
                val held = heldRange()
                // Text channels are numbered as they'll be after saving.
                val numbers = HashMap<String, String>()
                rows.filter { it.kind == Kind.TEXT }.forEachIndexed { i, r -> numbers[r.id] = (i + 1).toString().padStart(2, '0') }
                val firstCategory = rows.indexOfFirst { it.category }.let { if (it < 0) rows.size else it }
                LazyColumn(Modifier.fillMaxSize(), state = list) {
                    itemsIndexed(rows, key = { _, r -> r.id }) { i, r ->
                        val ch = st.channels[r.id]
                        val inHand = held != null && i in held
                        val gliding = r.id in settleFrom
                        Box(
                            Modifier.fillMaxWidth().height(ROW)
                                .then(
                                    when {
                                        inHand -> Modifier.zIndex(1f).graphicsLayer { translationY = heldTop() - held!!.first * rowH }
                                        gliding -> Modifier.zIndex(1f).graphicsLayer { translationY = (settleFrom[r.id] ?: 0f) * settle.value }
                                        else -> Modifier.animateItem(fadeInSpec = null, fadeOutSpec = null, placementSpec = motion.standard())
                                    },
                                )
                                .pointerInput(r.id) {
                                    detectDragGesturesAfterLongPress(onDragStart = { start(r.id) }, onDragEnd = ::end, onDragCancel = ::end) { change, amount ->
                                        change.consume()
                                        dragDelta += amount.y
                                        follow()
                                    }
                                },
                        ) {
                            if (ch != null) OrderLine(
                                name = ch.name, kind = r.kind, number = numbers[r.id], nested = !r.category && i > firstCategory,
                                lifted = inHand || gliding,
                                handle = Modifier.pointerInput(r.id) {
                                    detectDragGestures(onDragStart = { start(r.id) }, onDragEnd = ::end, onDragCancel = ::end) { change, amount ->
                                        change.consume()
                                        dragDelta += amount.y
                                        follow()
                                    }
                                },
                            )
                        }
                    }
                    item { Spacer(Modifier.height(if (dirty) 96.dp else 24.dp)) }
                }
            }
            UnsavedBar(dirty, busy, onReset = ::reset, onSave = { save() }, modifier = Modifier.align(Alignment.BottomCenter))
        }
    }

    if (leaving) AlertDialog(
        onDismissRequest = { leaving = false },
        title = { Text(t("Careful — you have unsaved changes!")) },
        text = { Text(t("Save them before you leave, or discard them.")) },
        confirmButton = { TextButton(onClick = { leaving = false; save(thenLeave = true) }) { Text(t("Save Changes")) } },
        dismissButton = { TextButton(onClick = { leaving = false; reset(); nav.pop() }) { Text(t("Discard"), color = c.danger) } },
    )
}

/** One row: a category's name like the channel list's kicker, or a channel with its number (or speaker), and the handle. */
@Composable
private fun OrderLine(name: String, kind: Int, number: String?, nested: Boolean, lifted: Boolean, handle: Modifier) {
    val c = Linkord.colors
    val shape = RoundedCornerShape(10.dp)
    Row(
        Modifier.fillMaxSize().padding(start = if (nested) 20.dp else 8.dp, end = 8.dp, top = 2.dp, bottom = 2.dp).clip(shape)
            .background(if (lifted) c.raised else Color.Transparent)
            .then(if (lifted) Modifier.border(1.dp, c.lineStrong, shape) else Modifier)
            .padding(start = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        when (kind) {
            Kind.CATEGORY -> Kicker(name, Modifier.weight(1f), color = c.text2)
            else -> {
                if (kind == Kind.VOICE) LIcon(LinkordIcons.Speaker, size = 16.dp, tint = c.text3)
                else Text(number ?: "··", style = Linkord.type.label, color = c.text3, modifier = Modifier.width(22.dp))
                Spacer(Modifier.width(8.dp))
                Text(name, style = Linkord.type.body, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            }
        }
        Box(handle.size(48.dp), contentAlignment = Alignment.Center) { LIcon(LinkordIcons.GripVertical, size = 18.dp, tint = c.text3) }
    }
}
