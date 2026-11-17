package com.linkord.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive

/** One emoji: its character, shortcodes (first = the one shown), search words and its five skin tones, if any. */
class EmojiEntry(val char: String, val names: List<String>, val tags: List<String>, val tones: List<String>?)

class EmojiGroup(val id: String, val emojis: List<EmojiEntry>)

/**
 * Every emoji the bundled Twemoji font has, by category: the web client's list (app/src/lib/emoji-list.json, built from
 * emojibase by scripts/build-emoji-data.mjs), copied into the app's assets at build time. Plain JVM: tested in core.
 */
object EmojiData {
    /** Category names (translated like the web's) and the emoji each one's tab shows. */
    val GROUPS = linkedMapOf(
        "Smileys" to "😀", "People" to "👋", "Nature" to "🐻", "Food" to "🍔", "Activities" to "⚽",
        "Travel" to "🚗", "Objects" to "💡", "Symbols" to "🔣", "Flags" to "🏁",
    )
    private val SKIN_TONES = listOf("🏻", "🏼", "🏽", "🏾", "🏿")

    @Volatile private var cached: List<EmojiGroup>? = null

    /** The list, read once ([read] gives the JSON: the app's assets/emoji/emoji-list.json). */
    fun load(read: () -> String): List<EmojiGroup> = cached ?: synchronized(this) {
        cached ?: runCatching { parse(read()) }.getOrDefault(emptyList()).also { cached = it }
    }

    /** [[group, [[emoji, "names", "tags", skins?], ...]], ...]; skins: 1 = the tone right after the first character. */
    fun parse(json: String): List<EmojiGroup> = Json.parseToJsonElement(json).jsonArray.map { g ->
        val (id, list) = g.jsonArray
        EmojiGroup(id.jsonPrimitive.content, list.jsonArray.map { e ->
            val a = e.jsonArray
            val char = a[0].jsonPrimitive.content
            val skins = a.getOrNull(3)
            val tones = when {
                skins == null -> null
                skins is JsonArray -> skins.map { it.jsonPrimitive.content }
                skins.jsonPrimitive.intOrNull == 1 -> SKIN_TONES.map { placeTone(char, it) }
                else -> null
            }
            EmojiEntry(char, a[1].jsonPrimitive.content.split(' '), a[2].jsonPrimitive.content.split(' ').filter { it.isNotEmpty() }, tones)
        })
    }

    /** The tone after the first character, replacing its FE0F (web: emoji-data.ts withTone). */
    private fun placeTone(emoji: String, tone: String): String {
        val first = emoji.codePointAt(0)
        var rest = emoji.substring(Character.charCount(first))
        if (rest.startsWith("️")) rest = rest.substring(1)
        return String(Character.toChars(first)) + tone + rest
    }

    /** Shortcodes that start with the query, then ones containing it, then keyword matches ("like" -> 👍). */
    fun search(groups: List<EmojiGroup>, q: String, limit: Int = 120): List<EmojiEntry> {
        val query = q.lowercase().trim().removePrefix(":").replace(Regex("\\s+"), "_")
        if (query.isEmpty()) return emptyList()
        val word = query.replace('_', ' ')
        val tiers = List(3) { mutableListOf<EmojiEntry>() }
        for (g in groups) for (e in g.emojis) when {
            e.names.any { it.startsWith(query) } -> tiers[0] += e
            e.names.any { it.contains(query) } -> tiers[1] += e
            e.tags.any { it.startsWith(word) } -> tiers[2] += e
        }
        return tiers.flatten().take(limit)
    }
}
