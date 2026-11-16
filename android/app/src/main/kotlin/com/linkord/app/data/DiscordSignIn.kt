package com.linkord.app.data

import android.content.Context
import android.net.Uri
import android.util.Base64
import androidx.browser.customtabs.CustomTabColorSchemeParams
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.content.edit
import com.linkord.app.BuildConfig
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * Discord sign-in for the Android app (server auth.rs, client=android). The start page opens in a Custom Tab (Discord
 * wants a real browser for its sign-in); the server sends the code back to this app's own scheme
 * (`linkord://auth`, `linkord-dev://auth` for the dev build), and only the secret kept here (PKCE verifier) turns it
 * into a session at POST /auth/exchange, so an intercepted link is useless.
 */
object DiscordSignIn {
    val scheme = if (BuildConfig.DEBUG) "linkord-dev" else "linkord"
    private val client = if (BuildConfig.DEBUG) "android-dev" else "android"

    private fun random(bytes: Int): String {
        val b = ByteArray(bytes).also { SecureRandom().nextBytes(it) }
        return Base64.encodeToString(b, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    }

    fun start(context: Context, server: String, toolbar: Int) {
        val state = random(30)
        val verifier = random(48)
        val challenge = Base64.encodeToString(
            MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray()),
            Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP,
        )
        // Kept on disk: the app may be killed while the browser is in front.
        prefs(context).edit { putString("state", state).putString("verifier", verifier).putLong("at", System.currentTimeMillis()) }
        val url = Uri.parse("$server/api/auth/discord/start").buildUpon()
            .appendQueryParameter("client", client)
            .appendQueryParameter("state", state)
            .appendQueryParameter("challenge", challenge)
            .build()
        CustomTabsIntent.Builder()
            .setDefaultColorSchemeParams(CustomTabColorSchemeParams.Builder().setToolbarColor(toolbar).build())
            .setShowTitle(true)
            .build()
            .launchUrl(context, url)
    }

    /** The code from `linkord://auth?code&state`, with the verifier it needs, if it answers our own sign-in. */
    fun finish(context: Context, uri: Uri): Pair<String, String>? {
        if (uri.scheme != scheme || uri.host != "auth") return null
        val p = prefs(context)
        val state = p.getString("state", null)
        val verifier = p.getString("verifier", null)
        val fresh = System.currentTimeMillis() - p.getLong("at", 0) < 10 * 60_000
        p.edit { clear() }
        val code = uri.getQueryParameter("code") ?: return null
        if (state == null || verifier == null || !fresh || uri.getQueryParameter("state") != state) return null
        return code to verifier
    }

    private fun prefs(context: Context) = context.getSharedPreferences("linkord.signin", Context.MODE_PRIVATE)
}
