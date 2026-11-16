package com.linkord.app.ui.settings

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.linkord.app.BuildConfig
import com.linkord.app.session
import com.linkord.app.ui.LocalNav
import com.linkord.app.ui.Screen
import com.linkord.app.ui.chat.ScreenScaffold
import com.linkord.app.ui.components.Kicker
import com.linkord.app.ui.components.LIcon
import com.linkord.app.ui.home.Entry
import com.linkord.app.ui.home.Section
import com.linkord.core.SessionInfo
import com.linkord.core.t
import com.linkord.designsystem.Linkord
import com.linkord.designsystem.LinkordIcons
import com.linkord.designsystem.ThemeMode
import kotlinx.coroutines.launch
import java.time.Duration
import java.time.Instant

@Composable
fun SettingsScreen() {
    val ctx = LocalContext.current
    val session = ctx.session
    val nav = LocalNav.current
    val c = Linkord.colors
    val scope = rememberCoroutineScope()
    ScreenScaffold(t("Settings")) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Section {
                Entry(LinkordIcons.EditProfile, t("Profile")) { nav.push(Screen.EditProfile) }
                Entry(LinkordIcons.Account, t("Account")) { nav.push(Screen.Account) }
                Entry(LinkordIcons.Mic, t("Voice")) { nav.push(Screen.VoiceSettings) }
                Entry(LinkordIcons.Appearance, t("Appearance")) { nav.push(Screen.Appearance) }
                Entry(LinkordIcons.Language, t("Language")) {
                    // Android's own per-app language screen (Android 13+); older phones follow the system language.
                    val intent = if (Build.VERSION.SDK_INT >= 33) Intent(Settings.ACTION_APP_LOCALE_SETTINGS, Uri.parse("package:${ctx.packageName}"))
                    else Intent(Settings.ACTION_LOCALE_SETTINGS)
                    runCatching { ctx.startActivity(intent) }
                }
                Entry(LinkordIcons.Bell, t("Notifications")) {
                    runCatching { ctx.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName)) }
                }
                Entry(LinkordIcons.BellOff, t("Server notifications")) { nav.push(Screen.NotificationLevels) }
                Entry(LinkordIcons.MobileDevice, t("Sessions")) { nav.push(Screen.Sessions) }
                Entry(LinkordIcons.Close, t("Blocked")) { nav.push(Screen.Blocked) }
                Entry(LinkordIcons.Music, "Kass") { nav.push(Screen.Kass) }
            }
            Section {
                Entry(LinkordIcons.Logout, t("Log Out"), danger = true) { session.signOut() }
            }
            Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Kicker("Linkord ${BuildConfig.VERSION_NAME} · Android")
                Text(t("Server: {host}", "host" to session.serverUrl().substringAfter("://")), style = Linkord.type.label)
                Text(t("Geist, Geist Mono and Instrument Serif are under the SIL Open Font License. Icons: Heroicons (MIT)."), style = Linkord.type.label)
            }
        }
    }
}

@Composable
fun AppearanceScreen() {
    val session = LocalContext.current.session
    val theme by session.prefs.theme.collectAsState()
    val c = Linkord.colors
    ScreenScaffold(t("Appearance")) {
        Column(Modifier.fillMaxSize().padding(vertical = 8.dp)) {
            Section {
                Kicker(t("Theme"), Modifier.padding(start = 16.dp, top = 12.dp, bottom = 4.dp))
                for ((mode, label) in listOf(ThemeMode.System to t("System default"), ThemeMode.Dark to t("Dark"), ThemeMode.Light to t("Light"), ThemeMode.Christmas to t("Christmas"))) {
                    Row(Modifier.fillMaxWidth().clickable { session.prefs.setTheme(mode) }.padding(horizontal = 16.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                        LIcon(when (mode) { ThemeMode.Dark -> LinkordIcons.Moon; ThemeMode.Light -> LinkordIcons.Sun; ThemeMode.Christmas -> LinkordIcons.Snowflake; else -> LinkordIcons.MobileDevice })
                        Spacer(Modifier.width(14.dp))
                        Text(label, style = Linkord.type.body, modifier = Modifier.weight(1f))
                        if (theme == mode) LIcon(LinkordIcons.Check, tint = c.text)
                    }
                }
            }
            if (theme == ThemeMode.Christmas) {
                Spacer(Modifier.height(12.dp))
                Section {
                    var sounds by remember { mutableStateOf(session.prefs.christmasSounds) }
                    SwitchRow(t("Christmas sounds"), t("Winter versions of the call sounds."), sounds) { sounds = it; session.prefs.christmasSounds = it }
                }
            }
        }
    }
}

/** Your logins (GET /auth/sessions): this phone first, then the others, each can be logged out. */
@Composable
fun SessionsScreen() {
    val session = LocalContext.current.session
    val c = Linkord.colors
    val scope = rememberCoroutineScope()
    var list by remember { mutableStateOf<List<SessionInfo>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    suspend fun load() {
        runCatching { session.api.get<List<SessionInfo>>("/auth/sessions") }.onSuccess { list = it; error = null }.onFailure { error = t("Couldn't load your devices.") }
    }
    LaunchedEffect(Unit) { load() }
    ScreenScaffold(t("Sessions")) {
        val all = list
        if (all == null) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                if (error != null) Text(error!!, style = Linkord.type.small) else CircularProgressIndicator(color = c.text3)
            }
            return@ScreenScaffold
        }
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            val current = all.filter { it.current }
            val others = all.filter { !it.current }
            item { Kicker(t("This device"), Modifier.padding(start = 4.dp, top = 4.dp)) }
            items(current, key = { it.id }) { SessionRow(it, null) }
            item { Kicker(t("Other devices"), Modifier.padding(start = 4.dp, top = 12.dp)) }
            if (others.isEmpty()) item { Text(t("No other devices are signed in."), style = Linkord.type.small, modifier = Modifier.padding(4.dp)) }
            items(others, key = { it.id }) { s ->
                SessionRow(s) {
                    scope.launch {
                        runCatching { session.api.send("DELETE", "/auth/sessions/${s.id}") }
                            .onSuccess { session.toast(t("Device logged out")); load() }
                            .onFailure { session.toast(session.describe(it)) }
                    }
                }
            }
        }
    }
}

/** What a login runs on, like the web client's lib/device.ts. */
private fun deviceName(s: SessionInfo): Pair<String, Boolean> {
    val ua = s.userAgent ?: ""
    val os = listOf("Windows" to "Windows", "Android" to "Android", "iPhone" to "iPhone", "iPad" to "iPad", "CrOS" to "ChromeOS", "Mac OS X" to "macOS", "Linux" to "Linux")
        .firstOrNull { Regex("\\b${Regex.escape(it.first)}\\b").containsMatchIn(ua) }?.second
    val browser = listOf("Edg" to "Edge", "OPR" to "Opera", "SamsungBrowser" to "Samsung Internet", "Firefox" to "Firefox", "Chrome" to "Chrome", "Safari" to "Safari")
        .firstOrNull { ua.contains(it.first + "/") }?.second
    val name = when (s.client) {
        "android" -> t("Linkord for Android")
        "desktop" -> t("Linkord app")
        else -> browser ?: t("Unknown device")
    }
    return listOfNotNull(name, os).joinToString(" · ") to Regex("\\b(Android|iPhone|iPad|Mobile)\\b").containsMatchIn(ua)
}

private fun ago(iso: String): String {
    val at = runCatching { Instant.parse(iso) }.getOrNull() ?: return ""
    return android.text.format.DateUtils.getRelativeTimeSpanString(at.toEpochMilli(), System.currentTimeMillis(), Duration.ofMinutes(1).toMillis()).toString()
}

@Composable
private fun SessionRow(s: SessionInfo, onEnd: (() -> Unit)?) {
    val c = Linkord.colors
    val (name, mobile) = deviceName(s)
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(c.panel).padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
        LIcon(if (mobile) LinkordIcons.MobileDevice else LinkordIcons.Desktop, size = 24.dp)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(name, style = Linkord.type.bodyStrong)
            val last = if (s.current || s.online) t("Active now") else t("Last active {when}", "when" to ago(s.lastSeenAt ?: s.createdAt))
            Text(last, style = Linkord.type.small, color = c.text3)
        }
        if (onEnd != null) TextButton(onClick = onEnd) { Text(t("Log Out"), color = c.text) }
    }
}

@Composable
fun AddFriendScreen() {
    val session = LocalContext.current.session
    val c = Linkord.colors
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf("") }
    var result by remember { mutableStateOf<Pair<Boolean, String>?>(null) }
    ScreenScaffold(t("Add Friend")) {
        Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(t("You can add friends with their Linkord username."), style = Linkord.type.small)
            OutlinedTextField(name, { name = it.lowercase().trim(); result = null }, singleLine = true, keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(autoCorrectEnabled = false, keyboardType = androidx.compose.ui.text.input.KeyboardType.Ascii), label = { Text(t("Username")) }, modifier = Modifier.fillMaxWidth())
            Button(
                onClick = {
                    scope.launch {
                        result = runCatching { session.actions.friendRequestByName(name) }
                            .fold({ true to t("Friend request sent to {name}.", "name" to name) }, { false to session.describe(it) })
                    }
                },
                enabled = name.length >= 2,
                colors = ButtonDefaults.buttonColors(containerColor = c.brand, contentColor = c.onBrand),
                modifier = Modifier.fillMaxWidth().height(48.dp),
            ) { Text(t("Send Friend Request")) }
            result?.let { (ok, text) -> Text(text, style = Linkord.type.small, color = if (ok) c.online else c.danger) }
        }
    }
}

@Composable
fun JoinServerScreen(initial: String = "") {
    val session = LocalContext.current.session
    val nav = LocalNav.current
    val c = Linkord.colors
    val scope = rememberCoroutineScope()
    var link by remember { mutableStateOf(initial) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    ScreenScaffold(t("Join a Server")) {
        Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(t("Enter an invite below to join an existing server."), style = Linkord.type.small)
            OutlinedTextField(link, { link = it; error = null }, singleLine = true, label = { Text(t("Invite link")) }, placeholder = { Text("${session.serverUrl()}/invite/abc123") }, modifier = Modifier.fillMaxWidth())
            Button(
                onClick = {
                    val code = link.trim().substringAfterLast('/').substringBefore('?')
                    busy = true
                    scope.launch {
                        runCatching { session.actions.acceptInvite(code) }.onSuccess { nav.pop() }.onFailure { error = session.describe(it) }
                        busy = false
                    }
                },
                enabled = link.isNotBlank() && !busy,
                colors = ButtonDefaults.buttonColors(containerColor = c.brand, contentColor = c.onBrand),
                modifier = Modifier.fillMaxWidth().height(48.dp),
            ) { Text(t("Join Server")) }
            error?.let { Text(it, style = Linkord.type.small, color = c.danger) }
        }
    }
}
