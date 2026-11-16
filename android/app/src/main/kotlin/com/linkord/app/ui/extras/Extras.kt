package com.linkord.app.ui.extras

import android.content.ClipData
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
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
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import com.linkord.app.session
import com.linkord.app.ui.LocalNav
import com.linkord.app.ui.Screen
import com.linkord.app.ui.chat.ScreenScaffold
import com.linkord.app.ui.components.Kicker
import com.linkord.app.ui.components.LIcon
import com.linkord.app.ui.components.mediaUrl
import com.linkord.core.Activity
import com.linkord.core.LinkordJson
import com.linkord.core.plural
import com.linkord.core.t
import com.linkord.designsystem.Linkord
import com.linkord.designsystem.LinkordIcons
import kotlinx.coroutines.launch
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonElement
import java.time.Instant

// ---------------------------------------------------------------- League

private const val CDRAGON = "https://raw.communitydragon.org/latest/"

/** CommunityDragon art through the server's copy (league.rs art_path; lib/league.ts art). */
fun leagueArt(base: String, url: String?): String? = url?.let { if (it.startsWith(CDRAGON)) "$base/api/league/art/${it.removePrefix(CDRAGON)}" else it }

/** "In Lobby", "In Queue"... (lib/league.ts phaseName) */
fun phaseName(phase: String) = when (phase) {
    "lobby" -> t("In Lobby")
    "queue" -> t("In Queue")
    "champ_select" -> t("Champion Select")
    "in_game" -> t("In Game")
    "post_game" -> t("Game Over")
    else -> t("In Client")
}

/** Someone's game as a card: icon, name, and for League what the client is doing (desktop only reports it). */
@Composable
fun GameCard(a: Activity, modifier: Modifier = Modifier) {
    val session = LocalContext.current.session
    val c = Linkord.colors
    val l = a.league
    Row(modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(c.raised).padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
        val icon = l?.champion?.icon?.let { leagueArt(session.serverUrl(), it) } ?: a.icon
        if (icon != null) AsyncImage(icon, null, modifier = Modifier.size(44.dp).clip(RoundedCornerShape(10.dp)))
        else Box(Modifier.size(44.dp).clip(RoundedCornerShape(10.dp)).background(c.raised2), contentAlignment = Alignment.Center) { LIcon(LinkordIcons.Gamepad, tint = c.text) }
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Kicker(t("Playing"))
            Text(a.name, style = Linkord.type.bodyStrong, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (l != null) {
                val parts = listOfNotNull(
                    phaseName(l.phase),
                    l.queue,
                    l.party?.takeIf { it.max > 1 }?.let { "${it.size}/${it.max}" },
                    l.champion?.name?.takeIf { it.isNotEmpty() },
                )
                Text(parts.joinToString(" · "), style = Linkord.type.small, color = c.text2, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            (l?.since ?: a.timestamps?.start)?.let { start ->
                val mins = ((System.currentTimeMillis() - start) / 60_000).coerceAtLeast(0)
                Text(if (mins >= 60) t("{h}h {m}m", "h" to mins / 60, "m" to mins % 60) else plural(mins.toInt(), "{n} minute", "{n} minutes"), style = Linkord.type.label)
            }
        }
    }
}

// ---------------------------------------------------------------- REC clips

@Serializable
data class SharedClip(
    val id: String,
    val slug: String,
    @SerialName("user_id") val userId: String = "",
    val title: String = "",
    val game: String = "",
    @SerialName("duration_ms") val durationMs: Long = 0,
    val views: Long = 0,
    @SerialName("on_profile") val onProfile: Boolean = true,
    @SerialName("created_at") val createdAt: String = "",
    val url: String = "",
    val video: String = "",
    val thumbnail: String = "",
    val size: Long = 0,
)

fun duration(ms: Long): String {
    val s = ms / 1000
    return if (s >= 3600) "%d:%02d:%02d".format(s / 3600, (s / 60) % 60, s % 60) else "%d:%02d".format(s / 60, s % 60)
}

/** A REC clip shared in chat (embed type `clip`): its picture, title and length; a tap plays it. */
@Composable
fun ClipCard(clipJson: JsonObject) {
    val session = LocalContext.current.session
    val nav = LocalNav.current
    val c = Linkord.colors
    val clip = remember(clipJson) { runCatching { LinkordJson.decodeFromJsonElement(SharedClip.serializer(), clipJson as JsonElement) }.getOrNull() } ?: return
    val inCall by session.calls.channel.collectAsState()
    val scope = rememberCoroutineScope()
    Column(Modifier.padding(top = 6.dp).widthIn(max = 320.dp).clip(RoundedCornerShape(12.dp)).background(c.raised)) {
        Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).background(Color.Black).clickable {
            nav.push(Screen.Video(session.api.media(clip.video) ?: clip.video, clip.title))
        }, contentAlignment = Alignment.Center) {
            AsyncImage(mediaUrl(clip.thumbnail), null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
            Box(Modifier.size(46.dp).clip(RoundedCornerShape(23.dp)).background(Color.Black.copy(alpha = 0.5f)), contentAlignment = Alignment.Center) { LIcon(LinkordIcons.Play, tint = Color.White) }
            Text(duration(clip.durationMs), style = Linkord.type.label, color = Color.White, modifier = Modifier.align(Alignment.BottomEnd).padding(8.dp).clip(RoundedCornerShape(4.dp)).background(Color.Black.copy(alpha = 0.6f)).padding(horizontal = 5.dp, vertical = 2.dp))
        }
        Column(Modifier.padding(10.dp)) {
            Kicker("REC" + (clip.game.takeIf { it.isNotEmpty() }?.let { " · $it" } ?: ""))
            Text(clip.title.ifEmpty { t("Clip") }, style = Linkord.type.bodyStrong, maxLines = 2, overflow = TextOverflow.Ellipsis)
            val call = inCall
            if (call != null) Text(t("Watch together in the call"), style = Linkord.type.small, color = c.brandHi, modifier = Modifier.padding(top = 6.dp).clickable {
                scope.launch { runCatching { session.api.send("PUT", "/channels/$call/watch", mapOf("url" to clip.url)) }.onFailure { session.toast(session.describe(it)) } }
            })
        }
    }
}

/** Your clips shared on the server (REC's Shared tab): play, copy the link, stop sharing. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun SharedClipsScreen() {
    val session = LocalContext.current.session
    val nav = LocalNav.current
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    val c = Linkord.colors
    var clips by remember { mutableStateOf<List<SharedClip>?>(null) }
    suspend fun load() {
        clips = runCatching { session.api.get<List<SharedClip>>("/users/@me/clips") }.getOrElse { emptyList() }
    }
    LaunchedEffect(Unit) { load() }
    var confirm by remember { mutableStateOf<String?>(null) }
    ScreenScaffold(t("Shared clips")) {
        val list = clips
        when {
            list == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = c.text3) }
            list.isEmpty() -> Text(t("Clips you share from REC on the desktop app show up here."), style = Linkord.type.small, modifier = Modifier.padding(16.dp))
            else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                items(list, key = { it.id }) { clip ->
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(c.panel)
                            .combinedClickable(onClick = { nav.push(Screen.Video(session.api.media(clip.video) ?: clip.video, clip.title)) }, onLongClick = { confirm = clip.id })
                            .padding(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        AsyncImage(mediaUrl(clip.thumbnail), null, contentScale = ContentScale.Crop, modifier = Modifier.width(112.dp).aspectRatio(16f / 9f).clip(RoundedCornerShape(8.dp)).background(Color.Black))
                        Spacer(Modifier.width(10.dp))
                        Column(Modifier.weight(1f)) {
                            Text(clip.title.ifEmpty { t("Clip") }, style = Linkord.type.bodyStrong, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            Text(listOf(duration(clip.durationMs), plural(clip.views.toInt(), "{n} view", "{n} views")).joinToString(" · "), style = Linkord.type.label)
                            Row(Modifier.padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                                Text(t("Copy link"), style = Linkord.type.small, color = c.brandHi, modifier = Modifier.clickable {
                                    scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("clip", clip.url))) }
                                    session.toast(t("Link copied"))
                                })
                                if (confirm == clip.id) Text(t("Stop sharing"), style = Linkord.type.small, color = c.danger, modifier = Modifier.clickable {
                                    scope.launch { runCatching { session.api.send("DELETE", "/clips/${clip.id}") }.onFailure { session.toast(session.describe(it)) }; load() }
                                })
                            }
                        }
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------- stats

@Serializable
private data class Stats(
    val messages: Long = 0,
    val reactions: Long = 0,
    @SerialName("reactions_received") val reactionsReceived: Long = 0,
    @SerialName("mentions_received") val mentionsReceived: Long = 0,
    val servers: Long = 0,
    val friends: Long = 0,
    val threads: Long = 0,
    val pins: Long = 0,
    val attachments: Long = 0,
    @SerialName("voice_seconds") val voiceSeconds: Long = 0,
    @SerialName("upload_bytes") val uploadBytes: Long = 0,
    @SerialName("upload_quota") val uploadQuota: Long = 0,
    @SerialName("created_at") val createdAt: String = "",
    @SerialName("top_channels") val topChannels: List<JsonObject> = emptyList(),
    @SerialName("top_emoji") val topEmoji: List<JsonObject> = emptyList(),
    /** [name, icon, seconds, last played] (users.rs stats). */
    val games: List<kotlinx.serialization.json.JsonArray> = emptyList(),
)

private fun hours(seconds: Long) = t("{n} h", "n" to "%.1f".format(seconds / 3600.0))

/** Your numbers (GET /users/@me/stats): messages, time in calls, games, top channels and emoji. */
@Composable
fun StatsScreen() {
    val session = LocalContext.current.session
    val c = Linkord.colors
    var stats by remember { mutableStateOf<Stats?>(null) }
    LaunchedEffect(Unit) {
        val tz = java.util.TimeZone.getDefault().getOffset(System.currentTimeMillis()) / 60_000
        stats = runCatching { session.api.get<Stats>("/users/@me/stats?tz=${-tz}") }.getOrNull()
    }
    ScreenScaffold(t("Stats")) {
        val s = stats ?: return@ScreenScaffold Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = c.text3) }
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            val tiles = listOf(
                t("Messages") to s.messages.toString(),
                t("In calls") to hours(s.voiceSeconds),
                t("Reactions") to s.reactions.toString(),
                t("Reactions received") to s.reactionsReceived.toString(),
                t("Mentions received") to s.mentionsReceived.toString(),
                t("Servers") to s.servers.toString(),
                t("Friends") to s.friends.toString(),
                t("Files sent") to s.attachments.toString(),
            )
            for (pair in tiles.chunked(2)) Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                for ((label, value) in pair) Column(Modifier.weight(1f).clip(RoundedCornerShape(14.dp)).background(c.panel).padding(14.dp)) {
                    Kicker(label)
                    Text(value, style = Linkord.type.display)
                }
            }
            if (s.games.isNotEmpty()) Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(c.panel).padding(14.dp)) {
                Kicker(t("Games"))
                for (g in s.games.take(8)) Row(Modifier.fillMaxWidth().padding(top = 8.dp)) {
                    Text((g.getOrNull(0) as? kotlinx.serialization.json.JsonPrimitive)?.content ?: "", style = Linkord.type.body, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(hours((g.getOrNull(2) as? kotlinx.serialization.json.JsonPrimitive)?.content?.toDoubleOrNull()?.toLong() ?: 0L), style = Linkord.type.mono)
                }
            }
            runCatching { Instant.parse(s.createdAt) }.getOrNull()?.let {
                Text(t("On Linkord since {date}", "date" to java.time.format.DateTimeFormatter.ofLocalizedDate(java.time.format.FormatStyle.LONG).format(it.atZone(java.time.ZoneId.systemDefault()))), style = Linkord.type.small, color = c.text3, modifier = Modifier.padding(4.dp))
            }
            Spacer(Modifier.height(12.dp))
        }
    }
}
