package com.linkord.voice

import android.annotation.SuppressLint
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.os.Process
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.min

/** Where the call stands. */
sealed interface VoiceStatus {
    data object Idle : VoiceStatus
    data object Connecting : VoiceStatus
    data object Connected : VoiceStatus
    /** The connection dropped; the seat is kept on the server (v2) while we get it back. */
    data object Reconnecting : VoiceStatus
    /** Over for good: 4001 signed out, 4002 replaced, 4004 not allowed, 4006 seat taken, or gave up after a minute. */
    data class Closed(val code: Int) : VoiceStatus
}

/** Something the server told the call (voice-worker.ts posts). */
sealed interface VoiceEvent {
    /** A soundboard sound someone played: everyone plays it locally. */
    data class Sound(val userId: String, val sound: JSONObject) : VoiceEvent
    /** The server moved us (AFK channel, a moderator). */
    data class Move(val channelId: String?, val reason: String?) : VoiceEvent
}

/**
 * One voice call: the voice socket (server voice.rs; the web client's voice-worker.ts), our microphone through the
 * voice gate and Opus, and everyone else decoded into the [Mixer] and played. v2 protocol: a dropped connection is
 * retried for a minute without tearing anything down, and `leave` is said when leaving.
 */
class VoiceClient(private val http: OkHttpClient, private val scope: CoroutineScope) {
    private val _status = MutableStateFlow<VoiceStatus>(VoiceStatus.Idle)
    val status: StateFlow<VoiceStatus> = _status
    /** Who is speaking right now ("me" for us). */
    private val _speaking = MutableStateFlow<Set<String>>(emptySet())
    val speaking: StateFlow<Set<String>> = _speaking
    private val _ping = MutableStateFlow<Int?>(null)
    val ping: StateFlow<Int?> = _ping
    private val _events = MutableSharedFlow<VoiceEvent>(extraBufferCapacity = 16)
    val events: SharedFlow<VoiceEvent> = _events
    /** Our mic level and the gate's threshold (0..1 RMS), for the sensitivity meter. */
    private val _level = MutableStateFlow(0.0 to 0.0)
    val level: StateFlow<Pair<Double, Double>> = _level

    @Volatile var muted = false
        private set
    /** Push to talk instead of the voice gate, and whether the button is held now. */
    @Volatile var pushToTalk = false
    @Volatile var talking = false
    @Volatile var deafened = false
        private set
    val mixer = Mixer()
    val gate = VoiceGate()

    private var url = ""
    private var token = ""
    var channelId: String? = null
        private set
    @Volatile private var ws: WebSocket? = null
    /** The media socket: cameras, streams and stream audio, apart from voice so video never delays it. */
    @Volatile private var media: WebSocket? = null
    val video = VideoReceiver { user, source -> sendJson(JSONObject().put("op", "request_keyframe").put("user_id", user).put("source", source)) }
    /** Streams we watch (the server only forwards a screen share to its viewers). */
    private val watching = ConcurrentHashMap.newKeySet<String>()
    @Volatile private var leaving = false
    private var lostAt = 0L
    private var attempt = 0
    @Volatile private var lastHeardAt = 0L
    private var pingJob: Job? = null
    private var speakingJob: Job? = null

    private var encoder = 0L
    private val decoders = ConcurrentHashMap<String, Long>()
    private val lastHeard = ConcurrentHashMap<String, Long>()
    @Volatile private var selfSpeaking = false

    private var capture: Thread? = null
    private var playback: Thread? = null
    @Volatile private var running = false

    /** Joins [channelId] on the server at [baseUrl]. The caller has the RECORD_AUDIO permission. */
    fun connect(baseUrl: String, token: String, channelId: String, muted: Boolean, deafened: Boolean) {
        if (this.channelId != null) leave()
        url = baseUrl.replaceFirst(Regex("^http"), "ws") + "/api/voice/connect"
        this.token = token
        this.channelId = channelId
        this.muted = muted
        this.deafened = deafened
        leaving = false
        lostAt = 0
        attempt = 0
        _status.value = VoiceStatus.Connecting
        encoder = Opus.encoderCreate(RATE, 1, 40_000, 8)
        startAudio()
        startSpeakingTimer()
        openVoice()
    }

    /** Leaves the call: tells the server (so the seat goes now), then stops everything. */
    fun leave() {
        leaving = true
        ws?.let {
            it.send("""{"op":"leave"}""")
            it.close(1000, null)
        }
        ws = null
        media?.close(1000, null)
        media = null
        stopAll()
        _status.value = VoiceStatus.Idle
    }

    private fun stopAll() {
        pingJob?.cancel()
        speakingJob?.cancel()
        running = false
        capture?.join(500)
        playback?.join(500)
        capture = null
        playback = null
        if (encoder != 0L) Opus.encoderDestroy(encoder)
        encoder = 0
        stopCamera()
        stopScreen()
        video.clear()
        watching.clear()
        decoders.values.forEach { Opus.decoderDestroy(it) }
        decoders.clear()
        mixer.clear()
        lastHeard.clear()
        _speaking.value = emptySet()
        selfSpeaking = false
        channelId = null
    }

    fun setMuted(on: Boolean) {
        muted = on
        sendState()
    }

    fun setDeafened(on: Boolean) {
        deafened = on
        sendState()
    }

    private fun sendState() = sendJson(JSONObject().put("op", "state").put("self_mute", muted || deafened).put("self_deaf", deafened))

    /** Plays a soundboard sound for everyone in the call. */
    fun playSound(soundId: String) = sendJson(JSONObject().put("op", "sound").put("sound_id", soundId))

    fun setUserVolume(userId: String, gain: Float) = mixer.setGain(userId, gain)

    private var camera: Pair<VideoSender, CameraSource>? = null
    private var screen: Triple<VideoSender, ScreenSource, ScreenAudio?>? = null
    private val _sending = MutableStateFlow(setOf<String>())
    /** What we send: "camera", "screen". */
    val sending: StateFlow<Set<String>> = _sending

    private fun sendMedia(kind: Int, payload: ByteArray) {
        val sock = media ?: return
        // Late video is useless: skip frames while the socket is backed up (viewers ask for a keyframe).
        if (sock.queueSize() > MAX_VIDEO_QUEUE) return
        val msg = ByteArray(payload.size + 1)
        msg[0] = kind.toByte()
        System.arraycopy(payload, 0, msg, 1, payload.size)
        sock.send(msg.toByteString())
    }

    /** Our camera, 720p30 H.264. Needs CAMERA granted. */
    /** The camera in use is the front one. */
    var frontCamera = true
        private set
    private var previewSurface: android.view.Surface? = null

    /** Your own camera on your tile (null when the tile goes away). */
    fun cameraPreview(surface: android.view.Surface?) {
        previewSurface = surface
        camera?.second?.preview(surface)
    }

    /** Front <-> back, keeping the camera on. */
    fun switchCamera(context: android.content.Context) {
        if (camera != null) startCamera(context, !frontCamera)
    }

    fun startCamera(context: android.content.Context, front: Boolean = true) {
        stopCamera()
        frontCamera = front
        val sender = VideoSender(1280, 720, 30, 1_500_000) { sendMedia(KIND_CAMERA, it) }
        val src = CameraSource(context, sender)
        previewSurface?.let { src.preview(it) }
        src.start(front)
        camera = sender to src
        _sending.value = _sending.value + "camera"
    }

    fun stopCamera() {
        val c = camera ?: return
        camera = null
        c.second.stop()
        c.first.stop()
        sendJson(JSONObject().put("op", "video_stop").put("source", "camera"))
        _sending.value = _sending.value - "camera"
    }

    /** Our screen (and, where apps allow it, its sound) from a MediaProjection the app got permission for. */
    fun startScreen(projection: android.media.projection.MediaProjection, width: Int, height: Int, dpi: Int) {
        stopScreen()
        // Even sizes for the encoder, at most 1080p on the long side.
        val scale = minOf(1f, 1920f / maxOf(width, height))
        val w = ((width * scale).toInt() / 2) * 2
        val h = ((height * scale).toInt() / 2) * 2
        val sender = VideoSender(w, h, 30, 4_000_000) { sendMedia(KIND_SCREEN, it) }
        val src = ScreenSource(projection, sender, dpi)
        src.start(w, h)
        val audio = runCatching { ScreenAudio(projection) { sendMedia(KIND_SCREEN_AUDIO, it) }.also { it.start() } }.getOrNull()
        screen = Triple(sender, src, audio)
        _sending.value = _sending.value + "screen"
    }

    fun stopScreen() {
        val sc = screen ?: return
        screen = null
        sc.third?.stop()
        sc.second.stop()
        sc.first.stop()
        sendJson(JSONObject().put("op", "video_stop").put("source", "screen"))
        _sending.value = _sending.value - "screen"
    }

    /** Start/stop receiving someone's screen share ("Watch Stream"); its sound plays while watching. */
    fun watch(userId: String, on: Boolean) {
        if (on) watching += userId else {
            watching -= userId
            mixer.remove("$userId:screen")
        }
        sendJson(JSONObject().put("op", "watch").put("user_id", userId).put("on", on))
    }

    private fun sendJson(o: JSONObject) {
        ws?.send(o.toString())
    }

    // ---------------------------------------------------------------- the socket

    private fun openVoice() {
        if (leaving || channelId == null) return
        val req = Request.Builder().url(url).build()
        lateinit var sock: WebSocket
        sock = http.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send(JSONObject().put("token", token).put("channel_id", channelId).put("v", 2).toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (ws !== sock) return
                lastHeardAt = System.currentTimeMillis()
                val m = runCatching { JSONObject(text) }.getOrNull() ?: return
                when (m.optString("op")) {
                    "ready" -> {
                        lostAt = 0
                        attempt = 0
                        _status.value = VoiceStatus.Connected
                        sendState()
                        startPing(sock)
                        openMedia()
                        // After a reconnect the server has forgotten what we watched.
                        for (u in watching) sendJson(JSONObject().put("op", "watch").put("user_id", u).put("on", true))
                    }
                    "pong" -> _ping.value = (System.nanoTime() / 1_000_000.0 - m.optDouble("t")).toInt()
                    "sound" -> _events.tryEmit(VoiceEvent.Sound(m.optString("user_id"), m.optJSONObject("sound") ?: JSONObject()))
                    "keyframe" -> if (m.optString("source") == "screen") screen?.first?.requestKeyframe() else camera?.first?.requestKeyframe()
                    "video_stop" -> {
                        val u = m.optString("user_id")
                        if (m.optString("source") == "screen") mixer.remove("$u:screen")
                    }
                    "move" -> _events.tryEmit(VoiceEvent.Move(m.optString("channel_id").takeIf { it.isNotEmpty() && it != "null" }, m.optString("reason").takeIf { it.isNotEmpty() }))
                }
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                if (ws !== sock) return
                lastHeardAt = System.currentTimeMillis()
                onBinary(bytes)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, null)
                lose(sock, code)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = lose(sock, 1006)
        })
        ws = sock
    }

    private fun openMedia() {
        if (leaving || channelId == null || ws == null) return
        media?.cancel()
        val req = Request.Builder().url(url.replace("/voice/connect", "/voice/media")).build()
        lateinit var sock: WebSocket
        sock = http.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send(JSONObject().put("token", token).put("channel_id", channelId).toString())
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                if (media === sock) onBinary(bytes)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, null)
                retryMedia(sock)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = retryMedia(sock)
        })
        media = sock
    }

    /** Video keeps flowing after network blips, as long as voice itself is connected. */
    private fun retryMedia(sock: WebSocket) {
        if (media !== sock) return
        media = null
        scope.launch {
            delay(300)
            if (ws != null && media == null) openMedia()
        }
    }

    private fun startPing(sock: WebSocket) {
        pingJob?.cancel()
        lastHeardAt = System.currentTimeMillis()
        pingJob = scope.launch {
            while (isActive && ws === sock) {
                // Nothing at all for 7 s (pongs come every 2): a dead connection the phone hasn't noticed yet.
                if (System.currentTimeMillis() - lastHeardAt > SILENT_MS) return@launch lose(sock, 4000)
                sock.send(JSONObject().put("op", "ping").put("t", System.nanoTime() / 1_000_000.0).toString())
                delay(2000)
            }
        }
    }

    /** The voice socket is gone: get the seat back, unless it's over for good (voice-worker.ts lose). */
    @Synchronized
    private fun lose(sock: WebSocket, code: Int) {
        if (ws !== sock) return
        ws = null
        pingJob?.cancel()
        sock.cancel()
        if (leaving) return
        val now = System.currentTimeMillis()
        if (code in FINAL_CODES || (lostAt != 0L && now - lostAt > RECONNECT_FOR_MS)) {
            lostAt = 0
            stopAll()
            _status.value = VoiceStatus.Closed(code)
            return
        }
        if (lostAt == 0L) {
            lostAt = now
            _status.value = VoiceStatus.Reconnecting
        }
        // 4100: the server is restarting and the next one is already listening; spread the reconnects a little.
        val wait = if (attempt == 0) (if (code == 4100) 50 + (Math.random() * 250).toLong() else 100L) else min(2000L, 250L shl (attempt - 1).coerceAtMost(4))
        attempt++
        scope.launch {
            delay(wait)
            openVoice()
        }
    }

    private fun onBinary(b: ByteString) {
        if (b.size < 9) return
        val kind = b[0].toInt()
        var sender = 0L
        for (i in 1..8) sender = (sender shl 8) or (b[i].toLong() and 0xFF)
        val id = java.lang.Long.toUnsignedString(sender)
        val packet = b.substring(9).toByteArray()
        when (kind) {
            KIND_VOICE -> {
                decode(id, packet, 1)
                lastHeard[id] = System.currentTimeMillis()
            }
            // Kass's music: stereo, played and volume-controlled like his voice, and his tile lights up.
            KIND_MUSIC -> {
                decode(id, packet, 2)
                lastHeard[id] = System.currentTimeMillis()
            }
            KIND_SCREEN_AUDIO -> if (id in watching) decode("$id:screen", packet, 2)
            KIND_CAMERA -> video.onFrame(id, "camera", packet)
            KIND_SCREEN -> video.onFrame(id, "screen", packet)
        }
    }

    private val mono = ShortArray(FRAME)

    private fun decode(id: String, packet: ByteArray, channels: Int) {
        val key = if (channels == 2) "$id:2" else id
        val d = decoders.getOrPut(key) { Opus.decoderCreate(RATE, channels) }
        if (channels == 1) {
            val n = synchronized(mono) { Opus.decode(d, packet, packet.size, mono, FRAME, false) }
            if (n <= 0) return
            val stereo = ShortArray(FRAME * 2)
            synchronized(mono) { for (i in 0 until n) { stereo[2 * i] = mono[i]; stereo[2 * i + 1] = mono[i] } }
            mixer.push(id, stereo)
        } else {
            val stereo = ShortArray(FRAME * 2)
            if (Opus.decode(d, packet, packet.size, stereo, FRAME, false) > 0) mixer.push(id, stereo)
        }
    }

    private fun startSpeakingTimer() {
        speakingJob?.cancel()
        speakingJob = scope.launch {
            while (isActive) {
                val now = System.currentTimeMillis()
                val set = lastHeard.filterValues { now - it < SPEAKING_TIMEOUT_MS }.keys.toMutableSet()
                if (selfSpeaking) set += "me"
                if (set != _speaking.value) _speaking.value = set
                delay(100)
            }
        }
    }

    // ---------------------------------------------------------------- audio devices

    /**
     * The mic through the voice-communication source (the phone's echo canceller, noise suppressor and gain control
     * apply) and playback as a voice call (earpiece/speaker/Bluetooth routing, the call volume).
     */
    @SuppressLint("MissingPermission")
    private fun startAudio() {
        running = true
        capture = Thread({
            Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
            val min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
            val rec = runCatching {
                AudioRecord.Builder()
                    .setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
                    .setAudioFormat(AudioFormat.Builder().setSampleRate(RATE).setChannelMask(AudioFormat.CHANNEL_IN_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
                    .setBufferSizeInBytes(maxOf(min, FRAME * 2 * 4))
                    .build()
            }.getOrNull()
            if (rec == null || rec.state != AudioRecord.STATE_INITIALIZED) {
                rec?.release()
                return@Thread
            }
            rec.startRecording()
            val pcm = ShortArray(FRAME)
            val out = ByteArray(4000)
            var frames = 0
            while (running) {
                var got = 0
                while (got < FRAME && running) {
                    val n = rec.read(pcm, got, FRAME - got)
                    if (n <= 0) break
                    got += n
                }
                if (got < FRAME) continue
                val level = VoiceGate.rms(pcm)
                val open = gate.open(level, System.currentTimeMillis())
                if (++frames % 5 == 0) _level.value = level to gate.threshold()
                // Push to talk: only while the button is held (the gate doesn't decide then).
                val send = (if (pushToTalk) talking else open) && !muted && !deafened
                selfSpeaking = send
                if (!send || encoder == 0L) continue
                val n = Opus.encode(encoder, pcm, FRAME, out)
                val sock = ws
                // Like the web client: skip rather than queue when the socket is backed up (old voice is useless).
                if (n > 0 && sock != null && sock.queueSize() < MAX_QUEUE) {
                    val msg = ByteArray(n + 1)
                    msg[0] = KIND_VOICE.toByte()
                    System.arraycopy(out, 0, msg, 1, n)
                    sock.send(msg.toByteString())
                }
            }
            rec.stop()
            rec.release()
        }, "linkord-capture").also { it.start() }

        playback = Thread({
            Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
            val min = AudioTrack.getMinBufferSize(RATE, AudioFormat.CHANNEL_OUT_STEREO, AudioFormat.ENCODING_PCM_16BIT)
            val track = AudioTrack.Builder()
                .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                .setAudioFormat(AudioFormat.Builder().setSampleRate(RATE).setChannelMask(AudioFormat.CHANNEL_OUT_STEREO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
                .setBufferSizeInBytes(maxOf(min, FRAME * 4 * 3))
                .setTransferMode(AudioTrack.MODE_STREAM)
                .setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY)
                .build()
            track.play()
            val frame = ShortArray(FRAME * 2)
            while (running) {
                mixer.pull(frame, deafened)
                // A blocking write paces this loop at the device's own clock.
                track.write(frame, 0, frame.size)
            }
            track.stop()
            track.release()
        }, "linkord-playback").also { it.start() }
    }

    companion object {
        const val KIND_VOICE = 1
        const val KIND_CAMERA = 2
        const val KIND_SCREEN = 3
        const val KIND_SCREEN_AUDIO = 4
        const val KIND_MUSIC = 5
        val FINAL_CODES = setOf(4001, 4002, 4004, 4006)
        const val RECONNECT_FOR_MS = 60_000L
        const val SILENT_MS = 7000L
        const val SPEAKING_TIMEOUT_MS = 250L
        /** Bytes waiting in the socket before our voice is skipped (the web client's MAX_VOICE_BUFFER). */
        const val MAX_QUEUE = 256 * 1024L
        const val MAX_VIDEO_QUEUE = 768 * 1024L
    }
}
