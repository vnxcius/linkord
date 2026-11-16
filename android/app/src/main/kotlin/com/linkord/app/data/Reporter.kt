package com.linkord.app.data

import com.linkord.app.BuildConfig
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Sends this app's errors to the server's log (POST /api/logs/client, read in the monitor), like the web client's
 * lib/report.ts: at most 15 a minute, the same one once a minute. Never tokens or message contents; the server
 * redacts ids and secrets too.
 */
class Reporter(private val session: Session) {
    private val client = "${BuildConfig.VERSION_NAME} android ${android.os.Build.VERSION.RELEASE}"
    private var sent = 0
    private var windowStart = System.currentTimeMillis()
    private val recent = HashSet<String>()

    @Synchronized
    fun report(level: String, message: String, error: Throwable? = null, context: String? = null) {
        if (session.vault.get() == null) return
        val now = System.currentTimeMillis()
        if (now - windowStart > 60_000) {
            windowStart = now
            sent = 0
            recent.clear()
        }
        val key = "$level:$message"
        if (sent >= 15 || key in recent) return
        sent++
        recent += key
        val ctx = error?.let { "${it::class.java.simpleName}: ${it.message}\n${it.stackTraceToString().take(1800)}" } ?: context
        session.scope.launch {
            runCatching {
                session.api.send("POST", "/logs/client", mapOf("level" to level, "message" to message.take(1000), "context" to ctx?.take(2000), "client" to client))
            }
        }
    }

    /** Uncaught exceptions: reported (best effort) before the default handler ends the process. */
    fun install() {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { t, e ->
            runCatching { reportBlocking(e) }
            previous?.uncaughtException(t, e)
        }
    }

    private fun reportBlocking(e: Throwable) {
        val token = session.vault.get() ?: return
        val body = com.linkord.core.toJson(
            mapOf("level" to "error", "message" to "Crash: ${e::class.java.simpleName}: ${e.message}".take(1000), "context" to e.stackTraceToString().take(2000), "client" to client),
        ).toString()
        val req = okhttp3.Request.Builder().url("${session.serverUrl()}/api/logs/client")
            .header("Authorization", "Bearer $token")
            .post(body.toRequestBody("application/json".toMediaType()))
            .build()
        val call = session.http.newBuilder().callTimeout(3, java.util.concurrent.TimeUnit.SECONDS).build().newCall(req)
        val th = Thread { runCatching { call.execute().close() } }
        th.start()
        th.join(3000)
    }

}
