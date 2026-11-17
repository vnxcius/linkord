package com.linkord.app.ui.chat

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.linkord.app.session
import com.linkord.app.ui.LocalNav
import com.linkord.app.ui.Screen
import com.linkord.app.ui.components.Avatar
import com.linkord.app.ui.components.Kicker
import com.linkord.app.ui.components.LIcon
import com.linkord.core.Kind
import com.linkord.core.Message
import com.linkord.core.bucket
import com.linkord.core.channelNumber
import com.linkord.core.dmName
import com.linkord.core.dmRecipient
import com.linkord.core.isPrivateChannel
import com.linkord.core.nameOf
import com.linkord.core.typingIn
import com.linkord.core.t
import com.linkord.designsystem.Linkord
import com.linkord.designsystem.LinkordIcons
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

@Composable
fun ChatScreen(channelId: String, onOpenHome: () -> Unit, onOpenMembers: () -> Unit, onOpenChannel: (String) -> Unit) {
    val session = LocalContext.current.session
    val st by session.store.state.collectAsState()
    val nav = LocalNav.current
    val c = Linkord.colors
    val ch = st.channels[channelId] ?: return
    val guildId = ch.guildId
    val bucket = st.bucket(channelId)
    val messages = bucket.list
    val highlight by session.actions.highlight.collectAsState()
    val scope = rememberCoroutineScope()
    var replyTo by remember(channelId) { mutableStateOf<Message?>(null) }
    var editing by remember(channelId) { mutableStateOf<Message?>(null) }
    // A voice message playing here stops when you leave the conversation or the app (VoicePlayback).
    androidx.compose.runtime.DisposableEffect(channelId) { onDispose { VoicePlayback.stopIn(channelId) } }
    androidx.lifecycle.compose.LifecycleEventEffect(androidx.lifecycle.Lifecycle.Event.ON_STOP) { VoicePlayback.pause() }
    var menuFor by remember { mutableStateOf<Message?>(null) }
    var menuImage by remember { mutableStateOf<Pair<String, String>?>(null) }
    val join = com.linkord.app.ui.call.rememberJoin()

    LaunchedEffect(channelId, st.ready) {
        if (!session.store.s.bucket(channelId).loaded) runCatching { session.actions.loadMessages(channelId) }.onFailure { session.toast(session.describe(it)) }
    }

    Column(Modifier.fillMaxSize().background(c.page)) {
        // The running head: "No. 03 · Server" over the channel's name in serif.
        Row(Modifier.fillMaxWidth().statusBarsPadding().padding(start = 4.dp, end = 8.dp, top = 4.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(44.dp).clip(RoundedCornerShape(22.dp)).clickable(onClick = onOpenHome), contentAlignment = Alignment.Center) {
                LIcon(LinkordIcons.Back, size = 22.dp, tint = c.text)
            }
            Column(Modifier.weight(1f).clickable(onClick = onOpenMembers)) {
                val kicker = when {
                    guildId != null -> listOfNotNull(st.channelNumber(ch)?.let { "No. $it" }, st.guilds[guildId]?.name).joinToString(" · ")
                    ch.kind == Kind.GROUP_DM -> t("Group")
                    else -> st.dmRecipient(ch)?.username ?: ""
                }
                if (kicker.isNotEmpty()) Kicker(kicker, maxLines = 1)
                Text(
                    if (guildId != null) ch.name else st.dmName(ch, t("Empty group")),
                    style = Linkord.type.title, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            if (guildId == null) HeaderButton(LinkordIcons.Phone) {
                join(channelId)
                nav.push(Screen.Call(channelId))
            }
            HeaderButton(LinkordIcons.Search) { nav.push(Screen.Search(channelId)) }
            HeaderButton(LinkordIcons.Pin) { nav.push(Screen.Pins(channelId)) }
            HeaderButton(LinkordIcons.Users, onOpenMembers)
        }
        HorizontalDivider(color = c.line)
        com.linkord.app.ui.call.CallBar()

        Box(Modifier.weight(1f)) {
            MessageList(
                channelId, guildId, messages, bucket.loaded, bucket.hasMore, bucket.hasNewer, bucket.loading && !bucket.loaded, highlight,
                onReply = { replyTo = it; editing = null },
                onMenu = { menuFor = it; menuImage = null },
                onImageMenu = { m, url, name -> menuFor = m; menuImage = url to name },
                onOpenChannel = onOpenChannel,
            )
        }

        // Typing entries expire by time (10 s after the last TYPING_START), not by an event, so wake up when the next one
        // runs out; otherwise "is typing" stayed until something else changed.
        val entries = st.typing[channelId]
        var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
        LaunchedEffect(entries) {
            now = System.currentTimeMillis()
            while (true) {
                val next = entries?.values?.filter { it > now }?.minOrNull() ?: break
                kotlinx.coroutines.delay(next - System.currentTimeMillis() + 50)
                now = System.currentTimeMillis()
            }
        }
        val typing = st.typingIn(channelId, now)
        TypingLine(typing.map { st.nameOf(it, guildId, t("Unknown")) })
        // The composer makes its own room for the keyboard and the navigation bar (its emoji panel takes the keyboard's place).
        Composer(
            channel = ch,
            replyTo = replyTo,
            editing = editing,
            onCancelReply = { replyTo = null },
            onCancelEdit = { editing = null },
        )
    }

    menuFor?.let { m ->
        MessageSheet(
            m, guildId,
            image = menuImage,
            onDismiss = { menuFor = null; menuImage = null },
            onReply = { replyTo = m; editing = null },
            onEdit = { editing = m; replyTo = null },
        )
    }
}

@Composable
private fun HeaderButton(icon: androidx.compose.ui.graphics.vector.ImageVector, onClick: () -> Unit) {
    Box(Modifier.size(40.dp).clip(RoundedCornerShape(20.dp)).clickable(onClick = onClick), contentAlignment = Alignment.Center) {
        LIcon(icon, size = 20.dp, tint = Linkord.colors.text2)
    }
}

@Composable
private fun MessageList(
    channelId: String,
    guildId: String?,
    messages: List<Message>,
    loaded: Boolean,
    hasMore: Boolean,
    hasNewer: Boolean,
    firstLoad: Boolean,
    highlight: String?,
    onReply: (Message) -> Unit,
    onMenu: (Message) -> Unit,
    onImageMenu: (Message, String, String) -> Unit,
    onOpenChannel: (String) -> Unit,
) {
    val session = LocalContext.current.session
    val haptics = androidx.compose.ui.platform.LocalHapticFeedback.current
    val st by session.store.state.collectAsState()
    val c = Linkord.colors
    val scope = rememberCoroutineScope()
    // Newest at the bottom: the list is laid out from the bottom (index 0 = newest).
    val state = rememberLazyListState()
    val reversed = remember(messages) { messages.asReversed() }
    val atBottom by remember { derivedStateOf { state.firstVisibleItemIndex <= 1 } }
    val sent by session.actions.sent.collectAsState()

    // New messages keep you at the bottom if you were there; your own always take you there.
    val newest = messages.lastOrNull()?.id
    LaunchedEffect(newest) { if (atBottom && !hasNewer) state.animateScrollToItem(0) }
    LaunchedEffect(sent) { if (sent.first == channelId) state.scrollToItem(0) }
    LaunchedEffect(highlight, messages.size) {
        val i = reversed.indexOfFirst { it.id == highlight }
        if (highlight != null && i >= 0) state.animateScrollToItem(i, -200)
    }
    // Paging: near the oldest loaded message, load older ones; at the newest while reading history, newer ones.
    LaunchedEffect(channelId, state) {
        snapshotFlow { state.layoutInfo.visibleItemsInfo.lastOrNull()?.index to state.layoutInfo.totalItemsCount }
            .distinctUntilChanged()
            .collect { (last, total) -> if (last != null && total > 0 && last >= total - 8) session.actions.loadOlder(channelId) }
    }
    LaunchedEffect(channelId, state, hasNewer) {
        if (!hasNewer) return@LaunchedEffect
        snapshotFlow { state.firstVisibleItemIndex }.collect { if (it <= 2) session.actions.loadNewer(channelId) }
    }

    Box(Modifier.fillMaxSize()) {
        if (firstLoad && messages.isEmpty()) Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = c.text3) }
        LazyColumn(state = state, reverseLayout = true, modifier = Modifier.fillMaxSize(), contentPadding = PaddingValues(vertical = 8.dp)) {
            itemsIndexed(reversed, key = { _, m -> m.nonce?.let { "n:$it" } ?: m.id }, contentType = { _, m -> if (m.type == 0) 0 else 1 }) { i, m ->
                val older = reversed.getOrNull(i + 1)
                val grouped = continues(older, m)
                Column {
                    val day = dayOf(m.createdAt)
                    if (day != null && (older == null || dayOf(older.createdAt) != day)) DaySeparator(day)
                    // Holding a picture in it: the message's quick actions with the picture's own on top.
                    val hold = remember(m.id) {
                        { url: String, name: String ->
                            haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress)
                            onImageMenu(m, url, name)
                        }
                    }
                    androidx.compose.runtime.CompositionLocalProvider(LocalImageHold provides (if (m.pending || m.failed) null else hold)) {
                        MessageItem(st, m, guildId, grouped, highlight == m.id, onReply, onMenu,
                            onJump = { id -> scope.launch { runCatching { session.actions.jumpToMessage(channelId, id) } } },
                            onOpenChannel = onOpenChannel)
                    }
                }
            }
            if (hasMore && messages.isNotEmpty()) item(key = "more") {
                Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = c.text3) }
            }
            // Its own item (the last one = the top), so an empty channel gets it too once its history has loaded.
            if (!hasMore && (loaded || messages.isNotEmpty())) item(key = "start", contentType = "start") { ChannelStart(channelId, onOpenChannel) }
        }
        // Back to the newest messages after scrolling up, or after a jump into history.
        AnimatedVisibility(!atBottom || hasNewer, enter = fadeIn() + scaleIn(), exit = fadeOut() + scaleOut(), modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp)) {
            Row(
                Modifier.clip(RoundedCornerShape(20.dp)).background(c.raised2).clickable {
                    scope.launch {
                        if (hasNewer) runCatching { session.actions.jumpToPresent(channelId) }
                        state.animateScrollToItem(0)
                    }
                }.padding(horizontal = 14.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                LIcon(LinkordIcons.Chevron, size = 16.dp, tint = c.text)
                Spacer(Modifier.width(6.dp))
                Text(t("Jump to present"), style = Linkord.type.small, color = c.text)
            }
        }
    }
}

@Composable
private fun DaySeparator(day: java.time.LocalDate) {
    val c = Linkord.colors
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        HorizontalDivider(Modifier.weight(1f), color = c.line)
        Text(DateTimeFormatter.ofLocalizedDate(FormatStyle.LONG).format(day), style = Linkord.type.label, modifier = Modifier.padding(horizontal = 10.dp))
        HorizontalDivider(Modifier.weight(1f), color = c.line)
    }
}

/** The top of a channel's history (Chat.tsx ChannelWelcome), like the first page of a chapter: its name big. */
@Composable
private fun ChannelStart(channelId: String, onOpenChannel: (String) -> Unit) {
    val session = LocalContext.current.session
    val st by session.store.state.collectAsState()
    val scope = rememberCoroutineScope()
    val c = Linkord.colors
    val ch = st.channels[channelId] ?: return
    val name = st.dmName(ch, t("Empty group"))
    Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 32.dp, bottom = 12.dp)) {
        when (ch.kind) {
            Kind.DM -> {
                Avatar(st.dmRecipient(ch), 72.dp)
                StartTitle(name)
                Text(t("This is the beginning of your direct message history with {name}.", "name" to name), style = Linkord.type.small, color = c.text3)
            }
            Kind.GROUP_DM -> {
                StartIcon(LinkordIcons.Users)
                StartTitle(name)
                Text(t("Welcome to the beginning of this group."), style = Linkord.type.small, color = c.text3)
            }
            Kind.THREAD -> {
                StartIcon(LinkordIcons.Thread)
                StartTitle(ch.name)
                Text(t("Started by {name}.", "name" to st.nameOf(ch.ownerId ?: "", ch.guildId, t("Unknown"))), style = Linkord.type.small, color = c.text3)
                val parent = ch.parentId
                val starter = ch.threadMessageId
                if (parent != null && starter != null) Text(
                    t("See the original message"),
                    style = Linkord.type.small.copy(textDecoration = TextDecoration.Underline),
                    color = c.brand,
                    modifier = Modifier.padding(top = 2.dp).clickable {
                        scope.launch {
                            runCatching { session.actions.jumpToMessage(parent, starter) }
                            onOpenChannel(parent)
                        }
                    },
                )
            }
            else -> {
                StartIcon(LinkordIcons.Hash, locked = st.isPrivateChannel(channelId))
                st.channelNumber(ch)?.let { Kicker("No. $it", Modifier.padding(top = 14.dp)) }
                StartTitle(t("Welcome to #{name}", "name" to ch.name), top = if (st.channelNumber(ch) != null) 4.dp else 14.dp)
                Text(t("This is the start of the #{name} channel.", "name" to ch.name), style = Linkord.type.small, color = c.text3)
            }
        }
    }
}

@Composable
private fun StartTitle(text: String, top: androidx.compose.ui.unit.Dp = 14.dp) {
    Text(text, style = Linkord.type.display.copy(fontSize = 34.sp, lineHeight = 38.sp), modifier = Modifier.padding(top = top, bottom = 6.dp))
}

/** The channel's glyph on a raised tile (.welcome-icon), with the lock badge for a private channel. */
@Composable
private fun StartIcon(icon: androidx.compose.ui.graphics.vector.ImageVector, locked: Boolean = false) {
    val c = Linkord.colors
    Box {
        Box(Modifier.size(64.dp).clip(RoundedCornerShape(18.dp)).background(c.raised), contentAlignment = Alignment.Center) {
            LIcon(icon, size = 36.dp, tint = c.brand)
        }
        if (locked) Box(
            Modifier.align(Alignment.TopEnd).offset(6.dp, (-6).dp).size(24.dp).clip(RoundedCornerShape(8.dp)).background(c.page),
            contentAlignment = Alignment.Center,
        ) { LIcon(LinkordIcons.Lock, size = 14.dp, tint = c.text2) }
    }
}

@Composable
private fun TypingLine(names: List<String>) {
    val c = Linkord.colors
    var dots by remember { mutableStateOf(0) }
    LaunchedEffect(names.isNotEmpty()) {
        while (names.isNotEmpty()) {
            delay(400)
            dots = (dots + 1) % 4
        }
    }
    AnimatedVisibility(names.isNotEmpty()) {
        val text = when (names.size) {
            1 -> t("{name} is typing", "name" to names[0])
            2 -> t("{a} and {b} are typing", "a" to names[0], "b" to names[1])
            else -> t("Several people are typing")
        }
        Text(text + ".".repeat(dots), style = Linkord.type.small, color = c.text2, modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 2.dp).height(18.dp))
    }
}
