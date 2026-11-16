package com.linkord.app.ui

import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.unit.dp
import com.linkord.designsystem.Linkord
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** Screens that open over the home pane and the chat. */
sealed interface Screen {
    data class Profile(val userId: String, val guildId: String?) : Screen
    data object Settings : Screen
    data object Sessions : Screen
    data object Appearance : Screen
    data object EditProfile : Screen
    data object Account : Screen
    data object VoiceSettings : Screen
    data object NotificationLevels : Screen
    data object Blocked : Screen
    data object Kass : Screen
    data object SharedClips : Screen
    data object Stats : Screen
    data class ServerSettings(val guildId: String) : Screen
    data class Roles(val guildId: String) : Screen
    /** Drag to reorder a server's channels and categories. */
    data class ChannelOrder(val guildId: String) : Screen
    data class RoleEdit(val guildId: String, val roleId: String) : Screen
    data class ChannelPermissions(val channelId: String) : Screen
    data class Image(val url: String, val name: String) : Screen
    /** [startMs]: where to pick up (fullscreen from a chat video that was already playing). */
    data class Video(val url: String, val name: String, val startMs: Long = 0) : Screen
    data class Pins(val channelId: String) : Screen
    data class Search(val channelId: String) : Screen
    data class Call(val channelId: String) : Screen
    data class Members(val channelId: String) : Screen
    data object AddFriend : Screen
    data class JoinServer(val code: String = "") : Screen
}

/** A small back stack. Predictive back peels the top screen off as the gesture moves; letting go pops it. */
class Navigator {
    val stack = mutableStateListOf<Screen>()
    /** Opens a channel's chat in the home shell (set by HomeShell). */
    var openChat: (String) -> Unit = {}
    /** Shows the home pane's server list (set by HomeShell). */
    var openHome: () -> Unit = {}
    fun push(s: Screen) {
        stack += s
    }
    fun pop() {
        if (stack.isNotEmpty()) stack.removeAt(stack.lastIndex)
    }
    fun replaceTop(s: Screen) {
        pop()
        push(s)
    }
}

val LocalNav = compositionLocalOf { Navigator() }

/** Draws the stack over [base]: each screen slides in from the right and follows the back gesture out. */
@Composable
fun ScreenStack(nav: Navigator, base: @Composable () -> Unit, screen: @Composable (Screen) -> Unit) {
    val holder = rememberSaveableStateHolder()
    val width = with(LocalDensity.current) { LocalConfiguration.current.screenWidthDp.dp.toPx() }
    val motion = Linkord.motion
    Box(Modifier.fillMaxSize()) {
        base()
        nav.stack.forEachIndexed { i, s ->
            key(s, i) {
                val x = remember { Animatable(width) }
                val scope = rememberCoroutineScope()
                val top = i == nav.stack.lastIndex
                LaunchedEffect(Unit) { x.animateTo(0f, motion.standard()) }
                PredictiveBackHandler(enabled = top) { progress ->
                    try {
                        progress.collect { e -> x.snapTo(width * e.progress * 0.9f) }
                        x.animateTo(width, motion.quick())
                        nav.pop()
                        holder.removeState(s.toString())
                    } catch (e: CancellationException) {
                        scope.launch { x.animateTo(0f, motion.standard()) }
                        throw e
                    }
                }
                // Profiles also close with a swipe to the right (a flick, or past a third of the screen).
                val swipe = if (top && s is Screen.Profile) Modifier.pointerInput(s) {
                    var started = 0L
                    detectHorizontalDragGestures(
                        onDragStart = { started = System.currentTimeMillis() },
                        onDragEnd = {
                            val quick = System.currentTimeMillis() - started < 300 && x.value > 40.dp.toPx()
                            scope.launch {
                                if (quick || x.value > width / 3) {
                                    x.animateTo(width, motion.quick())
                                    nav.pop()
                                    holder.removeState(s.toString())
                                } else x.animateTo(0f, motion.standard())
                            }
                        },
                        onDragCancel = { scope.launch { x.animateTo(0f, motion.standard()) } },
                    ) { change, dx ->
                        change.consume()
                        scope.launch { x.snapTo((x.value + dx).coerceAtLeast(0f)) }
                    }
                } else Modifier
                Box(
                    Modifier.fillMaxSize()
                        .then(swipe)
                        .graphicsLayer {
                            translationX = x.value
                            val p = (x.value / width).coerceIn(0f, 1f)
                            scaleX = 1f - p * 0.06f
                            scaleY = 1f - p * 0.06f
                        }
                        .clip(RoundedCornerShape(if (x.value > 0f) 24.dp else 0.dp))
                        .background(Linkord.colors.page),
                ) { holder.SaveableStateProvider(s.toString()) { screen(s) } }
            }
        }
    }
}
