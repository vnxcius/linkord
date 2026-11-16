package com.linkord.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.lifecycle.lifecycleScope
import com.linkord.app.data.DiscordSignIn
import com.linkord.app.ui.LinkordRoot
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    /** A sign-in that failed on its way back from the browser, shown on the sign-in screen. */
    private var signInError by mutableStateOf<String?>(null)
    /** Something to open: a notification's channel (and message), or a Linkord link. */
    private var openRequest by mutableStateOf<com.linkord.app.data.AppLink?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.auto(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.auto(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)
        handle(intent)
        setContent {
            if (pip) com.linkord.designsystem.LinkordTheme(session.prefs.theme.value) { com.linkord.app.ui.call.CallPip() }
            else LinkordRoot(signInError = signInError, openRequest = openRequest, onOpened = { openRequest = null })
        }
    }

    /** In picture-in-picture the window shows only the call (CallPip). */
    private var pip by mutableStateOf(false)

    // Leaving the app during a call shrinks it into picture-in-picture, like a phone call.
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (session.calls.channel.value != null) runCatching {
            enterPictureInPictureMode(android.app.PictureInPictureParams.Builder().setAspectRatio(android.util.Rational(16, 9)).build())
        }
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: android.content.res.Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        pip = isInPictureInPictureMode
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    private fun handle(intent: Intent?) {
        intent ?: return
        intent.getStringExtra(EXTRA_CHANNEL)?.let { openRequest = com.linkord.app.data.AppLink.Channel("", it, intent.getStringExtra(EXTRA_MESSAGE)) }
        val uri = intent.data ?: return
        if (uri.scheme == "https") {
            com.linkord.app.data.Links.parse(uri.toString(), session.knownServers())?.let { openRequest = it }
            return
        }
        if (uri.scheme != DiscordSignIn.scheme) return
        val (code, verifier) = DiscordSignIn.finish(this, uri) ?: run {
            signInError = com.linkord.core.t("This login link expired. Please try again from Linkord.")
            return
        }
        lifecycleScope.launch {
            runCatching {
                val res = session.api.post<kotlinx.serialization.json.JsonObject>("/auth/exchange", mapOf("code" to code, "verifier" to verifier))
                (res["token"] as kotlinx.serialization.json.JsonPrimitive).content
            }.onSuccess {
                signInError = null
                session.signIn(it)
            }.onFailure { signInError = session.describe(it) }
        }
    }

    companion object {
        const val EXTRA_CHANNEL = "channel"
        const val EXTRA_MESSAGE = "message"
    }
}
