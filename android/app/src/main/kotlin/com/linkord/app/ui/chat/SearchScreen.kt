package com.linkord.app.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.linkord.app.session
import com.linkord.app.ui.LocalNav
import com.linkord.app.ui.components.Chip
import com.linkord.app.ui.components.Kicker
import com.linkord.core.Message
import com.linkord.core.plural
import com.linkord.core.t
import com.linkord.designsystem.Linkord
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

@Serializable
private data class Found(val total: Long = 0, val messages: List<Message> = emptyList())

/** Message search in this channel or the whole server (server messages.rs search), newest first. */
@Composable
fun SearchScreen(channelId: String) {
    val session = LocalContext.current.session
    val st by session.store.state.collectAsState()
    val nav = LocalNav.current
    val scope = rememberCoroutineScope()
    val c = Linkord.colors
    val ch = st.channels[channelId]
    val guildId = ch?.guildId
    var query by remember { mutableStateOf("") }
    var wholeServer by remember { mutableStateOf(false) }
    var found by remember { mutableStateOf<Found?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    LaunchedEffect(query, wholeServer) {
        if (query.isBlank()) { found = null; return@LaunchedEffect }
        delay(350)
        busy = true
        val q = java.net.URLEncoder.encode(query.trim(), "UTF-8")
        val path = if (wholeServer && guildId != null) "/guilds/$guildId/messages/search?q=$q" else "/channels/$channelId/messages/search?q=$q"
        runCatching { session.api.get<Found>(path) }.onSuccess { found = it; error = null }.onFailure { error = session.describe(it) }
        busy = false
    }
    ScreenScaffold(t("Search")) {
        Column(Modifier.fillMaxSize()) {
            OutlinedTextField(
                query, { query = it }, singleLine = true, placeholder = { Text(t("Search messages")) },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search), keyboardActions = KeyboardActions(),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp).focusRequester(focus),
            )
            if (guildId != null) Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
                Chip("#${ch.name}", Modifier.clip(RoundedCornerShape(8.dp)).clickable { wholeServer = false }, selected = !wholeServer)
                Box(Modifier.padding(start = 8.dp)) {
                    Chip(st.guilds[guildId]?.name ?: "", Modifier.clip(RoundedCornerShape(8.dp)).clickable { wholeServer = true }, selected = wholeServer)
                }
            }
            val f = found
            when {
                busy && f == null -> Box(Modifier.fillMaxWidth().padding(24.dp)) { CircularProgressIndicator(color = c.text3) }
                error != null -> Text(error!!, style = Linkord.type.small, color = c.danger, modifier = Modifier.padding(16.dp))
                f != null -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
                    item { Kicker(plural(f.total.toInt(), "{n} result", "{n} results"), Modifier.padding(16.dp)) }
                    items(f.messages, key = { it.id }) { m ->
                        val where = st.channels[m.channelId]
                        Column(Modifier.fillMaxWidth().clickable {
                            nav.pop()
                            scope.launch { runCatching { session.actions.jumpToMessage(m.channelId, m.id) } }
                        }.background(c.page)) {
                            if (wholeServer && where != null) Kicker("#${where.name}", Modifier.padding(start = 16.dp, top = 8.dp))
                            MessageItem(st, m, guildId, grouped = false, highlighted = false, onReply = {}, onMenu = {}, onJump = {}, onOpenChannel = {})
                        }
                    }
                }
            }
        }
    }
}
