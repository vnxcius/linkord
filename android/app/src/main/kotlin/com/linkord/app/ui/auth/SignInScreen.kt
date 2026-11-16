package com.linkord.app.ui.auth

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.linkord.app.BuildConfig
import com.linkord.app.R
import com.linkord.app.data.DiscordSignIn
import com.linkord.app.session
import com.linkord.core.AuthConfig
import com.linkord.core.LinkordJson
import com.linkord.core.await
import com.linkord.core.t
import com.linkord.designsystem.Linkord
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.Request

/** Signing in: Discord is the only way (dev login too in debug builds, against a local server). */
@Composable
fun SignInScreen(error: String?) {
    val ctx = LocalContext.current
    val session = ctx.session
    val c = Linkord.colors
    val scope = rememberCoroutineScope()
    var config by remember { mutableStateOf<AuthConfig?>(null) }
    var problem by remember { mutableStateOf(error) }
    var busy by remember { mutableStateOf(false) }
    var server by remember { mutableStateOf(session.prefs.server) }
    var showServer by remember { mutableStateOf(false) }
    var devName by remember { mutableStateOf("") }

    suspend fun check() {
        config = null
        val base = session.serverUrl()
        config = withContext(Dispatchers.IO) {
            runCatching {
                session.http.newCall(Request.Builder().url("$base/api/auth/config").build()).await().use {
                    LinkordJson.decodeFromString(AuthConfig.serializer(), it.body.string())
                }
            }.onFailure { problem = t("Couldn't connect to {host}. Check the address and your internet.", "host" to base.substringAfter("://")) }.getOrNull()
        }
    }
    LaunchedEffect(Unit) { check() }

    fun devLogin() = scope.launch {
        busy = true
        runCatching {
            val res = session.api.post<kotlinx.serialization.json.JsonObject>("/auth/dev", mapOf("username" to devName))
            (res["token"] as kotlinx.serialization.json.JsonPrimitive).content
        }.onSuccess { session.signIn(it) }.onFailure { problem = session.describe(it) }
        busy = false
    }

    Box(Modifier.fillMaxSize().background(c.desk).statusBarsPadding().navigationBarsPadding().imePadding(), contentAlignment = Alignment.Center) {
        Column(
            Modifier.widthIn(max = 420.dp).fillMaxWidth().verticalScroll(rememberScrollState()).padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Image(painterResource(R.drawable.emblem), contentDescription = "Linkord", modifier = Modifier.size(88.dp))
            Text("Linkord", style = Linkord.type.display.copy(fontSize = Linkord.type.display.fontSize * 1.4f))
            Text(t("Your servers, your friends, your calls."), style = Linkord.type.small, color = c.text2, textAlign = TextAlign.Center)
            Spacer(Modifier.height(12.dp))
            Button(
                onClick = {
                    problem = null
                    DiscordSignIn.start(ctx, session.serverUrl(), c.desk.toArgb())
                },
                enabled = config?.discord != false && !busy,
                modifier = Modifier.fillMaxWidth().height(52.dp),
                shape = RoundedCornerShape(14.dp),
                colors = ButtonDefaults.buttonColors(containerColor = c.brand, contentColor = c.onBrand),
            ) { Text(t("Sign in with Discord"), style = Linkord.type.bodyStrong.copy(color = c.onBrand)) }
            if (config?.discord == false) Text(t("This server has no Discord sign-in set up."), style = Linkord.type.small, color = c.text3)

            if (config?.devLogin == true) {
                OutlinedTextField(
                    devName, { devName = it.lowercase().trim() },
                    label = { Text(t("Username (dev login)")) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go, autoCorrectEnabled = false, keyboardType = androidx.compose.ui.text.input.KeyboardType.Ascii, capitalization = androidx.compose.ui.text.input.KeyboardCapitalization.None),
                    keyboardActions = KeyboardActions(onGo = { devLogin() }),
                )
                TextButton(onClick = { devLogin() }, enabled = devName.length >= 2 && !busy) {
                    Text(t("Dev login"))
                }
            }

            AnimatedVisibility(problem != null) {
                Text(problem ?: "", color = c.danger, style = Linkord.type.small, textAlign = TextAlign.Center)
            }

            TextButton(onClick = { showServer = !showServer }) {
                Text(t("Server: {host}", "host" to session.serverUrl().substringAfter("://")), style = Linkord.type.label)
            }
            if (showServer) {
                OutlinedTextField(
                    server, { server = it },
                    label = { Text(t("Server address")) },
                    placeholder = { Text(session.defaultServer) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                TextButton(onClick = {
                    session.prefs.server = normalize(server)
                    server = session.prefs.server
                    problem = null
                    scope.launch { check() }
                }) { Text(t("Use this server")) }
            }
            if (BuildConfig.DEBUG) Text("Linkord Dev ${BuildConfig.VERSION_NAME}", style = Linkord.type.label)
        }
    }
}

/** Whatever was typed ("linkord.example.com", an invite link) as the server's origin ('' = the default). */
fun normalize(input: String): String {
    val t = input.trim()
    if (t.isEmpty()) return ""
    val uri = runCatching { java.net.URI(if (Regex("^[a-z][\\w+.-]*://", RegexOption.IGNORE_CASE).containsMatchIn(t)) t else "https://$t") }.getOrNull() ?: return ""
    if (uri.scheme != "http" && uri.scheme != "https" || uri.host == null) return ""
    return "${uri.scheme}://${uri.host}${if (uri.port > 0) ":${uri.port}" else ""}"
}

