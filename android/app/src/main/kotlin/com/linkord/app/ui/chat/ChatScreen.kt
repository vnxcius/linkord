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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.linkord.app.session
import com.linkord.app.ui.LocalNav
import com.linkord.app.ui.Screen
import com.linkord.app.ui.components.Kicker
import com.linkord.app.ui.components.LIcon
import com.linkord.core.Kind
import com.linkord.core.Message
import com.linkord.core.bucket
import com.linkord.core.channelNumber
import com.linkord.core.dmName
import com.linkord.core.dmRecipient
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
    var menuFor by remember { mutableStateOf<Message?>(null) }
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
                if (kicker.isNotEmpty()) Kicker(kicker)
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
                channelId, guildId, messages, bucket.hasMore, bucket.hasNewer, bucket.loading && !bucket.loaded, highlight,
                onReply = { replyTo = it; editing = null },
                onMenu = { menuFor = it },
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
        Composer(
            channel = ch,
            replyTo = replyTo,
            editing = editing,
            onCancelReply = { replyTo = null },
            onCancelEdit = { editing = null },
            modifier = Modifier.navigationBarsPadding().imePadding(),
        )
    }

    menuFor?.let { m ->
        MessageSheet(
            m, guildId,
            onDismiss = { menuFor = null },
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
    hasMore: Boolean,
    hasNewer: Boolean,
    firstLoad: Boolean,
    highlight: String?,
    onReply: (Message) -> Unit,
    onMenu: (Message) -> Unit,
    onOpenChannel: (String) -> Unit,
) {
    val session = LocalContext.current.session
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
                    if (older == null && !hasMore) ChannelStart(channelId)
                    val day = dayOf(m.createdAt)
                    if (day != null && (older == null || dayOf(older.createdAt) != day)) DaySeparator(day)
                    MessageItem(st, m, guildId, grouped, highlight == m.id, onReply, onMenu,
                        onJump = { id -> scope.launch { runCatching { session.actions.jumpToMessage(channelId, id) } } },
                        onOpenChannel = onOpenChannel)
                }
            }
            if (hasMore && messages.isNotEmpty()) item(key = "more") {
                Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = c.text3) }
            }
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

/** The top of a channel's history: its name big, like the first page of a chapter. */
@Composable
private fun ChannelStart(channelId: String) {
    val session = LocalContext.current.session
    val st by session.store.state.collectAsState()
    val ch = st.channels[channelId] ?: return
    Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 32.dp, bottom = 12.dp)) {
        if (ch.guildId != null) {
            st.channelNumber(ch)?.let { Kicker("No. $it") }
            Text(t("Welcome to #{name}!", "name" to ch.name), style = Linkord.type.display)
            Text(t("This is the start of the #{name} channel.", "name" to ch.name), style = Linkord.type.small)
        } else {
            Text(st.dmName(ch, t("Empty group")), style = Linkord.type.display)
            Text(t("This is the beginning of your direct message history with {name}.", "name" to st.dmName(ch, t("Empty group"))), style = Linkord.type.small)
        }
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
