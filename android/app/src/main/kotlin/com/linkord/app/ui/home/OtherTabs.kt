package com.linkord.app.ui.home

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
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.linkord.app.session
import com.linkord.app.ui.LocalNav
import com.linkord.app.ui.Screen
import com.linkord.app.ui.chat.MarkdownText
import com.linkord.app.ui.chat.timeOf
import com.linkord.app.ui.components.Avatar
import com.linkord.app.ui.components.CountBadge
import com.linkord.app.ui.components.Kicker
import com.linkord.app.ui.components.LIcon
import com.linkord.core.Kind
import com.linkord.core.Message
import com.linkord.core.Rel
import com.linkord.core.customStatusOf
import com.linkord.core.dmName
import com.linkord.core.dmRecipient
import com.linkord.core.gameOf
import com.linkord.core.isUnread
import com.linkord.core.nameOf
import com.linkord.core.presenceOf
import com.linkord.core.sortedDms
import com.linkord.core.t
import com.linkord.designsystem.Linkord
import com.linkord.designsystem.LinkordIcons
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

/** Direct messages and group DMs, newest first. */
@Composable
fun DmList(onOpenChannel: (String) -> Unit, showHeader: Boolean) {
    val session = LocalContext.current.session
    val st by session.store.state.collectAsState()
    val c = Linkord.colors
    val dms = st.sortedDms()
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(vertical = 8.dp)) {
        if (showHeader) item { Text(t("Direct Messages"), style = Linkord.type.title, modifier = Modifier.padding(horizontal = 16.dp, vertical = 14.dp)) }
        if (dms.isEmpty()) item {
            Text(t("No conversations yet. Say hi to a friend from their profile."), style = Linkord.type.small, color = c.text3, modifier = Modifier.padding(16.dp))
        }
        items(dms, key = { it.id }) { ch ->
            val other = st.dmRecipient(ch)
            val unread = st.isUnread(ch)
            val mentions = st.mentions[ch.id] ?: 0
            val active = st.view == "@me" && st.selected["@me"] == ch.id
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 1.dp).clip(RoundedCornerShape(12.dp))
                    .background(if (active) c.active else Color.Transparent)
                    .clickable { onOpenChannel(ch.id) }.padding(horizontal = 10.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (ch.kind == Kind.GROUP_DM) {
                    Box(Modifier.size(40.dp).clip(RoundedCornerShape(30)).background(c.raised2), contentAlignment = Alignment.Center) { LIcon(LinkordIcons.Users, tint = c.text) }
                } else Avatar(other, 40.dp, status = other?.let { st.presenceOf(it.id) })
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(
                        st.dmName(ch, t("Empty group")), maxLines = 1, overflow = TextOverflow.Ellipsis,
                        style = Linkord.type.body.copy(fontWeight = if (unread) FontWeight.SemiBold else FontWeight.Medium),
                        color = if (unread || active) c.text else c.text2,
                    )
                    val line = when {
                        ch.kind == Kind.GROUP_DM -> plural(ch.recipients?.size ?: 0)
                        other != null -> activityLine(st, other.id)
                        else -> null
                    }
                    if (line != null) Text(line, style = Linkord.type.small, color = c.text3, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                CountBadge(mentions, ring = Color.Transparent)
            }
        }
    }
}

private fun plural(n: Int) = com.linkord.core.plural(n, "{n} member", "{n} members")

/** What someone is up to, in one line: custom status, else the game, else nothing. */
fun activityLine(st: com.linkord.core.State, userId: String): String? {
    st.customStatusOf(userId)?.let { cs ->
        val text = listOfNotNull(cs.emoji?.takeIf { it.id == null }?.name, cs.state).joinToString(" ")
        if (text.isNotBlank()) return text
    }
    st.gameOf(userId)?.let { return t("Playing {game}", "game" to it.name) }
    return null
}

/** The Messages tab: conversations, then friends and requests. */
@Composable
fun MessagesTab(onOpenChannel: (String) -> Unit) {
    val session = LocalContext.current.session
    val st by session.store.state.collectAsState()
    val nav = LocalNav.current
    val c = Linkord.colors
    val scope = rememberCoroutineScope()
    var friendsMode by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(if (friendsMode) t("Friends") else t("Messages"), style = Linkord.type.display, modifier = Modifier.weight(1f))
            val pending = st.relationships.count { it.value == Rel.INCOMING }
            Box {
                Row(
                    Modifier.clip(RoundedCornerShape(10.dp)).background(c.raised).clickable { friendsMode = !friendsMode }.padding(horizontal = 12.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    LIcon(if (friendsMode) LinkordIcons.ChatBubble else LinkordIcons.Users, size = 18.dp, tint = c.text)
                    Spacer(Modifier.width(6.dp))
                    Text(if (friendsMode) t("Messages") else t("Friends"), style = Linkord.type.small, color = c.text)
                }
                if (pending > 0 && !friendsMode) CountBadge(pending, Modifier.align(Alignment.TopEnd))
            }
        }
        Box(Modifier.weight(1f).padding(horizontal = 8.dp).clip(RoundedCornerShape(topStart = 14.dp, topEnd = 14.dp)).background(c.panel)) {
            if (!friendsMode) DmList(onOpenChannel, showHeader = false)
            else LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(vertical = 8.dp)) {
                item {
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 8.dp).clip(RoundedCornerShape(12.dp)).clickable { nav.push(Screen.AddFriend) }.padding(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        LIcon(LinkordIcons.UserPlus, tint = c.text)
                        Spacer(Modifier.width(12.dp))
                        Text(t("Add Friend"), style = Linkord.type.bodyStrong)
                    }
                }
                val groups = listOf(
                    Rel.INCOMING to t("Incoming requests"),
                    Rel.FRIEND to t("All friends"),
                    Rel.OUTGOING to t("Sent requests"),
                )
                for ((kind, title) in groups) {
                    val people = st.relationships.filterValues { it == kind }.keys.mapNotNull { st.users[it] }.sortedBy { it.name.lowercase() }
                    if (people.isEmpty()) continue
                    item { Kicker("$title — ${people.size}", Modifier.padding(start = 18.dp, top = 16.dp, bottom = 6.dp)) }
                    items(people, key = { "$kind:${it.id}" }) { u ->
                        Row(
                            Modifier.fillMaxWidth().padding(horizontal = 8.dp).clip(RoundedCornerShape(12.dp))
                                .clickable { nav.push(Screen.Profile(u.id, null)) }.padding(horizontal = 10.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Avatar(u, 40.dp, status = st.presenceOf(u.id))
                            Spacer(Modifier.width(12.dp))
                            Column(Modifier.weight(1f)) {
                                Text(u.name, style = Linkord.type.bodyStrong, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(activityLine(st, u.id) ?: u.username, style = Linkord.type.small, color = c.text3, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                            when (kind) {
                                Rel.INCOMING -> {
                                    RoundAction(LinkordIcons.Check) { scope.launch { runCatching { session.actions.friendRequest(u.id) }.onFailure { session.toast(session.describe(it)) } } }
                                    Spacer(Modifier.width(8.dp))
                                    RoundAction(LinkordIcons.Close) { scope.launch { runCatching { session.actions.removeRelationship(u.id) } } }
                                }
                                Rel.OUTGOING -> RoundAction(LinkordIcons.Close) { scope.launch { runCatching { session.actions.removeRelationship(u.id) } } }
                                else -> RoundAction(LinkordIcons.ChatBubble) {
                                    scope.launch { runCatching { onOpenChannel(session.actions.dmChannel(u.id).id) }.onFailure { session.toast(session.describe(it)) } }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun RoundAction(icon: androidx.compose.ui.graphics.vector.ImageVector, onClick: () -> Unit) {
    Box(Modifier.size(36.dp).clip(RoundedCornerShape(18.dp)).background(Linkord.colors.raised).clickable(onClick = onClick), contentAlignment = Alignment.Center) {
        LIcon(icon, size = 18.dp, tint = Linkord.colors.text)
    }
}

@Serializable
private data class SearchResults(val total: Long = 0, val messages: List<Message> = emptyList())

/** Mentions and replies to you, everywhere (search with mentions=you), newest first. */
@Composable
fun MentionsTab(onOpenChannel: (String) -> Unit) {
    val session = LocalContext.current.session
    val st by session.store.state.collectAsState()
    val c = Linkord.colors
    val scope = rememberCoroutineScope()
    var results by remember { mutableStateOf<List<Message>?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    suspend fun load() {
        val me = st.me?.id ?: return
        runCatching { session.api.get<SearchResults>("/users/@me/messages/search?mentions=$me") }
            .onSuccess { results = it.messages; error = null }
            .onFailure { error = session.describe(it) }
    }
    LaunchedEffect(Unit) { load() }
    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        Text(t("Mentions"), style = Linkord.type.display, modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp))
        PullToRefreshBox(refreshing, onRefresh = { scope.launch { refreshing = true; load(); refreshing = false } }, modifier = Modifier.weight(1f)) {
            val list = results
            when {
                list == null && error == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = c.text3) }
                list.isNullOrEmpty() -> LazyColumn(Modifier.fillMaxSize()) {
                    item { Text(error ?: t("Nobody has mentioned you yet."), style = Linkord.type.small, color = c.text3, modifier = Modifier.padding(16.dp)) }
                }
                else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 8.dp, end = 8.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(list, key = { it.id }) { m ->
                        val ch = st.channels[m.channelId]
                        Column(
                            Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(c.panel)
                                .clickable {
                                    scope.launch {
                                        runCatching { session.actions.jumpToMessage(m.channelId, m.id) }
                                        onOpenChannel(m.channelId)
                                    }
                                }.padding(12.dp),
                        ) {
                            val where = when {
                                ch == null -> ""
                                ch.guildId != null -> "${st.guilds[ch.guildId]?.name ?: ""} · #${ch.name}"
                                else -> st.dmName(ch, t("Empty group"))
                            }
                            Kicker(where)
                            Spacer(Modifier.height(8.dp))
                            Row {
                                Avatar(m.author, 32.dp)
                                Spacer(Modifier.width(10.dp))
                                Column(Modifier.weight(1f)) {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Text(st.nameOf(m.author.id, ch?.guildId, t("Unknown")), style = Linkord.type.bodyStrong, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                                        Spacer(Modifier.width(8.dp))
                                        Text(timeOf(m.createdAt), style = Linkord.type.label)
                                    }
                                    MarkdownText(m.content, ch?.guildId)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
