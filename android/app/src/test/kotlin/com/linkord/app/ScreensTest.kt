package com.linkord.app

import androidx.compose.foundation.background
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.test.core.app.ApplicationProvider
import com.github.takahirom.roborazzi.captureRoboImage
import com.linkord.app.ui.LocalNav
import com.linkord.app.ui.Navigator
import com.linkord.app.ui.chat.ChatScreen
import com.linkord.app.ui.home.HomePane
import com.linkord.app.ui.home.Tab
import com.linkord.app.ui.profile.ProfileScreen
import com.linkord.core.Attachment
import com.linkord.core.Channel
import com.linkord.core.ChannelMessages
import com.linkord.core.Connection
import com.linkord.core.Embed
import com.linkord.core.Emoji
import com.linkord.core.Guild
import com.linkord.core.Kind
import com.linkord.core.Member
import com.linkord.core.Message
import com.linkord.core.MessageRef
import com.linkord.core.Reaction
import com.linkord.core.Rel
import com.linkord.core.Role
import com.linkord.core.State
import com.linkord.core.User
import com.linkord.core.VoiceState
import com.linkord.core.addDm
import com.linkord.core.addGuild
import com.linkord.core.putUser
import com.linkord.designsystem.LinkordTheme
import com.linkord.designsystem.ThemeMode
import kotlinx.collections.immutable.persistentMapOf
import kotlinx.collections.immutable.toPersistentList
import kotlinx.collections.immutable.toPersistentMap
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.Instant

/**
 * The main screens with sample data, drawn on the JVM and saved to app/build/screens (dark and light), so the UI can
 * be checked without a phone. Run: ./gradlew :app:testDebugUnitTest --tests '*ScreensTest*'
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-xxhdpi")
class ScreensTest {
    @get:Rule val compose = createComposeRule()
    private val session get() = ApplicationProvider.getApplicationContext<LinkordApp>().session

    @Before
    fun seed() = session.store.update { sample() }

    private fun shot(name: String, mode: ThemeMode, content: @Composable () -> Unit) {
        compose.setContent {
            LinkordTheme(mode) { CompositionLocalProvider(LocalNav provides Navigator()) { content() } }
        }
        compose.waitForIdle()
        compose.onRoot().captureRoboImage("build/screens/$name-${mode.name.lowercase()}.png")
    }

    @Test fun chatDark() = shot("chat", ThemeMode.Dark) { ChatScreen("c1", {}, {}, {}) }
    @Test fun chatLight() = shot("chat", ThemeMode.Light) { ChatScreen("c1", {}, {}, {}) }
    // A channel and a DM nobody has written in yet: the intro still shows.
    @Test fun emptyChannelDark() = empty("c3")
    @Test fun emptyChannelLight() = empty("c3", ThemeMode.Light)
    @Test fun emptyDmDark() = empty("dm2")
    @Test fun serversDark() = shot("servers", ThemeMode.Dark) { HomePane(Tab.Home, {}, {}) }
    @Test fun serversLight() = shot("servers", ThemeMode.Light) { HomePane(Tab.Home, {}, {}) }
    @Test fun messagesDark() = shot("messages", ThemeMode.Dark) { HomePane(Tab.Messages, {}, {}) }
    @Test fun youDark() = shot("you", ThemeMode.Dark) { HomePane(Tab.You, {}, {}) }
    @Test fun profileDark() = shot("profile", ThemeMode.Dark) { ProfileScreen("2", "g1") }
    @Test fun callDark() = shot("call", ThemeMode.Dark) { com.linkord.app.ui.call.CallScreen("v1") {} }
    @Test fun callLight() = shot("call", ThemeMode.Light) { com.linkord.app.ui.call.CallScreen("v1") {} }
    @Test fun emojiPickerDark() = shot("emoji-picker", ThemeMode.Dark) { Picker() }
    @Test fun emojiPickerLight() = shot("emoji-picker", ThemeMode.Light) { Picker() }
    @Test fun moderationDark() = shot("moderation", ThemeMode.Dark) { com.linkord.app.ui.profile.ModerationCard("g1", "2", zelda) }
    @Test fun moderationLight() = shot("moderation", ThemeMode.Light) { com.linkord.app.ui.profile.ModerationCard("g1", "2", zelda) }
    @Test fun serverSettingsDark() = shot("server-settings", ThemeMode.Dark) { com.linkord.app.ui.settings.ServerSettingsScreen("g1") }
    @Test fun serverSettingsLight() = shot("server-settings", ThemeMode.Light) { com.linkord.app.ui.settings.ServerSettingsScreen("g1") }
    @Test fun channelOrderDark() = shot("channel-order", ThemeMode.Dark) { com.linkord.app.ui.settings.ChannelOrderScreen("g1") }

    @Composable
    private fun Picker() {
        val st by session.store.state.collectAsState()
        androidx.compose.foundation.layout.Box(androidx.compose.ui.Modifier.background(com.linkord.designsystem.Linkord.colors.panel)) {
            com.linkord.app.ui.chat.EmojiPicker(st, "g1") {}
        }
    }

    private fun empty(channelId: String, mode: ThemeMode = ThemeMode.Dark) {
        session.store.update { it.copy(messages = it.messages.put(channelId, ChannelMessages(loaded = true, hasMore = false))) }
        shot("empty-$channelId", mode) { ChatScreen(channelId, {}, {}, {}) }
    }

    companion object {
        private val now = Instant.parse("2026-11-15T18:00:00Z")
        private fun at(minAgo: Long) = now.minusSeconds(minAgo * 60).toString()

        val me = User("1", "link", "Link", bio = "Hero of Time", status = "online")
        val zelda = User("2", "zelda", "Zelda", bio = "Princess. Archaeology, **ancient tech** and long walks.", pronouns = "she/her")
        val sheik = User("3", "sheik", "Sheik")
        val kass = User("4", "kass", "Kass", bot = true)

        fun sample(): State {
            val g = Guild(
                id = "g1", name = "Hyrule Castle", ownerId = "1",
                channels = listOf(
                    Channel("cat1", "g1", Kind.CATEGORY, "Kingdom", position = 0),
                    Channel("c1", "g1", Kind.TEXT, "general", position = 0, parentId = "cat1", lastMessageId = "m9"),
                    Channel("c2", "g1", Kind.TEXT, "clips", position = 1, parentId = "cat1", lastMessageId = "x2"),
                    Channel("c3", "g1", Kind.TEXT, "lore", position = 2, parentId = "cat1"),
                    Channel("v1", "g1", Kind.VOICE, "Temple of Time", position = 3, parentId = "cat1"),
                    Channel("v2", "g1", Kind.VOICE, "Lost Woods", position = 4, parentId = "cat1"),
                    Channel("cat2", "g1", Kind.CATEGORY, "Elsewhere", position = 1),
                    Channel("c4", "g1", Kind.TEXT, "kakariko", position = 0, parentId = "cat2"),
                ),
                members = listOf(me, zelda, sheik, kass).map { Member(it, roles = if (it.id == "2") listOf("r1") else emptyList()) },
                roles = listOf(Role("r1", "g1", "Royal Family", color = 0x5B9CF0, position = 1)),
                emojis = listOf(Emoji("42", "g1", "triforce")),
            )
            var st = State(connection = Connection.Open, ready = true, sessionId = "s", me = me).putUser(me)
            st = st.addGuild(g)
            st = st.addGuild(Guild(id = "g2", name = "Gerudo Valley", ownerId = "2", channels = listOf(Channel("d1", "g2", Kind.TEXT, "desert", lastMessageId = "z"))))
            st = st.addDm(Channel("dm1", null, Kind.DM, recipients = listOf(me, zelda), lastMessageId = "q"))
            st = st.addDm(Channel("dm2", null, Kind.DM, recipients = listOf(me, sheik)))
            val msgs = listOf(
                Message("m1", channelId = "c1", author = zelda, content = "Did anyone see the **Master Sword** room after the update?", createdAt = at(45)),
                Message("m2", channelId = "c1", author = zelda, content = "It's _glowing_ now. ||spoiler: it talks||", createdAt = at(44), reactions = listOf(Reaction("👀", listOf("1", "3")), Reaction("🔥", listOf("3")))),
                Message("m3", channelId = "c1", author = me, content = "On my way <:triforce:42> — save me a spot", createdAt = at(30), replyTo = "m1", referencedMessage = MessageRef("m1", zelda, "Did anyone see the **Master Sword** room after the update?")),
                Message("m4", channelId = "c1", author = sheik, content = "> the sword talks\nit always did, you just never listened\n\n- bring a lantern\n- bring `deku nuts`", createdAt = at(12)),
                Message("m5", channelId = "c1", author = kass, content = "**Now playing:** [Gerudo Valley](<https://www.youtube.com/watch?v=abc>) `3:09`", createdAt = at(10),
                    embeds = listOf(Embed(type = "rich", title = "Now playing", description = "Gerudo Valley · Koji Kondo", color = 0xECE8E1, footer = "Queued by Link"))),
                Message("m6", channelId = "c1", author = zelda, content = "<@1> check this out https://zelda.example/temple", createdAt = at(3),
                    embeds = listOf(Embed(url = "https://zelda.example/temple", siteName = "Hyrule Historia", title = "The Temple of Time, restored", description = "A look at the restoration of the temple's stained glass, piece by piece."))),
                Message("m7", channelId = "c1", author = zelda, content = "", createdAt = at(2), attachments = listOf(Attachment("a1", "temple-map.pdf", "/uploads/x", 482_133, "application/pdf"))),
                Message("m8", channelId = "c1", author = me, content = "🎉🎉", createdAt = at(1)),
            )
            st = st.copy(
                messages = persistentMapOf("c1" to ChannelMessages(msgs.toPersistentList(), loaded = true, hasMore = false)),
                selected = persistentMapOf("g1" to "c1"),
                view = "g1",
                presences = mapOf("1" to "online", "2" to "online", "3" to "idle", "4" to "online").toPersistentMap(),
                readStates = mapOf("c1" to "m9", "c3" to "x").toPersistentMap(),
                mentions = mapOf("c2" to 2, "dm1" to 1).toPersistentMap(),
                relationships = mapOf("2" to Rel.FRIEND, "3" to Rel.INCOMING).toPersistentMap(),
                voice = mapOf(
                    "2" to VoiceState("2", "g1", "v1"),
                    "3" to VoiceState("3", "g1", "v1", selfMute = true),
                    "4" to VoiceState("4", "g1", "v1", selfStream = true),
                ).toPersistentMap(),
                typing = persistentMapOf("c1" to persistentMapOf("3" to Long.MAX_VALUE)),
            )
            return st
        }
    }
}
