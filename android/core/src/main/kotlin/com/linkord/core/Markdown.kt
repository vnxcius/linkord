package com.linkord.core

/**
 * Discord-flavored markdown: a port of app/src/lib/markdown.ts that runs the same steps on the same (escaped) text,
 * but yields a small tree instead of HTML. [toHtml] turns it back into exactly the web client's HTML, so both test
 * suites check one set of fixtures (tests/fixtures/markdown.json).
 *
 * Text in the tree is still HTML-escaped, as in the web client's pipeline; [unescape] gives the text to show.
 */
object Markdown {
    class Options(
        val userName: (String) -> String,
        val meId: String? = null,
        /** Role name and colour (0xRRGGBB) for <@&id>. */
        val role: (String) -> Pair<String, Int?>? = { null },
        val emojiUrl: ((String, Boolean) -> String)? = null,
        val channelName: (String) -> String? = { null },
        /** <t:unix:style> as text (Discord's styles t T d D f F R). */
        val time: (Long, String) -> String = { u, _ -> java.util.Date(u * 1000).toString() },
        /** The full date for a <t:...>'s tooltip. */
        val timeTitle: (Long) -> String = { java.util.Date(it * 1000).toString() },
    )

    enum class Style(val open: Char, val close: Char, val tag: String, val attrs: String = "") {
        Bold('', '', "strong"),
        Underline('', '', "u"),
        Italic('', '', "em"),
        Strike('', '', "s"),
        Spoiler('', '', "span", " class=\"spoiler\""),
    }

    sealed interface Seg
    data class Text(val text: String) : Seg
    data class Open(val style: Style) : Seg
    data class Close(val style: Style) : Seg
    /** A line break inside a block (quotes and plain lines). */
    data object Break : Seg
    data class Code(val code: String) : Seg
    data class CodeBlock(val code: String) : Seg
    data class UserMention(val id: String, val name: String, val me: Boolean) : Seg
    data class RoleMention(val id: String, val name: String, val color: Int?) : Seg
    data class Everyone(val who: String) : Seg
    data class ChannelMention(val id: String, val name: String) : Seg
    data class CustomEmoji(val id: String, val name: String, val animated: Boolean, val url: String) : Seg
    data class Time(val unix: Long, val text: String, val title: String) : Seg
    data class Link(val url: String, val children: List<Seg>) : Seg

    sealed interface Block
    /** Plain lines; [Break] between them. */
    data class Lines(val segs: List<Seg>) : Block
    data class Quote(val segs: List<Seg>) : Block
    data class Sub(val segs: List<Seg>) : Block
    data class Heading(val level: Int, val segs: List<Seg>) : Block
    data class ListItem(val segs: List<Seg>) : Block

    private const val SLOT = '\u0000'
    private val PRIVATE = Regex("[\u0000-]")
    private val CODE_BLOCK = Regex("```(?:([\\w+-]+)\\n)?([\\s\\S]*?)```")
    private val CODE = Regex("`([^`\\n]+)`")
    private val ESCAPE = Regex("""\\([\\`*_~|\[\]()<>#@:!.-])""")
    private val USER = Regex("&lt;@(\\d+)&gt;")
    private val ROLE = Regex("&lt;@&amp;(\\d+)&gt;")
    private val EVERYONE = Regex("(^|\\s)@(everyone|here)\\b")
    private val EMOJI = Regex("&lt;(a?):(\\w{2,32}):(\\d+)&gt;")
    private val CHANNEL = Regex("&lt;#(\\d+)&gt;")
    private val TIME = Regex("&lt;t:(-?\\d{1,13})(?::([tTdDfFR]))?&gt;")
    private val MASKED = Regex("\\[([^\\]\\n]+)\\]\\((?:&lt;(https?://[^\\s\u0000]+?)&gt;|(https?://[^\\s()\u0000]+))\\)")
    private val ANGLE_URL = Regex("&lt;(https?://[^\\s\u0000]+?)&gt;")
    private val URL = Regex("https?://[^\\s<\u0000]+[^\\s<.,:;\"')\\]!?\u0000]")
    private val SLOT_REF = Regex("\u0000(\\d+)\u0000")

    private val BOLD = Regex("\\*\\*(.+?)\\*\\*")
    private val UNDERLINE = Regex("__(.+?)__")
    private val ITALIC_STAR = Regex("(^|[^\\w*])\\*(?!\\s)(.+?)\\*(?!\\w)")
    private val ITALIC_UNDER = Regex("(^|[^\\w])_(?!\\s)(.+?)_(?!\\w)")
    private val STRIKE = Regex("~~(.+?)~~")
    private val SPOILER = Regex("\\|\\|(.+?)\\|\\|")

    fun esc(s: String) = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;").replace("'", "&#39;")

    fun unescape(s: String) = s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&amp;", "&")

    private fun inline(s: String): String {
        val w = { st: Style -> { m: MatchResult -> "${st.open}${m.groupValues[1]}${st.close}" } }
        return s.replace(BOLD, w(Style.Bold))
            .replace(UNDERLINE, w(Style.Underline))
            .replace(ITALIC_STAR) { m -> "${m.groupValues[1]}${Style.Italic.open}${m.groupValues[2]}${Style.Italic.close}" }
            .replace(ITALIC_UNDER) { m -> "${m.groupValues[1]}${Style.Italic.open}${m.groupValues[2]}${Style.Italic.close}" }
            .replace(STRIKE, w(Style.Strike))
            .replace(SPOILER, w(Style.Spoiler))
    }

    /** What a slot holds: a finished piece, or a link whose text is still marked-up text (with slots of its own). */
    private sealed interface Slot
    private data class Piece(val seg: Seg) : Slot
    private data class LinkSlot(val url: String, val text: String) : Slot

    fun parse(src: String, o: Options): List<Block> {
        val slots = ArrayList<Slot>()
        fun slot(x: Slot): String {
            slots += x
            return "$SLOT${slots.size - 1}$SLOT"
        }

        var s = src.replace(PRIVATE, "")
        s = s.replace(CODE_BLOCK) { m -> slot(Piece(CodeBlock(esc(m.groupValues[2].trim('\n'))))) }
        s = s.replace(CODE) { m -> slot(Piece(Code(esc(m.groupValues[1])))) }
        // A backslash keeps the next character from being markup.
        s = s.replace(ESCAPE) { m -> slot(Piece(Text(esc(m.groupValues[1])))) }
        s = esc(s)
        s = s.replace(USER) { m ->
            val id = m.groupValues[1]
            slot(Piece(UserMention(id, esc(o.userName(id)), id == o.meId)))
        }
        s = s.replace(ROLE) { m ->
            val r = o.role(m.groupValues[1])
            slot(Piece(RoleMention(m.groupValues[1], esc(r?.first ?: "deleted-role"), r?.second)))
        }
        s = s.replace(EVERYONE) { m -> m.groupValues[1] + slot(Piece(Everyone(m.groupValues[2]))) }
        s = s.replace(EMOJI) { m ->
            val (a, name, id) = m.destructured
            val url = o.emojiUrl
            if (url != null) slot(Piece(CustomEmoji(id, name, a == "a", url(id, a == "a")))) else ":$name:"
        }
        s = s.replace(CHANNEL) { m -> slot(Piece(ChannelMention(m.groupValues[1], esc(o.channelName(m.groupValues[1]) ?: "unknown")))) }
        s = s.replace(TIME) { m ->
            val unix = m.groupValues[1].toLong()
            val style = m.groupValues[2].ifEmpty { "f" }
            slot(Piece(Time(unix, esc(o.time(unix, style)), esc(o.timeTitle(unix)))))
        }
        s = s.replace(MASKED) { m ->
            val url = m.groupValues[2].ifEmpty { m.groupValues[3] }
            slot(LinkSlot(url, inline(m.groupValues[1])))
        }
        s = s.replace(ANGLE_URL) { m -> slot(LinkSlot(m.groupValues[1], m.groupValues[1])) }
        s = s.replace(URL) { m -> slot(LinkSlot(m.value, m.value)) }

        fun segs(text: String, depth: Int = 0): List<Seg> {
            val out = ArrayList<Seg>()
            val buf = StringBuilder()
            fun flush() {
                if (buf.isNotEmpty()) out += Text(buf.toString())
                buf.clear()
            }
            var i = 0
            while (i < text.length) {
                val c = text[i]
                if (c == SLOT) {
                    val end = text.indexOf(SLOT, i + 1)
                    val n = if (end > i) text.substring(i + 1, end).toIntOrNull() else null
                    if (n != null && n < slots.size) {
                        flush()
                        when (val x = slots[n]) {
                            is Piece -> out += x.seg
                            // As in the web client, slots inside slots are expanded at most three levels deep.
                            is LinkSlot -> out += Link(x.url, if (depth < 3) segs(x.text, depth + 1) else listOf(Text(x.text)))
                        }
                        i = end + 1
                        continue
                    }
                }
                val style = Style.entries.firstOrNull { it.open == c || it.close == c }
                if (style != null) {
                    flush()
                    out += if (style.open == c) Open(style) else Close(style)
                } else buf.append(c)
                i++
            }
            flush()
            return out
        }

        val blocks = ArrayList<Block>()
        val quote = ArrayList<String>()
        val lines = ArrayList<String>()
        fun flushQuote() {
            if (quote.isNotEmpty()) blocks += Quote(join(quote.map { segs(inline(it)) }))
            quote.clear()
        }
        fun flushLines() {
            if (lines.isNotEmpty()) blocks += Lines(join(lines.map { segs(inline(it)) }))
            lines.clear()
        }
        for (line in s.split('\n')) {
            val q = Regex("^&gt; ?(.*)$").find(line)
            if (q != null) {
                flushLines()
                quote += q.groupValues[1]
                continue
            }
            flushQuote()
            val sub = Regex("^-# (.+)$").find(line)
            val h = Regex("^(#{1,3}) (.+)$").find(line)
            val li = Regex("^\\s*[-*] (.+)$").find(line)
            when {
                sub != null -> { flushLines(); blocks += Sub(segs(inline(sub.groupValues[1]))) }
                h != null -> { flushLines(); blocks += Heading(h.groupValues[1].length, segs(inline(h.groupValues[2]))) }
                li != null -> { flushLines(); blocks += ListItem(segs(inline(li.groupValues[1]))) }
                else -> lines += line
            }
        }
        flushQuote()
        flushLines()
        return blocks
    }

    private fun join(lines: List<List<Seg>>): List<Seg> = buildList {
        lines.forEachIndexed { i, l ->
            if (i > 0) add(Break)
            addAll(l)
        }
    }

    // ------------------------------------------------------------ HTML, exactly as the web client writes it

    fun toHtml(blocks: List<Block>): String {
        // The web client ends every plain line with "\n", drops the last one and turns the rest into <br>; blocks
        // (quotes, headings...) don't add one. Rebuilt here the same way.
        val sb = StringBuilder()
        for (b in blocks) when (b) {
            is Lines -> sb.append(segsHtml(b.segs).replace("<br>", "\n")).append('\n')
            is Quote -> sb.append("<blockquote>").append(segsHtml(b.segs).replace("<br>", BR_KEEP)).append("</blockquote>")
            is Sub -> sb.append("<div class=\"md-sub\">").append(segsHtml(b.segs)).append("</div>")
            is Heading -> sb.append("<div class=\"md-h${b.level}\">").append(segsHtml(b.segs)).append("</div>")
            is ListItem -> sb.append("<div class=\"md-li\">").append(segsHtml(b.segs)).append("</div>")
        }
        return sb.toString().removeSuffix("\n").replace("\n", "<br>").replace(BR_KEEP, "<br>").replace(NL_KEEP, "\n")
    }

    private const val BR_KEEP = ""
    /** Newlines inside code blocks: the web client expands those after turning line ends into <br>. */
    private const val NL_KEEP = ""

    private fun segsHtml(segs: List<Seg>): String = buildString {
        for (x in segs) append(
            when (x) {
                is Text -> x.text
                is Open -> "<${x.style.tag}${x.style.attrs}>"
                is Close -> "</${x.style.tag}>"
                Break -> "<br>"
                is Code -> "<code class=\"md-inline\">${x.code}</code>"
                is CodeBlock -> "<pre class=\"md-code\"><code>${x.code.replace("\n", NL_KEEP)}</code></pre>"
                is UserMention -> "<span class=\"mention${if (x.me) " me" else ""}\" data-user=\"${x.id}\">@${x.name}</span>"
                is RoleMention -> {
                    val style = x.color?.let { " style=\"--role:#${it.toString(16).padStart(6, '0')}\"" } ?: ""
                    "<span class=\"mention role\"$style>@${x.name}</span>"
                }
                is Everyone -> "<span class=\"mention everyone\">@${x.who}</span>"
                is ChannelMention -> "<span class=\"mention channel\">#${x.name}</span>"
                is CustomEmoji -> "<img class=\"emoji custom\" src=\"${x.url}\" alt=\":${x.name}:\" title=\":${x.name}:\" draggable=\"false\">"
                is Time -> "<span class=\"md-time\" title=\"${x.title}\">${x.text}</span>"
                is Link -> "<a href=\"${x.url}\" target=\"_blank\" rel=\"noopener noreferrer\" title=\"${x.url}\">${segsHtml(x.children)}</a>"
            },
        )
    }

    private fun isEmojiPart(cp: Int) = Character.isWhitespace(cp) || cp == 0x200D || cp == 0xFE0F || cp == 0x20E3 ||
        cp in 0x1F000..0x1FAFF || cp in 0x2600..0x27BF || cp in 0x2300..0x23FF || cp in 0x2B00..0x2BFF ||
        cp in 0xE0020..0xE007F || cp in 0x2190..0x21FF || cp in 0x25A0..0x25FF || cp in 0x0030..0x0039 ||
        cp == '#'.code || cp == '*'.code || cp in intArrayOf(0xA9, 0xAE, 0x203C, 0x2049, 0x2122, 0x2139, 0x24C2, 0x3030, 0x303D, 0x3297, 0x3299)

    /** Messages made only of a few emoji are shown large, like Discord. */
    fun isJumbo(content: String): Boolean {
        val t = content.trim()
        if (t.isEmpty() || Regex("^[\\d#*\\s]+$").matches(t) || !t.codePoints().allMatch(::isEmojiPart)) return false
        val it = java.text.BreakIterator.getCharacterInstance()
        val bare = t.replace(Regex("\\s"), "")
        it.setText(bare)
        var n = 0
        while (it.next() != java.text.BreakIterator.DONE) n++
        return n <= 27
    }
}
