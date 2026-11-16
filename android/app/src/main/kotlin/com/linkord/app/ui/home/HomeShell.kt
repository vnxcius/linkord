package com.linkord.app.ui.home

import androidx.activity.compose.BackHandler
import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.awaitHorizontalTouchSlopOrCancellation
import androidx.compose.ui.input.pointer.util.addPointerInputChange
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import com.linkord.app.session
import com.linkord.app.ui.chat.ChatScreen
import com.linkord.app.ui.chat.MembersPane
import com.linkord.designsystem.Linkord
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.roundToInt

enum class Tab { Home, Messages, Mentions, You }

/**
 * The phone layout (CLAUDE.md, Android design): the home pane (servers, DMs, inbox, you) underneath, the chat as a
 * page on top. The chat slides right to show the home pane and left to show who's in the channel; it follows the
 * finger, and predictive back slides it away as the gesture moves.
 */
@Composable
fun HomeShell(openRequest: com.linkord.app.data.AppLink?, onOpened: () -> Unit) {
    val session = LocalContext.current.session
    val st by session.store.state.collectAsState()
    var tab by rememberSaveable { mutableStateOf(Tab.Home) }
    val scope = rememberCoroutineScope()
    val motion = Linkord.motion
    val haptics = LocalHapticFeedback.current

    BoxWithConstraints(Modifier.fillMaxSize().background(Linkord.colors.desk)) {
        val width = with(LocalDensity.current) { maxWidth.toPx() }
        val membersWidth = width * 0.84f
        // 0 = the chat covers the screen; width = it's off to the right (home pane); -membersWidth = members shown.
        val x = remember { Animatable(width) }
        val channelId = st.selected[st.view]
        val chatOpen = x.value < width * 0.5f

        fun settle(target: Float) = scope.launch { x.animateTo(target, motion.standard()) }
        fun showChat() = settle(0f)
        fun showHome() = settle(width)

        // Start where you left off: in the last channel when there is one.
        LaunchedEffect(Unit) {
            val view = session.prefs.lastView
            if (view == "@me" || st.guilds[view] != null) session.actions.selectView(view)
            val ch = session.store.s.selected[session.store.s.view]
            if (ch != null && session.store.s.channels[ch] != null) {
                session.actions.selectChannel(ch)
                x.snapTo(0f)
            }
        }
        val nav = com.linkord.app.ui.LocalNav.current
        nav.openChat = { id ->
            session.actions.selectChannel(id)
            showChat()
        }
        nav.openHome = {
            tab = Tab.Home
            showHome()
        }
        LaunchedEffect(openRequest) {
            when (val req = openRequest ?: return@LaunchedEffect) {
                is com.linkord.app.data.AppLink.Channel -> {
                    val (ch, msg) = req.channel to req.message
                    if (session.store.s.channels[ch] != null) {
                        if (msg != null) runCatching { session.actions.jumpToMessage(ch, msg) } else session.actions.selectChannel(ch)
                        showChat()
                    }
                }
                is com.linkord.app.data.AppLink.Invite -> nav.push(com.linkord.app.ui.Screen.JoinServer(req.code))
                is com.linkord.app.data.AppLink.Profile -> nav.push(com.linkord.app.ui.Screen.Profile(req.userId, null))
                is com.linkord.app.data.AppLink.Clip -> nav.push(com.linkord.app.ui.Screen.Video("${session.serverUrl()}/uploads/clips/${req.slug}.mp4", ""))
            }
            onOpened()
        }
        // What the person is looking at (for acks and notifications).
        LaunchedEffect(chatOpen, channelId) { session.actions.setViewing(if (chatOpen) channelId else null) }

        // Back: members -> chat -> home pane, the chat following the gesture.
        PredictiveBackHandler(enabled = x.value < width * 0.5f && channelId != null) { progress ->
            val from = x.value
            try {
                progress.collect { e -> x.snapTo(if (from < 0f) from * (1 - e.progress) else width * e.progress * 0.6f) }
                if (from < -1f) settle(0f) else showHome()
            } catch (e: CancellationException) {
                settle(from)
                throw e
            }
        }
        BackHandler(enabled = !chatOpen && tab != Tab.Home) { tab = Tab.Home }

        // A flick opens the next panel in its direction however short it is; a slow drag opens it past a fifth of
        // the way. The panel follows the finger from where it went down (the lift's last bit of movement included),
        // and a flick is judged on the whole gesture, not only on the velocity tracker: a quick swipe brings few
        // events, often with the last movement on the lift itself.
        val flickSpeed = with(LocalDensity.current) { 120.dp.toPx() }
        val flickDistance = with(LocalDensity.current) { 40.dp.toPx() }
        val drag = Modifier.pointerInput(width, channelId) {
            if (channelId == null) return@pointerInput
            val anchors = floatArrayOf(-membersWidth, 0f, width)
            awaitEachGesture {
                val down = awaitFirstDown(requireUnconsumed = false)
                val tracker = VelocityTracker()
                tracker.addPointerInputChange(down)
                val x0 = x.value
                val from = anchors.minBy { abs(it - x0) }
                val at = { px: Float -> (x0 + px - down.position.x).coerceIn(-membersWidth, width) }
                var pos = x0
                var lastX = down.position.x
                var lastTime = down.uptimeMillis
                var claimed = false
                val start = awaitHorizontalTouchSlopOrCancellation(down.id) { change, over ->
                    // On the chat: either way (right = home, left = members). On the home pane: only left.
                    val ok = if (from >= width - 1f) over < 0 else true
                    if (ok && !change.isConsumed) {
                        change.consume()
                        claimed = true
                        pos = at(change.position.x)
                        scope.launch { x.snapTo(pos) }
                    }
                } ?: return@awaitEachGesture
                if (!claimed) return@awaitEachGesture
                tracker.addPointerInputChange(start)
                lastX = start.position.x
                lastTime = start.uptimeMillis
                while (true) {
                    val ev = awaitPointerEvent()
                    val c = ev.changes.firstOrNull { it.id == start.id } ?: break
                    tracker.addPointerInputChange(c)
                    lastX = c.position.x
                    lastTime = c.uptimeMillis
                    pos = at(c.position.x)
                    if (!c.pressed) break
                    c.consume()
                    scope.launch { x.snapTo(pos) }
                }
                val dx = lastX - down.position.x
                val quick = lastTime - down.uptimeMillis < 300 && abs(dx) > flickDistance
                val velocity = tracker.calculateVelocity().x
                val i = anchors.indexOfFirst { it == from }
                val next = anchors.getOrNull(i + 1)
                val prev = anchors.getOrNull(i - 1)
                val target = when {
                    next != null && dx > 0 && (velocity > flickSpeed || quick) -> next
                    prev != null && dx < 0 && (velocity < -flickSpeed || quick) -> prev
                    next != null && pos - from > (next - from) * 0.2f -> next
                    prev != null && from - pos > (from - prev) * 0.2f -> prev
                    else -> from
                }
                if (target != from) haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
                // A quick swipe that the tracker missed still lands with some speed.
                val v = if (quick && abs(velocity) < flickSpeed) (target - pos).coerceIn(-1f, 1f) * flickSpeed * 4 else velocity
                scope.launch { x.animateTo(target, motion.standard(), initialVelocity = v) }
            }
        }

        Box(Modifier.fillMaxSize().then(drag)) {
            // Underneath: the home pane, or the members when the chat is pulled left.
            if (x.value >= 0f) {
                HomePane(
                    tab = tab,
                    onTab = { tab = it },
                    onOpenChannel = { id ->
                        session.actions.selectChannel(id)
                        showChat()
                    },
                    modifier = Modifier.graphicsLayer {
                        // A little parallax as the chat slides over it.
                        translationX = -(1f - (x.value / width).coerceIn(0f, 1f)) * width * 0.12f
                    },
                )
            } else if (channelId != null) {
                Box(Modifier.fillMaxSize()) {
                    Box(Modifier.width(with(LocalDensity.current) { membersWidth.toDp() }).fillMaxHeight().align(androidx.compose.ui.Alignment.CenterEnd)) {
                        MembersPane(channelId)
                    }
                }
            }
            if (channelId != null && x.value < width - 0.5f) {
                Box(
                    Modifier.fillMaxSize()
                        .offset { IntOffset(x.value.roundToInt(), 0) }
                        .shadow(if (x.value != 0f) 16.dp else 0.dp, RoundedCornerShape(if (x.value != 0f) 20.dp else 0.dp))
                        .clip(RoundedCornerShape(if (x.value != 0f) 20.dp else 0.dp))
                        .background(Linkord.colors.page),
                ) {
                    ChatScreen(
                        channelId = channelId,
                        onOpenHome = { showHome() },
                        onOpenMembers = { settle(-membersWidth) },
                        onOpenChannel = { id ->
                            session.actions.selectChannel(id)
                            showChat()
                        },
                    )
                }
            }
        }
    }
}
