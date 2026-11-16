package com.linkord.app

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.github.takahirom.roborazzi.captureRoboImage
import com.linkord.designsystem.emojiText
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Emoji sequences drawn through the Twemoji text path (emojiText), saved to app/build/screens/emoji.png. Each row
 * must show one glyph per sequence: a split ZWJ / FE0F sequence shows up as two pictures side by side.
 * Run: ./gradlew :app:testDebugUnitTest --tests '*EmojiTest*'
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-xxhdpi")
class EmojiTest {
    @get:Rule val compose = createComposeRule()

    @Test fun sequences() {
        compose.setContent {
            Column(Modifier.background(Color.White).padding(8.dp)) {
                SAMPLES.forEach { Text(emojiText("$it|"), fontSize = 28.sp, color = Color.Black) }
            }
        }
        compose.waitForIdle()
        compose.onRoot().captureRoboImage("build/screens/emoji.png")
    }

    /** A ZWJ / FE0F / keycap sequence must stay one Twemoji run, or the font can't join it. */
    @Test fun sequencesStayOneRun() {
        for (seq in listOf("🏳️‍🌈", "🏳️‍⚧️", "❤️‍🔥", "1️⃣", "🕵️‍♀️", "👩🏿‍💻", "🇧🇷", "🏴‍☠️")) {
            val text = emojiText("a${seq}b")
            assertEquals(seq, listOf(1 to 1 + seq.length), text.spanStyles.map { it.start to it.end })
        }
    }

    companion object {
        val SAMPLES = listOf(
            "🏳️‍🌈 rainbow flag", "🏳‍🌈 without FE0F", "🏳️‍⚧️ trans flag", "❤️‍🔥 heart on fire", "❤️ heart",
            "1️⃣ #️⃣ *️⃣ keycaps", "👍🏽 👩🏿‍💻 skin tones", "🇧🇷 🏴‍☠️ flags", "🕵️‍♀️ 👨‍👩‍👧 ZWJ", "☺️ ✌️ ⭐ text + VS16",
        )
    }
}
