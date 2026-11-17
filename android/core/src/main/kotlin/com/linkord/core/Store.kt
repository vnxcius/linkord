package com.linkord.core

import kotlinx.collections.immutable.PersistentList
import kotlinx.collections.immutable.PersistentMap
import kotlinx.collections.immutable.persistentListOf
import kotlinx.collections.immutable.persistentMapOf
import kotlinx.collections.immutable.toPersistentList
import kotlinx.collections.immutable.toPersistentMap
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/** One channel's loaded messages, oldest first (app/src/lib/store.ts ChannelMessages). */
data class ChannelMessages(
    val list: PersistentList<Message> = persistentListOf(),
    val loaded: Boolean = false,
    /** Older messages exist on the server. */
    val hasMore: Boolean = true,
    /** Newer messages exist (after jumping back to an old one). */
    val hasNewer: Boolean = false,
    val loading: Boolean = false,
    /** Messages that came over the gateway while the latest page was on its way (not loaded yet): mergeLatest keeps them. */
    val arrived: Set<String> = emptySet(),
)

enum class Connection { Idle, Connecting, Open, Reconnecting }

/** Everything the app shows, in one immutable value (the web client's store.ts). Replace it, never mutate it. */
data class State(
    val connection: Connection = Connection.Idle,
    val ready: Boolean = false,
    val sessionId: String? = null,
    val me: User? = null,
    val users: PersistentMap<String, User> = persistentMapOf(),
    val guilds: PersistentMap<String, GuildInfo> = persistentMapOf(),
    val guildOrder: PersistentList<String> = persistentListOf(),
    val channels: PersistentMap<String, Channel> = persistentMapOf(),
    /** guild id -> user id -> membership */
    val members: PersistentMap<String, PersistentMap<String, MemberInfo>> = persistentMapOf(),
    /** guild id -> role id -> role */
    val roles: PersistentMap<String, PersistentMap<String, Role>> = persistentMapOf(),
    val emojis: PersistentMap<String, List<Emoji>> = persistentMapOf(),
    val dmOrder: PersistentList<String> = persistentListOf(),
    val relationships: PersistentMap<String, Int> = persistentMapOf(),
    val settings: Settings = Settings(),
    /** The settings as the server sent them, so unknown keys survive. */
    val settingsRaw: JsonObject = JsonObject(emptyMap()),
    val presences: PersistentMap<String, String> = persistentMapOf(),
    val activities: PersistentMap<String, List<Activity>> = persistentMapOf(),
    val customStatus: Activity? = null,
    val notes: PersistentMap<String, String> = persistentMapOf(),
    val readStates: PersistentMap<String, String> = persistentMapOf(),
    /** DM channel id -> the others' receipts by user id (server receipts.rs). */
    val receipts: PersistentMap<String, PersistentMap<String, Receipt>> = persistentMapOf(),
    val messages: PersistentMap<String, ChannelMessages> = persistentMapOf(),
    /** channel id -> user id -> expiry (ms since epoch) */
    val typing: PersistentMap<String, PersistentMap<String, Long>> = persistentMapOf(),
    val voice: PersistentMap<String, VoiceState> = persistentMapOf(),
    val voiceStatus: PersistentMap<String, String> = persistentMapOf(),
    val mentions: PersistentMap<String, Int> = persistentMapOf(),
    /** '@me' for DMs/friends, otherwise a guild id. */
    val view: String = "@me",
    /** Last selected channel per view. */
    val selected: PersistentMap<String, String> = persistentMapOf(),
    val admin: Boolean = false,
    /** DM calls going on: channel id -> who is being rung. */
    val calls: PersistentMap<String, List<String>> = persistentMapOf(),
    /** Server clock minus ours (ms), from READY. */
    val clockSkew: Long = 0,
    val botCommands: List<BotCommand> = emptyList(),
    /** Calls watching something together: channel id -> what. */
    val watches: PersistentMap<String, Watch> = persistentMapOf(),
)

/** A message the user should hear about (the app decides how: sound, notification). */
data class Alert(val message: Message, val channel: Channel, val mentioned: Boolean)

class Store {
    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state
    val s: State get() = _state.value

    /** Called for messages that notify (mirrors gateway.ts onMessage). */
    var onAlert: ((Alert) -> Unit)? = null

    /** A relationship changed (RELATIONSHIP_ADD / _REMOVE): [Rel] kinds before and after, null for none. */
    var onRelationship: ((id: String, before: Int?, after: Int?) -> Unit)? = null

    /** Whether the user is looking at this channel right now (app in front, chat open). */
    var isViewing: (String) -> Boolean = { false }

    fun update(f: (State) -> State) = _state.update(f)

    fun reset() {
        _state.value = State()
    }

    // ---------------------------------------------------------------- gateway events (gateway.ts handle)

    fun handle(t: String, d: JsonElement) {
        when (t) {
            "READY" -> onReady(LinkordJson.decodeFromJsonElement(d))
            "RESUMED" -> update { it.copy(connection = Connection.Open) }
            "GUILD_CREATE" -> update { it.addGuild(dec(d)) }
            "GUILD_UPDATE" -> {
                val g = d.jsonObject
                update { st ->
                    val id = g.str("id") ?: return@update st
                    val old = st.guilds[id] ?: return@update st
                    st.copy(guilds = st.guilds.putting(id, merge(old, g)))
                }
            }
            "GUILD_DELETE" -> update { it.removeGuild(d.jsonObject.str("id")!!) }
            "GUILD_MEMBER_ADD", "GUILD_MEMBER_UPDATE" -> {
                val o = d.jsonObject
                val gid = o.str("guild_id") ?: return
                val m: Member = dec(o["member"]!!)
                update { st ->
                    val s1 = st.putMember(gid, m)
                    val status = o.str("status")
                    if (status != null) s1.copy(presences = s1.presences.putting(m.user.id, status)) else s1
                }
            }
            "GUILD_MEMBER_REMOVE" -> {
                val o = d.jsonObject
                val gid = o.str("guild_id") ?: return
                val uid = o.str("user_id") ?: return
                update { st -> st.copy(members = st.members.putting(gid, (st.members[gid] ?: persistentMapOf()).removing(uid))) }
            }
            "GUILD_ROLES_UPDATE" -> {
                val o = d.jsonObject
                val roles: List<Role> = dec(o["roles"]!!)
                update { it.setRoles(o.str("guild_id")!!, roles) }
            }
            "GUILD_ROLE_UPDATE" -> {
                val o = d.jsonObject
                val gid = o.str("guild_id")!!
                val r: Role = dec(o["role"]!!)
                update { st -> st.copy(roles = st.roles.putting(gid, (st.roles[gid] ?: persistentMapOf()).putting(r.id, r))) }
            }
            "GUILD_EMOJIS_UPDATE" -> {
                val o = d.jsonObject
                update { it.copy(emojis = it.emojis.putting(o.str("guild_id")!!, dec(o["emojis"]!!))) }
            }
            "CHANNEL_CREATE" -> {
                val c: Channel = dec(d)
                update { if (Kind.isPrivate(c.kind)) it.addDm(c) else it.copy(channels = it.channels.putting(c.id, c)) }
            }
            "CHANNEL_UPDATE" -> {
                val o = d.jsonObject
                update { st ->
                    val id = o.str("id")!!
                    val old = st.channels[id]
                    val merged: Channel = if (old != null) merge(old, o) else dec(o)
                    st.copy(channels = st.channels.putting(id, merged.copy(recipients = old?.recipients ?: merged.recipients)))
                }
            }
            "CHANNEL_DELETE" -> {
                val o = d.jsonObject
                val id = o.str("id")!!
                update { st ->
                    val view = o.str("guild_id") ?: "@me"
                    val sel = if (st.selected[view] == id) {
                        o.str("parent_id")?.let { st.selected.putting(view, it) } ?: st.selected.removing(view)
                    } else st.selected
                    st.copy(channels = st.channels.removing(id), dmOrder = st.dmOrder.removing(id), selected = sel)
                }
            }
            "CHANNEL_RECIPIENT_ADD" -> {
                val o = d.jsonObject
                val u: User = dec(o["user"]!!)
                val cid = o.str("channel_id")!!
                update { st ->
                    val c = st.channels[cid] ?: return@update st.putUser(u)
                    st.putUser(u).copy(channels = st.channels.putting(cid, c.copy(recipients = (c.recipients ?: emptyList()) + u)))
                }
            }
            "CHANNEL_RECIPIENT_REMOVE" -> {
                val o = d.jsonObject
                val cid = o.str("channel_id")!!
                val uid = o.str("user_id")!!
                update { st ->
                    val c = st.channels[cid] ?: return@update st
                    st.copy(channels = st.channels.putting(cid, c.copy(recipients = c.recipients?.filter { it.id != uid })))
                }
            }
            "MESSAGE_CREATE" -> onMessage(dec(d))
            "MESSAGE_UPDATE" -> {
                val m: Message = dec(d)
                update { st ->
                    val b = st.messages[m.channelId] ?: return@update st
                    val i = b.list.indexOfFirst { it.id == m.id }
                    if (i < 0) st else st.copy(messages = st.messages.putting(m.channelId, b.copy(list = b.list.replacingAt(i, m))))
                }
            }
            "MESSAGE_DELETE" -> {
                val o = d.jsonObject
                val cid = o.str("channel_id")!!
                val id = o.str("id")!!
                update { st ->
                    val b = st.messages[cid] ?: return@update st
                    st.copy(messages = st.messages.putting(cid, b.copy(list = b.list.removingAll { it.id == id })))
                }
            }
            "MESSAGE_ACK" -> {
                val o = d.jsonObject
                val cid = o.str("channel_id")!!
                val mid = o.str("message_id")!!
                update { st ->
                    val cur = st.readStates[cid]
                    val rs = if (cur == null || cmpId(mid, cur) > 0) st.readStates.putting(cid, mid) else st.readStates
                    st.copy(readStates = rs, mentions = st.mentions.putting(cid, 0))
                }
            }
            "DM_RECEIPT" -> {
                val o = d.jsonObject
                val cid = o.str("channel_id") ?: return
                val uid = o.str("user_id") ?: return
                update { it.withReceipt(cid, uid, delivered = o.str("delivered_id"), read = o.str("read_id")) }
            }
            // Someone (maybe you) turned read receipts on or off: all of your DMs' receipts again.
            "DM_RECEIPTS" -> {
                val o = d.jsonObject
                val all: Map<String, List<Receipt>> = LinkordJson.decodeFromJsonElement(o["receipts"] ?: return)
                val own = (o["read_receipts"] as? JsonPrimitive)?.booleanOrNull
                update { st ->
                    st.copy(
                        receipts = all.mapValues { (_, l) -> l.associateBy { it.userId }.toPersistentMap() }.toPersistentMap(),
                        me = if (own != null) st.me?.copy(readReceipts = own) else st.me,
                    )
                }
            }
            "REACTION_ADD", "REACTION_REMOVE" -> {
                val o = d.jsonObject
                onReaction(t == "REACTION_ADD", o.str("channel_id")!!, o.str("message_id")!!, o.str("user_id")!!, o.str("emoji")!!)
            }
            "TYPING_START" -> {
                val o = d.jsonObject
                val cid = o.str("channel_id")!!
                val uid = o.str("user_id")!!
                update { st ->
                    val m = (st.typing[cid] ?: persistentMapOf()).putting(uid, System.currentTimeMillis() + 10_000)
                    st.copy(typing = st.typing.putting(cid, m))
                }
            }
            "PRESENCE_UPDATE" -> {
                val o = d.jsonObject
                val uid = o.str("user_id")!!
                val acts: List<Activity> = o["activities"]?.let { runCatching { dec<List<Activity>>(it) }.getOrNull() } ?: emptyList()
                update { st ->
                    st.copy(presences = st.presences.putting(uid, o.str("status") ?: "offline"), activities = st.activities.putting(uid, acts))
                }
            }
            "CUSTOM_STATUS_UPDATE" -> {
                val a = d.jsonObject["custom_status"]?.takeIf { it is JsonObject }?.let { dec<Activity>(it) }
                update { it.copy(customStatus = a) }
            }
            "USER_NOTE_UPDATE" -> {
                val o = d.jsonObject
                update { it.copy(notes = it.notes.putting(o.str("id")!!, o.str("note") ?: "")) }
            }
            "USER_UPDATE" -> {
                val o = d.jsonObject
                update { st ->
                    val id = o.str("id")!!
                    val old = st.users[id]
                    val u: User = if (old != null) merge(old, o) else dec(o)
                    val s1 = st.putUser(u)
                    if (id == st.me?.id) s1.copy(me = merge(st.me, o)) else s1
                }
            }
            "USER_SETTINGS_UPDATE" -> update { it.withSettings(d.jsonObject) }
            "RELATIONSHIP_ADD" -> {
                val r: Relationship = dec(d)
                val before = s.relationships[r.id]
                update { it.putUser(r.user).let { s1 -> s1.copy(relationships = s1.relationships.putting(r.id, r.type)) } }
                onRelationship?.invoke(r.id, before, r.type)
            }
            "RELATIONSHIP_REMOVE" -> {
                val id = d.jsonObject.str("id")!!
                val before = s.relationships[id]
                update { it.copy(relationships = it.relationships.removing(id)) }
                onRelationship?.invoke(id, before, null)
            }
            "CALL_UPDATE" -> {
                val o = d.jsonObject
                val ringing = o["ringing"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList()
                update { it.copy(calls = it.calls.putting(o.str("channel_id")!!, ringing)) }
            }
            "VOICE_CHANNEL_STATUS_UPDATE" -> {
                val o = d.jsonObject
                val cid = o.str("channel_id")!!
                val status = o.str("status")
                update { it.copy(voiceStatus = if (status.isNullOrEmpty()) it.voiceStatus.removing(cid) else it.voiceStatus.putting(cid, status)) }
            }
            "BOT_COMMANDS_UPDATE" -> {
                val list = (d as? JsonObject)?.get("commands")?.let { runCatching { dec<List<BotCommand>>(it) }.getOrNull() } ?: emptyList()
                update { it.copy(botCommands = list) }
            }
            "WATCH_UPDATE" -> {
                val o = d.jsonObject
                val cid = o.str("channel_id") ?: return
                val w = o["watch"]?.takeIf { it is JsonObject }?.let { runCatching { dec<Watch>(it) }.getOrNull() }
                val now = (o["server_now"] as? JsonPrimitive)?.longOrNull
                update { st ->
                    st.copy(
                        watches = if (w != null) st.watches.putting(cid, w) else st.watches.removing(cid),
                        clockSkew = now?.let { it - System.currentTimeMillis() } ?: st.clockSkew,
                    )
                }
            }
            "VOICE_STATE_UPDATE" -> {
                val v: VoiceState = dec(d)
                update { it.copy(voice = if (v.channelId != null) it.voice.putting(v.userId, v) else it.voice.removing(v.userId)) }
            }
        }
    }

    private fun onReady(d: Ready) {
        update { old ->
            var st = State(
                connection = Connection.Open,
                ready = true,
                sessionId = d.sessionId,
                me = d.user,
                admin = d.admin,
                view = old.view,
                selected = old.selected,
                notes = old.notes,
                clockSkew = d.serverNow?.let { it - System.currentTimeMillis() } ?: 0,
                calls = d.calls.associate { it.channelId to it.ringing }.toPersistentMap(),
                botCommands = d.botCommands,
                watches = d.watches.associate { it.channelId to it.watch }.toPersistentMap(),
            )
            st = st.putUser(d.user)
            for (g in d.guilds) st = st.addGuild(g)
            for (c in d.dms) st = st.addDm(c)
            for (r in d.relationships) st = st.putUser(r.user)
            st = st.copy(
                relationships = d.relationships.associate { it.id to it.type }.toPersistentMap(),
                presences = d.presences.toPersistentMap(),
                activities = d.activities.toPersistentMap(),
                customStatus = d.customStatus,
                readStates = d.readStates.toPersistentMap(),
                receipts = d.dmReceipts.mapValues { (_, l) -> l.associateBy { it.userId }.toPersistentMap() }.toPersistentMap(),
                voice = d.voiceStates.filter { it.channelId != null }.associateBy { it.userId }.toPersistentMap(),
                voiceStatus = d.voiceChannelStatuses.associate { it.channelId to it.status }.toPersistentMap(),
            )
            st = st.withSettings(d.settings as? JsonObject ?: JsonObject(emptyMap()))
            // Messages may have been missed while disconnected: each channel refreshes when it's opened and keeps what
            // it shows until then. Ones showing older history start over, like channels that are gone.
            var msgs = old.messages
            for ((id, b) in old.messages) {
                msgs = if (st.channels[id] == null || b.hasNewer) msgs.removing(id) else msgs.putting(id, b.copy(loaded = false, loading = false))
            }
            st = st.copy(messages = msgs)
            if (st.view != "@me" && st.guilds[st.view] == null) st = st.copy(view = "@me")
            st
        }
    }

    private fun onMessage(m: Message) {
        var alert: Alert? = null
        update { st0 ->
            var st = st0.putUser(m.author)
            val ch = st.channels[m.channelId]
            if (ch != null) st = st.copy(channels = st.channels.putting(ch.id, ch.copy(lastMessageId = m.id)))
            st = st.receive(m)
            st.typing[m.channelId]?.let { st = st.copy(typing = st.typing.putting(m.channelId, it.removing(m.author.id))) }
            if (!isViewing(m.channelId)) st = st.trimHistory(m.channelId)
            val me = st.me
            alert = null
            if (me == null || ch == null) return@update st
            if (m.author.id == me.id) return@update st.copy(readStates = st.readStates.putting(m.channelId, m.id))
            if (isViewing(m.channelId)) return@update st
            if (st.isBlocked(m.author.id)) return@update st
            val roleMention = (st.members[ch.guildId ?: ""]?.get(me.id)?.roles ?: emptyList()).any { m.content.contains("<@&$it>") }
            val direct = m.content.contains("<@${me.id}>")
            val mentioned = Kind.isPrivate(ch.kind) || direct || roleMention || m.mentionEveryone || m.referencedMessage?.author?.id == me.id
            // Muting silences everything except direct @mentions, like Discord; "Nothing" silences even those.
            val level = if (ch.guildId != null) st.notifyLevel(ch) else "all"
            if (level == "none" || (st.isMuted(ch) && !direct)) return@update st
            if (mentioned) {
                st = st.copy(mentions = st.mentions.putting(m.channelId, (st.mentions[m.channelId] ?: 0) + 1))
            } else if (level != "all" || ch.guildId == null || m.author.bot || m.type != 0) return@update st
            if (me.status != "dnd") alert = Alert(m, ch, mentioned)
            st
        }
        alert?.let { a -> onAlert?.invoke(a) }
    }

    private fun onReaction(add: Boolean, cid: String, mid: String, uid: String, emoji: String) = update { st ->
        val b = st.messages[cid] ?: return@update st
        val i = b.list.indexOfFirst { it.id == mid }
        if (i < 0) return@update st
        val msg = b.list[i]
        val rs = msg.reactions.toMutableList()
        val r = rs.indexOfFirst { it.emoji == emoji }
        if (add) {
            if (r < 0) rs += Reaction(emoji, listOf(uid))
            else if (uid !in rs[r].users) rs[r] = rs[r].copy(users = rs[r].users + uid)
        } else if (r >= 0) {
            val users = rs[r].users - uid
            if (users.isEmpty()) rs.removeAt(r) else rs[r] = rs[r].copy(users = users)
        }
        st.copy(messages = st.messages.putting(cid, b.copy(list = b.list.replacingAt(i, msg.copy(reactions = rs)))))
    }

    fun setConnection(c: Connection) = update { it.copy(connection = c) }

    private inline fun <reified T> dec(e: JsonElement): T = LinkordJson.decodeFromJsonElement(e)
}

// ---------------------------------------------------------------- pure state changes

fun State.putUser(u: User): State {
    val prev = users[u.id]
    return copy(users = users.putting(u.id, if (prev != null) u.copy(status = u.status ?: prev.status) else u))
}

fun State.putMember(guildId: String, m: Member): State {
    val s = putUser(m.user)
    return s.copy(members = s.members.putting(guildId, (s.members[guildId] ?: persistentMapOf()).putting(m.user.id, m.info())))
}

fun State.setRoles(guildId: String, list: List<Role>): State =
    copy(roles = roles.putting(guildId, list.associateBy { it.id }.toPersistentMap()))

fun State.addGuild(g: Guild): State {
    var s = copy(guilds = guilds.putting(g.id, g.info()), guildOrder = if (g.id in guildOrder) guildOrder else guildOrder.adding(g.id))
    val chans = s.channels.builder()
    for (c in g.channels) chans[c.id] = c
    s = s.copy(channels = chans.build(), members = s.members.putting(g.id, persistentMapOf()))
    val users = s.users.builder()
    val members = persistentMapOf<String, MemberInfo>().builder()
    for (m in g.members) {
        val prev = users[m.user.id]
        users[m.user.id] = if (prev != null) m.user.copy(status = m.user.status ?: prev.status) else m.user
        members[m.user.id] = m.info()
    }
    s = s.copy(users = users.build(), members = s.members.putting(g.id, members.build()))
    return s.setRoles(g.id, g.roles).copy(emojis = s.emojis.putting(g.id, g.emojis))
}

fun State.removeGuild(id: String): State = copy(
    channels = channels.filterValues { it.guildId != id }.toPersistentMap(),
    guilds = guilds.removing(id),
    members = members.removing(id),
    roles = roles.removing(id),
    emojis = emojis.removing(id),
    guildOrder = guildOrder.removing(id),
    view = if (view == id) "@me" else view,
)

fun State.addDm(c: Channel): State {
    var s = this
    for (u in c.recipients ?: emptyList()) s = s.putUser(u)
    return s.copy(channels = s.channels.putting(c.id, c), dmOrder = if (c.id in s.dmOrder) s.dmOrder else s.dmOrder.addingAt(0, c.id))
}

fun State.withSettings(raw: JsonObject): State {
    val typed = runCatching { LinkordJson.decodeFromJsonElement<Settings>(raw) }.getOrDefault(Settings())
    return copy(settingsRaw = raw, settings = typed)
}

fun State.bucket(channelId: String) = messages[channelId] ?: ChannelMessages()

/** Inserts a message, replacing the optimistic copy with the same nonce (actions.ts receiveMessage). */
fun State.receive(msg: Message): State {
    val b = messages[msg.channelId] ?: return this
    if (b.list.any { it.id == msg.id }) return this
    // Our own message coming back always takes its optimistic copy's place, even while the channel waits to be
    // reloaded (after a READY) or shows history: otherwise the grey copy stayed beside the real one.
    val pending = if (msg.nonce != null) b.list.indexOfFirst { it.nonce == msg.nonce && it.author.id == msg.author.id } else -1
    if (pending >= 0) {
        val confirmed = b.copy(list = b.list.replacingAt(pending, msg.copy(pending = false, failed = false)), arrived = if (b.loaded) b.arrived else b.arrived + msg.id)
        return copy(messages = messages.putting(msg.channelId, confirmed))
    }
    // While viewing history the new message isn't next to what's loaded; jumping to the present picks it up. While
    // the latest page is on its way it's kept (mergeLatest keeps what's newer than the page).
    if ((!b.loaded && !b.loading) || b.hasNewer) return this
    val arrived = if (b.loaded) b.arrived else b.arrived + msg.id
    return copy(messages = messages.putting(msg.channelId, b.copy(list = b.list.adding(msg), arrived = arrived)))
}

const val PAGE = 50
/** Older messages are dropped from memory beyond this while reading the latest ones. */
const val KEEP = 200

fun State.trimHistory(channelId: String): State {
    val b = messages[channelId] ?: return this
    if (b.hasNewer || b.list.size <= KEEP) return this
    return copy(messages = messages.putting(channelId, b.copy(list = b.list.subList(b.list.size - KEEP, b.list.size).toPersistentList(), hasMore = true)))
}

/**
 * The latest page, into what's already held (actions.ts mergeLatest): messages we have are kept as they are, so a
 * reconnect never wipes what's on screen.
 */
fun State.mergeLatest(channelId: String, page: List<Message>): State {
    val b = bucket(channelId)
    val held = b.list.associateBy { it.id }
    val first = page.firstOrNull()?.id
    val joined = page.size == PAGE && first != null && first in held
    val older = if (joined) b.list.filter { !it.pending && !it.failed && cmpId(it.id, first) < 0 } else emptyList()
    // Messages that came over the gateway while the page was on its way and aren't in it, then our unsent ones.
    val inPage = page.mapTo(HashSet()) { it.id }
    val newer = b.list.filter { it.id in b.arrived && it.id !in inPage && !it.pending && !it.failed }
    val local = b.list.filter { it.pending || it.failed }
    val list = (older + page + newer + local).toPersistentList()
    return copy(
        messages = messages.putting(
            channelId,
            b.copy(list = list, loaded = true, hasMore = if (joined) b.hasMore else page.size == PAGE, hasNewer = false, loading = false, arrived = emptySet()),
        ),
    )
}

// ---------------------------------------------------------------- reading the state (store.ts helpers)

private fun inOrder(a: Channel, b: Channel): Int =
    (if (a.kind == Kind.VOICE) 1 else 0).compareTo(if (b.kind == Kind.VOICE) 1 else 0).takeIf { it != 0 }
        ?: a.position.compareTo(b.position).takeIf { it != 0 }
        ?: cmpId(a.id, b.id)

data class CategoryGroup(val category: Channel, val channels: List<Channel>)
data class ChannelLayout(val top: List<Channel>, val categories: List<CategoryGroup>) {
    val all: List<Channel> get() = top + categories.flatMap { it.channels }
}

/** Top-level channels of a guild (threads are listed under their parent). */
fun State.guildChannels(guildId: String): List<Channel> =
    channels.values.filter { it.guildId == guildId && it.kind != Kind.THREAD }
        .sortedWith { a, b -> a.position.compareTo(b.position).takeIf { it != 0 } ?: cmpId(a.id, b.id) }

/** A server's channel list like Discord's: channels without a category first, then each category. */
fun State.channelLayout(guildId: String): ChannelLayout {
    val all = guildChannels(guildId)
    val cats = all.filter { it.kind == Kind.CATEGORY }
    val catIds = cats.map { it.id }.toSet()
    val chans = all.filter { it.kind == Kind.TEXT || it.kind == Kind.VOICE }
    return ChannelLayout(
        top = chans.filter { it.parentId == null || it.parentId !in catIds }.sortedWith(::inOrder),
        categories = cats.map { cat -> CategoryGroup(cat, chans.filter { it.parentId == cat.id }.sortedWith(::inOrder)) },
    )
}

/** A text channel's place in its server's list: "01", "02"… (threads use their parent's). */
fun State.channelNumber(c: Channel): String? {
    val ch = if (c.kind == Kind.THREAD && c.parentId != null) channels[c.parentId] else c
    if (ch?.guildId == null || ch.kind != Kind.TEXT) return null
    val i = channelLayout(ch.guildId).all.filter { it.kind == Kind.TEXT }.indexOfFirst { it.id == ch.id }
    return if (i < 0) null else (i + 1).toString().padStart(2, '0')
}

fun State.activeThreads(parentId: String): List<Channel> =
    channels.values.filter { it.kind == Kind.THREAD && it.parentId == parentId && !it.archived }
        .sortedWith { a, b -> cmpId(b.lastMessageId ?: b.id, a.lastMessageId ?: a.id) }

fun State.dmRecipient(c: Channel): User? {
    val other = c.recipients?.firstOrNull { it.id != me?.id } ?: c.recipients?.firstOrNull()
    return other?.let { users[it.id] ?: it }
}

fun State.dmName(c: Channel, emptyGroup: String = "Empty group"): String {
    if (c.kind == Kind.GROUP_DM) {
        if (c.name.isNotEmpty()) return c.name
        val others = (c.recipients ?: emptyList()).filter { it.id != me?.id }.map { nameOf(it.id) }
        return others.joinToString(", ").ifEmpty { emptyGroup }
    }
    return nameOf(dmRecipient(c)?.id ?: "")
}

fun State.sortedDms(): List<Channel> =
    dmOrder.mapNotNull { channels[it] }.sortedWith { a, b -> cmpId(b.lastMessageId ?: b.id, a.lastMessageId ?: a.id) }

fun State.isMuted(c: Channel): Boolean {
    val st = settings
    return c.id in st.mutedChannels || (c.parentId != null && c.parentId in st.mutedChannels) ||
        (c.guildId != null && c.guildId in st.mutedGuilds)
}

/** A receipt moved forward (DM_RECEIPT); positions never go back. */
fun State.withReceipt(channelId: String, userId: String, delivered: String? = null, read: String? = null): State {
    val later = { cur: String?, new: String? -> if (new == null || (cur != null && cmpId(cur, new) >= 0)) cur else new }
    val inChannel = receipts[channelId] ?: persistentMapOf()
    val cur = inChannel[userId] ?: Receipt(userId)
    val next = cur.copy(deliveredId = later(cur.deliveredId, delivered), readId = later(cur.readId, read))
    return if (next == cur && userId in inChannel) this else copy(receipts = receipts.putting(channelId, inChannel.putting(userId, next)))
}

/**
 * Your message's tick in a DM: read once everyone else has read it, delivered once a device of each of them got it,
 * else sent. Null outside DMs and for others' messages, pending ones and messages from before you joined in.
 */
fun State.tickFor(m: Message): Tick? {
    val ch = channels[m.channelId] ?: return null
    if (!Kind.isPrivate(ch.kind) || m.pending || m.failed || m.author.id != me?.id) return null
    val others = receipts[m.channelId]?.values?.filter { it.userId != m.author.id }.orEmpty()
    if (others.isEmpty()) return Tick.SENT
    val reached = { pos: String? -> pos != null && cmpId(pos, m.id) >= 0 }
    return when {
        others.all { reached(it.readId) } -> Tick.READ
        others.all { reached(it.readId) || reached(it.deliveredId) } -> Tick.DELIVERED
        else -> Tick.SENT
    }
}

fun State.isUnread(c: Channel): Boolean {
    if (c.kind == Kind.CATEGORY || c.lastMessageId == null) return false
    val read = readStates[c.id]
    return read == null || cmpId(c.lastMessageId, read) > 0
}

fun State.guildUnread(guildId: String): Boolean {
    if (guildId in settings.mutedGuilds) return false
    return channels.values.any { it.guildId == guildId && !isMuted(it) && isUnread(it) }
}

/** A channel's notification level: its own, its category's (or a thread's channel's), else the server's. */
fun State.notifyLevel(c: Channel): String {
    val own = settings.channelNotifications
    val parent = c.parentId?.let { channels[it] }
    return own[c.id] ?: parent?.let { own[it.id] } ?: parent?.parentId?.let { own[it] }
        ?: c.guildId?.let { settings.guildNotifications[it] } ?: "all"
}

fun State.channelAlert(c: Channel): Boolean =
    c.guildId != null && isUnread(c) && !isMuted(c) && notifyLevel(c) == "all" && c.kind != Kind.CATEGORY

fun State.guildAlert(guildId: String): Boolean {
    if (guildId in settings.mutedGuilds) return false
    return channels.values.any { it.guildId == guildId && channelAlert(it) }
}

fun State.guildMentions(guildId: String): Int = channels.values.sumOf { if (it.guildId == guildId) mentions[it.id] ?: 0 else 0 }

fun State.dmMentions(): Int = dmOrder.sumOf { mentions[it] ?: 0 }

fun State.totalMentions(): Int = mentions.values.sum()

fun State.presenceOf(userId: String): String = presences[userId] ?: "offline"

fun State.gameOf(userId: String): Activity? = activities[userId]?.firstOrNull { it.type == 0 }

fun State.customStatusOf(userId: String): Activity? =
    if (userId == me?.id) customStatus else activities[userId]?.firstOrNull { it.type == 4 }

fun State.voiceMembers(channelId: String): List<VoiceState> = voice.values.filter { it.channelId == channelId }

fun State.currentChannel(): Channel? = selected[view]?.let { channels[it] }

fun State.memberRoles(guildId: String, userId: String): List<Role> {
    val rs = roles[guildId] ?: return emptyList()
    return (members[guildId]?.get(userId)?.roles ?: emptyList()).mapNotNull { rs[it] }.sortedByDescending { it.position }
}

/** A heading in the member list and who's under it. */
data class MemberGroup(val title: String, val ids: List<String>, val roleId: String? = null)

/**
 * The member list, like the web's (Members.tsx): online members under their highest hoisted role ("Display role
 * members separately"), highest role first, then the other online members, then everyone offline. [ids] are the
 * people to list; names sort within each group.
 */
fun State.memberGroups(guildId: String?, ids: Collection<String>): List<MemberGroup> {
    val sorted = ids.sortedBy { nameOf(it, guildId, "").lowercase() }
    val out = ArrayList<MemberGroup>()
    val placed = HashSet<String>()
    if (guildId != null) {
        val hoisted = roles[guildId]?.values.orEmpty().filter { it.hoist && it.id != guildId }.sortedByDescending { it.position }
        for (role in hoisted) {
            val inRole = sorted.filter { id ->
                id !in placed && presenceOf(id) != "offline" && memberRoles(guildId, id).firstOrNull { it.hoist }?.id == role.id
            }
            placed += inRole
            if (inRole.isNotEmpty()) out += MemberGroup(role.name, inRole, role.id)
        }
    }
    val online = sorted.filter { it !in placed && presenceOf(it) != "offline" }
    val offline = sorted.filter { presenceOf(it) == "offline" }
    if (online.isNotEmpty()) out += MemberGroup(t("Online"), online)
    if (offline.isNotEmpty()) out += MemberGroup(t("Offline"), offline)
    return out
}

/** Name colour (0xRRGGBB) from the member's highest coloured role. */
fun State.nameColor(guildId: String?, userId: String): Int? =
    guildId?.let { g -> memberRoles(g, userId).firstOrNull { (it.color ?: 0) != 0 }?.color }

/** The user as they show up in a server: their server profile over the account's own. */
fun State.profileOf(userId: String, guildId: String? = null): User? {
    val u = users[userId] ?: return null
    val m = guildId?.let { members[it]?.get(userId) } ?: return u
    if (m.avatar == null && m.banner == null && m.bio == null) return u
    return u.copy(avatar = m.avatar ?: u.avatar, banner = m.banner ?: u.banner, bio = m.bio ?: u.bio)
}

/** Nickname in the guild, else display name, else username. */
fun State.nameOf(userId: String, guildId: String? = null, unknown: String = "Unknown"): String {
    val nick = guildId?.let { members[it]?.get(userId)?.nickname }
    val u = users[userId]
    return nick?.takeIf { it.isNotEmpty() } ?: u?.displayName?.takeIf { it.isNotEmpty() } ?: u?.username ?: unknown
}

fun State.findEmoji(id: String): Emoji? = emojis.values.firstNotNullOfOrNull { list -> list.firstOrNull { it.id == id } }

fun State.isBlocked(userId: String): Boolean = relationships[userId] == Rel.BLOCKED

fun State.friends(): List<User> = relationships.filterValues { it == Rel.FRIEND }.keys.mapNotNull { users[it] }

/** Typing right now in a channel (not you), soonest-expiring last. */
fun State.typingIn(channelId: String, now: Long = System.currentTimeMillis()): List<String> =
    (typing[channelId] ?: emptyMap()).filter { it.value > now && it.key != me?.id }.keys.toList()

// ---------------------------------------------------------------- JSON helpers

internal fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it.isString || it.longOrNull != null || it.booleanOrNull != null }?.content

/** A partial update: the fields in `patch` over `old` (CHANNEL_UPDATE / GUILD_UPDATE / USER_UPDATE send partial objects). */
internal inline fun <reified T> merge(old: T, patch: JsonObject): T {
    val base = LinkordJson.encodeToJsonElement(kotlinx.serialization.serializer<T>(), old).jsonObject
    return LinkordJson.decodeFromJsonElement(kotlinx.serialization.serializer<T>(), JsonObject(base + patch))
}

/** Server permission bits (server perms.rs, app lib/perms.ts). */
object Perm {
    const val CREATE_INVITE = 1L shl 0
    const val KICK_MEMBERS = 1L shl 1
    const val ADMINISTRATOR = 1L shl 3
    const val MANAGE_CHANNELS = 1L shl 4
    const val MANAGE_GUILD = 1L shl 5
    const val ADD_REACTIONS = 1L shl 6
    const val STREAM = 1L shl 9
    const val VIEW_CHANNEL = 1L shl 10
    const val SEND_MESSAGES = 1L shl 11
    const val MANAGE_MESSAGES = 1L shl 13
    const val ATTACH_FILES = 1L shl 15
    const val READ_MESSAGE_HISTORY = 1L shl 16
    const val MENTION_EVERYONE = 1L shl 17
    const val CONNECT = 1L shl 20
    const val SPEAK = 1L shl 21
    const val MOVE_MEMBERS = 1L shl 24
    const val CHANGE_NICKNAME = 1L shl 26
    const val MANAGE_NICKNAMES = 1L shl 27
    /** In a channel: "Manage Permissions" (edit its overwrites). */
    const val MANAGE_ROLES = 1L shl 28
    const val MANAGE_EMOJIS = 1L shl 30
    const val MANAGE_THREADS = 1L shl 34
    const val CREATE_THREADS = 1L shl 35
    const val USE_SOUNDBOARD = 1L shl 42

    const val ALL = CREATE_INVITE or KICK_MEMBERS or ADMINISTRATOR or MANAGE_CHANNELS or MANAGE_GUILD or ADD_REACTIONS or
        STREAM or VIEW_CHANNEL or SEND_MESSAGES or MANAGE_MESSAGES or ATTACH_FILES or READ_MESSAGE_HISTORY or
        MENTION_EVERYONE or CONNECT or SPEAK or MOVE_MEMBERS or CHANGE_NICKNAME or MANAGE_NICKNAMES or MANAGE_ROLES or
        MANAGE_EMOJIS or MANAGE_THREADS or CREATE_THREADS or USE_SOUNDBOARD

    /** What a channel overwrite can allow or deny (the rest only exist server-wide). */
    const val CHANNEL = CREATE_INVITE or MANAGE_CHANNELS or ADD_REACTIONS or STREAM or VIEW_CHANNEL or SEND_MESSAGES or
        MANAGE_MESSAGES or ATTACH_FILES or READ_MESSAGE_HISTORY or MENTION_EVERYONE or CONNECT or SPEAK or MOVE_MEMBERS or
        MANAGE_ROLES or MANAGE_THREADS or CREATE_THREADS or USE_SOUNDBOARD
}

/** A member's server-wide permissions (owner and Administrator = everything). */
fun State.guildPerms(guildId: String, userId: String?): Long {
    val g = guilds[guildId] ?: return 0
    if (userId == null) return 0
    if (g.ownerId == userId) return Perm.ALL
    val rs = roles[guildId] ?: return 0
    var p = rs[guildId]?.permissions ?: 0L
    for (r in members[guildId]?.get(userId)?.roles ?: emptyList()) p = p or (rs[r]?.permissions ?: 0)
    return if (p and Perm.ADMINISTRATOR != 0L) Perm.ALL else p
}

/** Discord's overwrite order (perms.rs apply_overwrites): @everyone's, the member's roles' together, then the member's own. */
fun applyOverwrites(base: Long, guildId: String, userId: String, roles: List<String>, ows: List<Overwrite>): Long {
    if (base and Perm.ADMINISTRATOR != 0L) return Perm.ALL
    var p = base
    ows.firstOrNull { it.type == 0 && it.id == guildId }?.let { p = (p and it.deny.inv()) or it.allow }
    val mine = ows.filter { it.type == 0 && it.id != guildId && it.id in roles }
    p = (p and mine.fold(0L) { a, o -> a or o.deny }.inv()) or mine.fold(0L) { a, o -> a or o.allow }
    ows.firstOrNull { it.type == 1 && it.id == userId }?.let { p = (p and it.deny.inv()) or it.allow }
    return if (p and Perm.VIEW_CHANNEL != 0L) p else 0
}

/** The overwrites that apply in a channel: a thread's parent's, otherwise its own. */
fun State.overwritesOf(channelId: String): List<Overwrite> {
    val c = channels[channelId] ?: return emptyList()
    val src = if (c.kind == Kind.THREAD && c.parentId != null) channels[c.parentId] else c
    return src?.permissionOverwrites.orEmpty()
}

/** Someone's permissions in a channel, overwrites counted (DMs: everything). */
fun State.channelPerms(channelId: String, userId: String?): Long {
    val c = channels[channelId] ?: return 0
    val guildId = c.guildId ?: return Perm.ALL
    if (userId == null) return 0
    val base = guildPerms(guildId, userId)
    if (base and Perm.ADMINISTRATOR != 0L) return Perm.ALL
    return applyOverwrites(base, guildId, userId, members[guildId]?.get(userId)?.roles.orEmpty(), overwritesOf(channelId))
}

/** A server channel @everyone can't see (lib/perms.ts isPrivateChannel): the lock on its icon. */
fun State.isPrivateChannel(channelId: String): Boolean {
    val guildId = channels[channelId]?.guildId ?: return false
    // Not known yet (roles still loading): no lock rather than a wrong one.
    val base = roles[guildId]?.get(guildId)?.permissions ?: return false
    if (base and Perm.ADMINISTRATOR != 0L) return false
    return applyOverwrites(base, guildId, "", emptyList(), overwritesOf(channelId)) and Perm.VIEW_CHANNEL == 0L
}

/** Whether you have `perm` in the server, or in the channel when one is given. */
fun State.can(guildId: String?, perm: Long, channelId: String? = null): Boolean {
    if (guildId == null) return false
    val bits = if (channelId != null && channels[channelId]?.guildId != null) channelPerms(channelId, me?.id) else guildPerms(guildId, me?.id)
    return bits and (perm or Perm.ADMINISTRATOR) != 0L
}

/** Where `userId` stands: their highest role's position (the owner is above everyone). */
fun State.topRole(guildId: String, userId: String?): Int {
    if (userId == null) return -1
    if (guilds[guildId]?.ownerId == userId) return Int.MAX_VALUE
    val rs = roles[guildId] ?: return 0
    return members[guildId]?.get(userId)?.roles.orEmpty().maxOfOrNull { rs[it]?.position ?: 0 } ?: 0
}

/** A server's roles, highest first, @everyone last. */
fun State.rolesOf(guildId: String): List<Role> =
    roles[guildId]?.values.orEmpty().sortedWith(compareByDescending<Role> { it.id != guildId }.thenByDescending { it.position })
