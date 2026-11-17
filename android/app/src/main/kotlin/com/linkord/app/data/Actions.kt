package com.linkord.app.data

import android.net.Uri
import android.provider.OpenableColumns
import com.linkord.core.Channel
import com.linkord.core.ChannelMessages
import com.linkord.core.Guild
import com.linkord.core.Kind
import com.linkord.core.LinkordJson
import com.linkord.core.Message
import com.linkord.core.MessageRef
import com.linkord.core.PAGE
import com.linkord.core.addDm
import com.linkord.core.addGuild
import com.linkord.core.bucket
import com.linkord.core.channelLayout
import com.linkord.core.cmpId
import com.linkord.core.mergeLatest
import com.linkord.core.receive
import com.linkord.core.toJson
import kotlinx.collections.immutable.toPersistentList
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.RequestBody
import okio.BufferedSink
import okio.source

/** A file picked to send: its content URI and what to call it. */
data class Outgoing(val uri: Uri, val name: String, val type: String, val size: Long)

/** What the UI does to the server and the store (the web client's lib/actions.ts). */
class Actions(private val session: Session) {
    private val store get() = session.store
    private val api get() = session.api
    private val scope get() = session.scope

    /** The channel the person is looking at right now (chat open, app in front), for acks and notifications. */
    private val _viewing = MutableStateFlow<String?>(null)
    val viewing: StateFlow<String?> = _viewing

    init {
        store.isViewing = { it == _viewing.value }
    }

    fun setViewing(channelId: String?) {
        _viewing.value = channelId
        if (channelId != null) {
            session.notifier.clearChannel(channelId)
            maybeAck(channelId)
        }
    }

    // ------------------------------------------------------------ navigation

    fun selectView(view: String) {
        store.update { st ->
            var s = st.copy(view = view)
            // A DM or group DM you were in comes back too (servers fall back to their first text channel).
            if (view == "@me" && s.selected[view] == null) session.prefs.lastChannel(view)?.takeIf { s.channels[it] != null }?.let {
                s = s.copy(selected = s.selected.putting(view, it))
            }
            if (view != "@me" && s.selected[view] == null) {
                val remembered = session.prefs.lastChannel(view)?.takeIf { s.channels[it] != null }
                val first = remembered ?: s.channelLayout(view).all.firstOrNull { it.kind == Kind.TEXT }?.id
                if (first != null) s = s.copy(selected = s.selected.putting(view, first))
            }
            s
        }
        session.prefs.lastView = view
    }

    fun selectChannel(channelId: String) {
        val ch = store.s.channels[channelId] ?: return
        val view = ch.guildId ?: "@me"
        store.update { it.copy(view = view, selected = it.selected.putting(view, channelId)) }
        session.prefs.setLastChannel(view, channelId)
        session.prefs.lastView = view
        if (store.s.messages[channelId]?.loaded != true) scope.launch { runCatching { loadMessages(channelId) } }
    }

    // ------------------------------------------------------------ messages

    private fun ensure(channelId: String) {
        if (store.s.messages[channelId] == null) store.update { it.copy(messages = it.messages.putting(channelId, ChannelMessages())) }
    }

    private fun setBucket(channelId: String, f: (ChannelMessages) -> ChannelMessages) =
        store.update { it.copy(messages = it.messages.putting(channelId, f(it.bucket(channelId)))) }

    suspend fun loadMessages(channelId: String, before: String? = null) {
        ensure(channelId)
        if (store.s.bucket(channelId).loading) return
        setBucket(channelId) { it.copy(loading = true) }
        try {
            val page = api.get<List<Message>>("/channels/$channelId/messages?limit=$PAGE${before?.let { "&before=$it" } ?: ""}")
            if (before != null) {
                setBucket(channelId) { it.copy(list = (page + it.list).toPersistentList(), loaded = true, hasMore = page.size == PAGE, loading = false) }
            } else {
                store.update { it.mergeLatest(channelId, page) }
            }
            maybeAck(channelId)
        } catch (e: Throwable) {
            setBucket(channelId) { it.copy(loading = false) }
            throw e
        }
    }

    fun loadOlder(channelId: String) {
        val b = store.s.bucket(channelId)
        if (!b.hasMore || b.loading || b.list.isEmpty()) return
        scope.launch { runCatching { loadMessages(channelId, b.list.first { !it.pending && !it.failed }.id) } }
    }

    fun loadNewer(channelId: String) {
        val b = store.s.bucket(channelId)
        if (!b.hasNewer || b.loading || b.list.isEmpty()) return
        setBucket(channelId) { it.copy(loading = true) }
        scope.launch {
            runCatching { api.get<List<Message>>("/channels/$channelId/messages?limit=$PAGE&after=${b.list.last().id}") }
                .onSuccess { page -> setBucket(channelId) { it.copy(list = (it.list + page).toPersistentList(), hasNewer = page.size == PAGE, loading = false) } }
                .onFailure { setBucket(channelId) { it.copy(loading = false) } }
        }
    }

    /** Opens the channel at a message, loading the page around it. */
    suspend fun jumpToMessage(channelId: String, messageId: String) {
        selectChannel(channelId)
        ensure(channelId)
        if (store.s.bucket(channelId).list.none { it.id == messageId }) {
            val page = api.get<List<Message>>("/channels/$channelId/messages?around=$messageId&limit=$PAGE")
            val latest = store.s.channels[channelId]?.lastMessageId
            setBucket(channelId) { ChannelMessages(page.toPersistentList(), loaded = true, hasMore = true, hasNewer = latest != null && page.none { it.id == latest }) }
        }
        _highlight.value = messageId
        scope.launch {
            delay(2500)
            if (_highlight.value == messageId) _highlight.value = null
        }
    }

    private val _highlight = MutableStateFlow<String?>(null)
    val highlight: StateFlow<String?> = _highlight

    suspend fun jumpToPresent(channelId: String) {
        setBucket(channelId) { ChannelMessages() }
        loadMessages(channelId)
    }

    private var ackJob: Job? = null

    /** Marks the channel read if it's on screen, after a moment (actions.ts maybeAck). */
    fun maybeAck(channelId: String) {
        ackJob?.cancel()
        ackJob = scope.launch {
            delay(250)
            val st = store.s
            val ch = st.channels[channelId] ?: return@launch
            val last = ch.lastMessageId ?: return@launch
            if (_viewing.value != channelId || st.bucket(channelId).hasNewer) return@launch
            store.update { it.copy(mentions = it.mentions.putting(channelId, 0)) }
            val read = st.readStates[channelId]
            if (read != null && cmpId(read, last) >= 0) return@launch
            store.update { it.copy(readStates = it.readStates.putting(channelId, last)) }
            runCatching { api.send("POST", "/channels/$channelId/ack", mapOf("message_id" to last)) }
        }
    }

    /** Voice messages this run told the server it played (it keeps the first time). */
    private val reportedPlays = java.util.Collections.synchronizedSet(HashSet<String>())

    /** You played someone's voice message in a DM: its author's tick turns read (receipts.rs). */
    fun voicePlayed(channelId: String, messageId: String) {
        val st = store.s
        val ch = st.channels[channelId] ?: return
        val m = st.messages[channelId]?.list?.firstOrNull { it.id == messageId } ?: return
        if (!Kind.isPrivate(ch.kind) || m.author.id == st.me?.id || !reportedPlays.add(messageId)) return
        scope.launch { runCatching { api.send("POST", "/channels/$channelId/messages/$messageId/played") }.onFailure { reportedPlays.remove(messageId) } }
    }

    fun markRead(channelIds: List<String>) {
        for (id in channelIds) {
            val last = store.s.channels[id]?.lastMessageId ?: continue
            store.update { it.copy(mentions = it.mentions.putting(id, 0), readStates = it.readStates.putting(id, last)) }
            scope.launch { runCatching { api.send("POST", "/channels/$id/ack", mapOf("message_id" to last)) } }
        }
    }

    /** Files of messages that failed to send, for Retry. */
    private val failedFiles = HashMap<String, List<Outgoing>>()

    fun failedFileNames(m: Message): List<String> = m.nonce?.let { failedFiles[it] }?.map { it.name } ?: emptyList()

    /** A recorded voice message: one Ogg/Opus file with its length and waveform (server messages.rs mark_voice). */
    fun sendVoice(channelId: String, file: java.io.File, seconds: Double, waveform: String, replyTo: String? = null) {
        sendMessage(channelId, "", replyTo, listOf(Outgoing(Uri.fromFile(file), "voice-message.ogg", "audio/ogg", file.length())), seconds to waveform)
    }

    fun sendMessage(channelId: String, content: String, replyTo: String? = null, files: List<Outgoing> = emptyList(), voice: Pair<Double, String>? = null) {
        val me = store.s.me ?: return
        // Over the limit, text goes as message.txt, like Discord (Composer.tsx): the phone sends it whole.
        var text = content
        var attach = files
        if (text.length > MAX_MESSAGE) {
            attach = files + textFile(text)
            text = ""
        }
        val nonce = "${System.currentTimeMillis()}${(0..999_999).random()}"
        ensure(channelId)
        scope.launch {
            if (store.s.bucket(channelId).hasNewer) runCatching { jumpToPresent(channelId) }
            val ref = replyTo?.let { id -> store.s.bucket(channelId).list.firstOrNull { it.id == id } }?.let { MessageRef(it.id, it.author, it.content) }
            // A voice message plays from the local recording while it uploads.
            val local = voice?.let { (secs, wave) ->
                listOf(com.linkord.core.Attachment("pending-$nonce", "voice-message.ogg", attach[0].uri.toString(), attach[0].size, "audio/ogg", secs, wave))
            } ?: emptyList()
            val temp = Message(
                id = "pending-$nonce", channelId = channelId, author = me, content = text, replyTo = replyTo, referencedMessage = ref, attachments = local,
                createdAt = java.time.Instant.now().toString(), nonce = nonce, pending = true,
            )
            setBucket(channelId) { it.copy(list = it.list.adding(temp)) }
            _sent.value = channelId to (_sent.value.second + 1)
            val payload = buildJsonObject {
                put("content", text)
                replyTo?.let { put("reply_to", it) }
                put("nonce", nonce)
                voice?.let { (secs, wave) ->
                    put("voice", buildJsonObject {
                        put("duration_secs", secs)
                        put("waveform", wave)
                    })
                }
            }
            try {
                val body: RequestBody = if (attach.isEmpty()) api.jsonBody(payload)!! else multipart(payload, attach)
                val msg = api.decode<Message>(api.raw("POST", "/channels/$channelId/messages", body))
                store.update { it.receive(msg) }
            } catch (e: Throwable) {
                if (attach.isNotEmpty()) failedFiles[nonce] = attach
                setBucket(channelId) { b ->
                    b.copy(list = b.list.map { if (it.nonce == nonce && it.pending) it.copy(pending = false, failed = true) else it }.toPersistentList())
                }
            }
        }
    }

    /** Bumps each time you send, so the chat scrolls to the bottom. */
    private val _sent = MutableStateFlow<Pair<String, Int>>("" to 0)
    val sent: StateFlow<Pair<String, Int>> = _sent

    private fun textFile(text: String): Outgoing {
        val f = java.io.File(session.context.cacheDir, "message-${System.nanoTime()}.txt")
        f.writeText(text)
        return Outgoing(Uri.fromFile(f), "message.txt", "text/plain", f.length())
    }

    private fun multipart(payload: JsonObject, files: List<Outgoing>): RequestBody {
        val b = MultipartBody.Builder().setType(MultipartBody.FORM).addFormDataPart("payload_json", payload.toString())
        files.forEachIndexed { i, f -> b.addFormDataPart("files[$i]", f.name, uriBody(f)) }
        return b.build()
    }

    private fun uriBody(f: Outgoing) = object : RequestBody() {
        override fun contentType() = f.type.toMediaTypeOrNull()
        override fun contentLength() = f.size
        override fun writeTo(sink: BufferedSink) {
            session.context.contentResolver.openInputStream(f.uri)!!.source().use { sink.writeAll(it) }
        }
    }

    /** What a picked content URI is called and how big it is. */
    fun describeUri(uri: Uri): Outgoing {
        val cr = session.context.contentResolver
        var name = uri.lastPathSegment ?: "file"
        var size = -1L
        cr.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                c.getString(0)?.let { name = it }
                if (!c.isNull(1)) size = c.getLong(1)
            }
        }
        return Outgoing(uri, name, cr.getType(uri) ?: "application/octet-stream", size)
    }

    fun dismissMessage(m: Message) {
        m.nonce?.let { failedFiles.remove(it) }
        setBucket(m.channelId) { b -> b.copy(list = b.list.removingAll { it.id == m.id }) }
    }

    fun retryMessage(m: Message) {
        val files = m.nonce?.let { failedFiles.remove(it) } ?: emptyList()
        setBucket(m.channelId) { b -> b.copy(list = b.list.removingAll { it.id == m.id }) }
        val v = m.attachments.firstOrNull()?.takeIf { it.isVoiceNote && it.url.startsWith("file:") }
        if (v != null) return sendVoice(m.channelId, java.io.File(Uri.parse(v.url).path!!), v.durationSecs ?: 0.0, v.waveform!!, m.replyTo)
        sendMessage(m.channelId, m.content, m.replyTo, files)
    }

    /** Runs a slash command (/play...). The bot answers in the channel; mistakes come back as a message to show. */
    fun runCommand(channelId: String, name: String, query: String) {
        scope.launch {
            runCatching { api.post<Message>("/channels/$channelId/commands", mapOf("name" to name, "query" to query)) }
                .onSuccess { m -> store.update { it.receive(m) } }
                .onFailure { session.toast(session.describe(it)) }
        }
    }

    /** Throws a snowball at someone (snowball.rs), at their message when there is one. */
    fun throwSnowball(channelId: String, target: String, messageId: String? = null) {
        scope.launch {
            runCatching { api.send("POST", "/channels/$channelId/snowball", mapOf("target" to target, "message_id" to messageId)) }
                .onFailure { session.toast(session.describe(it)) }
        }
    }

    /** A thread from a message (named after it unless a name is given), opened at once. */
    suspend fun startThread(m: Message, name: String?) {
        val thread = api.post<Channel>("/channels/${m.channelId}/messages/${m.id}/threads", mapOf("name" to name))
        store.update { it.copy(channels = it.channels.putting(thread.id, thread)) }
        selectChannel(thread.id)
    }

    /** Your custom status: emoji and/or text, clearing itself at [expiresAt] (unix ms) if given. */
    /** [emoji]: a Unicode one (name only) or a server's (id + name); the server checks it and fills in its real name. */
    suspend fun setCustomStatus(emoji: com.linkord.core.StatusEmoji?, text: String?, expiresAt: Long?) {
        val e = emoji?.takeIf { it.name.isNotBlank() }?.let { it.copy(name = it.name.trim()) }
        if (e == null && text.isNullOrBlank()) {
            api.send("DELETE", "/activities/custom")
            store.update { it.copy(customStatus = null) }
            return
        }
        val wire = e?.let { if (it.id != null) mapOf("id" to it.id, "name" to it.name, "animated" to it.animated) else mapOf("name" to it.name) }
        api.send("PUT", "/activities/custom", mapOf("text" to text?.trim(), "emoji" to wire, "expires_at" to expiresAt))
        store.update { it.copy(customStatus = com.linkord.core.Activity(type = 4, name = "Custom Status", state = text?.trim(), emoji = e, expiresAt = expiresAt)) }
    }

    suspend fun editMessage(m: Message, content: String) {
        api.send("PATCH", "/channels/${m.channelId}/messages/${m.id}", mapOf("content" to content))
    }

    suspend fun deleteMessage(m: Message) {
        api.send("DELETE", "/channels/${m.channelId}/messages/${m.id}")
    }

    fun toggleReaction(m: Message, emoji: String) {
        val me = store.s.me?.id ?: return
        val mine = m.reactions.firstOrNull { it.emoji == emoji }?.users?.contains(me) == true
        scope.launch {
            runCatching {
                api.send(if (mine) "DELETE" else "PUT", "/channels/${m.channelId}/messages/${m.id}/reactions/${java.net.URLEncoder.encode(emoji, "UTF-8").replace("+", "%20")}")
            }.onFailure { session.toast(session.describe(it)) }
        }
    }

    suspend fun togglePin(m: Message) {
        api.send(if (m.pinned) "DELETE" else "PUT", "/channels/${m.channelId}/pins/${m.id}")
    }

    private var lastTyping = 0L

    fun sendTyping(channelId: String) {
        val now = System.currentTimeMillis()
        if (now - lastTyping < 8000) return
        lastTyping = now
        scope.launch { runCatching { api.send("POST", "/channels/$channelId/typing") } }
    }

    fun resetTyping() {
        lastTyping = 0
    }

    // ------------------------------------------------------------ people, servers, settings

    suspend fun dmChannel(userId: String): Channel {
        val ch = api.post<Channel>("/users/@me/channels", mapOf("recipient_id" to userId))
        store.update { it.addDm(ch) }
        return ch
    }

    suspend fun openDm(userId: String) = selectChannel(dmChannel(userId).id)

    suspend fun acceptInvite(code: String) {
        val g = api.post<Guild>("/invites/$code")
        store.update { it.addGuild(g) }
        selectView(g.id)
    }

    /** Synced settings: shown at once, then saved (unknown keys are the server's business). */
    fun patchSettings(patch: Map<String, Any?>) {
        val json = toJson(patch) as JsonObject
        store.update { st -> applySettings(st.copy(settingsRaw = JsonObject(st.settingsRaw + json))) }
        scope.launch { runCatching { api.send("PATCH", "/users/@me/settings", json) }.onFailure { session.toast(session.describe(it)) } }
    }

    private fun applySettings(st: com.linkord.core.State) =
        st.copy(settings = runCatching { LinkordJson.decodeFromJsonElement(com.linkord.core.Settings.serializer(), st.settingsRaw) }.getOrDefault(st.settings))

    private fun toggleIn(list: List<String>, id: String) = if (id in list) list - id else list + id

    fun toggleMuteGuild(id: String) = patchSettings(mapOf("muted_guilds" to toggleIn(store.s.settings.mutedGuilds, id)))
    fun toggleMuteChannel(id: String) = patchSettings(mapOf("muted_channels" to toggleIn(store.s.settings.mutedChannels, id)))
    fun toggleCategory(id: String) = patchSettings(mapOf("collapsed_categories" to toggleIn(store.s.settings.collapsedCategories, id)))

    suspend fun friendRequest(userId: String) = api.send("PUT", "/users/@me/relationships/$userId")
    suspend fun friendRequestByName(username: String) = api.send("POST", "/users/@me/relationships", mapOf("username" to username))
    suspend fun removeRelationship(userId: String) = api.send("DELETE", "/users/@me/relationships/$userId")
    suspend fun blockUser(userId: String) = api.send("PUT", "/users/@me/relationships/$userId", mapOf("type" to 2))

    // Moderation (web: Profile.tsx memberMenu). The server checks the permission and that you outrank them.
    suspend fun kick(guildId: String, userId: String) = api.send("DELETE", "/guilds/$guildId/members/$userId")
    suspend fun ban(guildId: String, userId: String) = api.send("PUT", "/guilds/$guildId/bans/$userId")
    suspend fun unban(guildId: String, userId: String) = api.send("DELETE", "/guilds/$guildId/bans/$userId")
    /** Into another voice channel, or out of the call ([channelId] null). */
    suspend fun moveMember(guildId: String, userId: String, channelId: String?) =
        api.send("PATCH", "/guilds/$guildId/members/$userId/voice", mapOf("channel_id" to (channelId ?: kotlinx.serialization.json.JsonNull)))
    /** Someone's nickname in the server; empty clears it. */
    suspend fun setNickname(guildId: String, userId: String, nickname: String) =
        api.send("PATCH", "/guilds/$guildId/members/$userId", mapOf("nickname" to nickname))

    suspend fun setStatus(status: String) {
        api.send("PATCH", "/users/@me", mapOf("status" to status))
        store.update { st -> st.copy(me = st.me?.copy(status = status)) }
    }

    /** Privacy: read receipts in DMs (off both ways, server receipts.rs). */
    suspend fun setReadReceipts(on: Boolean) {
        api.send("PATCH", "/users/@me", mapOf("read_receipts" to on))
        store.update { st -> st.copy(me = st.me?.copy(readReceipts = on)) }
    }

    /** Privacy: let others' REC record my voice (users.rec_opt_out is the opposite). */
    suspend fun setRecordable(on: Boolean) {
        api.send("PATCH", "/users/@me", mapOf("rec_opt_out" to !on))
        store.update { st -> st.copy(me = st.me?.copy(recOptOut = !on)) }
    }

    companion object {
        /** What the server takes (messages.rs MAX_CONTENT). */
        const val MAX_MESSAGE = 4000
    }
}
