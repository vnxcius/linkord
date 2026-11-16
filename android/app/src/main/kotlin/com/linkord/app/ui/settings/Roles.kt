package com.linkord.app.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.linkord.app.session
import com.linkord.app.ui.LocalNav
import com.linkord.app.ui.Screen
import com.linkord.app.ui.chat.ScreenScaffold
import com.linkord.app.ui.components.Avatar
import com.linkord.app.ui.components.Kicker
import com.linkord.app.ui.components.LIcon
import com.linkord.core.Kind
import com.linkord.core.Member
import com.linkord.core.Overwrite
import com.linkord.core.Perm
import com.linkord.core.Role
import com.linkord.core.applyOverwrites
import com.linkord.core.can
import com.linkord.core.channelPerms
import com.linkord.core.guildPerms
import com.linkord.core.nameOf
import com.linkord.core.rolesOf
import com.linkord.core.t
import com.linkord.core.topRole
import com.linkord.designsystem.Linkord
import com.linkord.designsystem.LinkordIcons
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive

/** The web client's role colors (SettingsModals.tsx ROLE_COLORS). */
private val ROLE_COLORS = listOf(0x62d3d8, 0x5fb878, 0x5b8def, 0xb07ad8, 0xe06c9f, 0xdcb862, 0xe08a4f, 0xe0574f, 0x8a9a92, 0x4e6b5f)

private fun roleColor(c: Int?, fallback: Color) = c?.takeIf { it != 0 }?.let { Color(0xFF000000 or it.toLong()) } ?: fallback

/** A permission's bit, name and what it does: the web client's words (lib/perms.ts), so pt-BR already has them. */
private class PermItem(val bit: Long, val name: String, val hint: String)
private class PermGroup(val name: String, val items: List<PermItem>)

private val TEXT_PERMS = listOf(
    PermItem(Perm.SEND_MESSAGES, "Send Messages", ""),
    PermItem(Perm.ATTACH_FILES, "Attach Files", ""),
    PermItem(Perm.ADD_REACTIONS, "Add Reactions", ""),
    PermItem(Perm.READ_MESSAGE_HISTORY, "Read Message History", "See messages sent before they opened the channel."),
    PermItem(Perm.MENTION_EVERYONE, "Mention @everyone", "Notify everyone with @everyone or @here."),
    PermItem(Perm.MANAGE_MESSAGES, "Manage Messages", "Delete others' messages and pin messages."),
    PermItem(Perm.CREATE_THREADS, "Create Threads", ""),
    PermItem(Perm.MANAGE_THREADS, "Manage Threads", "Rename, archive and delete any thread."),
)
private val VOICE_PERMS = listOf(
    PermItem(Perm.CONNECT, "Connect", "Join voice channels."),
    PermItem(Perm.SPEAK, "Speak", "Talk in voice channels."),
    PermItem(Perm.STREAM, "Video", "Share their screen or turn on their camera."),
    PermItem(Perm.USE_SOUNDBOARD, "Use Soundboard", "Play soundboard sounds in calls."),
    PermItem(Perm.MOVE_MEMBERS, "Move Members", "Drag people between voice channels and disconnect them from calls."),
)
private val SERVER_PERMS = listOf(
    PermGroup("General", listOf(
        PermItem(Perm.ADMINISTRATOR, "Administrator", "Every permission, and can reorder roles. Dangerous."),
        PermItem(Perm.VIEW_CHANNEL, "View Channels", "See channels (unless a channel says otherwise)."),
        PermItem(Perm.MANAGE_GUILD, "Manage Server", "Rename the server and change its icon."),
        PermItem(Perm.MANAGE_CHANNELS, "Manage Channels", "Create, edit and delete channels."),
        PermItem(Perm.MANAGE_ROLES, "Manage Roles", "Create roles below their own and assign them."),
        PermItem(Perm.MANAGE_EMOJIS, "Manage Emoji", "Upload, rename and delete custom emoji."),
    )),
    PermGroup("Members", listOf(
        PermItem(Perm.CREATE_INVITE, "Create Invite", "Invite new people."),
        PermItem(Perm.CHANGE_NICKNAME, "Change Nickname", "Change their own nickname."),
        PermItem(Perm.MANAGE_NICKNAMES, "Manage Nicknames", "Change other members' nicknames."),
        PermItem(Perm.KICK_MEMBERS, "Kick Members", "Remove members below them."),
    )),
    PermGroup("Text", TEXT_PERMS),
    PermGroup("Voice", VOICE_PERMS),
)

/** What a channel's (or category's) Permissions page lists, by kind (lib/perms.ts channelPermInfo). */
private fun channelPermGroups(kind: Int): List<PermGroup> {
    val general = PermGroup("General", listOf(
        PermItem(Perm.VIEW_CHANNEL, "View Channel", "See this channel and, for text, read its messages."),
        PermItem(Perm.MANAGE_CHANNELS, "Manage Channel", "Rename it, change its topic and delete it."),
        PermItem(Perm.MANAGE_ROLES, "Manage Permissions", "Change this channel's permissions."),
        PermItem(Perm.CREATE_INVITE, "Create Invite", ""),
    ))
    return buildList {
        add(general)
        if (kind != Kind.VOICE) add(PermGroup("Text", TEXT_PERMS))
        if (kind != Kind.TEXT) add(PermGroup("Voice", VOICE_PERMS))
        // Voice channels have their own chat.
        if (kind == Kind.VOICE) add(PermGroup("Text", TEXT_PERMS))
    }
}

/** Server Settings -> Roles: highest first, @everyone last; tap to edit, arrows to move one (below your highest role). */
@Composable
fun RolesScreen(guildId: String) {
    val session = LocalContext.current.session
    val st by session.store.state.collectAsState()
    val nav = LocalNav.current
    val c = Linkord.colors
    val roles = st.rolesOf(guildId)
    val owner = st.guilds[guildId]?.ownerId == st.me?.id
    val top = st.topRole(guildId, st.me?.id)
    val canManage = st.can(guildId, Perm.MANAGE_ROLES)
    fun editable(r: Role) = owner || r.id == guildId || r.position < top
    fun move(r: Role, up: Boolean) {
        val list = roles.filter { it.id != guildId }.toMutableList()
        val i = list.indexOf(r)
        val j = if (up) i - 1 else i + 1
        if (j !in list.indices) return
        if (!owner && (!editable(list[j]))) return session.toast(t("You can only move roles below your highest role."))
        list[i] = list[j].also { list[j] = list[i] }
        session.launch { session.api.send("PUT", "/guilds/$guildId/roles", mapOf("ids" to list.map { it.id })) }
    }
    ScreenScaffold(t("Roles"), actions = {
        if (canManage) TextButton(onClick = {
            session.launch {
                val r = session.api.post<Role>("/guilds/$guildId/roles", mapOf("name" to t("new role")))
                nav.push(Screen.RoleEdit(guildId, r.id))
            }
        }) { Text(t("Create Role"), color = c.text) }
    }) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(vertical = 8.dp)) {
            val others = roles.filter { it.id != guildId }
            if (others.isEmpty()) Text(t("No roles yet."), color = c.text3, modifier = Modifier.padding(16.dp))
            for ((i, r) in roles.withIndex()) {
                val everyone = r.id == guildId
                Row(
                    Modifier.fillMaxWidth().clickable {
                        if (editable(r)) nav.push(Screen.RoleEdit(guildId, r.id)) else session.toast(t("You can only edit roles below your highest role."))
                    }.padding(start = 16.dp, end = 8.dp, top = 12.dp, bottom = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.size(14.dp).clip(CircleShape).background(roleColor(r.color, c.text3)))
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(if (everyone) "@everyone" else r.name, style = Linkord.type.body, color = c.text)
                        if (everyone) Text(t("@everyone applies to every member of the server."), style = Linkord.type.small, color = c.text3)
                    }
                    if (!editable(r)) LIcon(LinkordIcons.Lock, size = 16.dp, tint = c.text3)
                    else if (!everyone && canManage) {
                        val pos = others.indexOf(r)
                        Box(Modifier.size(36.dp).clip(CircleShape).clickable(enabled = pos > 0) { move(r, true) }, contentAlignment = Alignment.Center) {
                            LIcon(LinkordIcons.ChevronUpIcon, size = 16.dp, tint = if (pos > 0) c.text2 else c.text3.copy(alpha = 0.4f))
                        }
                        Box(Modifier.size(36.dp).clip(CircleShape).clickable(enabled = pos < others.lastIndex) { move(r, false) }, contentAlignment = Alignment.Center) {
                            LIcon(LinkordIcons.Chevron, size = 16.dp, tint = if (pos < others.lastIndex) c.text2 else c.text3.copy(alpha = 0.4f))
                        }
                    }
                }
                if (i < roles.lastIndex) HorizontalDivider(color = c.line, modifier = Modifier.padding(start = 42.dp))
            }
        }
    }
}

/** One role: name, color, how it shows, and its server-wide permissions. Saved with Save (top right). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun RoleEditScreen(guildId: String, roleId: String) {
    val session = LocalContext.current.session
    val st by session.store.state.collectAsState()
    val nav = LocalNav.current
    val c = Linkord.colors
    val role = st.roles[guildId]?.get(roleId)
    if (role == null) {
        // Deleted (here or elsewhere): nothing to edit.
        LaunchedEffect(Unit) { nav.pop() }
        return
    }
    val everyone = roleId == guildId
    var name by remember { mutableStateOf(role.name) }
    var color by remember { mutableStateOf(role.color?.takeIf { it != 0 }) }
    var hoist by remember { mutableStateOf(role.hoist) }
    var mentionable by remember { mutableStateOf(role.mentionable) }
    var permissions by remember { mutableStateOf(role.permissions) }
    var confirmDelete by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    val mine = st.guildPerms(guildId, st.me?.id)
    // Like the server's check_grant: only permissions you hold yourself can be handed out.
    fun grantable(bit: Long) = mine and Perm.ADMINISTRATOR != 0L || mine and bit != 0L
    val dirty = name.trim() != role.name || color != role.color?.takeIf { it != 0 } || hoist != role.hoist ||
        mentionable != role.mentionable || permissions != role.permissions

    ScreenScaffold(if (everyone) "@everyone" else t("Edit role"), actions = {
        TextButton(enabled = dirty && !busy && (everyone || name.isNotBlank()), onClick = {
            busy = true
            session.launch {
                try {
                    val body = buildMap<String, Any?> {
                        put("permissions", permissions)
                        if (!everyone) {
                            put("name", name.trim())
                            put("color", color?.let { JsonPrimitive(it) } ?: JsonNull)
                            put("hoist", hoist)
                            put("mentionable", mentionable)
                        }
                    }
                    session.api.patch<Role>("/guilds/$guildId/roles/$roleId", body)
                    session.toast(t("Role saved"))
                    nav.pop()
                } finally {
                    busy = false
                }
            }
        }) { Text(t("Save"), color = if (dirty) c.text else c.text3) }
    }) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(vertical = 12.dp)) {
            if (everyone) {
                Text(t("@everyone applies to every member of the server."), style = Linkord.type.small, color = c.text2, modifier = Modifier.padding(horizontal = 16.dp))
            } else {
                OutlinedTextField(name, { name = it.take(100) }, label = { Text(t("Role name")) }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp))
                Kicker(t("Role color"), Modifier.padding(start = 16.dp, top = 18.dp, bottom = 8.dp))
                FlowRow(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Swatch(null, color == null) { color = null }
                    for (rc in ROLE_COLORS) Swatch(rc, color == rc) { color = rc }
                }
                Text(t("Members use the color of the highest role they have."), style = Linkord.type.small, color = c.text3, modifier = Modifier.padding(start = 16.dp, top = 8.dp, end = 16.dp))
                Spacer(Modifier.height(8.dp))
                SwitchRow(t("Display role members separately"), t("Members with this role get their own group in the member list."), hoist) { hoist = it }
                SwitchRow(t("Allow anyone to @mention this role"), null, mentionable) { mentionable = it }
            }
            for (g in SERVER_PERMS) {
                Kicker(t(g.name), Modifier.padding(start = 16.dp, top = 20.dp, bottom = 4.dp))
                for (p in g.items) {
                    val on = permissions and p.bit != 0L
                    val enabled = grantable(p.bit)
                    // Like the server: only permissions you hold yourself can be handed out.
                    SwitchRow(t(p.name), p.hint.takeIf { it.isNotEmpty() }?.let { t(it) }, on, enabled = enabled) {
                        permissions = if (it) permissions or p.bit else permissions and p.bit.inv()
                    }
                }
            }
            if (!everyone) TextButton(onClick = { confirmDelete = true }, modifier = Modifier.padding(start = 6.dp, top = 16.dp)) {
                Text(t("Delete role"), color = c.danger)
            }
        }
    }
    if (confirmDelete) AlertDialog(
        onDismissRequest = { confirmDelete = false },
        title = { Text(t("Delete role")) },
        text = { Text(role.name) },
        confirmButton = {
            TextButton(onClick = {
                confirmDelete = false
                session.launch {
                    session.api.send("DELETE", "/guilds/$guildId/roles/$roleId")
                    session.toast(t("Role deleted"))
                    nav.pop()
                }
            }) { Text(t("Delete role"), color = c.danger) }
        },
        dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text(t("Cancel")) } },
    )
}

@Composable
private fun Swatch(color: Int?, selected: Boolean, onClick: () -> Unit) {
    val c = Linkord.colors
    Box(
        Modifier.size(34.dp).clip(CircleShape).background(roleColor(color, c.raised2))
            .border(if (selected) 3.dp else 1.dp, if (selected) c.text else c.line, CircleShape).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        if (selected) LIcon(LinkordIcons.Check, size = 16.dp, tint = if (color == null) c.text else Color.White)
    }
}

/**
 * A member's roles, from their profile in a server: a box per role, each change sent at once (PATCH members/{id}
 * {roles}). Roles at or above your highest one can't be given or taken (the server says the same).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MemberRolesSheet(guildId: String, userId: String, onDismiss: () -> Unit) {
    val session = LocalContext.current.session
    val st by session.store.state.collectAsState()
    val c = Linkord.colors
    val owner = st.guilds[guildId]?.ownerId == st.me?.id
    val top = st.topRole(guildId, st.me?.id)
    var held by remember { mutableStateOf(st.members[guildId]?.get(userId)?.roles.orEmpty().toSet()) }
    ModalBottomSheet(onDismiss, containerColor = c.panel) {
        Column(Modifier.navigationBarsPadding().padding(bottom = 12.dp)) {
            Text(t("Roles"), style = Linkord.type.title, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
            val list = st.rolesOf(guildId).filter { it.id != guildId }
            if (list.isEmpty()) Text(t("No roles yet."), color = c.text3, modifier = Modifier.padding(16.dp))
            for (r in list) {
                val allowed = owner || r.position < top
                val on = r.id in held
                Row(
                    Modifier.fillMaxWidth().clickable(enabled = allowed) {
                        val before = held
                        val next = if (on) held - r.id else held + r.id
                        held = next
                        session.launch {
                            try {
                                session.api.patch<Member>("/guilds/$guildId/members/$userId", mapOf("roles" to next.toList()))
                            } catch (e: Exception) {
                                held = before
                                throw e
                            }
                        }
                    }.padding(horizontal = 16.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.size(12.dp).clip(CircleShape).background(roleColor(r.color, c.text3)))
                    Text(r.name, style = Linkord.type.body, color = if (allowed) c.text else c.text3, modifier = Modifier.weight(1f).padding(start = 12.dp))
                    if (!allowed) LIcon(LinkordIcons.Lock, size = 16.dp, tint = c.text3)
                    Checkbox(on, null, enabled = allowed, colors = CheckboxDefaults.colors(checkedColor = c.brand, checkmarkColor = c.onBrand, uncheckedColor = c.lineStrong))
                }
            }
        }
    }
}

/** allow / neutral / deny for one permission of one role or member in a channel. */
private enum class Tri { Deny, Inherit, Allow }

/**
 * A channel's (or category's) permissions, like the web's: synced with its category or not, private or not, then per
 * @everyone / role / member a three-way switch for each permission. Saved with Save (PUT /channels/{id}/permissions).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ChannelPermissionsScreen(channelId: String) {
    val session = LocalContext.current.session
    val st by session.store.state.collectAsState()
    val nav = LocalNav.current
    val c = Linkord.colors
    val ch = st.channels[channelId]
    val gid = ch?.guildId
    if (ch == null || gid == null) {
        LaunchedEffect(Unit) { nav.pop() }
        return
    }
    val me = st.me?.id ?: return
    val saved = ch.permissionOverwrites.orEmpty()
    var draft by remember(saved) { mutableStateOf(saved) }
    var selected by remember { mutableStateOf(gid) }
    var adding by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    fun key(l: List<Overwrite>) = l.sortedWith(compareBy({ it.type }, { it.id })).map { listOf(it.id, it.type, it.allow, it.deny) }
    val dirty = key(draft) != key(saved)
    val admin = st.guilds[gid]?.ownerId == me || st.guildPerms(gid, me) and Perm.ADMINISTRATOR != 0L
    // Like Discord: you can only allow or deny what you have here yourself.
    fun canChange(bit: Long) = admin || st.channelPerms(channelId, me) and bit != 0L
    fun stateOf(id: String, bit: Long): Tri {
        val o = draft.firstOrNull { it.id == id }
        return when {
            o != null && o.allow and bit != 0L -> Tri.Allow
            o != null && o.deny and bit != 0L -> Tri.Deny
            else -> Tri.Inherit
        }
    }
    fun setBit(id: String, type: Int, bit: Long, to: Tri) {
        val o = draft.firstOrNull { it.id == id } ?: Overwrite(id, type)
        val next = o.copy(
            allow = if (to == Tri.Allow) o.allow or bit else o.allow and bit.inv(),
            deny = if (to == Tri.Deny) o.deny or bit else o.deny and bit.inv(),
        )
        draft = draft.filter { it.id != id } + next
    }
    val isPrivate = stateOf(gid, Perm.VIEW_CHANNEL) == Tri.Deny
    fun setPrivate(on: Boolean) {
        setBit(gid, 0, Perm.VIEW_CHANNEL, if (on) Tri.Deny else Tri.Inherit)
        // Don't lock yourself out: keep seeing it through your own overwrite.
        if (on && !admin) {
            val roles = st.members[gid]?.get(me)?.roles.orEmpty()
            if (applyOverwrites(st.guildPerms(gid, me), gid, me, roles, draft) and Perm.VIEW_CHANNEL == 0L) setBit(me, 1, Perm.VIEW_CHANNEL, Tri.Allow)
        }
    }
    val roles = st.roles[gid].orEmpty()
    // @everyone first, then roles highest first, then members.
    val targets = buildList {
        add(gid to 0)
        draft.filter { it.type == 0 && it.id != gid && roles[it.id] != null }.sortedByDescending { roles[it.id]!!.position }.forEach { add(it.id to 0) }
        draft.filter { it.type == 1 }.sortedBy { st.nameOf(it.id, gid, "") }.forEach { add(it.id to 1) }
    }
    val current = targets.firstOrNull { it.first == selected } ?: targets.first()
    fun label(t: Pair<String, Int>) = if (t.first == gid) "@everyone" else if (t.second == 0) roles[t.first]?.name ?: "?" else st.nameOf(t.first, gid, "?")
    val parent = ch.parentId?.let { st.channels[it] }?.takeIf { it.kind == Kind.CATEGORY }

    ScreenScaffold(t("Permissions"), actions = {
        TextButton(enabled = dirty && !busy, onClick = {
            busy = true
            session.launch {
                try {
                    session.api.send("PUT", "/channels/$channelId/permissions", mapOf("permission_overwrites" to draft.map {
                        mapOf("id" to it.id, "type" to it.type, "allow" to it.allow, "deny" to it.deny)
                    }))
                    session.toast(t("Permissions saved"))
                } finally {
                    busy = false
                }
            }
        }) { Text(t("Save"), color = if (dirty) c.text else c.text3) }
    }) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(vertical = 8.dp)) {
            Text(if (ch.kind == Kind.CATEGORY) ch.name else "#${ch.name}", style = Linkord.type.small, color = c.text3, modifier = Modifier.padding(horizontal = 16.dp))
            if (parent != null) {
                val synced = key(saved) == key(parent.permissionOverwrites.orEmpty())
                Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        if (synced) t("Permissions synced with category: {name}", "name" to parent.name) else t("Permissions not synced with category: {name}", "name" to parent.name),
                        style = Linkord.type.small, color = c.text2, modifier = Modifier.weight(1f),
                    )
                    if (!synced) TextButton(onClick = {
                        session.launch {
                            session.api.send("POST", "/channels/$channelId/permissions/sync")
                            session.toast(t("Synced"))
                        }
                    }) { Text(t("Sync Now"), color = c.text) }
                }
            }
            if (ch.kind == Kind.CATEGORY) Text(t("Channels synced with this category get the same permissions."), style = Linkord.type.small, color = c.text3, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
            SwitchRow(if (ch.kind == Kind.CATEGORY) t("Private Category") else t("Private Channel"), t("Only the roles and members you add below can see it."), isPrivate,
                enabled = canChange(Perm.VIEW_CHANNEL)) { setPrivate(it) }
            Kicker(t("Roles / Members"), Modifier.padding(start = 16.dp, top = 12.dp, bottom = 6.dp))
            LazyRow(contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                items(targets, key = { it.first }) { tg ->
                    val on = tg.first == current.first
                    Row(
                        Modifier.clip(RoundedCornerShape(10.dp)).background(if (on) c.brand else c.raised).clickable { selected = tg.first }.padding(horizontal = 10.dp, vertical = 7.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (tg.second == 0) Box(Modifier.size(10.dp).clip(CircleShape).background(roleColor(roles[tg.first]?.color, c.text3)))
                        else Avatar(st.users[tg.first], 18.dp)
                        Text(label(tg), style = Linkord.type.small, color = if (on) c.onBrand else c.text, modifier = Modifier.padding(start = 6.dp))
                    }
                }
                item {
                    Box {
                        Box(Modifier.clip(RoundedCornerShape(10.dp)).background(c.raised).clickable { adding = true }.padding(horizontal = 10.dp, vertical = 7.dp)) {
                            LIcon(LinkordIcons.Plus, size = 16.dp, tint = c.text)
                        }
                        DropdownMenu(adding, { adding = false }) {
                            val have = draft.map { it.id }.toSet() + gid
                            val rs = st.rolesOf(gid).filter { it.id !in have }
                            val ms = st.members[gid].orEmpty().keys.filter { it !in have }.sortedBy { st.nameOf(it, gid, "") }
                            if (rs.isEmpty() && ms.isEmpty()) DropdownMenuItem(text = { Text(t("Everyone is already here")) }, enabled = false, onClick = {})
                            for (r in rs) DropdownMenuItem(
                                text = { Text(r.name) },
                                leadingIcon = { Box(Modifier.size(10.dp).clip(CircleShape).background(roleColor(r.color, c.text3))) },
                                onClick = { adding = false; draft = draft + Overwrite(r.id, 0); selected = r.id },
                            )
                            if (rs.isNotEmpty() && ms.isNotEmpty()) HorizontalDivider(color = c.line)
                            for (id in ms) DropdownMenuItem(
                                text = { Text(st.nameOf(id, gid, "?")) },
                                leadingIcon = { Avatar(st.users[id], 20.dp) },
                                onClick = { adding = false; draft = draft + Overwrite(id, 1); selected = id },
                            )
                        }
                    }
                }
            }
            if (current.first != gid) TextButton(onClick = { draft = draft.filter { it.id != current.first }; selected = gid }, modifier = Modifier.padding(start = 6.dp)) {
                Text(t("Remove"), color = c.danger)
            }
            for (g in channelPermGroups(ch.kind)) {
                Kicker(t(g.name), Modifier.padding(start = 16.dp, top = 16.dp, bottom = 2.dp))
                for (p in g.items) {
                    val enabled = canChange(p.bit)
                    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(t(p.name), style = Linkord.type.body, color = if (enabled) c.text else c.text3)
                            if (p.hint.isNotEmpty()) Text(t(p.hint), style = Linkord.type.small, color = c.text3)
                        }
                        Spacer(Modifier.width(10.dp))
                        TriSwitch(stateOf(current.first, p.bit), enabled) { setBit(current.first, current.second, p.bit, it) }
                    }
                }
            }
        }
    }
}

/** Deny ✕ / Inherit / / Allow ✓, the chosen one filled (red, neutral, green: status colors with a glyph). */
@Composable
private fun TriSwitch(value: Tri, enabled: Boolean, onChange: (Tri) -> Unit) {
    val c = Linkord.colors
    Row(Modifier.clip(RoundedCornerShape(10.dp)).background(c.raised)) {
        for (v in Tri.entries) {
            val on = v == value
            val bg = when {
                !on -> Color.Transparent
                v == Tri.Deny -> c.danger
                v == Tri.Allow -> c.speaking
                else -> c.raised2
            }
            Box(
                Modifier.size(width = 40.dp, height = 34.dp).background(bg).clickable(enabled = enabled && !on) { onChange(v) },
                contentAlignment = Alignment.Center,
            ) {
                val tint = if (on && v != Tri.Inherit) Color.White else if (enabled) c.text2 else c.text3.copy(alpha = 0.5f)
                when (v) {
                    Tri.Deny -> LIcon(LinkordIcons.Close, size = 16.dp, tint = tint)
                    Tri.Inherit -> Text("/", style = Linkord.type.body, color = tint)
                    Tri.Allow -> LIcon(LinkordIcons.Check, size = 16.dp, tint = tint)
                }
            }
        }
    }
}
