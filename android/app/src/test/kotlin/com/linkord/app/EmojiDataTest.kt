package com.linkord.app

import com.linkord.app.ui.chat.EmojiData
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** The picker's emoji list (the web client's app/src/lib/emoji-list.json): categories, skin tones and search. */
class EmojiDataTest {
    private val groups = EmojiData.parse(File("../../app/src/lib/emoji-list.json").readText())
    private fun find(c: String) = groups.flatMap { it.emojis }.first { it.char == c }

    @Test fun everyCategoryLikeTheWeb() {
        assertEquals(EmojiData.GROUPS.keys.toList(), groups.map { it.id })
        assertTrue("all of Twemoji's emoji, not a short list", groups.sumOf { it.emojis.size } > 1800)
        assertTrue(groups.all { g -> g.emojis.isNotEmpty() })
    }

    @Test fun skinTones() {
        assertEquals(listOf("👍🏻", "👍🏼", "👍🏽", "👍🏾", "👍🏿"), find("👍").tones)
        // FE0F goes when a tone takes its place (✌️ -> ✌🏽).
        assertEquals("✌\uD83C\uDFFD", find("✌️").tones!![2])
        assertEquals(null, find("😀").tones)
        // Several people: each variant spelled out by the list.
        assertTrue(find("🤝").tones!!.all { it.startsWith("🤝") || it.contains("\u200D") })
    }

    @Test fun search() {
        assertEquals("👍", EmojiData.search(groups, "thumbsup").first().char)
        assertTrue(EmojiData.search(groups, ":fire").any { it.char == "🔥" })
        assertTrue("keywords too", EmojiData.search(groups, "like").any { it.char == "👍" })
        assertTrue(EmojiData.search(groups, "  ").isEmpty())
    }
}
