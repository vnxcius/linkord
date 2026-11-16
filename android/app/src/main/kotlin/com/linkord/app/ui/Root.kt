package com.linkord.app.ui

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.Crossfade
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import com.linkord.app.R
import com.linkord.app.session
import com.linkord.app.ui.auth.SignInScreen
import com.linkord.app.ui.home.HomeShell
import com.linkord.app.ui.profile.ProfileScreen
import com.linkord.app.ui.settings.AddFriendScreen
import com.linkord.app.ui.settings.AppearanceScreen
import com.linkord.app.ui.settings.SessionsScreen
import com.linkord.app.ui.settings.SettingsScreen
import com.linkord.app.ui.chat.ImageViewer
import com.linkord.app.ui.chat.MembersScreen
import com.linkord.app.ui.chat.PinsScreen
import com.linkord.core.Connection
import com.linkord.core.t
import com.linkord.designsystem.Linkord
import com.linkord.designsystem.LinkordTheme

@Composable
fun LinkordRoot(signInError: String?, openRequest: com.linkord.app.data.AppLink?, onOpened: () -> Unit) {
    val session = LocalContext.current.session
    val theme by session.prefs.theme.collectAsState()
    val signedIn by session.signedIn.collectAsState()
    LinkordTheme(theme) {
        Box(Modifier.fillMaxSize().background(Linkord.colors.desk)) {
            Crossfade(signedIn, label = "signed in") { inside ->
                if (inside) AppShell(openRequest, onOpened) else SignInScreen(signInError)
            }
        }
    }
}

@Composable
private fun AppShell(openRequest: com.linkord.app.data.AppLink?, onOpened: () -> Unit) {
    val session = LocalContext.current.session
    val st by session.store.state.collectAsState()
    val nav = remember { Navigator() }
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(Unit) { session.toasts.collect { snackbar.showSnackbar(it) } }

    // Notifications need asking on Android 13+; asked once, the first time the app is open and signed in.
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    LaunchedEffect(Unit) { if (Build.VERSION.SDK_INT >= 33) ask.launch(Manifest.permission.POST_NOTIFICATIONS) }

    CompositionLocalProvider(LocalNav provides nav) {
        Box(Modifier.fillMaxSize()) {
            if (!st.ready) Connecting(st.connection)
            else ScreenStack(
                nav,
                base = { HomeShell(openRequest, onOpened) },
                screen = { s ->
                    when (s) {
                        is Screen.Profile -> ProfileScreen(s.userId, s.guildId)
                        Screen.Settings -> SettingsScreen()
                        Screen.Sessions -> SessionsScreen()
                        Screen.Appearance -> AppearanceScreen()
                        Screen.EditProfile -> com.linkord.app.ui.settings.ProfileEditScreen()
                        Screen.Account -> com.linkord.app.ui.settings.AccountScreen()
                        Screen.VoiceSettings -> com.linkord.app.ui.settings.VoiceSettingsScreen()
                        Screen.NotificationLevels -> com.linkord.app.ui.settings.NotificationLevelsScreen()
                        Screen.Blocked -> com.linkord.app.ui.settings.BlockedScreen()
                        Screen.Kass -> com.linkord.app.ui.settings.KassScreen()
                        Screen.SharedClips -> com.linkord.app.ui.extras.SharedClipsScreen()
                        Screen.Stats -> com.linkord.app.ui.extras.StatsScreen()
                        is Screen.ServerSettings -> com.linkord.app.ui.settings.ServerSettingsScreen(s.guildId)
                        is Screen.Roles -> com.linkord.app.ui.settings.RolesScreen(s.guildId)
                        is Screen.RoleEdit -> com.linkord.app.ui.settings.RoleEditScreen(s.guildId, s.roleId)
                        is Screen.ChannelPermissions -> com.linkord.app.ui.settings.ChannelPermissionsScreen(s.channelId)
                        is Screen.Image -> ImageViewer(s.url, s.name)
                        is Screen.Video -> com.linkord.app.ui.chat.VideoViewer(s.url, s.name)
                        is Screen.Pins -> PinsScreen(s.channelId)
                        is Screen.Search -> com.linkord.app.ui.chat.SearchScreen(s.channelId)
                        is Screen.Call -> com.linkord.app.ui.call.CallScreen(s.channelId, onOpenChat = { nav.openChat(it) })
                        is Screen.Members -> MembersScreen(s.channelId)
                        Screen.AddFriend -> AddFriendScreen()
                        is Screen.JoinServer -> com.linkord.app.ui.settings.AddServerScreen(s.code)
                    }
                },
            )
            AnimatedVisibility(st.ready && st.connection == Connection.Reconnecting, enter = fadeIn(), exit = fadeOut(), modifier = Modifier.align(Alignment.TopCenter)) {
                Box(Modifier.fillMaxWidth().background(Linkord.colors.raised2).statusBarsPadding().padding(vertical = 4.dp), contentAlignment = Alignment.Center) {
                    Text(t("Reconnecting…"), style = Linkord.type.label, color = Linkord.colors.text2)
                }
            }
            var welcome by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(!session.prefs.welcomed) }
            if (st.ready && welcome) Welcome { welcome = false; session.prefs.welcomed = true }
            if (st.ready) com.linkord.app.ui.call.IncomingCall(Modifier.align(Alignment.TopCenter).statusBarsPadding())
            // Answer on the incoming call notification: join once connected (asking for the mic if needed), show the call.
            val answer by session.calls.answer.collectAsState()
            val join = com.linkord.app.ui.call.rememberJoin()
            androidx.compose.runtime.LaunchedEffect(answer, st.ready) {
                val ch = answer ?: return@LaunchedEffect
                if (!st.ready) return@LaunchedEffect
                session.calls.answer.value = null
                join(ch)
                nav.push(Screen.Call(ch))
            }
            SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).padding(bottom = 96.dp))
        }
    }
}

/** Before READY: the emblem on the desk, and a word if it's taking a while. */
@Composable
private fun Connecting(c: Connection) {
    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Image(painterResource(R.drawable.emblem), contentDescription = null, modifier = Modifier.size(72.dp))
        Text(
            if (c == Connection.Reconnecting) t("Connection lost — reconnecting…") else t("Opening the gate…"),
            style = Linkord.type.label, color = Linkord.colors.text3, modifier = Modifier.padding(top = 16.dp),
        )
    }
}
