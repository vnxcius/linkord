package com.linkord.app.data

import android.content.Context
import androidx.core.content.edit
import com.linkord.designsystem.ThemeMode
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** Per-device preferences (the web client's prefs.ts): nothing secret, nothing synced. */
class Prefs(context: Context) {
    private val p = context.getSharedPreferences("linkord.prefs", Context.MODE_PRIVATE)

    /** A server the person typed in (blank = the default one). */
    var server: String
        get() = p.getString("server", "") ?: ""
        set(v) = p.edit { putString("server", v) }

    private val _theme = MutableStateFlow(runCatching { ThemeMode.valueOf(p.getString("theme", "System")!!) }.getOrDefault(ThemeMode.System))
    val theme: StateFlow<ThemeMode> = _theme
    fun setTheme(m: ThemeMode) {
        _theme.value = m
        p.edit { putString("theme", m.name) }
    }

    /** Where each view (a server, or '@me') was last: channel id. */
    fun lastChannel(view: String): String? = p.getString("last.$view", null)
    fun setLastChannel(view: String, channel: String) = p.edit { putString("last.$view", channel) }

    var lastView: String
        get() = p.getString("lastView", "@me") ?: "@me"
        set(v) = p.edit { putString("lastView", v) }

    /** Voice: the gate follows the room (true) or a fixed threshold (0..1 RMS). */
    var autoSensitivity: Boolean
        get() = p.getBoolean("voice.auto", true)
        set(v) = p.edit { putBoolean("voice.auto", v) }
    var threshold: Float
        get() = p.getFloat("voice.threshold", 0.02f)
        set(v) = p.edit { putFloat("voice.threshold", v) }

    /** The Android welcome was shown on this phone. */
    var welcomed: Boolean
        get() = p.getBoolean("welcomed", false)
        set(v) = p.edit { putBoolean("welcomed", v) }

    /** Push to talk instead of the voice gate (a hold button in the call). */
    var pushToTalk: Boolean
        get() = p.getBoolean("voice.ptt", false)
        set(v) = p.edit { putBoolean("voice.ptt", v) }

    /** Discord's Winter pack for call sounds while the Christmas theme is on (prefs.christmasSounds). */
    var christmasSounds: Boolean
        get() = p.getBoolean("christmasSounds", true)
        set(v) = p.edit { putBoolean("christmasSounds", v) }

    /** Emoji picked lately, newest first (the picker's Recent tab): a character, or "name:id" for a server's emoji. */
    var recentEmoji: List<String>
        get() = p.getString("emoji.recent", "")!!.split('\n').filter { it.isNotEmpty() }
        set(v) = p.edit { putString("emoji.recent", v.joinToString("\n")) }

    /** Voice message playback speed (1, 1.5 or 2), kept like WhatsApp does. */
    var voiceSpeed: Float
        get() = p.getFloat("voice.speed", 1f)
        set(v) = p.edit { putFloat("voice.speed", v) }

    /** Voice messages you've listened to (attachment ids, the latest 1000): their mic turns from grey to the accent. */
    var heardVoice: List<String>
        get() = p.getString("voice.heard", "")!!.split(',').filter { it.isNotEmpty() }
        set(v) = p.edit { putString("voice.heard", v.joinToString(",")) }

    /** The skin tone chosen for each emoji (long press in the picker): the plain emoji -> the toned one. */
    var emojiTones: Map<String, String>
        get() = p.getString("emoji.tones", "")!!.split('\n').mapNotNull { l -> l.split('\t').takeIf { it.size == 2 }?.let { it[0] to it[1] } }.toMap()
        set(v) = p.edit { putString("emoji.tones", v.entries.joinToString("\n") { "${it.key}\t${it.value}" }) }

    /** Reaction added by a double tap on a message (a setting, owner's design note). */
    var quickReaction: String
        get() = p.getString("quickReaction", "❤️") ?: "❤️"
        set(v) = p.edit { putString("quickReaction", v) }
}
