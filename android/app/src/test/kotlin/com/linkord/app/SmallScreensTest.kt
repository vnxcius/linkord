package com.linkord.app

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import com.github.takahirom.roborazzi.captureRoboImage
import com.linkord.app.ui.LocalNav
import com.linkord.app.ui.Navigator
import com.linkord.app.ui.chat.ChatScreen
import com.linkord.app.ui.chat.InviteCardContent
import com.linkord.app.ui.home.HomePane
import com.linkord.app.ui.home.Tab
import com.linkord.app.ui.profile.ProfileScreen
import com.linkord.core.GuildInfo
import com.linkord.core.InvitePreview
import com.linkord.designsystem.Linkord
import com.linkord.designsystem.LinkordTheme
import com.linkord.designsystem.ThemeMode
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The screens on a small phone: 320dp wide, in Portuguese (longer than English) with the font a size up, saved to
 * app/build/screens/small-*. Rows that squeeze their text (a word broken a letter per line) show up here.
 * Run: ./gradlew :app:testDebugUnitTest --tests '*SmallScreensTest*'
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "pt-rBR-w320dp-h640dp-xhdpi", fontScale = 1.15f)
class SmallScreensTest {
    @get:Rule val compose = createComposeRule()
    private val session get() = ApplicationProvider.getApplicationContext<LinkordApp>().session

    @Before
    fun seed() = session.store.update { ScreensTest.sample() }

    private fun shot(name: String, content: @Composable () -> Unit) {
        compose.setContent {
            LinkordTheme(ThemeMode.Dark) { CompositionLocalProvider(LocalNav provides Navigator()) { content() } }
        }
        compose.waitForIdle()
        compose.onRoot().captureRoboImage("build/screens/small-$name.png")
    }

    @Test fun chat() = shot("chat") { ChatScreen("c1", {}, {}, {}) }
    @Test fun servers() = shot("servers") { HomePane(Tab.Home, {}, {}) }
    @Test fun messages() = shot("messages") { HomePane(Tab.Messages, {}, {}) }
    @Test fun you() = shot("you") { HomePane(Tab.You, {}, {}) }
    @Test fun profile() = shot("profile") { ProfileScreen("2", "g1") }
    @Test fun call() = shot("call") { com.linkord.app.ui.call.CallScreen("v1") {} }
    @Test fun moderation() = shot("moderation") { com.linkord.app.ui.profile.ModerationCard("g1", "2", ScreensTest.zelda) }
    @Test fun serverSettings() = shot("server-settings") { com.linkord.app.ui.settings.ServerSettingsScreen("g1") }
    @Test fun channelOrder() = shot("channel-order") { com.linkord.app.ui.settings.ChannelOrderScreen("g1") }
    @Test fun settings() = shot("settings") { com.linkord.app.ui.settings.SettingsScreen() }
    @Test fun appearance() = shot("appearance") { com.linkord.app.ui.settings.AppearanceScreen() }
    @Test fun sessions() = shot("sessions") { com.linkord.app.ui.settings.SessionsScreen() }
    @Test fun addFriend() = shot("add-friend") { com.linkord.app.ui.settings.AddFriendScreen() }
    @Test fun editProfile() = shot("edit-profile") { com.linkord.app.ui.settings.ProfileEditScreen() }
    @Test fun account() = shot("account") { com.linkord.app.ui.settings.AccountScreen() }
    @Test fun voiceSettings() = shot("voice-settings") { com.linkord.app.ui.settings.VoiceSettingsScreen() }
    @Test fun notificationLevels() = shot("notification-levels") { com.linkord.app.ui.settings.NotificationLevelsScreen() }
    @Test fun blocked() = shot("blocked") { com.linkord.app.ui.settings.BlockedScreen() }
    @Test fun kass() = shot("kass") { com.linkord.app.ui.settings.KassScreen() }
    @Test fun roles() = shot("roles") { com.linkord.app.ui.settings.RolesScreen("g1") }
    @Test fun roleEdit() = shot("role-edit") { com.linkord.app.ui.settings.RoleEditScreen("g1", "r1") }
    @Test fun channelPermissions() = shot("channel-permissions") { com.linkord.app.ui.settings.ChannelPermissionsScreen("c1") }
    @Test fun bans() = shot("bans") { com.linkord.app.ui.profile.BansScreen("g1") }
    @Test fun members() = shot("members") { com.linkord.app.ui.chat.MembersScreen("c1") }
    @Test fun pins() = shot("pins") { com.linkord.app.ui.chat.PinsScreen("c1") }
    @Test fun search() = shot("search") { com.linkord.app.ui.chat.SearchScreen("c1") }
    @Test fun joinServer() = shot("join-server") { com.linkord.app.ui.settings.AddServerScreen("") }
    @Test fun stats() = shot("stats") { com.linkord.app.ui.extras.StatsScreen() }
    @Test fun emojiPicker() = shot("emoji-picker") {
        val st by session.store.state.collectAsState()
        com.linkord.app.ui.chat.EmojiPicker(st, "g1") {}
    }

    // The card from the report: a long server name, both counts, and Join / Joined.
    @Test fun invites() = shot("invites") {
        val dream = InvitePreview("abc", GuildInfo("g9", "Dreamworks 🌛 and friends"), memberCount = 10, onlineCount = 3)
        Column(Modifier.background(Linkord.colors.page).padding(horizontal = 56.dp, vertical = 8.dp)) {
            InviteCardContent(dream, loaded = true, mine = false, joined = true, joining = false) {}
            InviteCardContent(dream.copy(memberCount = 12345, onlineCount = 1234), loaded = true, mine = true, joined = false, joining = false) {}
            InviteCardContent(null, loaded = true, mine = false, joined = false, joining = false) {}
        }
    }
}
