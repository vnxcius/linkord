package com.linkord.core

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

// Mirrors server/src/models.rs (and app/src/lib/types.ts). Ids are decimal strings of u64: never Long/Double here,
// so nothing is lost and they compare with cmpId.

val LinkordJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    coerceInputValues = true
    encodeDefaults = false
}

@Serializable
data class User(
    val id: String,
    val username: String = "",
    @SerialName("display_name") val displayName: String? = null,
    val avatar: String? = null,
    val banner: String? = null,
    val nameplate: String? = null,
    @SerialName("accent_color") val accentColor: Int? = null,
    val bio: String = "",
    val pronouns: String = "",
    /** 'MM-DD', or 'YYYY-MM-DD' when they show the year. */
    val birthday: String? = null,
    /** Only on your own user (presence is separate). */
    val status: String? = null,
    val bot: Boolean = false,
    @SerialName("needs_username") val needsUsername: Boolean = false,
    @SerialName("rec_opt_out") val recOptOut: Boolean = false,
    /** Privacy: read receipts in DMs (only ever set on your own user; server receipts.rs). */
    @SerialName("read_receipts") val readReceipts: Boolean = true,
) {
    val name: String get() = displayName?.takeIf { it.isNotBlank() } ?: username
}

object Kind {
    const val TEXT = 0
    const val DM = 1
    const val VOICE = 2
    const val GROUP_DM = 3
    const val CATEGORY = 4
    const val THREAD = 11
    fun isPrivate(k: Int) = k == DM || k == GROUP_DM
}

@Serializable
data class Overwrite(val id: String, val type: Int, val allow: Long = 0, val deny: Long = 0)

@Serializable
data class Channel(
    val id: String,
    @SerialName("guild_id") val guildId: String? = null,
    val kind: Int = Kind.TEXT,
    val name: String = "",
    val topic: String = "",
    val position: Int = 0,
    @SerialName("parent_id") val parentId: String? = null,
    @SerialName("last_message_id") val lastMessageId: String? = null,
    @SerialName("owner_id") val ownerId: String? = null,
    @SerialName("thread_message_id") val threadMessageId: String? = null,
    val archived: Boolean = false,
    @SerialName("message_count") val messageCount: Int = 0,
    val recipients: List<User>? = null,
    @SerialName("permission_overwrites") val permissionOverwrites: List<Overwrite>? = null,
)

@Serializable
data class GuildInfo(
    val id: String,
    val name: String = "",
    val icon: String? = null,
    @SerialName("owner_id") val ownerId: String = "",
    @SerialName("system_channel_id") val systemChannelId: String? = null,
    @SerialName("join_messages") val joinMessages: Boolean = true,
    val banner: String? = null,
    @SerialName("afk_channel_id") val afkChannelId: String? = null,
    @SerialName("afk_timeout") val afkTimeout: Int = 0,
)

@Serializable
data class Role(
    val id: String,
    @SerialName("guild_id") val guildId: String = "",
    val name: String = "",
    val color: Int? = null,
    val permissions: Long = 0,
    val position: Int = 0,
    val hoist: Boolean = false,
    val mentionable: Boolean = false,
)

@Serializable
data class Emoji(val id: String, @SerialName("guild_id") val guildId: String = "", val name: String, val animated: Boolean = false)

@Serializable
data class Member(
    val user: User,
    val nickname: String? = null,
    val avatar: String? = null,
    val banner: String? = null,
    val bio: String? = null,
    @SerialName("joined_at") val joinedAt: String = "",
    val roles: List<String> = emptyList(),
)

/** A membership without the user (the user lives in Store.users). */
data class MemberInfo(
    val nickname: String? = null,
    val avatar: String? = null,
    val banner: String? = null,
    val bio: String? = null,
    val joinedAt: String = "",
    val roles: List<String> = emptyList(),
)

fun Member.info() = MemberInfo(nickname, avatar, banner, bio, joinedAt, roles)

@Serializable
data class Guild(
    val id: String,
    val name: String = "",
    val icon: String? = null,
    @SerialName("owner_id") val ownerId: String = "",
    @SerialName("system_channel_id") val systemChannelId: String? = null,
    @SerialName("join_messages") val joinMessages: Boolean = true,
    val banner: String? = null,
    @SerialName("afk_channel_id") val afkChannelId: String? = null,
    @SerialName("afk_timeout") val afkTimeout: Int = 0,
    val channels: List<Channel> = emptyList(),
    val members: List<Member> = emptyList(),
    val roles: List<Role> = emptyList(),
    val emojis: List<Emoji> = emptyList(),
) {
    fun info() = GuildInfo(id, name, icon, ownerId, systemChannelId, joinMessages, banner, afkChannelId, afkTimeout)
}

@Serializable
data class Attachment(
    val id: String,
    val filename: String = "",
    val url: String = "",
    val size: Long = 0,
    @SerialName("content_type") val contentType: String = "",
    @SerialName("duration_secs") val durationSecs: Double? = null,
    val waveform: String? = null,
    val width: Int? = null,
    val height: Int? = null,
    val codec: String? = null,
    val playable: String? = null,
) {
    val isImage get() = contentType.startsWith("image/")
    val isVideo get() = contentType.startsWith("video/")
    val isAudio get() = contentType.startsWith("audio/")
    val isVoiceNote get() = waveform != null
}

@Serializable
data class EmbedField(val name: String = "", val value: String = "", val inline: Boolean = false)

@Serializable
data class Embed(
    /** link | image | video | rich | clip | league_invite */
    val type: String = "link",
    val url: String = "",
    val title: String? = null,
    val description: String? = null,
    @SerialName("site_name") val siteName: String? = null,
    val image: String? = null,
    @SerialName("large_image") val largeImage: Boolean = false,
    val color: Int? = null,
    val author: String? = null,
    val fields: List<EmbedField>? = null,
    val footer: String? = null,
    val thumbnail: String? = null,
    val timestamp: Long? = null,
    @SerialName("resolved_url") val resolvedUrl: String? = null,
    /** For type=clip: the shared REC clip. */
    val clip: JsonObject? = null,
    /** For type=league_invite (message type 8): the host's lobby when they sent it. */
    val league: LeagueActivity? = null,
)

/** GET /invites/{code}: the server an invite leads to. */
@Serializable
data class InvitePreview(
    val code: String = "",
    val guild: GuildInfo,
    @SerialName("member_count") val memberCount: Int = 0,
    @SerialName("online_count") val onlineCount: Int? = null,
)

@Serializable
data class Reaction(val emoji: String, val users: List<String> = emptyList())

@Serializable
data class MessageRef(val id: String, val author: User, val content: String = "")

@Serializable
data class Forwarded(
    @SerialName("message_id") val messageId: String,
    @SerialName("channel_id") val channelId: String,
    @SerialName("guild_id") val guildId: String? = null,
    val content: String = "",
    val attachments: List<Attachment> = emptyList(),
    val embeds: List<Embed> = emptyList(),
    @SerialName("created_at") val createdAt: String = "",
    @SerialName("edited_at") val editedAt: String? = null,
)

@Serializable
data class Interaction(val name: String, val user: User)

object MessageType {
    const val DEFAULT = 0
    const val PINNED = 6
    const val JOIN = 7
    const val LEAGUE_INVITE = 8
}

@Serializable
data class Message(
    val id: String,
    val type: Int = 0,
    @SerialName("channel_id") val channelId: String,
    val author: User,
    val content: String = "",
    @SerialName("reply_to") val replyTo: String? = null,
    @SerialName("referenced_message") val referencedMessage: MessageRef? = null,
    val attachments: List<Attachment> = emptyList(),
    val embeds: List<Embed> = emptyList(),
    val reactions: List<Reaction> = emptyList(),
    @SerialName("mention_everyone") val mentionEveryone: Boolean = false,
    val pinned: Boolean = false,
    @SerialName("thread_id") val threadId: String? = null,
    @SerialName("edited_at") val editedAt: String? = null,
    @SerialName("created_at") val createdAt: String = "",
    val forwarded: Forwarded? = null,
    val interaction: Interaction? = null,
    val nonce: String? = null,
    val ephemeral: Boolean = false,
    /** Your own voice messages in a DM: who played them (server receipts.rs; VOICE_PLAYED adds to it). */
    @SerialName("played_by") val playedBy: List<String>? = null,
    /** Client only: sent, not confirmed yet / failed to send. */
    @kotlinx.serialization.Transient val pending: Boolean = false,
    @kotlinx.serialization.Transient val failed: Boolean = false,
)

@Serializable
data class VoiceState(
    @SerialName("user_id") val userId: String,
    @SerialName("guild_id") val guildId: String? = null,
    @SerialName("channel_id") val channelId: String? = null,
    @SerialName("self_mute") val selfMute: Boolean = false,
    @SerialName("self_deaf") val selfDeaf: Boolean = false,
    @SerialName("self_stream") val selfStream: Boolean = false,
    @SerialName("self_video") val selfVideo: Boolean = false,
    val watching: List<String> = emptyList(),
    @SerialName("call_started_at") val callStartedAt: Long? = null,
)

object Rel {
    const val FRIEND = 1
    const val BLOCKED = 2
    const val INCOMING = 3
    const val OUTGOING = 4
}

@Serializable
data class Relationship(val id: String, val type: Int, val user: User)

/** What someone is doing. Kept close to the wire: only the fields the phone shows are typed. */
@Serializable
data class Activity(
    /** 0 = Playing, 2 = Listening (Spotify), 4 = custom status. */
    val type: Int = 0,
    val name: String = "",
    val icon: String? = null,
    val details: String? = null,
    val state: String? = null,
    val image: String? = null,
    val emoji: StatusEmoji? = null,
    @SerialName("expires_at") val expiresAt: Long? = null,
    val timestamps: Timestamps? = null,
    /** League of Legends / TFT: what the client is doing (desktop lib/league.ts). */
    val league: LeagueActivity? = null,
)

@Serializable
data class LeagueActivity(
    /** client | lobby | queue | champ_select | in_game | post_game */
    val phase: String = "client",
    val queue: String? = null,
    val mode: String? = null,
    val party: LeagueParty? = null,
    val since: Long? = null,
    val champion: LeagueChampion? = null,
)

@Serializable
data class LeagueParty(val size: Int = 1, val max: Int = 5)

@Serializable
data class LeagueChampion(val id: Int = 0, val name: String = "", val icon: String = "")

@Serializable
data class Timestamps(val start: Long? = null, val end: Long? = null)

@Serializable
data class StatusEmoji(val id: String? = null, val name: String = "", val animated: Boolean = false)

@Serializable
data class GuildFolder(
    val id: String? = null,
    val name: String? = null,
    val color: Int? = null,
    @SerialName("guild_ids") val guildIds: List<String> = emptyList(),
)

/** Synced settings (server api/settings.rs). Unknown keys are kept so a PATCH never drops them. */
@Serializable
data class Settings(
    @SerialName("muted_guilds") val mutedGuilds: List<String> = emptyList(),
    @SerialName("muted_channels") val mutedChannels: List<String> = emptyList(),
    @SerialName("guild_notifications") val guildNotifications: Map<String, String> = emptyMap(),
    @SerialName("channel_notifications") val channelNotifications: Map<String, String> = emptyMap(),
    @SerialName("guild_folders") val guildFolders: List<GuildFolder> = emptyList(),
    @SerialName("collapsed_categories") val collapsedCategories: List<String> = emptyList(),
)

@Serializable
data class CallInfo(@SerialName("channel_id") val channelId: String, val ringing: List<String> = emptyList())

@Serializable
data class ChannelStatus(@SerialName("channel_id") val channelId: String, val status: String = "")

@Serializable
data class Ready(
    @SerialName("session_id") val sessionId: String,
    val user: User,
    val guilds: List<Guild> = emptyList(),
    val dms: List<Channel> = emptyList(),
    val relationships: List<Relationship> = emptyList(),
    val settings: JsonElement? = null,
    val presences: Map<String, String> = emptyMap(),
    val activities: Map<String, List<Activity>> = emptyMap(),
    @SerialName("custom_status") val customStatus: Activity? = null,
    @SerialName("read_states") val readStates: Map<String, String> = emptyMap(),
    /** The others' delivered/read positions in DMs and group DMs (server receipts.rs). */
    @SerialName("dm_receipts") val dmReceipts: Map<String, List<Receipt>> = emptyMap(),
    @SerialName("voice_states") val voiceStates: List<VoiceState> = emptyList(),
    @SerialName("voice_channel_statuses") val voiceChannelStatuses: List<ChannelStatus> = emptyList(),
    val calls: List<CallInfo> = emptyList(),
    @SerialName("server_now") val serverNow: Long? = null,
    val admin: Boolean = false,
    @SerialName("bot_commands") val botCommands: List<BotCommand> = emptyList(),
    val watches: List<WatchEntry> = emptyList(),
)

/** How far someone's devices have received and read a DM (server receipts.rs); read counts as delivered too. */
@Serializable
data class Receipt(
    @SerialName("user_id") val userId: String,
    @SerialName("delivered_id") val deliveredId: String? = null,
    @SerialName("read_id") val readId: String? = null,
)

/** A message of yours in a DM, WhatsApp-style: the server has it, a device of theirs got it, they read it. */
enum class Tick { SENT, DELIVERED, READ }

/** A slash command of a bot driven from outside (Steve, steve.rs), while it's connected. */
@Serializable
data class BotCommand(
    @SerialName("bot_id") val botId: String,
    val name: String,
    val description: String = "",
    val option: String? = null,
    val optional: Boolean = false,
)

/** What a call is watching together (watch.rs). */
@Serializable
data class Watch(
    val provider: String = "",
    val media: String = "",
    val url: String = "",
    val live: Boolean = false,
    val playing: Boolean = false,
    val position: Double = 0.0,
    @SerialName("updated_at") val updatedAt: Long = 0,
    @SerialName("started_by") val startedBy: String? = null,
    val viewers: List<String> = emptyList(),
    val ended: Boolean = false,
)

@Serializable
data class WatchEntry(@SerialName("channel_id") val channelId: String, val watch: Watch)

/** One login of this account (Settings -> Sessions, GET /auth/sessions). */
@Serializable
data class SessionInfo(
    val id: String,
    val current: Boolean = false,
    val online: Boolean = false,
    val client: String? = null,
    @SerialName("user_agent") val userAgent: String? = null,
    @SerialName("created_at") val createdAt: String = "",
    @SerialName("last_seen_at") val lastSeenAt: String? = null,
)

@Serializable
data class AuthConfig(val discord: Boolean = false, @SerialName("dev_login") val devLogin: Boolean = false)

fun displayName(u: User?): String = u?.displayName?.takeIf { it.isNotBlank() } ?: u?.username ?: "Unknown"
