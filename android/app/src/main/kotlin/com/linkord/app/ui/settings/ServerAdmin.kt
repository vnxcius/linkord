package com.linkord.app.ui.settings

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.linkord.app.data.Session
import com.linkord.app.session
import com.linkord.app.ui.LocalNav
import com.linkord.app.ui.chat.ScreenScaffold
import com.linkord.app.ui.components.Kicker
import com.linkord.app.ui.components.ServerTile
import com.linkord.app.ui.home.Section
import com.linkord.core.Channel
import com.linkord.core.Guild
import com.linkord.core.GuildInfo
import com.linkord.core.Kind
import com.linkord.core.addGuild
import com.linkord.core.channelLayout
import com.linkord.core.removeGuild
import com.linkord.core.rolesOf
import com.linkord.core.can
import com.linkord.core.t
import com.linkord.designsystem.Linkord
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.toRequestBody

@Serializable
private data class Invite(val code: String)

/** Makes an invite (7 days) and opens Android's share sheet with its link. */
suspend fun shareInvite(session: Session, guildId: String) {
    val inv = session.api.post<Invite>("/guilds/$guildId/invites", mapOf("max_age" to 7 * 24 * 3600))
    val link = "${session.serverUrl()}/invite/${inv.code}"
    val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, link)
    session.context.startActivity(Intent.createChooser(send, t("Invite friends")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
}

/** A new channel: text or voice, in a category or at the top. */
@Composable
fun NewChannelDialog(guildId: String, onDismiss: () -> Unit) {
    val session = LocalContext.current.session
    val st = session.store.s
    val c = Linkord.colors
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf("") }
    var voice by remember { mutableStateOf(false) }
    val cats = st.channelLayout(guildId).categories.map { it.category }
    var parent by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(t("Create Channel")) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    for ((v, label) in listOf(false to t("Text"), true to t("Voice"))) Text(
                        label, style = Linkord.type.small, color = if (voice == v) c.onBrand else c.text,
                        modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(if (voice == v) c.brand else c.raised).clickable { voice = v }.padding(horizontal = 12.dp, vertical = 6.dp),
                    )
                }
                OutlinedTextField(name, { name = if (voice) it else it.lowercase().replace(' ', '-') }, label = { Text(t("Channel Name")) }, singleLine = true)
                if (cats.isNotEmpty()) {
                    Kicker(t("Category"))
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        for ((id, label) in listOf<Pair<String?, String>>(null to t("None")) + cats.map { it.id to it.name }) Text(
                            label, style = Linkord.type.small, color = if (parent == id) c.onBrand else c.text,
                            modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(if (parent == id) c.brand else c.raised).clickable { parent = id }.padding(horizontal = 10.dp, vertical = 6.dp),
                        )
                    }
                }
            }
        },
        confirmButton = {
            TextButton(enabled = name.isNotBlank(), onClick = {
                scope.launch {
                    runCatching { session.api.post<Channel>("/guilds/$guildId/channels", mapOf("name" to name.trim(), "kind" to if (voice) Kind.VOICE else Kind.TEXT, "parent_id" to parent)) }
                        .onSuccess { ch -> session.store.update { it.copy(channels = it.channels.putting(ch.id, ch)) }; onDismiss() }
                        .onFailure { session.toast(session.describe(it)) }
                }
            }) { Text(t("Create Channel")) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(t("Cancel")) } },
    )
}

/** Rename a channel, change its topic, or delete it. */
@Composable
fun EditChannelDialog(channel: Channel, onDismiss: () -> Unit) {
    val session = LocalContext.current.session
    val st by session.store.state.collectAsState()
    val nav = com.linkord.app.ui.LocalNav.current
    val c = Linkord.colors
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf(channel.name) }
    var topic by remember { mutableStateOf(channel.topic) }
    var deleting by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (deleting) t("Delete #{name}?", "name" to channel.name) else t("Edit Channel")) },
        text = {
            if (deleting) Text(t("Its messages go with it. This can't be undone."))
            else Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(name, { name = it }, label = { Text(t("Channel Name")) }, singleLine = true)
                if (channel.kind == Kind.TEXT) OutlinedTextField(topic, { topic = it.take(1024) }, label = { Text(t("Topic")) }, maxLines = 4)
                if (st.can(channel.guildId, com.linkord.core.Perm.MANAGE_ROLES, channel.id)) Text(t("Permissions"), color = c.text, style = Linkord.type.small,
                    modifier = Modifier.clickable { onDismiss(); nav.push(com.linkord.app.ui.Screen.ChannelPermissions(channel.id)) }.padding(vertical = 6.dp))
                Text(t("Delete Channel"), color = c.danger, style = Linkord.type.small, modifier = Modifier.clickable { deleting = true }.padding(vertical = 6.dp))
            }
        },
        confirmButton = {
            TextButton(onClick = {
                scope.launch {
                    if (deleting) runCatching { session.api.send("DELETE", "/channels/${channel.id}") }.onSuccess { onDismiss() }.onFailure { session.toast(session.describe(it)) }
                    else runCatching { session.api.patch<Channel>("/channels/${channel.id}", mapOf("name" to name.trim(), "topic" to topic)) }
                        .onSuccess { onDismiss() }.onFailure { session.toast(session.describe(it)) }
                }
            }) { Text(if (deleting) t("Delete Channel") else t("Save"), color = if (deleting) c.danger else c.text) }
        },
        dismissButton = { TextButton(onClick = { if (deleting) deleting = false else onDismiss() }) { Text(t("Cancel")) } },
    )
}

/** The + tile: join with an invite, or make a server of your own. */
@Composable
fun AddServerScreen(initialCode: String) {
    val session = LocalContext.current.session
    val nav = LocalNav.current
    val c = Linkord.colors
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf("") }
    Column(Modifier.fillMaxSize().imePadding()) {
        Column(Modifier.weight(1f)) { JoinServerScreen(initialCode) }
        Section {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Kicker(t("Or create your own"))
                OutlinedTextField(name, { name = it.take(100) }, label = { Text(t("Server Name")) }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Button(
                    enabled = name.isNotBlank(),
                    onClick = {
                        scope.launch {
                            runCatching { session.api.post<Guild>("/guilds", mapOf("name" to name.trim())) }
                                .onSuccess { g -> session.store.update { it.addGuild(g) }; session.actions.selectView(g.id); nav.pop() }
                                .onFailure { session.toast(session.describe(it)) }
                        }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = c.brand, contentColor = c.onBrand),
                    modifier = Modifier.fillMaxWidth().height(48.dp),
                ) { Text(t("Create Server")) }
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}
