package com.linkord.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import kotlin.math.min
import kotlin.random.Random

/**
 * The realtime gateway (server/src/gateway.rs; the web client's lib/gateway.ts). One websocket: `identify` (or
 * `resume` with the session and the last seq) then `{"s","t","d"}` events. Close codes: 4001 = the login ended (sign
 * out here), 4100 = the server is handing over to its next process (reconnect at once and resume, quietly).
 *
 * Events are applied on [scope] (the app passes the main thread), in order.
 */
class Gateway(
    private val http: OkHttpClient,
    private val store: Store,
    private val scope: CoroutineScope,
    private val baseUrl: () -> String,
    private val token: () -> String?,
    /** Called with every event after the store has applied it (APP_UPDATE, calls, etc. are the app's business). */
    private val onEvent: (String, JsonElement) -> Unit = { _, _ -> },
    /** The login is gone (close 4001): sign out. */
    private val onSignedOut: () -> Unit = {},
    private val onError: (String, Throwable) -> Unit = { _, _ -> },
) {
    @Volatile private var ws: WebSocket? = null
    private var retry = 0
    private var stopped = true
    @Volatile private var seq = 0L
    /** Reconnecting after a handover (4100): no "reconnecting" banner unless it takes a while. */
    private var quiet = false
    private var quietJob: Job? = null
    private var reconnectJob: Job? = null
    private var lastActive = 0L
    /** The app is in front (input counts as "in use" for push.rs only then). */
    var foreground = false
        private set

    fun connect() {
        stopped = false
        reconnectJob?.cancel()
        open()
    }

    fun disconnect() {
        stopped = true
        reconnectJob?.cancel()
        ws?.close(1000, null)
        ws = null
        store.setConnection(Connection.Idle)
    }

    /** When the app went to the background (0 = in front). */
    private var hiddenAt = 0L

    /**
     * The app came back to the front. In the background Android blocks a cached app's network, so the socket it had is
     * usually dead (or its retries are stuck behind a long backoff, one maybe hanging on a connect that can't happen)
     * even when it still looks open. After more than a few seconds away, or whenever it isn't open, drop it and resume
     * right now (missed events are replayed), quietly like after a server handover: the "Reconnecting" banner only if it
     * takes longer than that.
     */
    fun wake() {
        if (token() == null) return
        val cameBack = hiddenAt > 0
        val away = if (cameBack) System.currentTimeMillis() - hiddenAt else 0L
        hiddenAt = 0
        // The first start: its connection is already on the way.
        if (!stopped && !cameBack && retry == 0) return
        if (!stopped && store.s.connection == Connection.Open && away < 10_000) return
        val old = ws
        ws = null
        old?.cancel()
        reconnectJob?.cancel()
        retry = 0
        stopped = false
        quiet = true
        quietJob?.cancel()
        quietJob = scope.launch {
            delay(2500)
            quiet = false
            if (store.s.connection != Connection.Open) store.setConnection(Connection.Reconnecting)
        }
        if (store.s.connection == Connection.Reconnecting || store.s.connection == Connection.Idle) store.setConnection(Connection.Connecting)
        open()
    }

    /** Reconnect now if the socket is down (the network came back, the app returned to the front). */
    fun nudge() {
        if (!stopped && ws == null) {
            reconnectJob?.cancel()
            retry = 0
            open()
        }
    }

    private fun open() {
        val tok = token() ?: return
        if (!quiet) store.setConnection(if (retry > 0) Connection.Reconnecting else Connection.Connecting)
        val url = baseUrl().replaceFirst(Regex("^http"), "ws") + "/api/gateway"
        val req = Request.Builder().url(url).build()
        lateinit var sock: WebSocket
        sock = http.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                val st = store.s
                val msg = if (st.sessionId != null && st.ready) {
                    mapOf("op" to "resume", "token" to tok, "session_id" to st.sessionId, "seq" to seq, "client" to CLIENT)
                } else {
                    mapOf("op" to "identify", "token" to tok, "client" to CLIENT)
                }
                webSocket.send(toJson(msg).toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                scope.launch {
                    if (ws !== sock) return@launch
                    val o = runCatching { LinkordJson.parseToJsonElement(text).jsonObject }.getOrNull() ?: return@launch
                    (o["s"] as? JsonPrimitive)?.longOrNull?.let { seq = it }
                    val t = (o["t"] as? JsonPrimitive)?.content ?: return@launch
                    val d = o["d"] ?: JsonNull
                    try {
                        if (t == "READY") seq = 0
                        store.handle(t, d)
                        when (t) {
                            "READY", "RESUMED" -> onConnected()
                        }
                        onEvent(t, d)
                    } catch (e: Throwable) {
                        onError("Gateway event $t failed", e)
                    }
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                scope.launch { closed(sock, code) }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                scope.launch { closed(sock, -1) }
            }
        })
        ws = sock
    }

    private fun onConnected() {
        retry = 0
        quiet = false
        quietJob?.cancel()
        lastActive = 0
        reportActivity(force = true)
    }

    private fun closed(sock: WebSocket, code: Int) {
        if (ws !== sock) return
        ws = null
        if (code == 4001) {
            stopped = true
            store.reset()
            onSignedOut()
            return
        }
        if (stopped) return
        // 4100: the next server process is already listening. Resume right away, without the banner unless it
        // takes more than a couple of seconds.
        if (code == 4100 && !quiet) {
            quiet = true
            retry = 0
            quietJob?.cancel()
            quietJob = scope.launch {
                delay(2500)
                quiet = false
                if (store.s.connection != Connection.Open) store.setConnection(Connection.Reconnecting)
            }
            schedule(50 + Random.nextLong(300))
            return
        }
        if (!quiet) store.setConnection(Connection.Reconnecting)
        val base = min(if (quiet) 1000.0 else 30_000.0, 500.0 * (1 shl min(retry++, 10)))
        schedule((base * (0.75 + Random.nextDouble() * 0.5)).toLong())
    }

    private fun schedule(ms: Long) {
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            delay(ms)
            if (!stopped) open()
        }
    }

    /**
     * Whether Linkord is being used here, so phones only get pushes (server push.rs) when it isn't: `active` on input
     * (at most every 30 s) while in front, `away` as soon as it goes to the background.
     */
    fun reportActivity(force: Boolean = false) {
        val sock = ws ?: return
        if (!foreground) {
            if (lastActive != 0L || force) sock.send("""{"op":"away"}""")
            lastActive = 0
            return
        }
        val now = System.currentTimeMillis()
        if (!force && now - lastActive < 30_000) return
        lastActive = now
        sock.send("""{"op":"active"}""")
    }

    fun setForeground(front: Boolean) {
        if (foreground == front) return
        foreground = front
        if (!front) hiddenAt = System.currentTimeMillis()
        reportActivity(force = true)
    }

    companion object {
        /** Settings -> Sessions shows "Linkord for Android" for this (server accepts it since the Android app). */
        const val CLIENT = "android"
    }
}

