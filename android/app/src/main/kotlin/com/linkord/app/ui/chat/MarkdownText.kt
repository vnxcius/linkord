package com.linkord.app.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import coil3.compose.AsyncImage
import com.linkord.app.session
import com.linkord.core.Markdown
import com.linkord.core.Markdown.Seg
import com.linkord.core.State
import com.linkord.core.nameOf
import com.linkord.core.t
import com.linkord.designsystem.GeistMono
import com.linkord.designsystem.appendWithEmoji
import com.linkord.designsystem.Linkord
import com.linkord.designsystem.LinkordColors
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/** What a tap on a piece of a message does. */
sealed interface MdTap {
    data class User(val id: String) : MdTap
    data class Channel(val id: String) : MdTap
    data class Url(val url: String) : MdTap
}

fun markdownOptions(st: State, guildId: String?, emojiUrl: (String, Boolean) -> String) = Markdown.Options(
    userName = { st.nameOf(it, guildId, t("Unknown")) },
    meId = st.me?.id,
    role = { id -> guildId?.let { st.roles[it]?.get(id) }?.let { it.name to it.color?.takeIf { c -> c != 0 } } },
    emojiUrl = emojiUrl,
    channelName = { st.channels[it]?.name },
    time = ::formatTime,
    timeTitle = { formatTime(it, "F") },
)

/** <t:unix:style> as Discord shows it, in the phone's language. */
fun formatTime(unix: Long, style: String): String {
    val at = Instant.ofEpochSecond(unix).atZone(ZoneId.systemDefault())
    val loc = Locale.getDefault()
    fun f(s: FormatStyle, time: Boolean, date: Boolean) = when {
        time && date -> DateTimeFormatter.ofLocalizedDateTime(s, FormatStyle.SHORT)
        time -> DateTimeFormatter.ofLocalizedTime(s)
        else -> DateTimeFormatter.ofLocalizedDate(s)
    }.withLocale(loc).format(at)
    return when (style) {
        "t" -> f(FormatStyle.SHORT, true, false)
        "T" -> f(FormatStyle.MEDIUM, true, false)
        "d" -> f(FormatStyle.SHORT, false, true)
        "D" -> f(FormatStyle.LONG, false, true)
        "F" -> f(FormatStyle.FULL, false, true) + " " + f(FormatStyle.SHORT, true, false)
        "R" -> android.text.format.DateUtils.getRelativeTimeSpanString(unix * 1000).toString()
        else -> f(FormatStyle.LONG, false, true) + " " + f(FormatStyle.SHORT, true, false)
    }
}

/**
 * A message's text: Discord-flavored markdown (core Markdown, the web client's renderer) drawn with Compose. Plain
 * lines are one Text each so selection and line breaking are the system's; quotes, headings, list items and code
 * blocks get their own boxes.
 */
@Composable
fun MarkdownText(
    content: String,
    guildId: String?,
    modifier: Modifier = Modifier,
    style: TextStyle = Linkord.type.body,
    color: Color = Linkord.colors.text,
    jumbo: Boolean = false,
    edited: Boolean = false,
    onTap: (MdTap) -> Unit = {},
) {
    val ctx = LocalContext.current
    val session = ctx.session
    val blocks = remember(content, guildId) { Markdown.parse(content, markdownOptions(session.store.s, guildId, session.api::emojiUrl)) }
    val c = Linkord.colors
    var revealed by remember(content) { mutableStateOf(setOf<Int>()) }
    val render = Renderer(c, if (jumbo) style.copy(fontSize = style.fontSize * 2.4f, lineHeight = style.lineHeight * 2.2f) else style, revealed, { revealed = revealed + it }, onTap)
    Column(modifier, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        blocks.forEachIndexed { i, b ->
            val last = i == blocks.lastIndex
            when (b) {
                is Markdown.Lines -> render.Lines(b.segs, color, if (last && edited) t("(edited)") else null)
                is Markdown.Quote -> Row(Modifier.height(IntrinsicSize.Min)) {
                    Box(Modifier.width(3.dp).fillMaxHeight().clip(RoundedCornerShape(2.dp)).background(c.lineStrong))
                    Box(Modifier.padding(start = 10.dp)) { render.Lines(b.segs, color, null) }
                }
                is Markdown.Heading -> render.Lines(
                    b.segs, color, null,
                    style.copy(fontWeight = FontWeight.Bold, fontSize = style.fontSize * (when (b.level) { 1 -> 1.5f; 2 -> 1.25f; else -> 1.1f })),
                )
                is Markdown.ListItem -> Row {
                    Text("•", style = style, color = c.text3, modifier = Modifier.padding(start = 4.dp, end = 8.dp))
                    render.Lines(b.segs, color, null)
                }
                is Markdown.Sub -> render.Lines(b.segs, c.text3, null, style.copy(fontSize = style.fontSize * 0.85f))
            }
        }
    }
}

private class Renderer(
    val c: LinkordColors,
    val style: TextStyle,
    val revealed: Set<Int>,
    val reveal: (Int) -> Unit,
    val onTap: (MdTap) -> Unit,
) {
    /** Plain lines, split around code blocks (which are boxes of their own). */
    @Composable
    fun Lines(segs: List<Seg>, color: Color, suffix: String?, textStyle: TextStyle = style) {
        val parts = ArrayList<Any>()
        var run = ArrayList<Seg>()
        for (s in segs) {
            if (s is Markdown.CodeBlock) {
                if (run.isNotEmpty()) parts.add(run)
                run = ArrayList()
                parts.add(s)
            } else run += s
        }
        if (run.isNotEmpty() || parts.isEmpty()) parts.add(run)
        parts.forEachIndexed { i, p ->
            if (p is Markdown.CodeBlock) CodeBlock(Markdown.unescape(p.code))
            else {
                @Suppress("UNCHECKED_CAST")
                val list = (p as List<Seg>).dropWhile { i > 0 && it == Markdown.Break }
                if (list.isNotEmpty() || suffix != null) Inline(list, color, if (i == parts.lastIndex) suffix else null, textStyle)
            }
        }
    }

    @Composable
    fun CodeBlock(code: String) {
        Box(
            Modifier.fillMaxWidth().padding(vertical = 2.dp).clip(RoundedCornerShape(8.dp)).background(c.raised)
                .horizontalScroll(rememberScrollState()).padding(10.dp),
        ) { Text(code, style = Linkord.type.mono.copy(color = c.text)) }
    }

    @Composable
    fun Inline(segs: List<Seg>, color: Color, suffix: String?, textStyle: TextStyle) {
        val inline = HashMap<String, InlineTextContent>()
        val emojiSize = if (textStyle.fontSize > style.fontSize * 1.5f || textStyle.fontSize.value > 30) 1.1.em else 1.3.em
        val text = buildAnnotatedString {
            val active = HashMap<Markdown.Style, Int>()
            var spoiler = 0
            fun spanFor(): SpanStyle {
                fun on(s: Markdown.Style) = (active[s] ?: 0) > 0
                val deco = listOfNotNull(TextDecoration.Underline.takeIf { on(Markdown.Style.Underline) }, TextDecoration.LineThrough.takeIf { on(Markdown.Style.Strike) })
                val hidden = on(Markdown.Style.Spoiler) && spoiler !in revealed
                return SpanStyle(
                    fontWeight = if (on(Markdown.Style.Bold)) FontWeight.Bold else null,
                    fontStyle = if (on(Markdown.Style.Italic)) FontStyle.Italic else null,
                    textDecoration = if (deco.isEmpty()) null else TextDecoration.combine(deco),
                    color = if (hidden) Color.Transparent else Color.Unspecified,
                    background = if (on(Markdown.Style.Spoiler)) (if (hidden) c.text3 else c.raised) else Color.Unspecified,
                )
            }
            fun add(segs: List<Seg>) {
                for (s in segs) when (s) {
                    is Markdown.Text -> {
                        val txt = Markdown.unescape(s.text)
                        val sp = spanFor()
                        if ((active[Markdown.Style.Spoiler] ?: 0) > 0 && spoiler !in revealed) {
                            val n = spoiler
                            withLink(LinkAnnotation.Clickable("spoiler$n") { reveal(n) }) { withStyle(sp) { appendWithEmoji(txt) } }
                        } else withStyle(sp) { appendWithEmoji(txt) }
                    }
                    is Markdown.Open -> active[s.style] = (active[s.style] ?: 0) + 1
                    is Markdown.Close -> {
                        active[s.style] = ((active[s.style] ?: 0) - 1).coerceAtLeast(0)
                        if (s.style == Markdown.Style.Spoiler) spoiler++
                    }
                    Markdown.Break -> append('\n')
                    is Markdown.Code -> withStyle(SpanStyle(fontFamily = GeistMono, background = c.raised, fontSize = textStyle.fontSize * 0.88f)) {
                        append(" ${Markdown.unescape(s.code)} ")
                    }
                    is Markdown.CodeBlock -> withStyle(SpanStyle(fontFamily = GeistMono)) { append(Markdown.unescape(s.code)) }
                    is Markdown.UserMention -> withLink(LinkAnnotation.Clickable("user:${s.id}") { onTap(MdTap.User(s.id)) }) {
                        withStyle(mention(s.me)) { append("@${Markdown.unescape(s.name)}") }
                    }
                    is Markdown.RoleMention -> withStyle(
                        SpanStyle(color = s.color?.let { Color(0xFF000000 or it.toLong()) } ?: c.brandHi, background = (s.color?.let { Color(0xFF000000 or it.toLong()) } ?: c.brand).copy(alpha = 0.16f * c.tint), fontWeight = FontWeight.Medium),
                    ) { append("@${Markdown.unescape(s.name)}") }
                    is Markdown.Everyone -> withStyle(mention(false)) { append("@${s.who}") }
                    is Markdown.ChannelMention -> withLink(LinkAnnotation.Clickable("channel:${s.id}") { onTap(MdTap.Channel(s.id)) }) {
                        withStyle(mention(false)) { append("#${Markdown.unescape(s.name)}") }
                    }
                    is Markdown.CustomEmoji -> {
                        val key = "emoji:${s.id}:${inline.size}"
                        inline[key] = InlineTextContent(Placeholder(emojiSize, emojiSize, PlaceholderVerticalAlign.TextCenter)) {
                            AsyncImage(s.url, contentDescription = ":${s.name}:", modifier = Modifier.fillMaxSize())
                        }
                        appendInlineContent(key, ":${s.name}:")
                    }
                    is Markdown.Time -> withStyle(SpanStyle(background = c.raised)) { append(Markdown.unescape(s.text)) }
                    is Markdown.Link -> {
                        val url = Markdown.unescape(s.url)
                        withLink(LinkAnnotation.Clickable("url:$url", TextLinkStyles(SpanStyle(color = c.brandHi, textDecoration = TextDecoration.Underline))) { onTap(MdTap.Url(url)) }) {
                            add(s.children)
                        }
                    }
                }
            }
            add(segs)
            if (suffix != null) withStyle(SpanStyle(color = c.text3, fontSize = textStyle.fontSize * 0.75f)) { append(" $suffix") }
        }
        Text(text, style = textStyle, color = color, inlineContent = inline)
    }

    private fun mention(me: Boolean) = SpanStyle(
        color = c.brandHi,
        background = c.brandTint(if (me) 0.26f else 0.14f),
        fontWeight = FontWeight.Medium,
    )
}

/** A whole message's text without markup, for notifications and the copy action. */
fun plainText(content: String, st: State, guildId: String?): String {
    val blocks = Markdown.parse(content, markdownOptions(st, guildId) { _, _ -> "" })
    fun segs(l: List<Seg>): String = buildString {
        for (s in l) when (s) {
            is Markdown.Text -> append(Markdown.unescape(s.text))
            Markdown.Break -> append('\n')
            is Markdown.Code -> append(Markdown.unescape(s.code))
            is Markdown.CodeBlock -> append(Markdown.unescape(s.code))
            is Markdown.UserMention -> append("@" + Markdown.unescape(s.name))
            is Markdown.RoleMention -> append("@" + Markdown.unescape(s.name))
            is Markdown.Everyone -> append("@" + s.who)
            is Markdown.ChannelMention -> append("#" + Markdown.unescape(s.name))
            is Markdown.CustomEmoji -> append(":${s.name}:")
            is Markdown.Time -> append(Markdown.unescape(s.text))
            is Markdown.Link -> append(segs(s.children))
            else -> {}
        }
    }
    return blocks.joinToString("\n") { b ->
        when (b) {
            is Markdown.Lines -> segs(b.segs)
            is Markdown.Quote -> segs(b.segs)
            is Markdown.Heading -> segs(b.segs)
            is Markdown.ListItem -> "• " + segs(b.segs)
            is Markdown.Sub -> segs(b.segs)
        }
    }
}

