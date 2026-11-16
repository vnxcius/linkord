package com.linkord.app.ui.chat

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.util.Base64
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.systemGestureExclusion
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.linkord.app.ui.components.LIcon
import com.linkord.core.t
import com.linkord.designsystem.Linkord
import com.linkord.designsystem.LinkordIcons
import com.linkord.voice.OggOpus
import com.linkord.voice.Opus
import kotlinx.coroutines.delay
import java.io.File
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * A voice message being recorded: the mic through our own Opus encoder (48 kHz mono, 20 ms packets) kept in memory,
 * so a paused recording can be played back (written out as Ogg Opus on demand, [OggOpus]) and then continued.
 */
class VoiceNoteRecorder(private val context: Context) {
    private val packets = ArrayList<ByteArray>()
    /** Peak level per 100 ms (0..1), for the live waveform and the one sent with the message. */
    val levels = ArrayList<Double>()
    @Volatile var paused = false
        private set
    @Volatile private var running = true
    private var record: AudioRecord? = null
    private var thread: Thread? = null
    private val encoder = Opus.encoderCreate(48_000, 1, 32_000, 8)

    val seconds: Double get() = synchronized(packets) { packets.size * 0.02 }

    @SuppressLint("MissingPermission")
    fun start() {
        val min = AudioRecord.getMinBufferSize(48_000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val r = AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, 48_000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, max(min, 960 * 2 * 8))
        check(r.state == AudioRecord.STATE_INITIALIZED) { "mic unavailable" }
        r.startRecording()
        record = r
        paused = false
        thread = Thread({ loop(r) }, "linkord-voice-note").also { it.start() }
    }

    private fun loop(r: AudioRecord) {
        val pcm = ShortArray(960)
        val out = ByteArray(1500)
        var peak = 0
        var frames = 0
        while (running && !paused) {
            var got = 0
            while (got < 960 && running && !paused) {
                val n = r.read(pcm, got, 960 - got)
                if (n <= 0) return
                got += n
            }
            if (got < 960) break
            for (s in pcm) peak = max(peak, abs(s.toInt()))
            val len = Opus.encode(encoder, pcm, 960, out)
            if (len > 0) synchronized(packets) { packets += out.copyOf(len) }
            if (++frames == 5) {
                synchronized(levels) { levels += loudness(peak / 32768.0) }
                peak = 0
                frames = 0
            }
        }
    }

    private fun stopMic() {
        paused = true
        thread?.join(500)
        thread = null
        record?.let { runCatching { it.stop() }; it.release() }
        record = null
    }

    fun pause() = stopMic()

    fun resume() {
        if (running && paused) start()
    }

    fun levelsNow(): List<Double> = synchronized(levels) { levels.toList() }

    /** Writes what's been recorded so far as Ogg Opus. */
    fun writeTo(file: File) {
        val copy = synchronized(packets) { packets.toList() }
        file.outputStream().buffered().use { OggOpus.write(it, copy) }
    }

    /** Stops and returns the file, its length and waveform; null if it's too short to send. */
    fun finish(): Triple<File, Double, String>? {
        stopMic()
        running = false
        val secs = seconds
        Opus.encoderDestroy(encoder)
        if (secs < 1.0) return null
        val file = File(context.cacheDir, "voice-${System.nanoTime()}.ogg")
        writeTo(file)
        return Triple(file, (secs * 100).roundToInt() / 100.0, Base64.encodeToString(packWaveform(levelsNow()), Base64.NO_WRAP))
    }

    fun cancel() {
        stopMic()
        if (running) {
            running = false
            Opus.encoderDestroy(encoder)
        }
    }
}

enum class RecMode { Idle, Holding, Locked, Cancelling }

/** The composer's voice message state (WhatsApp's flow: hold to record, slide left to cancel, slide up to lock). */
@Stable
class VoiceNoteState {
    var recorder by mutableStateOf<VoiceNoteRecorder?>(null)
    var mode by mutableStateOf(RecMode.Idle)
    var dragX by mutableFloatStateOf(0f)
    var dragY by mutableFloatStateOf(0f)
    var paused by mutableStateOf(false)
    /** "Hold to record, release to send" after a tap. */
    var hint by mutableIntStateOf(0)
    var tick by mutableIntStateOf(0)

    fun cancel() {
        recorder?.cancel()
        recorder = null
        paused = false
        mode = RecMode.Idle
    }
}

private val CANCEL = 120.dp
private val LOCK = 90.dp

/**
 * The mic button. Press: recording starts at once. Release: sent. Slide left past [CANCEL]: thrown away. Slide up past
 * [LOCK]: keeps recording without the finger (the composer then shows delete / pause / send). A quick tap only shows
 * the hint, like WhatsApp.
 */
@Composable
fun HoldToRecordMic(
    vn: VoiceNoteState,
    hasPermission: () -> Boolean,
    askPermission: () -> Unit,
    start: () -> Boolean,
    send: () -> Unit,
) {
    val c = Linkord.colors
    val haptics = LocalHapticFeedback.current
    val density = LocalDensity.current
    val cancelPx = with(density) { CANCEL.toPx() }
    val lockPx = with(density) { LOCK.toPx() }
    val slop = with(density) { 8.dp.toPx() }
    val holding = vn.mode == RecMode.Holding
    val scale by animateFloatAsState(if (holding) 1.7f else 1f, tween(160), label = "mic")

    // The mic sits at the screen's edge, where a swipe left would be Android's back gesture: sliding to cancel must
    // reach us instead.
    Box(Modifier.size(44.dp).systemGestureExclusion(), contentAlignment = Alignment.Center) {
        // The lock above the finger, rising as it slides up.
        if (holding) {
            val up = (-vn.dragY / lockPx).coerceIn(0f, 1f)
            val lift = with(density) { (110.dp + 24.dp * up).roundToPx() }
            androidx.compose.ui.window.Popup(Alignment.TopCenter, androidx.compose.ui.unit.IntOffset(0, -lift)) {
                Column(
                    Modifier.clip(RoundedCornerShape(20.dp)).background(c.raised2).padding(horizontal = 10.dp, vertical = 10.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    LIcon(LinkordIcons.Lock, size = 18.dp, tint = if (up > 0.9f) c.text else c.text2)
                    LIcon(LinkordIcons.ChevronUpIcon, size = 14.dp, tint = c.text3, modifier = Modifier.graphicsLayer { translationY = -up * 6f })
                }
            }
        }
        if (vn.hint > 0) {
            androidx.compose.ui.window.Popup(Alignment.TopEnd, androidx.compose.ui.unit.IntOffset(0, with(density) { -52.dp.roundToPx() })) {
                Text(
                    t("Hold to record, release to send"), style = Linkord.type.small, color = c.text,
                    modifier = Modifier.clip(RoundedCornerShape(10.dp)).background(c.raised2).padding(horizontal = 12.dp, vertical = 8.dp),
                )
            }
            LaunchedEffect(vn.hint) {
                delay(2200)
                vn.hint = 0
            }
        }
        Box(
            // The gesture reads positions before the button moves and grows (graphicsLayer after it), or the
            // distance would shrink as the button follows the finger.
            Modifier.requiredSize(44.dp)
                .pointerInput(Unit) {
                    awaitEachGesture {
                        val down = awaitFirstDown()
                        down.consume()
                        if (!hasPermission()) {
                            askPermission()
                            return@awaitEachGesture
                        }
                        if (!start()) return@awaitEachGesture
                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                        val t0 = down.uptimeMillis
                        var axis = 0 // 0 undecided, 1 sideways, 2 up
                        var outcome = 0 // 0 released, 1 cancelled, 2 locked
                        var last = t0
                        while (true) {
                            val ev = awaitPointerEvent()
                            val ch = ev.changes.firstOrNull { it.id == down.id } ?: break
                            last = ch.uptimeMillis
                            if (!ch.pressed) break
                            ch.consume()
                            val d = ch.position - down.position
                            if (axis == 0 && (abs(d.x) > slop || abs(d.y) > slop)) axis = if (abs(d.x) >= abs(d.y)) 1 else 2
                            vn.dragX = if (axis == 1) d.x.coerceAtMost(0f) else 0f
                            vn.dragY = if (axis == 2) d.y.coerceAtMost(0f) else 0f
                            if (vn.dragX < -cancelPx) {
                                outcome = 1
                                break
                            }
                            if (vn.dragY < -lockPx) {
                                outcome = 2
                                break
                            }
                        }
                        vn.dragX = 0f
                        vn.dragY = 0f
                        // Cancelled or locked with the finger still down: the rest of this touch stays ours, so the
                        // chat panel doesn't take it as a swipe.
                        val stillDown = outcome != 0
                        when {
                            outcome == 1 -> {
                                haptics.performHapticFeedback(HapticFeedbackType.Reject)
                                vn.recorder?.cancel()
                                vn.recorder = null
                                vn.mode = RecMode.Cancelling
                            }
                            outcome == 2 -> {
                                haptics.performHapticFeedback(HapticFeedbackType.Confirm)
                                vn.mode = RecMode.Locked
                            }
                            last - t0 < 400 -> {
                                vn.cancel()
                                vn.hint++
                            }
                            else -> send()
                        }
                        if (stillDown) while (true) {
                            val ev = awaitPointerEvent()
                            ev.changes.forEach { it.consume() }
                            if (ev.changes.none { it.pressed }) break
                        }
                    }
                }
                .graphicsLayer {
                    translationX = vn.dragX
                    translationY = vn.dragY
                    scaleX = scale
                    scaleY = scale
                }
                .clip(CircleShape)
                .background(if (holding) c.brand else Color0),
            contentAlignment = Alignment.Center,
        ) {
            LIcon(if (holding) LinkordIcons.MicSolid else LinkordIcons.Mic, size = if (holding) 20.dp else 22.dp, tint = if (holding) c.onBrand else c.text2)
        }
    }
}

private val Color0 = androidx.compose.ui.graphics.Color.Transparent

private fun clock(secs: Double): String {
    val s = secs.toInt()
    return "%d:%02d".format(s / 60, s % 60)
}

/** Keeps the screen on and the timer moving while a recording is open. */
@Composable
fun RecordingTicker(vn: VoiceNoteState) {
    val view = LocalView.current
    val active = vn.mode == RecMode.Holding || vn.mode == RecMode.Locked
    DisposableEffect(active) {
        view.keepScreenOn = active
        onDispose { view.keepScreenOn = false }
    }
    LaunchedEffect(active, vn.paused) {
        while (active && !vn.paused) {
            vn.tick++
            // Twenty minutes at most, like the web app: then it pauses.
            if ((vn.recorder?.seconds ?: 0.0) >= 1200) {
                vn.recorder?.pause()
                vn.paused = true
            }
            delay(100)
        }
    }
    LaunchedEffect(vn.mode) {
        if (vn.mode == RecMode.Cancelling) {
            delay(650)
            if (vn.mode == RecMode.Cancelling) vn.mode = RecMode.Idle
        }
    }
}

/** While the finger holds the mic: blinking dot, time, and "slide to cancel" that follows the finger. */
@Composable
fun HoldingStrip(vn: VoiceNoteState, modifier: Modifier) {
    val c = Linkord.colors
    val blink = rememberInfiniteTransition(label = "rec")
    val alpha by blink.animateFloat(1f, 0.2f, infiniteRepeatable(tween(600), RepeatMode.Reverse), label = "dot")
    val cancelPx = with(LocalDensity.current) { CANCEL.toPx() }
    vn.tick
    Row(modifier.height(44.dp).padding(start = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        if (vn.mode == RecMode.Cancelling) {
            val wobble = rememberInfiniteTransition(label = "bin")
            val r by wobble.animateFloat(-14f, 14f, infiniteRepeatable(tween(110), RepeatMode.Reverse), label = "r")
            LIcon(LinkordIcons.Trash, size = 22.dp, tint = c.danger, modifier = Modifier.graphicsLayer { rotationZ = r })
            return@Row
        }
        LIcon(LinkordIcons.MicSolid, size = 20.dp, tint = c.danger, modifier = Modifier.graphicsLayer { this.alpha = alpha })
        Spacer(Modifier.width(10.dp))
        Text(clock(vn.recorder?.seconds ?: 0.0), style = Linkord.type.mono.copy(color = c.text))
        Spacer(Modifier.weight(1f))
        val p = (-vn.dragX / cancelPx).coerceIn(0f, 1f)
        Row(
            Modifier.graphicsLayer {
                translationX = vn.dragX * 0.6f
                this.alpha = 1f - p
            },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            LIcon(LinkordIcons.ChevronRight, size = 16.dp, tint = c.text3, modifier = Modifier.graphicsLayer { rotationZ = 180f })
            Text(t("Slide to cancel"), style = Linkord.type.small, color = c.text3)
        }
        Spacer(Modifier.width(20.dp))
    }
}

/** Locked: hands free. Live waveform and time; delete, pause (then play back what's there) or send. */
@Composable
fun LockedRecorder(vn: VoiceNoteState, send: () -> Unit) {
    val c = Linkord.colors
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val haptics = LocalHapticFeedback.current
    val rec = vn.recorder ?: return
    vn.tick
    // Playing back a paused recording.
    var player by remember { mutableStateOf<MediaPlayer?>(null) }
    var progress by remember { mutableFloatStateOf(0f) }
    fun stopPreview() {
        player?.release()
        player = null
        progress = 0f
    }
    DisposableEffect(Unit) { onDispose { player?.release() } }
    LaunchedEffect(player) {
        val p = player ?: return@LaunchedEffect
        while (player === p) {
            runCatching { progress = if (p.duration > 0) p.currentPosition.toFloat() / p.duration else 0f }
            delay(50)
        }
    }

    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp).clip(RoundedCornerShape(18.dp)).background(c.raised).padding(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (vn.paused) {
                Box(Modifier.size(32.dp).clip(CircleShape).clickable {
                    val p = player
                    if (p != null && p.isPlaying) p.pause()
                    else if (p != null) p.start()
                    else runCatching {
                        val f = File(ctx.cacheDir, "voice-preview.ogg")
                        rec.writeTo(f)
                        player = MediaPlayer().apply {
                            setDataSource(f.path)
                            setOnCompletionListener { stopPreview() }
                            prepare()
                            start()
                        }
                    }
                }, contentAlignment = Alignment.Center) {
                    LIcon(if (player?.isPlaying == true) LinkordIcons.PauseSolid else LinkordIcons.PlaySolid, size = 20.dp, tint = c.text)
                }
            } else {
                val blink = rememberInfiniteTransition(label = "rec")
                val alpha by blink.animateFloat(1f, 0.2f, infiniteRepeatable(tween(600), RepeatMode.Reverse), label = "dot")
                Box(Modifier.size(32.dp), contentAlignment = Alignment.Center) {
                    Box(Modifier.size(10.dp).graphicsLayer { this.alpha = alpha }.clip(CircleShape).background(c.danger))
                }
            }
            Spacer(Modifier.width(8.dp))
            LiveWave(rec.levelsNow(), if (vn.paused) progress else -1f, Modifier.weight(1f).height(28.dp))
            Spacer(Modifier.width(10.dp))
            Text(clock(rec.seconds), style = Linkord.type.mono.copy(color = c.text))
        }
        Spacer(Modifier.height(10.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(44.dp).clip(CircleShape).clickable {
                haptics.performHapticFeedback(HapticFeedbackType.Reject)
                stopPreview()
                vn.cancel()
            }, contentAlignment = Alignment.Center) { LIcon(LinkordIcons.Trash, size = 22.dp, tint = c.text2) }
            Spacer(Modifier.weight(1f))
            Box(Modifier.size(44.dp).clip(CircleShape).clickable {
                if (vn.paused) {
                    stopPreview()
                    runCatching { rec.resume() }.onSuccess { vn.paused = false }
                } else {
                    rec.pause()
                    vn.paused = true
                }
            }, contentAlignment = Alignment.Center) {
                LIcon(if (vn.paused) LinkordIcons.MicSolid else LinkordIcons.PauseSolid, size = 22.dp, tint = c.danger)
            }
            Spacer(Modifier.weight(1f))
            Box(Modifier.size(44.dp).clip(CircleShape).background(c.brand).clickable {
                stopPreview()
                send()
            }, contentAlignment = Alignment.Center) { LIcon(LinkordIcons.Send, size = 20.dp, tint = c.onBrand) }
        }
    }
}

/**
 * Bars of the recording's level. While recording ([progress] < 0) the newest are on the right and older ones scroll
 * off to the left; paused, the whole recording is squeezed into the width and fills as it plays back.
 */
@Composable
private fun LiveWave(levels: List<Double>, progress: Float, modifier: Modifier) {
    val c = Linkord.colors
    val barW: Dp = 3.dp
    val gap: Dp = 2.dp
    Canvas(modifier) {
        val step = (barW + gap).toPx()
        val fit = max(1, (size.width / step).toInt())
        val shown: List<Double> = if (progress >= 0f) {
            // Resample everything into the width.
            if (levels.isEmpty()) emptyList() else List(minOf(fit, levels.size)) { i ->
                val a = i * levels.size / minOf(fit, levels.size)
                val b = max(a + 1, (i + 1) * levels.size / minOf(fit, levels.size))
                levels.subList(a, minOf(b, levels.size)).max()
            }
        } else levels.takeLast(fit)
        val start = if (progress >= 0f) 0f else size.width - shown.size * step
        shown.forEachIndexed { i, l ->
            val h = max(3.dp.toPx(), (l * size.height).toFloat())
            val played = progress >= 0f && i.toFloat() / shown.size <= progress
            drawRoundRect(
                if (progress < 0f || played) c.text else c.text3,
                topLeft = Offset(start + i * step, (size.height - h) / 2),
                size = Size(barW.toPx(), h),
                cornerRadius = CornerRadius(barW.toPx() / 2),
            )
        }
    }
}
