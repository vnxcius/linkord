package com.linkord.app.ui.settings

import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import com.linkord.app.session
import com.linkord.app.ui.LocalNav
import com.linkord.app.ui.Screen
import com.linkord.app.ui.chat.ScreenScaffold
import com.linkord.app.ui.components.Kicker
import com.linkord.app.ui.components.LIcon
import com.linkord.app.ui.components.ServerTile
import com.linkord.app.ui.components.TileMark
import com.linkord.app.ui.components.mediaUrl
import com.linkord.app.ui.home.Entry
import com.linkord.app.ui.home.Section
import com.linkord.core.GuildInfo
import com.linkord.core.Kind
import com.linkord.core.Perm
import com.linkord.core.can
import com.linkord.core.channelLayout
import com.linkord.core.channelNumber
import com.linkord.core.removeGuild
import com.linkord.core.rolesOf
import com.linkord.core.t
import com.linkord.designsystem.AvatarShape
import com.linkord.designsystem.Linkord
import com.linkord.designsystem.LinkordIcons
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.toRequestBody

/** Seconds of silence the AFK channel can be set to (the server's AFK_TIMEOUTS). */
private val AFK_TIMEOUTS = listOf(60 to "1 minute", 300 to "5 minutes", 900 to "15 minutes", 1800 to "30 minutes", 3600 to "1 hour")

/** A picture waiting for Save: new bytes, or null bytes = take the current one off. */
private class Staged(val bytes: ByteArray?)

/**
 * Server Settings on a phone: a live preview of the icon and banner as the server list shows them, the name,
 * system messages, the AFK channel, roles and channel order. Nothing changes until Save Changes; leaving with
 * unsaved changes asks first.
 */
@Composable
fun ServerSettingsScreen(guildId: String) {
    val session = LocalContext.current.session
    val st by session.store.state.collectAsState()
    val nav = LocalNav.current
    val c = Linkord.colors
    val scope = rememberCoroutineScope()
    val g = st.guilds[guildId] ?: return
    val afkDefault = g.afkTimeout.takeIf { s -> AFK_TIMEOUTS.any { it.first == s } } ?: 300

    var name by remember(guildId) { mutableStateOf(g.name) }
    var icon by remember(guildId) { mutableStateOf<Staged?>(null) }
    var banner by remember(guildId) { mutableStateOf<Staged?>(null) }
    var join by remember(guildId) { mutableStateOf(g.joinMessages) }
    var system by remember(guildId) { mutableStateOf(g.systemChannelId) }
    var afk by remember(guildId) { mutableStateOf(g.afkChannelId) }
    var afkTimeout by remember(guildId) { mutableStateOf(afkDefault) }
    var busy by remember { mutableStateOf(false) }
    var leaving by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    var picking by remember { mutableStateOf<ImageKind?>(null) }
    var cropping by remember { mutableStateOf<Pair<ImageKind, Uri>?>(null) }

    fun fields() = buildMap<String, Any> {
        if (name.trim() != g.name) put("name", name.trim())
        if (join != g.joinMessages) put("join_messages", join)
        // A plain null would be dropped from the body: JsonNull clears the setting.
        if (system != g.systemChannelId) put("system_channel_id", system ?: JsonNull)
        if (afk != g.afkChannelId) put("afk_channel_id", afk ?: JsonNull)
        if (afkTimeout != afkDefault) put("afk_timeout", afkTimeout)
    }
    val dirty = fields().isNotEmpty() || icon != null || banner != null
    fun reset() {
        name = g.name
        icon = null
        banner = null
        join = g.joinMessages
        system = g.systemChannelId
        afk = g.afkChannelId
        afkTimeout = afkDefault
    }
    fun saved(info: GuildInfo) = session.store.update { it.copy(guilds = it.guilds.putting(guildId, info)) }
    suspend fun upload(path: String, bytes: ByteArray): GuildInfo {
        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("file", "$path.jpg", bytes.toRequestBody("image/jpeg".toMediaType())).build()
        return session.api.decode(session.api.raw("POST", "/guilds/$guildId/$path", body))
    }
    // Each part is cleared once it's saved, so a failure leaves only what didn't go through.
    fun save(thenLeave: Boolean = false) {
        if (busy || name.isBlank()) return
        busy = true
        scope.launch {
            runCatching {
                icon?.bytes?.let { saved(upload("icon", it)) }
                icon = null
                banner?.let { b ->
                    saved(if (b.bytes == null) session.api.decode(session.api.raw("DELETE", "/guilds/$guildId/banner")) else upload("banner", b.bytes))
                }
                banner = null
                val f = fields()
                if (f.isNotEmpty()) saved(session.api.patch<GuildInfo>("/guilds/$guildId", f))
            }.onSuccess {
                session.toast(t("Saved"))
                if (thenLeave) nav.pop()
            }.onFailure { session.toast(session.describe(it)) }
            busy = false
        }
    }
    fun back() = if (dirty) leaving = true else nav.pop()
    BackHandler(enabled = dirty) { leaving = true }

    val manageGuild = st.can(guildId, Perm.MANAGE_GUILD)
    val iconShown: Any? = icon?.bytes ?: mediaUrl(g.icon)
    val bannerShown: Any? = if (banner != null) banner!!.bytes else mediaUrl(g.banner)
    val layout = st.channelLayout(guildId)

    ScreenScaffold(t("Server Settings"), onBack = ::back) {
        Box(Modifier.fillMaxSize()) {
            Column(
                Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = if (dirty) 96.dp else 24.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                if (manageGuild) {
                    ServerPreview(
                        name = name.trim().ifEmpty { g.name }, icon = iconShown, banner = bannerShown,
                        channels = layout.all.take(4).map { (st.channelNumber(it) ?: "") to it },
                        onIcon = { picking = ImageKind.Avatar }, onBanner = { picking = ImageKind.Banner },
                    )
                    Row(Modifier.padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Pill(if (iconShown != null) t("Change icon") else t("Upload icon")) { picking = ImageKind.Avatar }
                        Pill(if (bannerShown != null) t("Change banner") else t("Upload banner")) { picking = ImageKind.Banner }
                        if (bannerShown != null) Pill(t("Remove banner"), danger = true) { banner = if (g.banner != null) Staged(null) else null }
                    }

                    SectionTitle(t("Overview"))
                    Section {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            OutlinedTextField(
                                name, { name = it.take(100) }, label = { Text(t("Server Name")) }, singleLine = true, isError = name.isBlank(),
                                modifier = Modifier.fillMaxWidth(),
                            )
                            Text(t("We recommend an image of at least 512×512 for the server."), style = Linkord.type.small, color = c.text3)
                            Text(t("Shown at the top of the channel list, behind the server name. Wide pictures work best (at least 960×540)."), style = Linkord.type.small, color = c.text3)
                        }
                    }

                    SectionTitle(t("System messages"))
                    Section {
                        SwitchRow(t("Send a message when someone joins this server"), checked = join) { join = it }
                        val texts = layout.all.filter { it.kind == Kind.TEXT }
                        ChoiceRow(
                            t("Channel for system messages"), enabled = join, selected = system,
                            options = listOf<Pair<String?, String>>(null to t("First text channel (default)")) + texts.map { it.id to "#${it.name}" },
                        ) { system = it }
                    }

                    SectionTitle(t("AFK channel"))
                    Section {
                        Text(
                            t("People who haven't talked for a while are moved to this voice channel. Off by default."),
                            style = Linkord.type.small, color = c.text3, modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp),
                        )
                        val voices = layout.all.filter { it.kind == Kind.VOICE }
                        ChoiceRow(
                            t("AFK channel"), selected = afk,
                            options = listOf<Pair<String?, String>>(null to t("No AFK channel")) + voices.map { it.id to it.name },
                        ) { afk = it }
                        ChoiceRow(t("AFK timeout"), enabled = afk != null, selected = afkTimeout, options = AFK_TIMEOUTS.map { it.first to t(it.second) }) { afkTimeout = it }
                    }
                }

                val roles = st.can(guildId, Perm.MANAGE_ROLES)
                val channels = st.can(guildId, Perm.MANAGE_CHANNELS)
                val bans = st.can(guildId, Perm.KICK_MEMBERS)
                if (roles || channels || bans) {
                    Spacer(Modifier.height(4.dp))
                    Section {
                        if (roles) Entry(LinkordIcons.Users, t("Roles"), trailing = (st.rolesOf(guildId).size - 1).toString()) { nav.push(Screen.Roles(guildId)) }
                        if (channels) Entry(LinkordIcons.Hash, t("Channels"), trailing = layout.all.size.toString()) { nav.push(Screen.ChannelOrder(guildId)) }
                        if (bans) Entry(LinkordIcons.NoSymbol, t("Banned")) { nav.push(Screen.Bans(guildId)) }
                    }
                }
                Text(t("Emoji and sounds are managed in the desktop or web app."), style = Linkord.type.small, color = c.text3, modifier = Modifier.padding(horizontal = 16.dp))
                if (g.ownerId == st.me?.id) Section { Entry(LinkordIcons.Trash, t("Delete Server"), danger = true) { confirmDelete = true } }
            }
            UnsavedBar(dirty, busy, canSave = name.isNotBlank(), onReset = ::reset, onSave = { save() }, modifier = Modifier.align(Alignment.BottomCenter))
        }
    }

    if (leaving) AlertDialog(
        onDismissRequest = { leaving = false },
        title = { Text(t("Careful — you have unsaved changes!")) },
        text = { Text(t("Save them before you leave, or discard them.")) },
        confirmButton = {
            TextButton(enabled = name.isNotBlank(), onClick = { leaving = false; save(thenLeave = true) }) { Text(t("Save Changes")) }
        },
        dismissButton = {
            TextButton(onClick = { leaving = false; reset(); nav.pop() }) { Text(t("Discard"), color = c.danger) }
        },
    )
    if (confirmDelete) AlertDialog(
        onDismissRequest = { confirmDelete = false },
        title = { Text(t("Delete '{name}'?", "name" to g.name)) },
        text = { Text(t("This can't be undone.")) },
        confirmButton = {
            TextButton(onClick = {
                confirmDelete = false
                scope.launch {
                    runCatching { session.api.send("DELETE", "/guilds/$guildId") }
                        .onSuccess { session.store.update { it.removeGuild(guildId) }; nav.pop() }
                        .onFailure { session.toast(session.describe(it)) }
                }
            }) { Text(t("Delete Server"), color = c.danger) }
        },
        dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text(t("Cancel")) } },
    )
    picking?.let { kind ->
        PhotoPicker(kind, onClose = { picking = null }, title = if (kind == ImageKind.Avatar) t("Choose an icon") else t("Choose a banner")) { uri -> cropping = kind to uri }
    }
    // Over the picker: cancelling the crop goes back to the photos, finishing stages the picture for Save.
    cropping?.let { (kind, uri) ->
        ImageCropper(uri, kind, onCancel = { cropping = null }) { picked ->
            cropping = null
            picking = null
            if (kind == ImageKind.Avatar) icon = Staged(picked.bytes) else banner = Staged(picked.bytes)
        }
    }
}

/**
 * The server as its members see it on a phone: the tile in the server column (active mark beside it) and the top
 * of the channel list with the banner, its fade and the name, drawn with the unsaved choices.
 */
@Composable
private fun ServerPreview(name: String, icon: Any?, banner: Any?, channels: List<Pair<String, com.linkord.core.Channel>>, onIcon: () -> Unit, onBanner: () -> Unit) {
    val c = Linkord.colors
    Row(Modifier.fillMaxWidth().height(250.dp).background(c.desk)) {
        Column(Modifier.width(72.dp).fillMaxHeight().padding(top = 14.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.width(72.dp), contentAlignment = Alignment.Center) {
                TileMark(active = true, unread = false)
                Box(Modifier.clickable(onClick = onIcon)) {
                    // A staged picture (bytes) or the current one (URL); initials when there's none.
                    if (icon != null) AsyncImage(icon, name, contentScale = ContentScale.Crop, modifier = Modifier.size(46.dp).clip(AvatarShape).background(c.raised))
                    else ServerTile(name, null, 46.dp)
                }
                Box(Modifier.align(Alignment.BottomEnd).padding(end = 6.dp).size(20.dp).clip(RoundedCornerShape(10.dp)).background(Color.Black.copy(alpha = 0.6f)), contentAlignment = Alignment.Center) {
                    LIcon(LinkordIcons.Edit, size = 12.dp, tint = Color.White)
                }
            }
            // Other servers, faded: only this one is being changed.
            repeat(3) { Box(Modifier.size(46.dp).clip(AvatarShape).background(c.raised.copy(alpha = 0.45f))) }
        }
        Box(Modifier.weight(1f).fillMaxHeight().padding(end = 8.dp, top = 6.dp).clip(RoundedCornerShape(topStart = 14.dp, topEnd = 14.dp)).background(c.panel)) {
            Column {
                // Same sizes and fade as the channel list's header (ServersTab.ChannelList).
                Box(Modifier.fillMaxWidth().height(if (banner != null) 132.dp else 72.dp).clickable(onClick = onBanner)) {
                    if (banner != null) {
                        AsyncImage(banner, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Color.Transparent, c.panel.copy(alpha = 0.92f)))))
                    }
                    Text(
                        name, style = Linkord.type.title, maxLines = 2, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.align(Alignment.BottomStart).padding(start = 16.dp, end = 48.dp, top = 12.dp, bottom = 12.dp),
                    )
                    EditBadge(Modifier.align(Alignment.TopEnd).padding(8.dp))
                }
                for ((i, pair) in channels.withIndex()) {
                    val (num, ch) = pair
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 1.dp).clip(RoundedCornerShape(10.dp))
                            .background(if (i == 0) c.active else Color.Transparent).padding(horizontal = 10.dp, vertical = 9.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (ch.kind == Kind.VOICE) LIcon(LinkordIcons.Speaker, size = 16.dp, tint = c.text3)
                        else Text(num.ifEmpty { "··" }, style = Linkord.type.label, color = c.text3, modifier = Modifier.width(22.dp))
                        Spacer(Modifier.width(8.dp))
                        Text(ch.name, style = Linkord.type.body, color = if (i == 0) c.text else c.text2, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
    }
}

@Composable
private fun SectionTitle(text: String) = Kicker(text, Modifier.padding(start = 24.dp, top = 8.dp))

@Composable
private fun Pill(text: String, danger: Boolean = false, onClick: () -> Unit) {
    val c = Linkord.colors
    Text(
        text, style = Linkord.type.small, color = if (danger) c.danger else c.text,
        modifier = Modifier.clip(RoundedCornerShape(10.dp)).background(c.raised).border(1.dp, c.line, RoundedCornerShape(10.dp))
            .clickable(onClick = onClick).padding(horizontal = 12.dp, vertical = 8.dp),
    )
}

/** A setting picked from a short list: the title, the current choice, and a menu with the choices. */
@Composable
fun <T> ChoiceRow(title: String, selected: T, options: List<Pair<T, String>>, enabled: Boolean = true, onPick: (T) -> Unit) {
    val c = Linkord.colors
    var open by remember { mutableStateOf(false) }
    Box {
        Row(
            Modifier.fillMaxWidth().clickable(enabled = enabled) { open = true }.padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(title, style = Linkord.type.body, color = if (enabled) c.text else c.text3)
                Text(options.firstOrNull { it.first == selected }?.second ?: options.first().second, style = Linkord.type.small, color = c.text3, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            LIcon(LinkordIcons.Chevron, size = 16.dp, tint = c.text3)
        }
        DropdownMenu(open, { open = false }) {
            for ((value, label) in options) DropdownMenuItem(
                text = { Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                trailingIcon = if (value == selected) ({ LIcon(LinkordIcons.Check, size = 16.dp, tint = c.text) }) else null,
                onClick = { open = false; onPick(value) },
            )
        }
    }
}

/** Discord's bar for unsaved changes: Reset puts everything back, Save Changes sends it. */
@Composable
fun UnsavedBar(visible: Boolean, busy: Boolean, canSave: Boolean = true, onReset: () -> Unit, onSave: () -> Unit, modifier: Modifier = Modifier) {
    val c = Linkord.colors
    AnimatedVisibility(
        visible, modifier,
        enter = slideInVertically(Linkord.motion.standard()) { it } + fadeIn(),
        exit = slideOutVertically(Linkord.motion.quick()) { it } + fadeOut(),
    ) {
        Row(
            Modifier.navigationBarsPadding().padding(12.dp).fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(c.raised)
                .border(1.dp, c.lineStrong, RoundedCornerShape(14.dp)).padding(start = 14.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(t("Careful — you have unsaved changes!"), style = Linkord.type.small, color = c.text, modifier = Modifier.weight(1f))
            TextButton(enabled = !busy, onClick = onReset) { Text(t("Reset"), color = c.text2) }
            Button(
                enabled = !busy && canSave, onClick = onSave,
                colors = ButtonDefaults.buttonColors(containerColor = c.brand, contentColor = c.onBrand),
            ) { Text(t("Save Changes")) }
        }
    }
}
