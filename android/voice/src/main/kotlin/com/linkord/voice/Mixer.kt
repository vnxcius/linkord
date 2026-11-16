package com.linkord.voice

import kotlin.math.abs
import kotlin.math.sqrt
import kotlin.math.tanh

/**
 * Everyone you hear, mixed into one stereo stream (the web client's voice-worklets.ts Playback): each source starts
 * playing once 60 ms is buffered and never runs more than 300 ms behind (the oldest audio is dropped). Thread safe:
 * the socket thread pushes, the playback thread pulls 20 ms at a time.
 */
class Mixer {
    private class Source {
        val frames = ArrayDeque<ShortArray>()
        var primed = false
        var gain = 1f
    }

    private val sources = HashMap<String, Source>()
    /** Volumes by id, kept when a source goes away (someone leaving and coming back keeps their volume). */
    private val gains = HashMap<String, Float>()

    /** One decoded 20 ms frame, interleaved stereo (FRAME * 2 samples). */
    @Synchronized
    fun push(id: String, stereo: ShortArray) {
        val s = sources.getOrPut(id) { Source().also { it.gain = gains[id] ?: 1f } }
        s.frames.addLast(stereo)
        while (s.frames.size > MAX_FRAMES) s.frames.removeFirst()
    }

    @Synchronized
    fun setGain(id: String, gain: Float) {
        gains[id] = gain
        sources[id]?.gain = gain
    }

    @Synchronized
    fun remove(id: String) {
        sources.remove(id)
    }

    @Synchronized
    fun clear() {
        sources.clear()
    }

    private val acc = FloatArray(FRAME * 2)

    /** The next 20 ms of everyone together, into [out] (FRAME * 2 interleaved stereo samples). */
    @Synchronized
    fun pull(out: ShortArray, muted: Boolean) {
        acc.fill(0f)
        val it = sources.values.iterator()
        while (it.hasNext()) {
            val s = it.next()
            if (!s.primed) {
                if (s.frames.size >= TARGET_FRAMES) s.primed = true else continue
            }
            val f = s.frames.removeFirstOrNull()
            if (f == null) {
                // Ran dry: wait for 60 ms again before playing it (a late packet beats a choppy one).
                s.primed = false
                continue
            }
            if (muted) continue
            val g = s.gain
            for (i in acc.indices) acc[i] += f[i] * g
        }
        for (i in acc.indices) out[i] = softClip(acc[i])
    }

    companion object {
        /** 60 ms buffered before a source plays. */
        const val TARGET_FRAMES = 3
        /** Never more than 300 ms behind. */
        const val MAX_FRAMES = 15

        /** Sums of loud voices stay below full scale without a hard edge. */
        fun softClip(v: Float): Short {
            val x = v / 32768f
            val y = if (abs(x) < 0.8f) x else (0.8f + 0.2f * tanh((abs(x) - 0.8f) / 0.2f)) * (if (x < 0) -1 else 1)
            return Math.round(y * 32768f).coerceIn(-32768, 32767).toShort()
        }
    }
}

/**
 * When to send our voice (voice-worker.ts onCapture without RNNoise): above a threshold that follows the room's
 * noise floor (4x it, between 0.006 and 0.08 RMS), held open 350 ms after the last loud frame so words don't get cut.
 */
class VoiceGate {
    var noiseFloor = 0.01
        private set
    private var gateUntil = 0L
    /** A fixed threshold (0..1 RMS) instead of following the room; null = automatic. */
    var manualThreshold: Double? = null

    fun threshold(): Double = manualThreshold ?: (noiseFloor * 4).coerceIn(0.006, 0.08)

    /** Whether this frame is sent; [level] is its RMS (0..1). */
    fun open(level: Double, now: Long): Boolean {
        noiseFloor = if (level < noiseFloor) noiseFloor * 0.9 + level * 0.1 else noiseFloor + (level - noiseFloor) * 0.002
        if (level > threshold()) gateUntil = now + HANGOVER_MS
        return now < gateUntil
    }

    companion object {
        const val HANGOVER_MS = 350L

        fun rms(pcm: ShortArray, n: Int = pcm.size): Double {
            var sum = 0.0
            for (i in 0 until n) {
                val v = pcm[i] / 32768.0
                sum += v * v
            }
            return sqrt(sum / n)
        }
    }
}
