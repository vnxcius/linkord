package com.linkord.app.data

import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.SoundPool
import android.os.Build
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import com.linkord.app.VoiceService
import com.linkord.core.Kind
import com.linkord.core.t
import com.linkord.core.voiceMembers
import com.linkord.voice.VoiceClient
import com.linkord.voice.VoiceEvent
import com.linkord.voice.VoiceStatus
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/** Where the call's sound comes out. */
enum class Route { Speaker, Earpiece, Bluetooth, Wired }

/**
 * The call this phone is in: the voice client (:voice), the phone's audio set up for a call (communication mode,
 * focus, routing), the foreground service that keeps it alive with the screen off, and the call's sounds.
 */
class Calls(private val session: Session) {
    private val ctx: Context get() = session.context
    private val audio = ctx.getSystemService(AudioManager::class.java)
    private val prefs = ctx.getSharedPreferences("linkord.voice", Context.MODE_PRIVATE)
    val voice = VoiceClient(session.http, session.scope)

    private val _channel = MutableStateFlow<String?>(null)
    /** The voice channel (or DM) we're in. */
    val channel: StateFlow<String?> = _channel
    private val _muted = MutableStateFlow(prefs.getBoolean("muted", false))
    val muted: StateFlow<Boolean> = _muted
    private val _deafened = MutableStateFlow(prefs.getBoolean("deafened", false))
    val deafened: StateFlow<Boolean> = _deafened
    private val _route = MutableStateFlow(Route.Speaker)
    val route: StateFlow<Route> = _route

    private val sounds = SoundPool.Builder().setMaxStreams(4)
        .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
        .build()
    private val soundIds = HashMap<String, Int>()
    private val christmasIds = HashMap<String, Int>()
    private var focus: AudioFocusRequest? = null
    private var ring: MediaPlayer? = null
    /** The DM call last ringing us, so its pushed notification goes away once it stops. */
    private var lastRinging: String? = null

    /** Answer tapped on the incoming call notification: the UI joins once it's up (Root, with the mic permission). */
    val answer = kotlinx.coroutines.flow.MutableStateFlow<String?>(null)

    /** The app came to the front or left it (LinkordApp): the ringing moves between the app and the notification. */
    fun foregroundChanged(front: Boolean) {
        val ringing = lastRinging ?: return
        if (front) {
            session.notifier.clearCall(ringing)
            startRing()
        } else stopRing()
    }

    /** At your ear on the earpiece, the screen goes off (no cheek presses); never with video. */
    private val proximity by lazy {
        ctx.getSystemService(android.os.PowerManager::class.java).newWakeLock(android.os.PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "linkord:call")
    }

    init {
        for (name in listOf("join", "leave", "disconnect", "mute", "unmute", "deafen", "undeafen")) {
            runCatching { ctx.assets.openFd("sounds/$name.wav").use { soundIds[name] = sounds.load(it, 1) } }
            runCatching { ctx.assets.openFd("sounds/christmas/$name.mp3").use { christmasIds[name] = sounds.load(it, 1) } }
        }
        // Voice states of the call we're in: sounds when people come and go.
        session.scope.launch {
            var before: Set<String>? = null
            var inChannel: String? = null
            session.store.state.map { st -> _channel.value?.let { ch -> ch to st.voiceMembers(ch).map { it.userId }.toSet() } }
                .distinctUntilChanged().collect { now ->
                    if (now == null) {
                        before = null; inChannel = null; return@collect
                    }
                    val (ch, people) = now
                    val prev = before
                    if (prev != null && inChannel == ch) {
                        val me = session.store.s.me?.id
                        if ((people - prev - me).isNotEmpty()) play("join")
                        if ((prev - people - me).isNotEmpty()) play("leave")
                    }
                    before = people
                    inChannel = ch
                }
        }
        session.scope.launch {
            voice.status.collect { s ->
                if (s is VoiceStatus.Closed) {
                    session.toast(if (s.code == 4004) t("You can't join this voice channel.") else t("Disconnected from voice."))
                    cleanup(sound = true)
                }
            }
        }
        session.scope.launch {
            voice.events.collect { e ->
                when (e) {
                    is VoiceEvent.Sound -> playSoundboard(e)
                    is VoiceEvent.Move -> e.channelId?.let { join(it) } ?: leave()
                }
            }
        }
        session.scope.launch { voice.sending.collect { updateProximity() } }
        // A DM call ringing us: the ringtone plays until we answer, decline, or it stops ringing.
        session.scope.launch {
            session.store.state.map { st -> st.calls.entries.firstOrNull { (ch, ringing) -> st.me?.id in ringing && _channel.value != ch }?.key }
                .distinctUntilChanged().collect { ringing ->
                    lastRinging?.takeIf { it != ringing }?.let { session.notifier.clearCall(it) }
                    lastRinging = ringing
                    // In front the app rings (and the card shows); in the background the call notification does.
                    if (ringing != null && session.gateway.foreground) {
                        session.notifier.clearCall(ringing)
                        startRing()
                    } else if (ringing == null) stopRing()
                }
        }
    }

    /** The Christmas theme's Winter pack replaces the call sounds (prefs.christmasSounds), like the desktop app. */
    private val christmas get() = session.prefs.theme.value == com.linkord.designsystem.ThemeMode.Christmas && session.prefs.christmasSounds

    fun play(name: String) {
        ((if (christmas) christmasIds[name] else null) ?: soundIds[name])?.let { sounds.play(it, 0.6f, 0.6f, 1, 0, 1f) }
    }

    /** The voice gate's sensitivity (Settings -> Voice): automatic, or a fixed threshold. */
    fun applySensitivity() {
        voice.gate.manualThreshold = if (session.prefs.autoSensitivity) null else session.prefs.threshold.toDouble()
        voice.pushToTalk = session.prefs.pushToTalk
    }


    private fun updateProximity() {
        val want = _channel.value != null && _route.value == Route.Earpiece && voice.sending.value.isEmpty()
        if (want && !proximity.isHeld) proximity.acquire(4 * 3600_000L)
        if (!want && proximity.isHeld) proximity.release()
    }

    private fun playSoundboard(e: VoiceEvent.Sound) {
        if (_deafened.value) return
        val url = session.api.media(e.sound.optString("url")) ?: return
        val volume = e.sound.optDouble("volume", 1.0).toFloat().coerceIn(0f, 1f)
        val mp = MediaPlayer()
        mp.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
        mp.setDataSource(url)
        mp.setVolume(volume, volume)
        mp.setOnPreparedListener { it.start() }
        mp.setOnCompletionListener { it.release() }
        mp.setOnErrorListener { p, _, _ -> p.release(); true }
        mp.prepareAsync()
    }

    /** Joins a voice channel or a DM's call (which rings the others). Needs RECORD_AUDIO already granted. */
    fun join(channelId: String) {
        val token = session.vault.get() ?: return
        if (_channel.value == channelId && voice.status.value !is VoiceStatus.Closed) return
        if (_channel.value != null) voice.leave()
        _channel.value = channelId
        stopRing()
        audio.mode = AudioManager.MODE_IN_COMMUNICATION
        focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .build().also { audio.requestAudioFocus(it) }
        // Voice channels start on the speaker (it's a group hangout); a headset or Bluetooth takes over by itself.
        setRoute(bestRoute(if (session.store.s.channels[channelId]?.kind == Kind.VOICE) Route.Speaker else Route.Earpiece))
        ContextCompat.startForegroundService(ctx, Intent(ctx, VoiceService::class.java))
        applySensitivity()
        voice.connect(session.serverUrl(), token, channelId, _muted.value, _deafened.value)
        play("join")
    }

    fun leave() {
        if (_channel.value == null) return
        voice.leave()
        cleanup(sound = true)
    }

    private fun cleanup(sound: Boolean) {
        if (_channel.value == null) return
        _channel.value = null
        if (sound) play("disconnect")
        focus?.let { audio.abandonAudioFocusRequest(it) }
        focus = null
        if (Build.VERSION.SDK_INT >= 31) audio.clearCommunicationDevice() else @Suppress("DEPRECATION") { audio.isSpeakerphoneOn = false }
        if (proximity.isHeld) proximity.release()
        audio.mode = AudioManager.MODE_NORMAL
        ctx.stopService(Intent(ctx, VoiceService::class.java))
    }

    fun toggleMute() {
        // Unmuting while deafened undeafens too, like Discord.
        if (_deafened.value) return toggleDeafen()
        val on = !_muted.value
        _muted.value = on
        prefs.edit { putBoolean("muted", on) }
        voice.setMuted(on)
        play(if (on) "mute" else "unmute")
    }

    fun toggleDeafen() {
        val on = !_deafened.value
        _deafened.value = on
        prefs.edit { putBoolean("deafened", on) }
        voice.setDeafened(on)
        play(if (on) "deafen" else "undeafen")
    }

    /** Routes the call: speaker, earpiece, or the headset/Bluetooth device when one is there. */
    fun setRoute(r: Route) {
        if (Build.VERSION.SDK_INT >= 31) {
            val type = when (r) {
                Route.Speaker -> AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
                Route.Earpiece -> AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
                Route.Bluetooth -> AudioDeviceInfo.TYPE_BLUETOOTH_SCO
                Route.Wired -> AudioDeviceInfo.TYPE_WIRED_HEADSET
            }
            val dev = audio.availableCommunicationDevices.firstOrNull { it.type == type || (r == Route.Wired && it.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES) || (r == Route.Wired && it.type == AudioDeviceInfo.TYPE_USB_HEADSET) || (r == Route.Bluetooth && it.type == AudioDeviceInfo.TYPE_BLE_HEADSET) }
            if (dev != null) audio.setCommunicationDevice(dev)
        } else @Suppress("DEPRECATION") {
            audio.isSpeakerphoneOn = r == Route.Speaker
            if (r == Route.Bluetooth) audio.startBluetoothSco() else audio.stopBluetoothSco()
        }
        _route.value = r
        updateProximity()
    }

    /** The routes this phone has right now (speaker and earpiece always; headsets when plugged in or paired). */
    fun routes(): List<Route> {
        val out = mutableListOf(Route.Speaker, Route.Earpiece)
        val devices = if (Build.VERSION.SDK_INT >= 31) audio.availableCommunicationDevices.map { it.type } else audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS).map { it.type }
        if (devices.any { it == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || it == AudioDeviceInfo.TYPE_BLE_HEADSET }) out += Route.Bluetooth
        if (devices.any { it == AudioDeviceInfo.TYPE_WIRED_HEADSET || it == AudioDeviceInfo.TYPE_WIRED_HEADPHONES || it == AudioDeviceInfo.TYPE_USB_HEADSET }) out += Route.Wired
        return out
    }

    private fun bestRoute(fallback: Route): Route {
        val r = routes()
        return when {
            Route.Bluetooth in r -> Route.Bluetooth
            Route.Wired in r -> Route.Wired
            else -> fallback
        }
    }

    /** Declines a DM call ringing us (server: POST /channels/{id}/call/decline). */
    fun decline(channelId: String) {
        stopRing()
        session.scope.launch { runCatching { session.api.send("POST", "/channels/$channelId/call/decline") } }
    }

    private fun startRing() {
        if (ring != null || _channel.value != null) return
        ring = runCatching {
            MediaPlayer().apply {
                ctx.assets.openFd(if (christmas) "sounds/christmas/ring-incoming.mp3" else "sounds/ring-incoming.mp3").use { setDataSource(it.fileDescriptor, it.startOffset, it.length) }
                setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                isLooping = true
                prepare()
                start()
            }
        }.getOrNull()
    }

    private fun stopRing() {
        ring?.runCatching { stop(); release() }
        ring = null
    }
}
