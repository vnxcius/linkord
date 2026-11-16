package com.linkord.app.data

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import com.linkord.app.BuildConfig
import com.linkord.core.await
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import okhttp3.Request
import java.io.File
import java.security.MessageDigest

@Serializable
data class AndroidUpdate(
    val version: String,
    @SerialName("version_code") val versionCode: Long,
    val notes: String = "",
    val url: String,
    val sha256: String,
    val size: Long? = null,
)

sealed interface UpdateState {
    data object None : UpdateState
    data class Available(val update: AndroidUpdate) : UpdateState
    data class Downloading(val update: AndroidUpdate, val progress: Float) : UpdateState
    /** Android's install screen is up (it asks the person to confirm). */
    data class Installing(val update: AndroidUpdate) : UpdateState
    data class Failed(val update: AndroidUpdate, val reason: String) : UpdateState
}

/**
 * The app updates itself from this server's feed (server api/updates.rs, android.json), like the desktop app: a
 * check at launch, on every gateway READY, when APP_UPDATE says a release went out, and every 6 h; the APK's sha256
 * is checked against the feed, then Android installs it (it also refuses anything not signed with our key). The dev
 * build (Linkord Dev) never updates: the update is the release app.
 */
class Updater(private val session: Session) {
    private val _state = MutableStateFlow<UpdateState>(UpdateState.None)
    val state: StateFlow<UpdateState> = _state

    init {
        session.scope.launch {
            while (true) {
                delay(6 * 3600_000L)
                check()
            }
        }
    }

    fun check() {
        if (BuildConfig.DEBUG) return
        if (_state.value is UpdateState.Downloading || _state.value is UpdateState.Installing) return
        session.scope.launch {
            val abi = android.os.Build.SUPPORTED_ABIS.firstOrNull { it == "arm64-v8a" } ?: return@launch
            val u = runCatching {
                val text = session.api.raw("GET", "/updates/android/$abi/${BuildConfig.VERSION_CODE}")
                if (text.isBlank()) null else session.api.decode<AndroidUpdate>(text)
            }.getOrNull() ?: return@launch
            if (u.versionCode > BuildConfig.VERSION_CODE) _state.value = UpdateState.Available(u)
        }
    }

    fun install(u: AndroidUpdate) {
        session.scope.launch {
            _state.value = UpdateState.Downloading(u, 0f)
            val file = File(session.context.cacheDir, "update.apk")
            val ok = withContext(Dispatchers.IO) {
                runCatching {
                    session.http.newCall(Request.Builder().url(u.url).build()).await().use { res ->
                        if (!res.isSuccessful) error("HTTP ${res.code}")
                        val total = res.body.contentLength().takeIf { it > 0 } ?: u.size ?: -1
                        val digest = MessageDigest.getInstance("SHA-256")
                        res.body.byteStream().use { input ->
                            file.outputStream().use { out ->
                                val buf = ByteArray(64 * 1024)
                                var done = 0L
                                while (true) {
                                    val n = input.read(buf)
                                    if (n < 0) break
                                    out.write(buf, 0, n)
                                    digest.update(buf, 0, n)
                                    done += n
                                    if (total > 0) _state.value = UpdateState.Downloading(u, done.toFloat() / total)
                                }
                            }
                        }
                        digest.digest().joinToString("") { "%02x".format(it) }.equals(u.sha256, ignoreCase = true)
                    }
                }.getOrDefault(false)
            }
            if (!ok) {
                file.delete()
                _state.value = UpdateState.Failed(u, com.linkord.core.t("The download didn't complete. Try again."))
                return@launch
            }
            withContext(Dispatchers.IO) { commit(file) }
            _state.value = UpdateState.Installing(u)
        }
    }

    private fun commit(apk: File) {
        val installer = session.context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(session.context.packageName)
        params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        val id = installer.createSession(params)
        installer.openSession(id).use { s ->
            s.openWrite("linkord.apk", 0, apk.length()).use { out -> apk.inputStream().use { it.copyTo(out) }; s.fsync(out) }
            val intent = Intent(session.context, InstallResult::class.java)
            val pi = PendingIntent.getBroadcast(session.context, id, intent, PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            s.commit(pi.intentSender)
        }
    }

    fun dismiss() {
        _state.value = UpdateState.None
    }

    /** Android's answer: if it needs the person to confirm, show its screen; failures go back to the banner. */
    class InstallResult : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
                PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                    @Suppress("DEPRECATION")
                    val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT) ?: return
                    context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }
                PackageInstaller.STATUS_SUCCESS -> {}
                else -> {
                    val s = (context.applicationContext as com.linkord.app.LinkordApp).session
                    val st = s.updater.state.value
                    val u = (st as? UpdateState.Installing)?.update ?: return
                    s.updater.fail(u, intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "")
                }
            }
        }
    }

    internal fun fail(u: AndroidUpdate, why: String) {
        _state.value = UpdateState.Failed(u, why.ifEmpty { com.linkord.core.t("The update couldn't be installed.") })
    }
}
