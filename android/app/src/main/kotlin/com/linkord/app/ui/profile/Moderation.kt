package com.linkord.app.ui.profile

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ModalBottomSheet
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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.linkord.app.session
import com.linkord.app.ui.LocalNav
import com.linkord.app.ui.chat.ScreenScaffold
import com.linkord.app.ui.components.Avatar
import com.linkord.app.ui.components.Kicker
import com.linkord.app.ui.components.LIcon
import com.linkord.core.Kind
import com.linkord.core.Perm
import com.linkord.core.State
import com.linkord.core.User
import com.linkord.core.can
import com.linkord.core.nameOf
import com.linkord.core.t
import com.linkord.core.topRole
import com.linkord.designsystem.Linkord
import com.linkord.designsystem.LinkordIcons
import kotlinx.coroutines.launch

/** You stand above [userId] in the server (your highest role is higher, or you own it): the server's `outranks`. */
fun State.outranks(guildId: String, userId: String): Boolean =
    me?.id != userId && guilds[guildId]?.ownerId != userId && topRole(guildId, me?.id) > topRole(guildId, userId)

/** Voice channels [userId] can be moved to from where they are, if you may move them at all (web: voiceModItems). */
fun State.moveTargets(guildId: String, userId: String): List<com.linkord.core.Channel>? {
    val from = voice[userId]?.channelId ?: return null
    if (channels[from]?.guildId != guildId || !can(guildId, Perm.MOVE_MEMBERS, from)) return null
    return channels.values
        .filter { it.guildId == guildId && it.kind == Kind.VOICE && it.id != from && can(guildId, Perm.MOVE_MEMBERS, it.id) && can(guildId, Perm.CONNECT, it.id) }
        .sortedBy { it.position }
}

private enum class Confirm { Kick, Ban }

/**
 * What you can do to someone as a moderator, on their server profile: move them to another voice channel or out of
 * the call, change their nickname, kick or ban them (both asked first). Only what your roles allow is listed; nothing
 * at all for yourself, the owner or people at or above your highest role.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ModerationCard(guildId: String, userId: String, user: User) {
    val session = LocalContext.current.session
    val st by session.store.state.collectAsState()
    val nav = LocalNav.current
    val c = Linkord.colors
    val scope = rememberCoroutineScope()
    val name = st.nameOf(userId, guildId, user.name)
    val targets = st.moveTargets(guildId, userId)
    val outranks = st.outranks(guildId, userId)
    val nick = outranks && st.can(guildId, Perm.MANAGE_NICKNAMES)
    val remove = outranks && st.can(guildId, Perm.KICK_MEMBERS)
    if (targets == null && !nick && !remove) return

    var moving by remember { mutableStateOf(false) }
    var naming by remember { mutableStateOf(false) }
    var confirm by remember { mutableStateOf<Confirm?>(null) }
    fun run(done: String? = null, leave: Boolean = false, f: suspend () -> Unit) = scope.launch {
        runCatching { f() }
            .onSuccess { done?.let(session::toast); if (leave) nav.pop() }
            .onFailure { session.toast(session.describe(it)) }
    }

    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp).clip(RoundedCornerShape(14.dp)).background(c.panel).padding(vertical = 8.dp)) {
        Row(Modifier.padding(horizontal = 16.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            LIcon(LinkordIcons.Shield, size = 14.dp, tint = c.text3)
            Spacer(Modifier.width(6.dp))
            Kicker(t("Moderation"))
        }
        if (targets != null) {
            val here = st.voice[userId]?.channelId?.let { st.channels[it]?.name } ?: ""
            if (targets.isNotEmpty() && !user.bot) ModRow(LinkordIcons.Speaker, t("Move To"), here) { moving = true }
            ModRow(LinkordIcons.Hangup, t("Disconnect"), t("Leaves the call, stays in the server"), danger = true) {
                run(t("You disconnected {name}.", "name" to name)) { session.actions.moveMember(guildId, userId, null) }
            }
        }
        if (nick) ModRow(LinkordIcons.Edit, t("Edit nickname"), st.members[guildId]?.get(userId)?.nickname ?: t("No nickname")) { naming = true }
        if (remove) {
            if (targets != null || nick) HorizontalDivider(Modifier.padding(horizontal = 16.dp, vertical = 4.dp), color = c.line)
            ModRow(LinkordIcons.UserMinus, t("Kick {name}", "name" to name), t("They can rejoin with a new invite."), danger = true) { confirm = Confirm.Kick }
            ModRow(LinkordIcons.NoSymbol, t("Ban {name}", "name" to name), t("They can't come back, even with an invite."), danger = true) { confirm = Confirm.Ban }
        }
    }

    if (moving && targets != null) ModalBottomSheet({ moving = false }, containerColor = c.panel) {
        Column(Modifier.navigationBarsPadding().padding(bottom = 12.dp)) {
            Kicker(t("Move {name} to", "name" to name), Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
            for (ch in targets) {
                val count = st.voice.values.count { it.channelId == ch.id }
                ModRow(LinkordIcons.Speaker, ch.name, if (count > 0) com.linkord.core.plural(count, "{n} person", "{n} people") else null) {
                    moving = false
                    run { session.actions.moveMember(guildId, userId, ch.id) }
                }
            }
        }
    }

    if (naming) {
        var text by remember { mutableStateOf(st.members[guildId]?.get(userId)?.nickname ?: "") }
        AlertDialog(
            onDismissRequest = { naming = false },
            containerColor = c.panel,
            title = { Text(t("Edit nickname")) },
            text = {
                OutlinedTextField(
                    text, { if (it.length <= 32) text = it }, singleLine = true, label = { Text(t("Nickname")) }, placeholder = { Text(user.name) },
                    modifier = Modifier.fillMaxWidth(),
                )
            },
            confirmButton = {
                TextButton(onClick = { naming = false; run { session.actions.setNickname(guildId, userId, text.trim()) } }) { Text(t("Save")) }
            },
            dismissButton = {
                Row {
                    if (st.members[guildId]?.get(userId)?.nickname != null) TextButton(onClick = { naming = false; run { session.actions.setNickname(guildId, userId, "") } }) {
                        Text(t("Reset nickname"), color = c.text2)
                    }
                    TextButton(onClick = { naming = false }) { Text(t("Cancel")) }
                }
            },
        )
    }

    confirm?.let { what ->
        val kick = what == Confirm.Kick
        AlertDialog(
            onDismissRequest = { confirm = null },
            containerColor = c.panel,
            icon = { LIcon(if (kick) LinkordIcons.UserMinus else LinkordIcons.NoSymbol, size = 28.dp, tint = c.danger) },
            title = { Text(if (kick) t("Kick {name}", "name" to name) else t("Ban {name}", "name" to name)) },
            text = {
                Text(
                    if (kick) t("They can rejoin with a new invite.")
                    else t("They're removed and can't come back, even with an invite, until you unban them in Server Settings."),
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirm = null
                    if (kick) run(t("You kicked {name}.", "name" to name), leave = true) { session.actions.kick(guildId, userId) }
                    else run(t("You banned {name}.", "name" to name), leave = true) { session.actions.ban(guildId, userId) }
                }) { Text(if (kick) t("Kick") else t("Ban"), color = c.danger) }
            },
            dismissButton = { TextButton(onClick = { confirm = null }) { Text(t("Cancel")) } },
        )
    }
}

@Composable
private fun ModRow(icon: ImageVector, label: String, hint: String?, danger: Boolean = false, onClick: () -> Unit) {
    val c = Linkord.colors
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 11.dp), verticalAlignment = Alignment.CenterVertically) {
        LIcon(icon, tint = if (danger) c.danger else c.text2)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(label, style = Linkord.type.body, color = if (danger) c.danger else c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (!hint.isNullOrEmpty()) Text(hint, style = Linkord.type.small, color = c.text3, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** Who is banned from a server, with Unban (Server Settings -> Banned; web: SettingsModals BanList). */
@Composable
fun BansScreen(guildId: String) {
    val session = LocalContext.current.session
    val scope = rememberCoroutineScope()
    val c = Linkord.colors
    var bans by remember { mutableStateOf<List<User>?>(null) }
    LaunchedEffect(guildId) {
        runCatching { session.api.get<List<User>>("/guilds/$guildId/bans") }.onSuccess { bans = it }.onFailure { bans = emptyList(); session.toast(session.describe(it)) }
    }
    ScreenScaffold(t("Banned")) {
        val list = bans
        when {
            list == null -> {}
            list.isEmpty() -> Text(t("No one is banned from this server."), style = Linkord.type.small, color = c.text3, modifier = Modifier.padding(16.dp))
            else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(12.dp)) {
                items(list, key = { it.id }) { u ->
                    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Avatar(u, 40.dp)
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            Text(u.name, style = Linkord.type.bodyStrong, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(u.username, style = Linkord.type.mono, color = c.text3, maxLines = 1)
                        }
                        TextButton(onClick = {
                            scope.launch {
                                runCatching { session.actions.unban(guildId, u.id) }
                                    .onSuccess { bans = bans?.filter { it.id != u.id } }
                                    .onFailure { session.toast(session.describe(it)) }
                            }
                        }) { Text(t("Unban"), color = c.text) }
                    }
                }
            }
        }
    }
}

/** The moderation entries for a voice tile's menu (the call screen): move and disconnect, when you may. */
@Composable
fun VoiceModItems(guildId: String?, userId: String, onDone: () -> Unit) {
    val session = LocalContext.current.session
    val st by session.store.state.collectAsState()
    val scope = rememberCoroutineScope()
    val c = Linkord.colors
    if (guildId == null) return
    val targets = st.moveTargets(guildId, userId) ?: return
    var open by remember { mutableStateOf(false) }
    fun move(to: String?) {
        onDone()
        scope.launch { runCatching { session.actions.moveMember(guildId, userId, to) }.onFailure { session.toast(session.describe(it)) } }
    }
    if (targets.isNotEmpty() && st.users[userId]?.bot != true) {
        androidx.compose.material3.DropdownMenuItem(
            text = { Text(t("Move To")) },
            leadingIcon = { LIcon(LinkordIcons.Speaker, size = 18.dp) },
            trailingIcon = { LIcon(if (open) LinkordIcons.ChevronUpIcon else LinkordIcons.Chevron, size = 16.dp, tint = c.text3) },
            onClick = { open = !open },
        )
        if (open) for (ch in targets) androidx.compose.material3.DropdownMenuItem(
            text = { Text(ch.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
            modifier = Modifier.padding(start = 16.dp),
            onClick = { move(ch.id) },
        )
    }
    androidx.compose.material3.DropdownMenuItem(
        text = { Text(t("Disconnect"), color = c.danger) },
        leadingIcon = { LIcon(LinkordIcons.Hangup, size = 18.dp, tint = c.danger) },
        onClick = { move(null) },
    )
}
