package com.linkord.app.data

import android.content.Context
import android.os.Build
import com.linkord.app.BuildConfig
import com.linkord.core.Api
import com.linkord.core.ApiException
import com.linkord.core.Gateway
import com.linkord.core.I18n
import com.linkord.core.Store
import com.linkord.core.await
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * Everything one signed-in app needs, made once per process: HTTP, the REST client, the store, the gateway, and
 * the token. The UI reads [store] and calls [actions].
 */
class Session(val context: Context) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    val prefs = Prefs(context)
    val vault = TokenVault(context)

    val userAgent = "Linkord/${BuildConfig.VERSION_NAME} (Android ${Build.VERSION.RELEASE}; ${Build.MODEL})"

    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        // The gateway answers the server's pings; this keeps a dead connection from looking alive for long.
        .pingInterval(25, TimeUnit.SECONDS)
        .addInterceptor { chain -> chain.proceed(chain.request().newBuilder().header("User-Agent", userAgent).build()) }
        .build()

    /** This launch only: the direct address when the usual one is unreachable (api.ts pickReachableServer). */
    @Volatile private var fallback: String? = null

    val defaultServer: String = BuildConfig.DEFAULT_SERVER
    val directServer: String = BuildConfig.DIRECT_SERVER

    fun serverUrl(): String = fallback ?: prefs.server.ifBlank { defaultServer }

    /** Every address this server is or was known by (to recognize its invite and message links). */
    fun knownServers(): List<String> =
        (listOf(serverUrl(), defaultServer, directServer) + BuildConfig.FORMER_SERVERS.split(',')).map { it.trim() }.filter { it.isNotEmpty() }.distinct()

    val store = Store()
    val api = Api(http, ::serverUrl, vault::get)

    private val _signedIn = MutableStateFlow(vault.get() != null)
    val signedIn: StateFlow<Boolean> = _signedIn

    val reporter = Reporter(this)
    val notifier by lazy { Notifier(this) }

    val gateway = Gateway(
        http = http,
        store = store,
        scope = scope,
        baseUrl = ::serverUrl,
        token = vault::get,
        onEvent = { t, d -> events.onEvent(t, d) },
        onSignedOut = { signedOut() },
        onError = { msg, e -> reporter.report("error", msg, e) },
    )

    val actions = Actions(this)
    val calls by lazy { Calls(this) }
    val updater by lazy { Updater(this) }
    val push by lazy { Push(this) }
    val events = Events(this)

    /** Short messages for the person (a failed request): the UI shows them as a snackbar. */
    private val _toasts = kotlinx.coroutines.flow.MutableSharedFlow<String>(extraBufferCapacity = 8)
    val toasts: kotlinx.coroutines.flow.SharedFlow<String> = _toasts
    fun toast(text: String) {
        _toasts.tryEmit(text)
    }

    init {
        loadLanguage()
        store.onAlert = { notifier.alert(it) }
        store.onRelationship = { id, before, after -> notifier.relationship(id, before, after) }
    }

    /** The UI language follows the app's locale (Android's per-app language, or the system's). */
    fun loadLanguage() {
        val locale = context.resources.configuration.locales[0]
        val pt = locale.language == "pt"
        I18n.load(if (pt) "pt-BR" else "en", if (pt) runCatching { context.assets.open("i18n/pt-BR.json").bufferedReader().readText() }.getOrNull() else null)
    }

    /** At launch and after signing in: pick the address, then connect. */
    fun start() {
        if (vault.get() == null) return
        scope.launch {
            pickReachableServer()
            gateway.connect()
        }
    }

    private suspend fun reachable(base: String): Boolean = withTimeoutOrNull(6000) {
        runCatching { http.newCall(Request.Builder().url("$base/api/health").build()).await().use { it.isSuccessful } }.getOrDefault(false)
    } ?: false

    /** If linkord.app doesn't answer but the direct address does (an ISP blocking Cloudflare), use that for now. */
    private suspend fun pickReachableServer() {
        val usual = prefs.server.ifBlank { defaultServer }
        if (directServer.isBlank() || usual != defaultServer) return
        val main = scope.async(Dispatchers.IO) { reachable(usual) }
        val alt = scope.async(Dispatchers.IO) { reachable(directServer) }
        if (main.await()) return
        if (alt.await()) fallback = directServer
    }

    fun signIn(token: String) {
        vault.set(token)
        _signedIn.value = true
        start()
    }

    /** Signs out here: the server ends the session, everything local goes. */
    fun signOut() {
        scope.launch {
            runCatching { api.send("POST", "/auth/logout") }
            signedOut()
        }
    }

    private fun signedOut() {
        calls.leave()
        gateway.disconnect()
        vault.set(null)
        store.reset()
        notifier.clearAll()
        _signedIn.value = false
    }

    /**
     * A request a sheet or menu fires as it closes: it runs on the session's scope, so closing (which ends the
     * composable's own scope) can't cancel it halfway. A failure is a toast; a cancellation never is.
     */
    fun launch(block: suspend () -> Unit) = scope.launch {
        try {
            block()
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Throwable) {
            toast(describe(e))
        }
    }

    /** A request failed: the server's words in the UI language, or a plain line for network trouble. */
    fun describe(e: Throwable): String = when (e) {
        is ApiException -> I18n.serverError(e.message ?: "")
        is java.io.IOException -> com.linkord.core.t("Couldn't reach the server. Check your internet connection.")
        else -> e.message ?: e.toString()
    }
}
