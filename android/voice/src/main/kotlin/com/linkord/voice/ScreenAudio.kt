package com.linkord.voice

import android.annotation.SuppressLint
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.projection.MediaProjection
import android.os.Process

/**
 * A screen share's sound: what other apps play (AudioPlaybackCapture; apps can refuse it, games often do), as stereo
 * Opus at music quality, kind 4. Silence isn't sent. Our own call audio is a voice-communication usage, which
 * playback capture never includes, so viewers don't hear themselves.
 */
class ScreenAudio(private val projection: MediaProjection, private val send: (ByteArray) -> Unit) {
    @Volatile private var running = false
    private var thread: Thread? = null

    @SuppressLint("MissingPermission")
    fun start() {
        val config = AudioPlaybackCaptureConfiguration.Builder(projection)
            .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
            .addMatchingUsage(AudioAttributes.USAGE_GAME)
            .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
            .build()
        val rec = AudioRecord.Builder()
            .setAudioPlaybackCaptureConfig(config)
            .setAudioFormat(AudioFormat.Builder().setSampleRate(RATE).setChannelMask(AudioFormat.CHANNEL_IN_STEREO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
            .setBufferSizeInBytes(FRAME * 4 * 4)
            .build()
        val enc = Opus.encoderCreate(RATE, 2, 128_000, 8)
        running = true
        thread = Thread({
            Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)
            rec.startRecording()
            val pcm = ShortArray(FRAME * 2)
            val out = ByteArray(4000)
            while (running) {
                var got = 0
                while (got < pcm.size && running) {
                    val n = rec.read(pcm, got, pcm.size - got)
                    if (n <= 0) break
                    got += n
                }
                if (got < pcm.size || VoiceGate.rms(pcm) < 0.0002) continue
                val n = Opus.encode(enc, pcm, FRAME, out)
                if (n > 0) send(out.copyOf(n))
            }
            rec.stop()
            rec.release()
            Opus.encoderDestroy(enc)
        }, "linkord-screen-audio").also { it.start() }
    }

    fun stop() {
        running = false
        thread?.join(500)
    }
}
