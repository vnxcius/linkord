package com.linkord.core

import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class MarkdownTest {
    private val opts = Markdown.Options(
        userName = { if (it == "7") "me" else "someone" },
        meId = "7",
        role = { if (it == "5") "mods" to 0xff0000 else null },
        emojiUrl = { id, a -> "/e/$id.${if (a) "gif" else "png"}" },
        channelName = { if (it == "42") "geral" else null },
        time = { unix, style -> "$style:$unix" },
    )

    /** The same cases and HTML as the web client's tests/markdown.test.mjs. */
    @Test
    fun sharedFixtures() {
        val file = File("../../tests/fixtures/markdown.json")
        val cases = LinkordJson.parseToJsonElement(file.readText()).jsonObject["cases"]!!.jsonArray
        assertTrue(cases.size > 30)
        for (c in cases) {
            val input = c.jsonObject["input"]!!.jsonPrimitive.content
            val want = c.jsonObject["html"]!!.jsonPrimitive.content
            val got = Markdown.toHtml(Markdown.parse(input, opts)).replace(Regex("<span class=\"md-time\" title=\"[^\"]*\">"), "<span class=\"md-time\">")
            assertEquals("input: $input", want, got)
        }
    }

    @Test
    fun jumbo() {
        assertTrue(Markdown.isJumbo("😀"))
        assertTrue(Markdown.isJumbo("👍🏽 ❤️"))
        assertFalse(Markdown.isJumbo("hi 😀"))
        assertFalse(Markdown.isJumbo("123"))
    }

    @Test
    fun unescapes() {
        assertEquals("a < b & \"c\" 'd'", Markdown.unescape(Markdown.esc("a < b & \"c\" 'd'")))
    }
}
