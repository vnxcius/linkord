package com.linkord.core

import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * UI translations, like the web client's lib/i18n.ts: the English text is the key, `{name}` placeholders are filled
 * from vars. The dictionary is app/src/lib/locales/pt-BR.ts, turned into an asset at build time; every string used
 * here needs an entry there (tests/i18n.test.mjs scans android/ too).
 */
object I18n {
    @Volatile private var ui: Map<String, String> = emptyMap()
    @Volatile private var server: Map<String, String> = emptyMap()
    @Volatile var lang: String = "en"
        private set

    /** Loads a dictionary JSON ({"ui": {...}, "server": {...}}) for [language]; "en" (or null json) = no dictionary. */
    fun load(language: String, json: String?) {
        lang = language
        if (json == null) {
            ui = emptyMap(); server = emptyMap(); return
        }
        val o = LinkordJson.parseToJsonElement(json).jsonObject
        ui = o["ui"]?.jsonObject?.mapValues { it.value.jsonPrimitive.content } ?: emptyMap()
        server = o["server"]?.jsonObject?.mapValues { it.value.jsonPrimitive.content } ?: emptyMap()
    }

    fun fill(s: String, vars: Map<String, Any?>): String =
        if (vars.isEmpty()) s else Regex("\\{(\\w+)\\}").replace(s) { m -> if (m.groupValues[1] in vars) vars[m.groupValues[1]].toString() else m.value }

    fun lookup(text: String): String = ui[text] ?: server[text] ?: text

    // Server errors with numbers or names in them, matched by pattern (i18n.ts SERVER_PATTERNS).
    private val patterns = listOf(
        "^channels can have up to (\\d+) pins$" to "channels can have up to {0} pins",
        "^delete the servers you own first: (.+)$" to "delete the servers you own first: {0}",
        "^file exceeds (\\d+) MB$" to "file exceeds {0} MB",
        "^group DMs can have up to (\\d+) people$" to "group DMs can have up to {0} people",
        "^message must be at most (\\d+) characters$" to "message must be at most {0} characters",
        "^servers can have up to (\\d+) emoji$" to "servers can have up to {0} emoji",
        "^unknown setting (.+)$" to "unknown setting {0}",
        "^you can forward to up to (\\d+) places at once$" to "you can forward to up to {0} places at once",
    ).map { Regex(it.first) to it.second }

    /** A server error message (English) in the UI language. */
    fun serverError(text: String): String {
        if (server.isEmpty() && ui.isEmpty()) return text
        (server[text] ?: ui[text])?.let { return it }
        for ((re, key) in patterns) {
            val m = re.find(text) ?: continue
            return fill(lookup(key), m.groupValues.drop(1).withIndex().associate { (i, v) -> i.toString() to v })
        }
        return text
    }
}

/** The English text (with "name" to value pairs for its placeholders) in the UI language. */
fun t(text: String, vararg vars: Pair<String, Any?>): String = I18n.fill(I18n.lookup(text), vars.toMap())

/** t() with the singular or plural form; `{n}` is the count. */
fun plural(n: Int, one: String, other: String, vararg vars: Pair<String, Any?>): String =
    I18n.fill(I18n.lookup(if (n == 1) one else other), mapOf("n" to n) + vars.toMap())
