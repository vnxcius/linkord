package com.linkord.app.ui.home

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import com.linkord.app.session
import com.linkord.app.ui.LocalNav
import com.linkord.app.ui.Screen
import com.linkord.app.ui.components.Avatar
import com.linkord.app.ui.components.CountBadge
import com.linkord.app.ui.components.Kicker
import com.linkord.app.ui.components.LIcon
import com.linkord.app.ui.components.ServerTile
import com.linkord.app.ui.components.TileMark
import com.linkord.app.ui.components.mediaUrl
import com.linkord.core.Channel
import com.linkord.core.Kind
import com.linkord.core.State
import com.linkord.core.activeThreads
import com.linkord.core.can
import com.linkord.core.removeGuild
import com.linkord.core.channelAlert
import com.linkord.core.channelLayout
import com.linkord.core.channelNumber
import com.linkord.core.dmMentions
import com.linkord.core.guildAlert
import com.linkord.core.guildMentions
import com.linkord.core.guildUnread
import com.linkord.core.isMuted
import com.linkord.core.isUnread
import com.linkord.core.nameOf
import com.linkord.core.t
import com.linkord.core.voiceMembers
import com.linkord.designsystem.AvatarShape
import com.linkord.designsystem.Linkord
import com.linkord.designsystem.LinkordIcons
import com.linkord.designsystem.LinkordMark

@Composable
fun ServersTab(onOpenChannel: (String) -> Unit) {
    val session = LocalContext.current.session
    val st by session.store.state.collectAsState()
    Row(Modifier.fillMaxSize().statusBarsPadding()) {
        ServerColumn(st, onSelect = { session.actions.selectView(it) })
        Box(
            Modifier.weight(1f).fillMaxHeight().padding(end = 8.dp, top = 6.dp)
                .clip(RoundedCornerShape(topStart = 14.dp, topEnd = 14.dp)).background(Linkord.colors.panel),
        ) {
            if (st.view == "@me") DmList(onOpenChannel, showHeader = true)
            else ChannelList(st, st.view, onOpenChannel)
        }
    }
}

/** The vertical server column: Direct Messages, then servers (folders open as groups), then "join / create". */
@Composable
private fun ServerColumn(st: State, onSelect: (String) -> Unit) {
    val nav = LocalNav.current
    val c = Linkord.colors
    val haptics = LocalHapticFeedback.current
    // Folders' order first (Discord's guild_folders), then servers no folder lists.
    val folders = st.settings.guildFolders
    val listed = folders.flatMap { it.guildIds }.toSet()
    val entries: List<List<String>> = folders.map { f -> f.guildIds.filter { st.guilds[it] != null } }.filter { it.isNotEmpty() } +
        st.guildOrder.filter { it !in listed }.map { listOf(it) }
    LazyColumn(
        Modifier.width(72.dp).fillMaxHeight(),
        contentPadding = PaddingValues(vertical = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        item {
            val active = st.view == "@me"
            Box(Modifier.width(72.dp), contentAlignment = Alignment.Center) {
                TileMark(active, false)
                Box(
                    Modifier.size(46.dp).clip(AvatarShape).background(if (active) c.brand else c.raised).clickable { onSelect("@me") },
                    contentAlignment = Alignment.Center,
                ) { LIcon(LinkordMark, size = 26.dp, tint = if (active) c.onBrand else c.text) }
                CountBadge(st.dmMentions(), Modifier.align(Alignment.BottomEnd).padding(end = 10.dp))
            }
        }
        item { HorizontalDivider(Modifier.width(32.dp), color = c.lineStrong) }
        for (group in entries) {
            if (group.size > 1) item { Box(Modifier.width(36.dp).height(2.dp).clip(RoundedCornerShape(1.dp)).background(c.lineStrong)) }
            items(group, key = { it }) { id ->
                val g = st.guilds[id] ?: return@items
                val active = st.view == id
                var menu by remember { mutableStateOf(false) }
                Box(Modifier.width(72.dp), contentAlignment = Alignment.Center) {
                    TileMark(active, !active && st.guildUnread(id))
                    ServerTile(
                        g.name, g.icon, 46.dp, active = false,
                        modifier = Modifier.combinedClickable(onClick = { onSelect(id) }, onLongClick = {
                            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                            menu = true
                        }),
                    )
                    val mentions = st.guildMentions(id)
                    if (mentions > 0) CountBadge(mentions, Modifier.align(Alignment.BottomEnd).padding(end = 10.dp))
                    else if (st.guildAlert(id) && !active) Box(Modifier.align(Alignment.BottomEnd).padding(end = 12.dp, bottom = 2.dp).size(12.dp).clip(RoundedCornerShape(6.dp)).background(c.desk).padding(2.dp).clip(RoundedCornerShape(4.dp)).background(c.danger))
                    GuildMenu(menu, { menu = false }, id)
                }
            }
        }
        item { HorizontalDivider(Modifier.width(32.dp), color = c.lineStrong) }
        item {
            Box(
                Modifier.size(46.dp).clip(AvatarShape).background(c.raised).clickable { nav.push(Screen.JoinServer()) },
                contentAlignment = Alignment.Center,
            ) { LIcon(LinkordIcons.Plus, size = 22.dp, tint = c.text) }
        }
    }
}

@Composable
private fun GuildMenu(open: Boolean, onDismiss: () -> Unit, guildId: String) {
    val session = LocalContext.current.session
    val st by session.store.state.collectAsState()
    val nav = LocalNav.current
    DropdownMenu(open, onDismiss) {
        if (st.can(guildId, com.linkord.core.Perm.CREATE_INVITE)) DropdownMenuItem(text = { Text(t("Invite People")) }, onClick = {
            onDismiss()
            session.launch { com.linkord.app.ui.settings.shareInvite(session, guildId) }
        })
        if (canOpenSettings(st, guildId)) DropdownMenuItem(text = { Text(t("Server Settings")) }, onClick = {
            onDismiss()
            nav.push(Screen.ServerSettings(guildId))
        })
        DropdownMenuItem(text = { Text(t("Mark as read")) }, onClick = {
            session.actions.markRead(st.channels.values.filter { it.guildId == guildId && st.isUnread(it) }.map { it.id })
            onDismiss()
        })
        DropdownMenuItem(text = { Text(if (guildId in st.settings.mutedGuilds) t("Unmute server") else t("Mute server")) }, onClick = {
            session.actions.toggleMuteGuild(guildId)
            onDismiss()
        })
        if (st.guilds[guildId]?.ownerId != st.me?.id) DropdownMenuItem(text = { Text(t("Leave Server"), color = Linkord.colors.danger) }, onClick = {
            onDismiss()
            session.launch {
                session.api.send("DELETE", "/guilds/$guildId/members/@me")
                session.store.update { it.removeGuild(guildId) }
            }
        })
    }
}

/** Server Settings opens for whoever may change something there: the server itself, roles or the channel order. */
private fun canOpenSettings(st: State, guildId: String) =
    st.can(guildId, com.linkord.core.Perm.MANAGE_GUILD) || st.can(guildId, com.linkord.core.Perm.MANAGE_ROLES) || st.can(guildId, com.linkord.core.Perm.MANAGE_CHANNELS)

/** A server's channels: banner and name on top, then channels without a category, then each category. */
@Composable
private fun ChannelList(st: State, guildId: String, onOpenChannel: (String) -> Unit) {
    val session = LocalContext.current.session
    val c = Linkord.colors
    val g = st.guilds[guildId] ?: return
    val layout = st.channelLayout(guildId)
    val selected = st.selected[guildId]
    val collapsed = st.settings.collapsedCategories
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 16.dp)) {
        item {
            val banner = mediaUrl(g.banner)
            // The name/banner opens Server Settings for whoever may change something there (same rule as the server menu).
            val nav = com.linkord.app.ui.LocalNav.current
            val settings = canOpenSettings(st, guildId)
            Box(Modifier.fillMaxWidth().height(if (banner != null) 132.dp else 72.dp)
                .then(if (settings) Modifier.clickable { nav.push(com.linkord.app.ui.Screen.ServerSettings(guildId)) } else Modifier)) {
                if (banner != null) {
                    AsyncImage(banner, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                    Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Color.Transparent, c.panel.copy(alpha = 0.92f)))))
                }
                Row(
                    Modifier.align(Alignment.BottomStart).padding(start = 16.dp, end = 56.dp, top = 12.dp, bottom = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(g.name, style = Linkord.type.title, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    if (settings) LIcon(LinkordIcons.ChevronRight, size = 16.dp, tint = c.text2, modifier = Modifier.padding(start = 6.dp))
                }
                if (st.can(guildId, com.linkord.core.Perm.MANAGE_CHANNELS)) {
                    var creating by remember { mutableStateOf(false) }
                    Box(Modifier.align(Alignment.BottomEnd).padding(8.dp).size(36.dp).clip(RoundedCornerShape(18.dp)).clickable { creating = true }, contentAlignment = Alignment.Center) {
                        LIcon(LinkordIcons.Plus, tint = c.text)
                    }
                    if (creating) com.linkord.app.ui.settings.NewChannelDialog(guildId) { creating = false }
                }
            }
        }
        items(layout.top, key = { it.id }) { ch -> ChannelRow(st, ch, ch.id == selected, onOpenChannel) }
        for (cat in layout.categories) {
            if (cat.channels.isEmpty()) continue
            val shut = cat.category.id in collapsed
            item(key = cat.category.id) {
                Row(
                    Modifier.fillMaxWidth().clickable { session.actions.toggleCategory(cat.category.id) }.padding(start = 16.dp, end = 12.dp, top = 18.dp, bottom = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Kicker(cat.category.name, Modifier.weight(1f))
                    LIcon(if (shut) LinkordIcons.ChevronRight else LinkordIcons.Chevron, size = 14.dp, tint = c.text3)
                }
            }
            // A collapsed category still shows the channel you're in and unread ones, like Discord.
            val shown = if (shut) cat.channels.filter { it.id == selected || (st.isUnread(it) && !st.isMuted(it)) } else cat.channels
            items(shown, key = { it.id }) { ch -> ChannelRow(st, ch, ch.id == selected, onOpenChannel) }
        }
    }
}

@Composable
private fun ChannelRow(st: State, ch: Channel, active: Boolean, onOpenChannel: (String) -> Unit) {
    val c = Linkord.colors
    val nav = LocalNav.current
    val unread = st.isUnread(ch) && !st.isMuted(ch)
    val mentions = st.mentions[ch.id] ?: 0
    val muted = st.isMuted(ch)
    val session = LocalContext.current.session
    val haptics = LocalHapticFeedback.current
    var menu by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf(false) }
    Column(Modifier.animateContentSize()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 1.dp).clip(RoundedCornerShape(10.dp))
                .background(if (active) c.active else Color.Transparent)
                .combinedClickable(
                    onClick = { if (ch.kind == Kind.VOICE) nav.push(Screen.Call(ch.id)) else onOpenChannel(ch.id) },
                    onLongClick = { haptics.performHapticFeedback(HapticFeedbackType.LongPress); menu = true },
                ).padding(horizontal = 10.dp, vertical = 9.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (ch.kind == Kind.VOICE) LIcon(LinkordIcons.Speaker, size = 16.dp, tint = c.text3)
            else Text(st.channelNumber(ch) ?: "··", style = Linkord.type.label, color = if (unread || active) c.text2 else c.text3, modifier = Modifier.width(22.dp))
            Spacer(Modifier.width(8.dp))
            Text(
                ch.name, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                style = Linkord.type.body.copy(fontWeight = if (unread) FontWeight.SemiBold else FontWeight.Normal),
                color = when {
                    active || unread -> c.text
                    muted -> c.text3.copy(alpha = 0.7f)
                    else -> c.text2
                },
            )
            if (ch.kind == Kind.VOICE) st.voiceMembers(ch.id).mapNotNull { it.callStartedAt }.minOrNull()?.let { CallTimer(it) }
            if (mentions > 0) CountBadge(mentions, ring = Color.Transparent)
            else if (st.channelAlert(ch) && !active) Box(Modifier.size(8.dp).clip(RoundedCornerShape(4.dp)).background(c.text))
            DropdownMenu(menu, { menu = false }) {
                DropdownMenuItem(text = { Text(t("Mark as read")) }, onClick = { menu = false; session.actions.markRead(listOf(ch.id)) })
                DropdownMenuItem(text = { Text(if (muted) t("Unmute channel") else t("Mute channel")) }, onClick = { menu = false; session.actions.toggleMuteChannel(ch.id) })
                if (st.can(ch.guildId, com.linkord.core.Perm.MANAGE_CHANNELS, ch.id) || st.can(ch.guildId, com.linkord.core.Perm.MANAGE_ROLES, ch.id)) DropdownMenuItem(text = { Text(t("Edit Channel")) }, onClick = { menu = false; editing = true })
                ch.guildId?.takeIf { st.can(it, com.linkord.core.Perm.MANAGE_CHANNELS) }?.let { gid -> DropdownMenuItem(text = { Text(t("Reorder channels")) }, onClick = { menu = false; nav.push(Screen.ChannelOrder(gid)) }) }
            }
            if (editing) com.linkord.app.ui.settings.EditChannelDialog(ch) { editing = false }
        }
        if (ch.kind == Kind.TEXT) {
            for (th in st.activeThreads(ch.id).take(5)) {
                Row(
                    Modifier.fillMaxWidth().padding(start = 40.dp, end = 8.dp).clip(RoundedCornerShape(8.dp))
                        .background(if (st.selected[st.view] == th.id) c.active else Color.Transparent)
                        .clickable { onOpenChannel(th.id) }.padding(horizontal = 10.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    LIcon(LinkordIcons.Thread, size = 14.dp, tint = c.text3)
                    Spacer(Modifier.width(6.dp))
                    Text(th.name, style = Linkord.type.small, maxLines = 1, overflow = TextOverflow.Ellipsis, color = if (st.isUnread(th)) c.text else c.text3)
                }
            }
        }
        if (ch.kind == Kind.VOICE) {
            val people = st.voiceMembers(ch.id)
            if (people.isNotEmpty()) Column(Modifier.padding(start = 34.dp, end = 12.dp, bottom = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                for (v in people) {
                    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(c.raised)) {
                        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                            Avatar(st.users[v.userId], 22.dp)
                            Spacer(Modifier.width(8.dp))
                            Text(st.nameOf(v.userId, ch.guildId, t("Unknown")), style = Linkord.type.small, color = c.text, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            if (v.selfStream) Text(t("LIVE"), style = Linkord.type.label, color = c.danger)
                            if (v.selfMute || v.selfDeaf) LIcon(if (v.selfDeaf) LinkordIcons.HeadphonesOff else LinkordIcons.MicOff, size = 14.dp, tint = c.text3)
                        }
                        if (v.selfStream) StreamPreview(v.userId) { nav.push(Screen.Call(ch.id)) }
                    }
                }
            }
        }
    }
}

/** How long the call in a voice channel has run (the server's start, the same for everyone), like the web's. */
@Composable
private fun CallTimer(since: Long) {
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(since) {
        while (true) {
            now = System.currentTimeMillis()
            delay(1000 - now % 1000)
        }
    }
    val s = ((now - since) / 1000).coerceAtLeast(0)
    val text = if (s >= 3600) "%d:%02d:%02d".format(s / 3600, s % 3600 / 60, s % 60) else "%d:%02d".format(s / 60, s % 60)
    Text(text, style = Linkord.type.label, color = Linkord.colors.text3, maxLines = 1, modifier = Modifier.padding(start = 6.dp).semantics { contentDescription = t("Call duration") + " " + text })
}

/**
 * The picture of a live member's stream (the streamer's app sends one now and then, server previews.rs): the phone's
 * stand-in for the web's hover card. Fetched while the list is in front, every 20 s; a tap opens the call to watch.
 */
@Composable
private fun StreamPreview(userId: String, onClick: () -> Unit) {
    val c = Linkord.colors
    val session = LocalContext.current.session
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var shot by remember(userId) { mutableStateOf<ImageBitmap?>(null) }
    var tried by remember(userId) { mutableStateOf(false) }
    LaunchedEffect(userId) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (true) {
                val bytes = runCatching { session.api.bytes("/users/$userId/stream-preview") }.getOrNull()
                if (bytes != null) withContext(Dispatchers.Default) { BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap() }?.let { shot = it }
                tried = true
                delay(20_000)
            }
        }
    }
    Box(
        Modifier.fillMaxWidth().padding(start = 8.dp, end = 8.dp, bottom = 8.dp).aspectRatio(16f / 9f).clip(RoundedCornerShape(8.dp))
            .background(c.desk).clickable(onClickLabel = t("Watch Stream"), onClick = onClick),
    ) {
        val img = shot
        if (img != null) Image(img, null, Modifier.fillMaxSize().background(Color.Black), contentScale = ContentScale.Fit)
        else if (tried) Text(t("No preview yet"), style = Linkord.type.small, color = c.text3, modifier = Modifier.align(Alignment.Center))
    }
}

