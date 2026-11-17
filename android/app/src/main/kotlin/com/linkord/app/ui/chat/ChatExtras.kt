package com.linkord.app.ui.chat

import android.content.ClipData
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage
import com.linkord.app.session
import com.linkord.app.ui.LocalNav
import com.linkord.app.ui.Screen
import com.linkord.app.ui.components.Avatar
import com.linkord.app.ui.components.Kicker
import com.linkord.app.ui.components.LIcon
import com.linkord.app.ui.home.activityLine
import com.linkord.core.Kind
import com.linkord.core.Message
import com.linkord.core.State
import com.linkord.core.memberRoles
import com.linkord.core.nameOf
import com.linkord.core.tickFor
import com.linkord.core.presenceOf
import com.linkord.core.memberGroups
import com.linkord.core.t
import com.linkord.designsystem.Linkord
import com.linkord.designsystem.LinkordIcons
import kotlinx.coroutines.launch
import com.linkord.core.isVoice

/** Quick reactions, as on the web client (EmojiPicker QUICK_REACTIONS). */
val QUICK_REACTIONS = listOf("👍", "❤️", "😂", "🔥", "👀", "🎉")

@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun MessageSheet(m: Message, guildId: String?, onDismiss: () -> Unit, onReply: () -> Unit, onEdit: () -> Unit, image: Pair<String, String>? = null) {
    val session = LocalContext.current.session
    val st by session.store.state.collectAsState()
    val clipboard = LocalClipboard.current
    val c = Linkord.colors
    val scope = rememberCoroutineScope()
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = false)
    var more by remember { mutableStateOf(false) }
    var info by remember { mutableStateOf(false) }
    val mine = m.author.id == st.me?.id
    fun close(then: () -> Unit = {}) {
        scope.launch { sheet.hide() }.invokeOnCompletion { onDismiss(); then() }
    }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet, containerColor = c.panel) {
        Column(Modifier.navigationBarsPadding().padding(bottom = 12.dp)) {
            if (m.pending || m.failed) {
                if (m.failed) {
                    SheetAction(LinkordIcons.Rejoin, t("Retry")) { close { session.actions.retryMessage(m) } }
                    SheetAction(LinkordIcons.Trash, t("Delete"), danger = true) { close { session.actions.dismissMessage(m) } }
                }
                return@Column
            }
            // Quick reactions on top, every emoji under "more" (EmojiPicker).
            // As big as 46dp, smaller when seven don't fit across (a small phone).
            if (!info) androidx.compose.foundation.layout.BoxWithConstraints(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
                val dot = minOf(46.dp, (maxWidth - 6.dp * QUICK_REACTIONS.size) / (QUICK_REACTIONS.size + 1))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    for (e in QUICK_REACTIONS) {
                        Box(Modifier.size(dot).clip(RoundedCornerShape(dot / 2)).background(c.raised).clickable { close { session.actions.toggleReaction(m, e) } }, contentAlignment = Alignment.Center) {
                            Text(com.linkord.designsystem.emojiText(e), fontSize = (22 * dot.value / 46).sp)
                        }
                    }
                    Box(Modifier.size(dot).clip(RoundedCornerShape(dot / 2)).background(c.raised).clickable { more = !more }, contentAlignment = Alignment.Center) {
                        LIcon(if (more) LinkordIcons.Chevron else LinkordIcons.Smile, tint = c.text)
                    }
                }
            }
            if (info) MessageInfo(m)
            else if (more) EmojiPicker(st, guildId, height = 420.dp) { e -> close { session.actions.toggleReaction(m, e) } }
            else {
                // Held on a picture: its own actions first.
                if (image != null) {
                    ImageActionRows(image.first, image.second) { then -> close(then) }
                    androidx.compose.material3.HorizontalDivider(Modifier.padding(horizontal = 16.dp, vertical = 4.dp), color = c.line)
                }
                SheetAction(LinkordIcons.Reply, t("Reply")) { close(onReply) }
                val ch = st.channels[m.channelId]
                if (ch?.guildId != null && ch.kind == Kind.TEXT && m.threadId == null && m.type == 0) SheetAction(LinkordIcons.Thread, t("Create Thread")) {
                    close { session.launch { session.actions.startThread(m, null) } }
                }
                if (!mine && !m.author.bot) SheetAction(LinkordIcons.Snowflake, t("Throw a snowball")) {
                    close { session.actions.throwSnowball(m.channelId, m.author.id, m.id) }
                }
                if (mine && m.type == 0) SheetAction(LinkordIcons.Edit, t("Edit Message")) { close(onEdit) }
                if (m.content.isNotEmpty()) SheetAction(LinkordIcons.Copy, t("Copy Text")) {
                    scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("message", plainText(m.content, st, guildId)))) }
                    close()
                }
                // Your DMs: when it was sent, delivered and read (server receipts.rs).
                if (st.tickFor(m) != null) SheetAction(LinkordIcons.Info, t("Message info")) { info = true }
                SheetAction(LinkordIcons.Pin, if (m.pinned) t("Unpin Message") else t("Pin Message")) {
                    close { session.launch { session.actions.togglePin(m) } }
                }
                SheetAction(LinkordIcons.Link, t("Copy Message Link")) {
                    val where = guildId ?: "@me"
                    val link = "${session.serverUrl()}/channels/$where/${m.channelId}/${m.id}"
                    scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("link", link))) }
                    close()
                }
                if (mine) SheetAction(LinkordIcons.Trash, t("Delete Message"), danger = true) {
                    close { session.launch { session.actions.deleteMessage(m) } }
                }
            }
        }
    }
}

@kotlinx.serialization.Serializable
private data class MessageReceipt(
    @kotlinx.serialization.SerialName("user_id") val userId: String,
    val delivered: Boolean = false,
    val read: Boolean = false,
    /** False when either of you has read receipts off (Privacy): then there's no Read line. */
    @kotlinx.serialization.SerialName("read_receipts") val readReceipts: Boolean = true,
    @kotlinx.serialization.SerialName("delivered_at") val deliveredAt: String? = null,
    @kotlinx.serialization.SerialName("read_at") val readAt: String? = null,
    /** Voice messages: when they played it. */
    @kotlinx.serialization.SerialName("played_at") val playedAt: String? = null,
)

/** Message info, WhatsApp-style: when your DM was sent, and when each person got it and read it. */
@Composable
private fun MessageInfo(m: Message) {
    val session = LocalContext.current.session
    val st by session.store.state.collectAsState()
    val c = Linkord.colors
    var list by remember { mutableStateOf<List<MessageReceipt>?>(null) }
    var failed by remember { mutableStateOf<String?>(null) }
    // Asked again whenever a receipt in this conversation moves, so it fills in while it's open.
    val played = st.messages[m.channelId]?.list?.firstOrNull { it.id == m.id }?.playedBy
    LaunchedEffect(m.id, st.receipts[m.channelId], played) {
        runCatching { session.api.get<List<MessageReceipt>>("/channels/${m.channelId}/messages/${m.id}/receipts") }
            .onSuccess { list = it; failed = null }
            .onFailure { failed = session.describe(it) }
    }
    fun at(iso: String?) = iso?.let { runCatching { formatTime(java.time.Instant.parse(it).epochSecond, "f") }.getOrNull() }
    Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(t("Message info"), style = Linkord.type.title)
        InfoLine(LinkordIcons.Check, c.text3, t("Sent"), at(m.createdAt))
        val people = list
        when {
            people == null && failed != null -> Text(failed!!, style = Linkord.type.small, color = c.text3)
            people == null -> CircularProgressIndicator(color = c.text3, modifier = Modifier.size(20.dp))
            else -> for (r in people) {
                val group = people.size > 1
                if (group) Row(Modifier.padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Avatar(st.users[r.userId], 22.dp)
                    Spacer(Modifier.width(8.dp))
                    Text(st.nameOf(r.userId, null, t("Unknown")), style = Linkord.type.bodyStrong, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                InfoLine(LinkordIcons.CheckDouble, c.text3, t("Delivered"), if (r.delivered) at(r.deliveredAt) ?: "" else null)
                if (r.readReceipts) InfoLine(LinkordIcons.CheckDouble, c.brand, t("Read"), if (r.read) at(r.readAt) ?: "" else null)
                if (r.readReceipts && m.isVoice) InfoLine(LinkordIcons.Mic, c.brand, t("Played"), r.playedAt?.let { at(it) ?: "" })
            }
        }
    }
}

/** One step of Message info: its tick, its name and when (null = not yet; "" = before times were kept). */
@Composable
private fun InfoLine(icon: ImageVector, tint: Color, label: String, time: String?) {
    val c = Linkord.colors
    Row(verticalAlignment = Alignment.CenterVertically) {
        LIcon(icon, size = 18.dp, tint = if (time == null) c.text3.copy(alpha = 0.5f) else tint)
        Spacer(Modifier.width(12.dp))
        Text(label, style = Linkord.type.body, color = if (time == null) c.text3 else c.text, modifier = Modifier.weight(1f))
        Text(time ?: t("Not yet"), style = Linkord.type.mono, color = c.text3)
    }
}

@Composable
fun SheetAction(icon: ImageVector, label: String, danger: Boolean = false, onClick: () -> Unit) {
    val c = Linkord.colors
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 20.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
        LIcon(icon, tint = if (danger) c.danger else c.text2)
        Spacer(Modifier.width(16.dp))
        Text(label, style = Linkord.type.body, color = if (danger) c.danger else c.text)
    }
}

/** Who can see this channel, grouped by status: the margin's People, as a drawer. */
@Composable
fun MembersPane(channelId: String) {
    val session = LocalContext.current.session
    val st by session.store.state.collectAsState()
    val nav = LocalNav.current
    val c = Linkord.colors
    val ch = st.channels[channelId] ?: return
    val people = if (ch.guildId != null) st.members[ch.guildId]?.keys?.mapNotNull { st.users[it] } ?: emptyList()
    else ch.recipients?.map { st.users[it.id] ?: it } ?: emptyList()
    // Hoisted roles get their own group, like on the web (core memberGroups).
    val byId = people.associateBy { it.id }
    val groups = st.memberGroups(ch.guildId, byId.keys)
    LazyColumn(Modifier.fillMaxSize().background(c.panel).statusBarsPadding(), contentPadding = PaddingValues(vertical = 12.dp)) {
        item { Text(if (ch.guildId != null) t("People") else st.channels[channelId]?.let { if (it.kind == Kind.GROUP_DM) t("Members") else t("People") } ?: "", style = Linkord.type.title, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) }
        for (g in groups) {
            val list = g.ids.mapNotNull { byId[it] }
            if (list.isEmpty()) continue
            val title = g.title
            item(key = "group-" + (g.roleId ?: title)) { Kicker("$title — ${list.size}", Modifier.padding(start = 16.dp, top = 12.dp, bottom = 6.dp)) }
            items(list, key = { (g.roleId ?: title) + it.id }) { u ->
                Row(
                    Modifier.fillMaxWidth().clickable { nav.push(Screen.Profile(u.id, ch.guildId)) }.padding(horizontal = 16.dp, vertical = 7.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Avatar(u, 36.dp, status = st.presenceOf(u.id), modifier = Modifier.graphicsLayer { alpha = if (st.presenceOf(u.id) == "offline") 0.5f else 1f })
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        val color = ch.guildId?.let { g -> st.memberRoles(g, u.id).firstOrNull { (it.color ?: 0) != 0 }?.color }?.let { Color(0xFF000000 or it.toLong()) } ?: c.text
                        Text(st.nameOf(u.id, ch.guildId, u.username), style = Linkord.type.bodyStrong, color = color, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        activityLine(st, u.id)?.let { Text(it, style = Linkord.type.small, color = c.text3, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                    }
                    if (u.bot) Text("BOT", style = Linkord.type.label, color = c.onBrand, modifier = Modifier.clip(RoundedCornerShape(4.dp)).background(c.brand).padding(horizontal = 4.dp, vertical = 1.dp))
                }
            }
        }
    }
}

@Composable
fun MembersScreen(channelId: String) = ScreenScaffold(t("People")) { MembersPane(channelId) }

@Composable
fun PinsScreen(channelId: String) {
    val session = LocalContext.current.session
    val st by session.store.state.collectAsState()
    val nav = LocalNav.current
    val scope = rememberCoroutineScope()
    var pins by remember { mutableStateOf<List<Message>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(channelId) {
        runCatching { session.api.get<List<Message>>("/channels/$channelId/pins") }.onSuccess { pins = it }.onFailure { error = session.describe(it) }
    }
    val guildId = st.channels[channelId]?.guildId
    ScreenScaffold(t("Pinned Messages")) {
        val list = pins
        when {
            list == null && error == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = Linkord.colors.text3) }
            list.isNullOrEmpty() -> Text(error ?: t("This channel doesn't have any pinned messages... yet."), style = Linkord.type.small, modifier = Modifier.padding(16.dp))
            else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(vertical = 8.dp)) {
                items(list, key = { it.id }) { m ->
                    Box(Modifier.clickable {
                        nav.pop()
                        scope.launch { runCatching { session.actions.jumpToMessage(channelId, m.id) } }
                    }) {
                        MessageItem(st, m, guildId, grouped = false, highlighted = false, onReply = {}, onMenu = {}, onJump = {}, onOpenChannel = {})
                    }
                }
            }
        }
    }
}

/** A title bar with back, over [content]. [onBack] replaces the plain pop (pages that guard unsaved changes). */
@Composable
fun ScreenScaffold(title: String, actions: @Composable () -> Unit = {}, onBack: (() -> Unit)? = null, content: @Composable () -> Unit) {
    val nav = LocalNav.current
    val c = Linkord.colors
    Column(Modifier.fillMaxSize().background(c.page)) {
        Row(Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 4.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(44.dp).clip(RoundedCornerShape(22.dp)).clickable { onBack?.invoke() ?: nav.pop() }, contentAlignment = Alignment.Center) { LIcon(LinkordIcons.Back, size = 22.dp, tint = c.text) }
            Text(title, style = Linkord.type.title, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            actions()
        }
        // Pages make room for the keyboard (edge to edge, the window itself doesn't resize).
        Box(Modifier.weight(1f).imePadding()) { content() }
    }
}

/** A picture full screen: pinch or double tap to zoom, drag down to put it away, hold for Save / Share / Copy Link. */
@Composable
fun ImageViewer(url: String, name: String) {
    val nav = LocalNav.current
    val haptics = androidx.compose.ui.platform.LocalHapticFeedback.current
    var actions by remember { mutableStateOf(false) }
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(androidx.compose.ui.geometry.Offset.Zero) }
    var drop by remember { mutableFloatStateOf(0f) }
    Box(
        Modifier.fillMaxSize().background(Color.Black.copy(alpha = (1f - kotlin.math.abs(drop) / 1200f).coerceIn(0.3f, 1f)))
            .pointerInput(Unit) {
                detectTransformGestures { _, pan, zoom, _ ->
                    scale = (scale * zoom).coerceIn(1f, 6f)
                    offset = if (scale > 1f) offset + pan else androidx.compose.ui.geometry.Offset.Zero
                }
            }
            .pointerInput(Unit) {
                detectTapGestures(
                    onLongPress = { haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress); actions = true },
                    onDoubleTap = {
                        if (scale > 1f) { scale = 1f; offset = androidx.compose.ui.geometry.Offset.Zero } else scale = 2.5f
                    },
                )
            }
            .pointerInput(Unit) {
                detectVerticalDragGestures(
                    onDragEnd = { if (kotlin.math.abs(drop) > 300f) nav.pop() else drop = 0f },
                    onVerticalDrag = { ch, d -> if (scale == 1f) { ch.consume(); drop += d } },
                )
            },
        contentAlignment = Alignment.Center,
    ) {
        AsyncImage(
            url, name, contentScale = ContentScale.Fit,
            modifier = Modifier.fillMaxSize().graphicsLayer {
                scaleX = scale; scaleY = scale
                translationX = offset.x; translationY = offset.y + drop
            },
        )
        Box(Modifier.align(Alignment.TopStart).statusBarsPadding().padding(8.dp).size(44.dp).clip(RoundedCornerShape(22.dp)).background(Color.Black.copy(alpha = 0.4f)).clickable { nav.pop() }, contentAlignment = Alignment.Center) {
            LIcon(LinkordIcons.Close, tint = Color.White)
        }
    }
    if (actions) ImageSheet(url, name) { actions = false }
}
