package com.linkord.voice

import android.media.MediaCodec
import android.media.MediaFormat
import android.view.Surface
import java.util.concurrent.ConcurrentHashMap

/**
 * Cameras and streams we watch: frames from the media socket (voice.rs: [flags u8][seq u16 BE][codec on keyframes]
 * [frame], flag bit 0 = keyframe) decoded by MediaCodec straight onto the tile's Surface. Senders use H.264 (Annex B)
 * or, from browsers, VP9/VP8. A gap in the sequence drops frames until the next keyframe, which we ask for.
 */
class VideoReceiver(private val requestKeyframe: (userId: String, source: String) -> Unit) {
    private class Stream(val surface: Surface) {
        var codec: MediaCodec? = null
        var mime: String? = null
        var lastSeq = -1
        var waitingKey = true
        var pts = 0L
    }

    private val streams = ConcurrentHashMap<String, Stream>()

    /** A tile shows [userId]'s [source] ("camera" | "screen") on [surface]; a keyframe is asked for at once. */
    fun attach(userId: String, source: String, surface: Surface) {
        streams.put("$userId:$source", Stream(surface))?.release()
        requestKeyframe(userId, source)
    }

    fun detach(userId: String, source: String) {
        streams.remove("$userId:$source")?.release()
    }

    fun clear() {
        streams.values.forEach { it.release() }
        streams.clear()
    }

    private fun Stream.release() {
        runCatching { codec?.stop() }
        runCatching { codec?.release() }
        codec = null
    }

    fun onFrame(userId: String, source: String, data: ByteArray) {
        val s = streams["$userId:$source"] ?: return
        if (data.size < 3) return
        val key = data[0].toInt() and 1 == 1
        val seq = ((data[1].toInt() and 0xFF) shl 8) or (data[2].toInt() and 0xFF)
        var off = 3
        var codecName: String? = null
        if (key) {
            val n = data[3].toInt() and 0xFF
            codecName = String(data, 4, n, Charsets.US_ASCII)
            off = 4 + n
        }
        synchronized(s) {
            val gap = s.lastSeq >= 0 && seq != ((s.lastSeq + 1) and 0xFFFF)
            s.lastSeq = seq
            if (gap && !key) {
                if (!s.waitingKey) requestKeyframe(userId, source)
                s.waitingKey = true
            }
            if (key) s.waitingKey = false
            if (s.waitingKey) return
            if (key && codecName != null) {
                val mime = mimeOf(codecName) ?: return
                if (s.codec == null || s.mime != mime) {
                    s.release()
                    s.codec = runCatching {
                        MediaCodec.createDecoderByType(mime).apply {
                            val fmt = MediaFormat.createVideoFormat(mime, 1920, 1080)
                            fmt.setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
                            configure(fmt, s.surface, null, 0)
                            start()
                        }
                    }.getOrNull()
                    s.mime = mime
                }
            }
            val codec = s.codec ?: return
            runCatching {
                val i = codec.dequeueInputBuffer(10_000)
                if (i >= 0) {
                    val buf = codec.getInputBuffer(i)!!
                    buf.clear()
                    buf.put(data, off, data.size - off)
                    codec.queueInputBuffer(i, 0, data.size - off, s.pts, if (key) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0)
                    s.pts += 16_666
                }
                // Render whatever is decoded: newest frames win, nothing waits.
                val info = MediaCodec.BufferInfo()
                while (true) {
                    val o = codec.dequeueOutputBuffer(info, 0)
                    if (o >= 0) codec.releaseOutputBuffer(o, true) else if (o == MediaCodec.INFO_TRY_AGAIN_LATER) break
                }
            }.onFailure {
                // A decoder that broke (bad frame, surface gone): start over at the next keyframe.
                s.release()
                s.waitingKey = true
                requestKeyframe(userId, source)
            }
        }
    }

    companion object {
        fun mimeOf(codec: String): String? = when {
            codec.startsWith("avc1") || codec.startsWith("avc3") -> MediaFormat.MIMETYPE_VIDEO_AVC
            codec.startsWith("vp09") || codec == "vp9" -> MediaFormat.MIMETYPE_VIDEO_VP9
            codec.startsWith("vp8") -> MediaFormat.MIMETYPE_VIDEO_VP8
            codec.startsWith("hvc1") || codec.startsWith("hev1") -> MediaFormat.MIMETYPE_VIDEO_HEVC
            codec.startsWith("av01") -> MediaFormat.MIMETYPE_VIDEO_AV1
            else -> null
        }
    }
}
