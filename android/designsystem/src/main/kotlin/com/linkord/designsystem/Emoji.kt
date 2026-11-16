package com.linkord.designsystem

import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle

/** Code points that make up emoji sequences (pictographs, flags, ZWJ, VS16, skin tones, tags, keycaps). */
fun isEmojiPoint(cp: Int) = cp in 0x1F000..0x1FAFF || cp in 0x2600..0x27BF || cp in 0x2300..0x23FF || cp in 0x2B00..0x2BFF ||
    cp in 0xE0020..0xE007F || cp == 0x200D || cp == 0xFE0F || cp == 0x20E3 || cp in 0x2190..0x21FF || cp in 0x25A0..0x25FF ||
    cp == 0xA9 || cp == 0xAE || cp == 0x203C || cp == 0x2049 || cp == 0x2122 || cp == 0x2139 || cp == 0x3030 || cp == 0x303D

/** Appends [text], its emoji runs in Twemoji (keycaps too: a digit, # or * followed by VS16 / U+20E3). */
fun AnnotatedString.Builder.appendWithEmoji(text: String) {
    var i = 0
    val n = text.length
    while (i < n) {
        val cp = text.codePointAt(i)
        val next = if (i + Character.charCount(cp) < n) text.codePointAt(i + Character.charCount(cp)) else -1
        val keycap = (cp in '0'.code..'9'.code || cp == '#'.code || cp == '*'.code) && (next == 0xFE0F || next == 0x20E3)
        if (isEmojiPoint(cp) && cp != 0x200D || keycap) {
            var j = i
            while (j < n) {
                val c = text.codePointAt(j)
                val after = if (j + Character.charCount(c) < n) text.codePointAt(j + Character.charCount(c)) else -1
                val kc = (c in '0'.code..'9'.code || c == '#'.code || c == '*'.code) && (after == 0xFE0F || after == 0x20E3)
                if (!isEmojiPoint(c) && !kc) break
                j += Character.charCount(c)
            }
            withStyle(SpanStyle(fontFamily = Twemoji)) { append(text, i, j) }
            i = j
        } else {
            var j = i
            while (j < n) {
                val c = text.codePointAt(j)
                val after = if (j + Character.charCount(c) < n) text.codePointAt(j + Character.charCount(c)) else -1
                val kc = (c in '0'.code..'9'.code || c == '#'.code || c == '*'.code) && (after == 0xFE0F || after == 0x20E3)
                if (isEmojiPoint(c) && c != 0x200D || kc) break
                j += Character.charCount(c)
            }
            append(text, i, j)
            i = j
        }
    }
}

/** A plain string with its emoji in Twemoji. */
fun emojiText(text: String): AnnotatedString = buildAnnotatedString { appendWithEmoji(text) }
