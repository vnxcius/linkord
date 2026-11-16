package com.linkord.app.ui.chat

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.util.Base64
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.drag
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.media3.exoplayer.ExoPlayer
import com.linkord.app.session
import kotlinx.coroutines.launch
import com.linkord.app.ui.components.LIcon
import com.linkord.core.Attachment
import com.linkord.designsystem.Linkord
import com.linkord.designsystem.LinkordIcons
import kotlinx.coroutines.delay
import java.io.File
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.roundToInt

/** Bars in a voice message's waveform, one byte each (lib/voice-note.ts BARS). */
const val BARS = 48

/** Loudness 0-1 on a dB scale so quiet speech still shows (voice-note.ts loudness). */
fun loudness(rms: Double) = ((20 * log10(rms + 1e-9) + 55) / 50).coerceIn(0.0, 1.0)

/** Levels resampled to n bars (peak per bucket), the loudest bar full height (voice-note.ts packWaveform). */
fun packWaveform(levels: List<Double>, n: Int = BARS): ByteArray {
    val out = IntArray(n)
    if (levels.isEmpty()) return ByteArray(n)
    for (i in 0 until n) {
        val a = i * levels.size / n
        val b = max(a + 1, (i + 1) * levels.size / n)
        var peak = 0.0
        for (j in a until minOf(b, levels.size)) peak = max(peak, levels[j])
        out[i] = (peak * 255).roundToInt()
    }
    val top = max(out.max(), 1)
    return ByteArray(n) { ((out[it].toDouble() / top) * 255).roundToInt().toByte() }
}

fun decodeWaveform(b64: String?): List<Float> =
    runCatching { Base64.decode(b64 ?: "", Base64.DEFAULT).map { (it.toInt() and 0xFF) / 255f } }.getOrDefault(emptyList())

/**
 * Voice messages playing in the chat, like WhatsApp: one at a time (videos and songs stop, ChatPlayback), it keeps
 * playing while you scroll, each message remembers where you left it, the speed (1x/1.5x/2x) is kept, and when one
 * ends the voice message right after it starts. The chat stops it when you leave the conversation or the app.
 */
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
object VoicePlayback {
    const val SPEEDS_KEY = "voice"
    val SPEEDS = listOf(1f, 1.5f, 2f)
    /** ChatPlayback's id while a voice message plays. */
    private const val CHAT_ID = "voice-note"

    /** The voice message loaded (attachment id), and its state. */
    var id by mutableStateOf<String?>(null); private set
    var playing by mutableStateOf(false); private set
    var loading by mutableStateOf(false); private set
    var position by mutableLongStateOf(0L); private set
    var duration by mutableLongStateOf(0L); private set
    var speed by mutableFloatStateOf(1f); private set
    /** Where each message was left (ms): pausing one and playing another keeps your place in both. */
    val positions = mutableStateMapOf<String, Long>()
    /** Voice messages you've listened to (the mic turns from grey to the accent), kept on the phone. */
    val heard = mutableStateMapOf<String, Boolean>()

    private var player: ExoPlayer? = null
    private var session: com.linkord.app.data.Session? = null
    private var channelId: String? = null
    private var messageId: String? = null
    // The UI dispatcher carries a frame clock (withFrameMillis in tick); a plain MainScope has none and throws.
    private val scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.SupervisorJob() + androidx.compose.ui.platform.AndroidUiDispatcher.Main)
    private var ticker: kotlinx.coroutines.Job? = null

    private fun init(s: com.linkord.app.data.Session) {
        if (session != null) return
        session = s
        speed = s.prefs.voiceSpeed.takeIf { it in SPEEDS } ?: 1f
        s.prefs.heardVoice.forEach { heard[it] = true }
    }

    private fun player(s: com.linkord.app.data.Session): ExoPlayer = player ?: ExoPlayer.Builder(s.context)
        .setMediaSourceFactory(androidx.media3.exoplayer.source.DefaultMediaSourceFactory(androidx.media3.datasource.DefaultDataSource.Factory(s.context, androidx.media3.datasource.okhttp.OkHttpDataSource.Factory(s.http))))
        .setAudioAttributes(androidx.media3.common.AudioAttributes.Builder().setUsage(androidx.media3.common.C.USAGE_MEDIA).setContentType(androidx.media3.common.C.AUDIO_CONTENT_TYPE_SPEECH).build(), true)
        .build().also { p ->
            p.addListener(object : androidx.media3.common.Player.Listener {
                override fun onPlaybackStateChanged(state: Int) {
                    loading = state == androidx.media3.common.Player.STATE_BUFFERING && p.playWhenReady
                    if (p.duration > 0) duration = p.duration
                    if (state == androidx.media3.common.Player.STATE_ENDED) ended()
                }
                override fun onIsPlayingChanged(isPlaying: Boolean) {
                    playing = isPlaying
                    if (isPlaying) tick() else { ticker?.cancel(); position = p.currentPosition; id?.let { positions[it] = position } }
                }
                override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
                    loading = false; playing = false
                    session?.toast(com.linkord.core.t("Couldn't play this voice message."))
                }
            })
            player = p
        }

    /** Follows the playback every screen frame, so the waveform fills smoothly instead of in steps. */
    private fun tick() {
        ticker?.cancel()
        ticker = scope.launch {
            while (true) {
                val p = player ?: break
                androidx.compose.runtime.withFrameMillis { }
                position = p.currentPosition
                if (p.duration > 0) duration = p.duration
                // A video or a song started in the chat: this one stops (one thing plays at a time).
                if (ChatPlayback.current != CHAT_ID) { p.pause(); break }
            }
        }
    }

    /** Plays [a] (from where it was left), or pauses it if it's the one playing. */
    fun toggle(s: com.linkord.app.data.Session, a: Attachment, url: String, channelId: String?, messageId: String?) {
        init(s)
        val p = player(s)
        if (id == a.id) {
            if (p.isPlaying || (loading && p.playWhenReady)) { p.pause(); loading = false; return }
            if (p.playbackState == androidx.media3.common.Player.STATE_ENDED) p.seekTo(0)
            ChatPlayback.current = CHAT_ID
            p.play()
            return
        }
        // Another message: keep this one's place, then load the new one.
        id?.let { positions[it] = p.currentPosition }
        id = a.id
        this.channelId = channelId
        this.messageId = messageId
        position = positions[a.id] ?: 0L
        duration = ((a.durationSecs ?: 0.0) * 1000).toLong()
        p.setMediaItem(androidx.media3.common.MediaItem.fromUri(url), position)
        p.setPlaybackSpeed(speed)
        p.prepare()
        ChatPlayback.current = CHAT_ID
        p.play()
        loading = true
        if (heard[a.id] != true) {
            heard[a.id] = true
            s.prefs.heardVoice = (s.prefs.heardVoice + a.id).takeLast(1000)
        }
    }

    /** Jumps to [fraction] of [a]: the one loaded seeks; another is marked to start there. */
    fun seek(a: Attachment, fraction: Float, totalMs: Long) {
        val at = (fraction.coerceIn(0f, 1f) * totalMs).toLong()
        if (id == a.id) {
            player?.seekTo(at)
            position = at
        }
        positions[a.id] = at
    }

    fun cycleSpeed() {
        speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.size]
        player?.setPlaybackSpeed(speed)
        session?.prefs?.voiceSpeed = speed
    }

    /** Pauses, keeping the place (leaving the app). */
    fun pause() = player?.pause()

    /** Stops what plays in [channelId] (leaving that conversation). */
    fun stopIn(channelId: String) {
        if (this.channelId != channelId) return
        player?.pause()
    }

    private fun ended() {
        val done = id ?: return
        positions.remove(done)
        position = 0L
        player?.pause()
        player?.seekTo(0)
        // The voice message right after this one plays next, like WhatsApp.
        val s = session ?: return
        val list = channelId?.let { s.store.s.messages[it]?.list } ?: return
        val next = list.getOrNull(list.indexOfFirst { it.id == messageId } + 1) ?: return
        val a = next.attachments.firstOrNull { it.isVoiceNote } ?: return
        toggle(s, a, s.api.media(a.url) ?: a.url, channelId, next.id)
    }
}

private fun clock(ms: Long): String {
    val secs = (ms / 1000).toInt()
    return "%d:%02d".format(secs / 60, secs % 60)
}

/**
 * A voice message in the chat, like WhatsApp's: play/pause (a spinner while it loads), the waveform filling as it
 * plays (tap or drag it to jump, even before playing), its length (then the time played), and the sender's picture
 * with a mic that lights up once you've heard it; while it plays, the speed button (1x/1.5x/2x) takes the picture's place.
 */
@Composable
fun VoiceNotePlayer(a: Attachment, url: String, m: com.linkord.core.Message? = null, author: com.linkord.core.User? = m?.author) {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val session = ctx.session
    val c = Linkord.colors
    val v = VoicePlayback
    val bars = remember(a.waveform) { decodeWaveform(a.waveform) }
    val active = v.id == a.id
    val playing = active && v.playing
    val loading = active && v.loading
    val total = when {
        active && v.duration > 0 -> v.duration
        else -> ((a.durationSecs ?: 0.0) * 1000).toLong()
    }
    val at = if (active) v.position else v.positions[a.id] ?: 0L
    val progress = if (total > 0) (at.toFloat() / total).coerceIn(0f, 1f) else 0f
    val mine = author?.id != null && author.id == session.store.s.me?.id
    val heard = mine || v.heard[a.id] == true
    val toggle = { v.toggle(session, a, url, m?.channelId, m?.id) }

    Row(
        Modifier.padding(top = 4.dp).widthIn(max = 320.dp).fillMaxWidth().clip(RoundedCornerShape(22.dp)).background(c.raised).padding(start = 6.dp, end = 8.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(40.dp).clip(CircleShape).clickable(onClick = toggle), contentAlignment = Alignment.Center) {
            if (loading) androidx.compose.material3.CircularProgressIndicator(Modifier.size(22.dp), color = c.text, strokeWidth = 2.dp)
            else LIcon(if (playing) LinkordIcons.PauseSolid else LinkordIcons.PlaySolid, size = 24.dp, tint = c.text)
        }
        Spacer(Modifier.width(4.dp))
        Column(Modifier.weight(1f).padding(top = 8.dp)) {
            Waveform(bars, progress, Modifier.fillMaxWidth().height(30.dp), thumb = true) { f -> v.seek(a, f, total) }
            Text(
                clock(if (playing || at > 0) at else total),
                style = Linkord.type.mono.copy(fontSize = 11.sp), color = c.text3, modifier = Modifier.padding(top = 1.dp),
            )
        }
        Spacer(Modifier.width(10.dp))
        Box(Modifier.size(44.dp), contentAlignment = Alignment.Center) {
            if (playing || (active && at > 0)) {
                // The speed, in the picture's place while it plays.
                Box(
                    Modifier.clip(RoundedCornerShape(14.dp)).background(c.raised2).clickable { v.cycleSpeed() }.padding(horizontal = 9.dp, vertical = 5.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    val s = v.speed
                    Text((if (s % 1f == 0f) s.toInt().toString() else s.toString()) + "×", style = Linkord.type.bodyStrong.copy(fontSize = 13.sp), color = c.text)
                }
            } else {
                if (author != null) com.linkord.app.ui.components.Avatar(author, 40.dp)
                Box(
                    Modifier.align(if (author != null) Alignment.BottomStart else Alignment.Center).offset(x = if (author != null) (-4).dp else 0.dp, y = if (author != null) 2.dp else 0.dp)
                        .size(20.dp).clip(CircleShape).background(c.raised),
                    contentAlignment = Alignment.Center,
                ) { LIcon(LinkordIcons.MicSolid, size = 14.dp, tint = if (heard && !mine) c.brand else c.text3) }
            }
        }
    }
}

/**
 * The waveform: the played part in the accent, cut exactly where it is (through a bar, not bar by bar, so it moves
 * smoothly), and a thumb there; [onSeek] (0-1) makes it tappable and draggable.
 */
@Composable
fun Waveform(bars: List<Float>, progress: Float, modifier: Modifier, thumb: Boolean = false, onSeek: ((Float) -> Unit)? = null) {
    val c = Linkord.colors
    val seek = if (onSeek == null) Modifier else Modifier.pointerInput(onSeek) {
        awaitEachGesture {
            val down = awaitFirstDown()
            down.consume()
            onSeek(down.position.x / size.width)
            // Drag to scrub (it also keeps the chat's swipe-to-reply from starting).
            drag(down.id) { change -> change.consume(); onSeek(change.position.x / size.width) }
        }
    }
    Canvas(modifier.then(seek)) {
        val list = bars.ifEmpty { List(BARS) { 0.15f } }
        val step = size.width / list.size
        val w = (step * 0.55f).coerceAtMost(3.dp.toPx())
        val minH = 3.dp.toPx()
        fun bars(color: androidx.compose.ui.graphics.Color) = list.forEachIndexed { i, value ->
            val h = max(size.height * value, minH)
            drawRoundRect(color, topLeft = Offset(i * step + (step - w) / 2, (size.height - h) / 2), size = Size(w, h), cornerRadius = CornerRadius(w / 2))
        }
        val x = progress.coerceIn(0f, 1f) * size.width
        clipRect(left = x) { bars(c.text3.copy(alpha = 0.7f)) }
        if (x > 0f) clipRect(right = x) { bars(c.brand) }
        if (thumb) drawCircle(if (progress > 0f) c.brand else c.text2, 6.dp.toPx(), Offset(progress.coerceIn(0f, 1f) * size.width, size.height / 2))
    }
}
