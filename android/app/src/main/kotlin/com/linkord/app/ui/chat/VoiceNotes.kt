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
 * Records a voice message as Ogg/Opus, which the server keeps as it is (it only rewrites browsers' WebM). Levels are
 * read every 100 ms for the waveform.
 */
/** A voice message in the chat: play/pause, its waveform filling as it plays, and the time. */
@Composable
fun VoiceNotePlayer(a: Attachment, url: String) {
    val c = Linkord.colors
    val bars = remember(a.waveform) { decodeWaveform(a.waveform) }
    var player by remember { mutableStateOf<MediaPlayer?>(null) }
    var playing by remember { mutableStateOf(false) }
    var progress by remember { mutableFloatStateOf(0f) }
    DisposableEffect(url) { onDispose { player?.release() } }
    LaunchedEffect(playing) {
        while (playing) {
            player?.let { p -> if (p.duration > 0) progress = p.currentPosition.toFloat() / p.duration }
            delay(50)
        }
    }
    fun toggle() {
        val p = player
        when {
            p == null -> {
                val mp = MediaPlayer()
                mp.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                mp.setDataSource(url)
                mp.setOnPreparedListener { it.start(); playing = true }
                mp.setOnCompletionListener { playing = false; progress = 0f }
                mp.prepareAsync()
                player = mp
            }
            p.isPlaying -> { p.pause(); playing = false }
            else -> { p.start(); playing = true }
        }
    }
    Row(
        Modifier.padding(top = 4.dp).widthIn(max = 300.dp).clip(RoundedCornerShape(20.dp)).background(c.raised).padding(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(36.dp).clip(RoundedCornerShape(18.dp)).background(c.brand).clickable(onClick = ::toggle), contentAlignment = Alignment.Center) {
            LIcon(if (playing) LinkordIcons.Pause else LinkordIcons.Play, size = 18.dp, tint = c.onBrand)
        }
        Spacer(Modifier.width(10.dp))
        Waveform(bars, progress, Modifier.width(170.dp).height(28.dp))
        Spacer(Modifier.width(10.dp))
        val secs = ((a.durationSecs ?: 0.0) * (if (playing || progress > 0f) progress.toDouble() else 1.0)).toInt()
        Text("%d:%02d".format(secs / 60, secs % 60), style = Linkord.type.mono, modifier = Modifier.padding(end = 8.dp))
    }
}

@Composable
fun Waveform(bars: List<Float>, progress: Float, modifier: Modifier) {
    val c = Linkord.colors
    Canvas(modifier) {
        if (bars.isEmpty()) return@Canvas
        val step = size.width / bars.size
        val w = step * 0.55f
        bars.forEachIndexed { i, v ->
            val h = max(size.height * v, 3f)
            val played = (i + 0.5f) / bars.size <= progress
            drawRoundRect(
                if (played) c.brand else c.text3,
                topLeft = Offset(i * step + (step - w) / 2, (size.height - h) / 2),
                size = Size(w, h),
                cornerRadius = CornerRadius(w / 2),
            )
        }
    }
}
