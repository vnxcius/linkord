package com.linkord.app.ui.settings

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.linkord.app.session
import com.linkord.app.ui.chat.ScreenScaffold
import com.linkord.app.ui.components.Avatar
import com.linkord.app.ui.components.Kicker
import com.linkord.app.ui.components.LIcon
import com.linkord.app.ui.components.ServerTile
import com.linkord.app.ui.home.Section
import com.linkord.core.Rel
import com.linkord.core.User
import com.linkord.core.putUser
import com.linkord.core.t
import com.linkord.designsystem.Linkord
import com.linkord.designsystem.LinkordIcons
import com.linkord.voice.FRAME
import com.linkord.voice.RATE
import com.linkord.voice.VoiceGate
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerialName
import kotlin.math.log10
import kotlin.math.pow

/** A setting with a switch. */
@Composable
fun SwitchRow(title: String, hint: String? = null, checked: Boolean, enabled: Boolean = true, onChange: (Boolean) -> Unit) {
    val c = Linkord.colors
    Row(Modifier.fillMaxWidth().clickable(enabled = enabled) { onChange(!checked) }.padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, style = Linkord.type.body, color = if (enabled) androidx.compose.ui.graphics.Color.Unspecified else c.text3)
            if (hint != null) Text(hint, style = Linkord.type.small, color = c.text3)
        }
        Spacer(Modifier.width(12.dp))
        Switch(checked, onChange, enabled = enabled, colors = SwitchDefaults.colors(checkedThumbColor = c.onBrand, checkedTrackColor = c.brand, uncheckedTrackColor = c.raised2, uncheckedBorderColor = c.lineStrong))
    }
}

/** Your username (Discord's rules: 2-32 of a-z 0-9 _ .). */
@Composable
fun AccountScreen() {
    val session = LocalContext.current.session
    val st by session.store.state.collectAsState()
    val me = st.me ?: return
    val c = Linkord.colors
    val scope = rememberCoroutineScope()
    var username by remember { mutableStateOf(me.username) }
    var error by remember { mutableStateOf<String?>(null) }
    ScreenScaffold(t("Account")) {
        Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedTextField(
                username, { username = it.lowercase().filter { ch -> ch.isLetterOrDigit() || ch == '_' || ch == '.' }.take(32); error = null },
                label = { Text(t("Username")) }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, keyboardType = KeyboardType.Ascii),
            )
            error?.let { Text(it, style = Linkord.type.small, color = c.danger) }
            Button(
                enabled = username != me.username && username.length >= 2,
                onClick = {
                    scope.launch {
                        runCatching { session.api.patch<User>("/users/@me", mapOf("username" to username)) }
                            .onSuccess { u -> session.store.update { it.putUser(u).copy(me = it.me?.let { m -> u.copy(status = m.status) }) }; session.toast(t("Username changed")) }
                            .onFailure { error = session.describe(it) }
                    }
                },
                colors = ButtonDefaults.buttonColors(containerColor = c.brand, contentColor = c.onBrand),
                modifier = Modifier.fillMaxWidth().height(48.dp),
            ) { Text(t("Save")) }
        }
    }
}

/**
 * Voice: how loud you must be to be heard (automatic follows the room; manual is a fixed bar), with a mic test that
 * shows your level against it. The phone's own echo cancelling and noise suppression always apply.
 */
@SuppressLint("MissingPermission")
@Composable
fun VoiceSettingsScreen() {
    val ctx = LocalContext.current
    val session = ctx.session
    val c = Linkord.colors
    var auto by remember { mutableStateOf(session.prefs.autoSensitivity) }
    var threshold by remember { mutableFloatStateOf(session.prefs.threshold) }
    var testing by remember { mutableStateOf(false) }
    var level by remember { mutableFloatStateOf(0f) }
    var autoBar by remember { mutableFloatStateOf(0.02f) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { if (it) testing = true }
    LaunchedEffect(testing) {
        if (!testing) return@LaunchedEffect
        withContext(Dispatchers.IO) {
            val rec = AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, FRAME * 8)
            val gate = VoiceGate()
            val pcm = ShortArray(FRAME)
            rec.startRecording()
            try {
                while (isActive && testing) {
                    if (rec.read(pcm, 0, FRAME) <= 0) break
                    val r = VoiceGate.rms(pcm)
                    gate.open(r, System.currentTimeMillis())
                    level = r.toFloat()
                    autoBar = gate.threshold().toFloat()
                }
            } finally {
                rec.stop()
                rec.release()
            }
        }
    }
    DisposableEffect(Unit) { onDispose { testing = false } }
    fun apply() {
        session.prefs.autoSensitivity = auto
        session.prefs.threshold = threshold
        session.calls.applySensitivity()
    }
    // Levels on a dB scale (-60..0) so quiet speech still moves the meter.
    fun db(v: Float) = ((20 * log10(v.coerceAtLeast(1e-6f)) + 60) / 60).coerceIn(0f, 1f)
    fun fromDb(p: Float) = 10.0.pow((p * 60 - 60) / 20.0).toFloat()

    ScreenScaffold(t("Voice")) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Section {
                var ptt by remember { mutableStateOf(session.prefs.pushToTalk) }
                SwitchRow(t("Push to Talk"), t("Hold the button in the call to talk."), ptt) { ptt = it; session.prefs.pushToTalk = it; session.calls.applySensitivity() }
            }
            Section {
                SwitchRow(t("Automatically determine input sensitivity"), checked = auto) { auto = it; apply() }
                Column(Modifier.padding(16.dp)) {
                    Kicker(t("Input Sensitivity"))
                    val bar = if (auto) autoBar else threshold
                    BoxWithConstraints(Modifier.fillMaxWidth().padding(vertical = 10.dp).height(10.dp).clip(RoundedCornerShape(5.dp)).background(c.raised2)) {
                        Box(Modifier.fillMaxHeight().fillMaxWidth(db(level)).background(if (level > bar) c.speaking else c.text3))
                        Box(Modifier.offset(x = maxWidth * db(bar)).width(2.dp).fillMaxHeight().background(c.text))
                    }
                    if (!auto) Slider(db(threshold), { threshold = fromDb(it); apply() }, valueRange = 0.2f..0.95f)
                    Text(
                        if (auto) t("Linkord listens to the room and only sends your voice when you're louder than it.") else t("Your voice is sent when the meter passes the line."),
                        style = Linkord.type.small, color = c.text3,
                    )
                }
                Row(Modifier.fillMaxWidth().padding(16.dp)) {
                    Button(
                        onClick = {
                            if (testing) testing = false
                            else if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) testing = true
                            else ask.launch(Manifest.permission.RECORD_AUDIO)
                        },
                        colors = ButtonDefaults.buttonColors(containerColor = c.brand, contentColor = c.onBrand),
                    ) { Text(if (testing) t("Stop Testing") else t("Let's Check")) }
                }
            }
        }
    }
}

/** How much each server notifies you (settings.guild_notifications): every message, only mentions, or nothing. */
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun NotificationLevelsScreen() {
    val session = LocalContext.current.session
    val st by session.store.state.collectAsState()
    val c = Linkord.colors
    ScreenScaffold(t("Server notifications")) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(st.guildOrder.mapNotNull { st.guilds[it] }, key = { it.id }) { g ->
                val level = st.settings.guildNotifications[g.id] ?: "all"
                val muted = g.id in st.settings.mutedGuilds
                Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(c.panel).padding(12.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        ServerTile(g.name, g.icon, 32.dp)
                        Spacer(Modifier.width(10.dp))
                        Text(g.name, style = Linkord.type.bodyStrong, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(if (muted) t("Unmute") else t("Mute"), style = Linkord.type.small, color = c.text2, modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable { session.actions.toggleMuteGuild(g.id) }.padding(6.dp))
                    }
                    // Wraps whole options onto the next line: in a plain row a small phone squeezed them and pushed the last
                    // one off the card.
                    androidx.compose.foundation.layout.FlowRow(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        for ((id, label) in listOf("all" to t("All Messages"), "mentions" to t("Only @mentions"), "none" to t("Nothing"))) {
                            val on = level == id
                            Text(
                                label, style = Linkord.type.small, color = if (on) c.onBrand else c.text, maxLines = 1, softWrap = false,
                                modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(if (on) c.brand else c.raised)
                                    .clickable { session.actions.patchSettings(mapOf("guild_notifications" to st.settings.guildNotifications + (g.id to id))) }
                                    .padding(horizontal = 10.dp, vertical = 6.dp),
                            )
                        }
                    }
                }
            }
        }
    }
}

/** Privacy: read receipts in DMs and your voice in other people's REC recordings (web Settings → Privacy). */
@Composable
fun PrivacyScreen() {
    val session = LocalContext.current.session
    val st by session.store.state.collectAsState()
    val scope = rememberCoroutineScope()
    val me = st.me ?: return
    fun save(block: suspend () -> Unit) {
        scope.launch { runCatching { block() }.onFailure { session.toast(session.describe(it)) } }
    }
    ScreenScaffold(t("Privacy")) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            com.linkord.app.ui.home.Section {
                Kicker(t("Direct Messages"), Modifier.padding(start = 16.dp, top = 12.dp, bottom = 4.dp))
                SwitchRow(
                    t("Read receipts"),
                    t("When this is off, people won't see when you've read their messages, and you won't see when they've read yours. Delivered still shows."),
                    me.readReceipts,
                ) { on -> save { session.actions.setReadReceipts(on) } }
            }
            com.linkord.app.ui.home.Section {
                Kicker("REC", Modifier.padding(start = 16.dp, top = 12.dp, bottom = 4.dp))
                SwitchRow(
                    t("Let others record my voice"),
                    t("When this is off, everyone's Linkord leaves your voice out of their recordings from now on. What was already recorded stays."),
                    !me.recOptOut,
                ) { on -> save { session.actions.setRecordable(on) } }
            }
        }
    }
}

/** People you blocked, with Unblock. */
@Composable
fun BlockedScreen() {
    val session = LocalContext.current.session
    val st by session.store.state.collectAsState()
    val scope = rememberCoroutineScope()
    val c = Linkord.colors
    val blocked = st.relationships.filterValues { it == Rel.BLOCKED }.keys.mapNotNull { st.users[it] }
    ScreenScaffold(t("Blocked")) {
        if (blocked.isEmpty()) Text(t("You haven't blocked anyone."), style = Linkord.type.small, modifier = Modifier.padding(16.dp))
        else LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(12.dp)) {
            items(blocked, key = { it.id }) { u ->
                Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Avatar(u, 40.dp)
                    Spacer(Modifier.width(12.dp))
                    Text(u.name, style = Linkord.type.bodyStrong, modifier = Modifier.weight(1f))
                    TextButton(onClick = { scope.launch { runCatching { session.actions.removeRelationship(u.id) }.onFailure { session.toast(session.describe(it)) } } }) {
                        Text(t("Unblock"), color = c.text)
                    }
                }
            }
        }
    }
}

@Serializable
private data class KassSettings(@SerialName("new_servers") val newServers: Boolean = true)

/** Kass, the music bot: whether servers you create include him (GET/PUT /users/@me/kass). */
@Composable
fun KassScreen() {
    val session = LocalContext.current.session
    val scope = rememberCoroutineScope()
    var on by remember { mutableStateOf<Boolean?>(null) }
    LaunchedEffect(Unit) { on = runCatching { session.api.get<KassSettings>("/users/@me/kass").newServers }.getOrNull() }
    ScreenScaffold("Kass") {
        Column(Modifier.fillMaxSize().padding(vertical = 8.dp)) {
            Section {
                val v = on
                if (v != null) SwitchRow(t("Add Kass to servers I create"), t("Kass plays music in voice channels: /play a song or a link."), v) { n ->
                    on = n
                    scope.launch { runCatching { session.api.send("PUT", "/users/@me/kass", mapOf("new_servers" to n)) }.onFailure { session.toast(session.describe(it)); on = !n } }
                }
            }
        }
    }
}

