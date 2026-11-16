package com.linkord.app.ui.chat

import android.content.Intent
import android.net.Uri
import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.awaitHorizontalTouchSlopOrCancellation
import androidx.compose.foundation.gestures.horizontalDrag
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import com.linkord.app.session
import com.linkord.app.ui.LocalNav
import com.linkord.app.ui.Screen
import com.linkord.app.ui.components.Avatar
import com.linkord.app.ui.components.LIcon
import com.linkord.app.ui.components.mediaUrl
import com.linkord.core.Attachment
import com.linkord.core.Embed
import com.linkord.core.Markdown
import com.linkord.core.Message
import com.linkord.core.MessageType
import com.linkord.core.State
import com.linkord.core.nameColor
import com.linkord.core.nameOf
import com.linkord.core.profileOf
import com.linkord.core.t
import com.linkord.designsystem.Linkord
import com.linkord.designsystem.LinkordIcons
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import kotlin.math.roundToInt

/** "14:05", "Yesterday at 14:05" or the date, from an ISO timestamp. */
fun timeOf(iso: String, withDay: Boolean = true): String {
    val at = runCatching { Instant.parse(iso).atZone(ZoneId.systemDefault()) }.getOrNull() ?: return ""
    val time = DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).format(at)
    if (!withDay) return time
    val day = at.toLocalDate()
    val today = LocalDate.now()
    return when (day) {
        today -> time
        today.minusDays(1) -> t("Yesterday at {time}", "time" to time)
        else -> DateTimeFormatter.ofLocalizedDate(FormatStyle.SHORT).format(at) + " " + time
    }
}

fun dayOf(iso: String): LocalDate? = runCatching { Instant.parse(iso).atZone(ZoneId.systemDefault()).toLocalDate() }.getOrNull()

/** Whether [m] continues [prev]'s group (same author, within 7 minutes, nothing in between). */
fun continues(prev: Message?, m: Message): Boolean {
    if (prev == null || prev.author.id != m.author.id || m.replyTo != null || m.type != 0 || prev.type != 0 || m.interaction != null) return false
    val a = runCatching { Instant.parse(prev.createdAt) }.getOrNull() ?: return false
    val b = runCatching { Instant.parse(m.createdAt) }.getOrNull() ?: return false
    return b.toEpochMilli() - a.toEpochMilli() < 7 * 60_000 && dayOf(prev.createdAt) == dayOf(m.createdAt)
}

@OptIn(ExperimentalFoundationApi::class, ExperimentalLayoutApi::class)
@Composable
fun MessageItem(
    st: State,
    m: Message,
    guildId: String?,
    grouped: Boolean,
    highlighted: Boolean,
    onReply: (Message) -> Unit,
    onMenu: (Message) -> Unit,
    onJump: (String) -> Unit,
    onOpenChannel: (String) -> Unit,
) {
    val ctx = LocalContext.current
    val session = ctx.session
    val nav = LocalNav.current
    val c = Linkord.colors
    val haptics = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    val density = LocalDensity.current
    val threshold = with(density) { 64.dp.toPx() }
    val swipe = remember(m.id) { Animatable(0f) }
    val me = st.me?.id
    val mentionsMe = me != null && (m.content.contains("<@$me>") || m.mentionEveryone || m.referencedMessage?.author?.id == me)

    if (m.type == MessageType.JOIN || m.type == MessageType.PINNED) {
        SystemLine(st, m, guildId, onJump)
        return
    }

    val onTap: (MdTap) -> Unit = { tap ->
        when (tap) {
            is MdTap.User -> nav.push(Screen.Profile(tap.id, guildId))
            is MdTap.Channel -> if (st.channels[tap.id] != null) onOpenChannel(tap.id)
            is MdTap.Url -> when (val link = com.linkord.app.data.Links.parse(tap.url, session.knownServers())) {
                is com.linkord.app.data.AppLink.Invite -> nav.push(Screen.JoinServer(link.code))
                is com.linkord.app.data.AppLink.Channel -> if (st.channels[link.channel] != null) {
                    if (link.message != null) scope.launch { runCatching { session.actions.jumpToMessage(link.channel, link.message) } } else onOpenChannel(link.channel)
                } else openLink(ctx, tap.url)
                is com.linkord.app.data.AppLink.Clip -> nav.push(Screen.Video("${session.serverUrl()}/uploads/clips/${link.slug}.mp4", ""))
                null -> openLink(ctx, tap.url)
            }
        }
    }

    Box(
        Modifier.fillMaxWidth()
            .background(
                when {
                    highlighted -> c.brandTint(0.14f)
                    mentionsMe -> c.idle.copy(alpha = 0.08f)
                    else -> Color.Transparent
                },
            )
            // Swipe left on a message to reply (the chat's own right swipe still opens the channels).
            .pointerInput(m.id) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    var ticked = false
                    val start = awaitHorizontalTouchSlopOrCancellation(down.id) { change, over ->
                        if (over < 0 && !change.isConsumed) {
                            change.consume()
                            scope.launch { swipe.snapTo(over) }
                        }
                    } ?: return@awaitEachGesture
                    horizontalDrag(start.id) { change ->
                        val next = (swipe.value + change.positionChange().x).coerceIn(-threshold * 1.6f, 0f)
                        change.consume()
                        if (!ticked && next < -threshold) {
                            ticked = true
                            haptics.performHapticFeedback(HapticFeedbackType.GestureThresholdActivate)
                        }
                        scope.launch { swipe.snapTo(next) }
                    }
                    if (swipe.value < -threshold) onReply(m)
                    scope.launch { swipe.animateTo(0f) }
                }
            },
    ) {
        // The reply arrow that appears as you swipe.
        if (swipe.value < 0f) LIcon(
            LinkordIcons.Reply, size = 22.dp, tint = if (swipe.value < -threshold) c.text else c.text3,
            modifier = Modifier.align(Alignment.CenterEnd).padding(end = 18.dp).alpha((-swipe.value / threshold).coerceIn(0f, 1f)),
        )
        Row(
            Modifier.fillMaxWidth()
                .offset { IntOffset(swipe.value.roundToInt(), 0) }
                .combinedClickable(
                    interactionSource = null, indication = null,
                    onClick = {},
                    onDoubleClick = { if (!m.pending && !m.failed) session.actions.toggleReaction(m, session.prefs.quickReaction) },
                    onLongClick = {
                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                        onMenu(m)
                    },
                )
                .padding(start = 12.dp, end = 12.dp, top = if (grouped) 1.dp else 10.dp, bottom = 1.dp)
                .alpha(if (m.pending) 0.6f else 1f),
        ) {
            if (grouped) Spacer(Modifier.width(44.dp))
            else Avatar(
                st.profileOf(m.author.id, guildId) ?: m.author, 36.dp,
                modifier = Modifier.padding(top = if (m.referencedMessage != null) 22.dp else 2.dp).clickable { nav.push(Screen.Profile(m.author.id, guildId)) },
            )
            if (!grouped) Spacer(Modifier.width(8.dp))
            Column(Modifier.weight(1f)) {
                m.referencedMessage?.let { ref ->
                    Row(
                        Modifier.padding(bottom = 3.dp).clip(RoundedCornerShape(6.dp)).clickable { onJump(ref.id) },
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        LIcon(LinkordIcons.Reply, size = 12.dp, tint = c.text3)
                        Spacer(Modifier.width(4.dp))
                        Avatar(ref.author, 14.dp)
                        Spacer(Modifier.width(4.dp))
                        Text(st.nameOf(ref.author.id, guildId, t("Unknown")), style = Linkord.type.small.copy(fontWeight = FontWeight.SemiBold), color = c.text2)
                        Spacer(Modifier.width(6.dp))
                        Text(plainText(ref.content, st, guildId).replace('\n', ' ').ifEmpty { t("Click to see attachment") }, style = Linkord.type.small, color = c.text3, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                if (!grouped) Row(verticalAlignment = Alignment.CenterVertically) {
                    val color = st.nameColor(guildId, m.author.id)?.let { Color(0xFF000000 or it.toLong()) } ?: c.text
                    Text(
                        st.nameOf(m.author.id, guildId, t("Unknown")), style = Linkord.type.bodyStrong, color = color, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false).clickable { nav.push(Screen.Profile(m.author.id, guildId)) },
                    )
                    if (m.author.bot) {
                        Spacer(Modifier.width(6.dp))
                        Text("BOT", style = Linkord.type.label, color = c.onBrand, modifier = Modifier.clip(RoundedCornerShape(4.dp)).background(c.brand).padding(horizontal = 4.dp, vertical = 1.dp))
                    }
                    Spacer(Modifier.width(8.dp))
                    Text(timeOf(m.createdAt), style = Linkord.type.label)
                }
                m.interaction?.let { i ->
                    Text(t("{name} used /{command}", "name" to st.nameOf(i.user.id, guildId, t("Unknown")), "command" to i.name), style = Linkord.type.small, color = c.text3)
                }
                m.forwarded?.let { f ->
                    Row(Modifier.padding(vertical = 2.dp).height(IntrinsicSize.Min)) {
                        Box(Modifier.width(3.dp).fillMaxHeight().clip(RoundedCornerShape(2.dp)).background(c.lineStrong))
                        Column(Modifier.padding(start = 10.dp)) {
                            Text(t("Forwarded"), style = Linkord.type.label)
                            if (f.content.isNotEmpty()) MarkdownText(f.content, guildId, onTap = onTap)
                            Attachments(f.attachments)
                        }
                    }
                }
                if (m.content.isNotEmpty()) MarkdownText(
                    m.content, guildId, jumbo = Markdown.isJumbo(m.content), edited = m.editedAt != null,
                    color = if (m.failed) c.danger else c.text, onTap = onTap,
                )
                if (m.ephemeral) Text(t("Only you can see this"), style = Linkord.type.label)
                Attachments(m.attachments)
                for (e in m.embeds) EmbedCard(e, guildId, onTap)
                if (m.failed) FailedRow(m)
                if (m.reactions.isNotEmpty()) FlowRow(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (r in m.reactions) {
                        val mine = me != null && me in r.users
                        Row(
                            Modifier.clip(RoundedCornerShape(8.dp)).background(if (mine) c.brandSoft else c.raised)
                                .border(1.dp, if (mine) c.brandTint(0.6f) else Color.Transparent, RoundedCornerShape(8.dp))
                                .clickable { session.actions.toggleReaction(m, r.emoji) }.padding(horizontal = 8.dp, vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            ReactionEmoji(r.emoji, 18.dp)
                            Spacer(Modifier.width(5.dp))
                            Text(r.users.size.toString(), style = Linkord.type.mono.copy(color = if (mine) c.text else c.text2))
                        }
                    }
                }
                m.threadId?.let { tid ->
                    st.channels[tid]?.let { th ->
                        Row(
                            Modifier.padding(top = 4.dp).clip(RoundedCornerShape(10.dp)).background(c.raised).clickable { onOpenChannel(th.id) }.padding(horizontal = 10.dp, vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            LIcon(LinkordIcons.Thread, size = 14.dp)
                            Spacer(Modifier.width(6.dp))
                            Text(th.name, style = Linkord.type.small, color = c.text)
                            Spacer(Modifier.width(6.dp))
                            Text(com.linkord.core.plural(th.messageCount, "{n} message", "{n} messages"), style = Linkord.type.label)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun FailedRow(m: Message) {
    val session = LocalContext.current.session
    val c = Linkord.colors
    Row(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(t("Failed to send."), style = Linkord.type.small, color = c.danger)
        Text(t("Retry"), style = Linkord.type.small.copy(fontWeight = FontWeight.SemiBold), color = c.text, modifier = Modifier.clickable { session.actions.retryMessage(m) })
        Text(t("Delete"), style = Linkord.type.small, color = c.text3, modifier = Modifier.clickable { session.actions.dismissMessage(m) })
    }
}

/** "X joined the server." / "X pinned a message." */
@Composable
private fun SystemLine(st: State, m: Message, guildId: String?, onJump: (String) -> Unit) {
    val c = Linkord.colors
    val name = st.nameOf(m.author.id, guildId, t("Unknown"))
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        LIcon(if (m.type == MessageType.PINNED) LinkordIcons.Pin else LinkordIcons.ArrowRight, size = 16.dp, tint = if (m.type == MessageType.PINNED) c.text3 else c.online)
        Spacer(Modifier.width(12.dp))
        val text = if (m.type == MessageType.PINNED) t("{name} pinned a message to this channel.", "name" to name) else t("{name} joined the server.", "name" to name)
        Text(text, style = Linkord.type.small, color = c.text2, modifier = Modifier.weight(1f).then(if (m.replyTo != null) Modifier.clickable { onJump(m.replyTo!!) } else Modifier))
        Text(timeOf(m.createdAt), style = Linkord.type.label)
    }
}

/** A reaction's emoji: unicode as text, a server emoji (`name:id`) as its picture. */
@Composable
fun ReactionEmoji(emoji: String, size: androidx.compose.ui.unit.Dp) {
    val session = LocalContext.current.session
    val custom = remember(emoji) { Regex("^(\\w+):(\\d+)$").find(emoji) }
    if (custom != null) {
        val id = custom.groupValues[2]
        val animated = session.store.s.emojis.values.any { l -> l.any { it.id == id && it.animated } }
        AsyncImage(session.api.emojiUrl(id, animated), ":${custom.groupValues[1]}:", modifier = Modifier.size(size))
    } else Text(com.linkord.designsystem.emojiText(emoji), fontSize = with(LocalDensity.current) { (size * 0.9f).toSp() })
}

@Composable
fun Attachments(list: List<Attachment>) {
    val nav = LocalNav.current
    val ctx = LocalContext.current
    val c = Linkord.colors
    for (a in list) {
        val url = mediaUrl(a.url) ?: continue
        when {
            a.isImage -> {
                val ratio = if (a.width != null && a.height != null && a.height!! > 0) a.width!!.toFloat() / a.height!! else 4f / 3f
                AsyncImage(
                    url, a.filename, contentScale = ContentScale.Crop,
                    modifier = Modifier.padding(top = 4.dp).widthIn(max = 300.dp).heightIn(max = 360.dp).aspectRatio(ratio.coerceIn(0.4f, 3f))
                        .clip(RoundedCornerShape(10.dp)).background(c.raised).clickable { nav.push(Screen.Image(url, a.filename)) },
                )
            }
            // `playable` is the H.264 copy the server makes of videos phones can't decode (videos.rs).
            a.isVideo -> FileCard(a, LinkordIcons.Play) { nav.push(Screen.Video(mediaUrlOf(ctx, a.playable ?: a.url), a.filename)) }
            a.isVoiceNote -> VoiceNotePlayer(a, if (a.url.startsWith("file:")) a.url else url)
            a.isAudio -> FileCard(a, LinkordIcons.Music) { openMedia(ctx, url, a.contentType) }
            else -> FileCard(a, LinkordIcons.Paperclip) { openLink(ctx, url) }
        }
    }
}

private fun mediaUrlOf(ctx: android.content.Context, path: String) = ctx.session.api.media(path) ?: path

@Composable
private fun FileCard(a: Attachment, icon: androidx.compose.ui.graphics.vector.ImageVector, onClick: () -> Unit) {
    val c = Linkord.colors
    Row(
        Modifier.padding(top = 4.dp).widthIn(max = 320.dp).fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(c.raised)
            .border(1.dp, c.line, RoundedCornerShape(12.dp)).clickable(onClick = onClick).padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(36.dp).clip(RoundedCornerShape(10.dp)).background(c.raised2), contentAlignment = Alignment.Center) { LIcon(icon, tint = c.text) }
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(a.filename, style = Linkord.type.bodyStrong.copy(fontWeight = FontWeight.Medium), maxLines = 1, overflow = TextOverflow.Ellipsis)
            val extra = a.durationSecs?.let { d -> "%d:%02d".format((d / 60).toInt(), (d % 60).toInt()) }
            Text(listOfNotNull(extra, humanSize(a.size)).joinToString(" · "), style = Linkord.type.label)
        }
    }
}

fun humanSize(b: Long): String = when {
    b < 1024 -> "$b B"
    b < 1024 * 1024 -> "%.1f KB".format(b / 1024.0)
    b < 1024L * 1024 * 1024 -> "%.1f MB".format(b / 1024.0 / 1024)
    else -> "%.2f GB".format(b / 1024.0 / 1024 / 1024)
}

/** Link previews and bots' cards. */
@Composable
fun EmbedCard(e: Embed, guildId: String?, onTap: (MdTap) -> Unit) {
    val c = Linkord.colors
    val ctx = LocalContext.current
    val nav = LocalNav.current
    if (e.type == "clip" && e.clip != null) {
        com.linkord.app.ui.extras.ClipCard(e.clip!!)
        return
    }
    if (e.type == "image" && e.image != null) {
        val url = mediaUrl(e.image)!!
        AsyncImage(url, null, contentScale = ContentScale.Fit, modifier = Modifier.padding(top = 4.dp).widthIn(max = 300.dp).heightIn(max = 300.dp).clip(RoundedCornerShape(10.dp)).clickable { nav.push(Screen.Image(url, "")) })
        return
    }
    if (e.title == null && e.description == null && e.image == null && e.fields.isNullOrEmpty()) return
    val bar = e.color?.let { Color(0xFF000000 or it.toLong()) } ?: c.lineStrong
    Row(
        Modifier.padding(top = 6.dp).widthIn(max = 360.dp).clip(RoundedCornerShape(10.dp)).background(c.raised)
            .then(if (e.type != "rich" && e.url.isNotEmpty()) Modifier.clickable { openLink(ctx, e.url) } else Modifier)
            .height(IntrinsicSize.Min),
    ) {
        Box(Modifier.width(3.dp).fillMaxHeight().background(bar))
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            e.siteName?.let { Text(it, style = Linkord.type.label) }
            e.author?.let { Text(it, style = Linkord.type.small.copy(fontWeight = FontWeight.SemiBold), color = c.text) }
            e.title?.let { Text(it, style = Linkord.type.bodyStrong, color = if (e.url.isNotEmpty() && e.type != "rich") c.brandHi else c.text) }
            e.description?.let { d ->
                if (e.type == "rich") MarkdownText(d, guildId, style = Linkord.type.small.copy(color = c.text2), color = c.text2, onTap = onTap)
                else Text(d, style = Linkord.type.small, maxLines = 4, overflow = TextOverflow.Ellipsis)
            }
            e.fields?.let { fields ->
                for (f in fields) Column {
                    Text(f.name, style = Linkord.type.small.copy(fontWeight = FontWeight.SemiBold), color = c.text)
                    MarkdownText(f.value, guildId, style = Linkord.type.small, color = c.text2, onTap = onTap)
                }
            }
            e.image?.let { img ->
                val url = mediaUrl(img)!!
                AsyncImage(url, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxWidth().heightIn(max = 200.dp).clip(RoundedCornerShape(8.dp)).clickable { nav.push(Screen.Image(url, "")) })
            }
            e.footer?.let { Text(it, style = Linkord.type.label) }
        }
        e.thumbnail?.let { th ->
            AsyncImage(mediaUrl(th), null, contentScale = ContentScale.Crop, modifier = Modifier.padding(12.dp).size(64.dp).clip(RoundedCornerShape(8.dp)))
        }
    }
}

fun openLink(ctx: android.content.Context, url: String) {
    runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
}

fun openMedia(ctx: android.content.Context, url: String, type: String) {
    runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(Uri.parse(url), type).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        .onFailure { openLink(ctx, url) }
}

