package com.linkord.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.linkord.core.dmName
import com.linkord.core.t
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/**
 * Keeps a call going with the screen off or another app in front (a foreground service using the mic), with the
 * call's notification: where you are, Mute and Leave.
 */
class VoiceService : Service() {
    private var watch: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val calls = session.calls
        var types = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
        if (calls.voice.sending.value.contains("camera") || intent?.action == ACTION_CAMERA) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
        when (intent?.action) {
            ACTION_MUTE -> calls.toggleMute()
            ACTION_PROJECTION -> {
                // Android 14+: the service must be a media projection one before the projection is taken.
                types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
                val nm0 = getSystemService(NotificationManager::class.java)
                nm0.createNotificationChannel(NotificationChannel(CHANNEL, t("Voice calls"), NotificationManager.IMPORTANCE_LOW))
                ServiceCompat.startForeground(this, ID, notification(), types)
                @Suppress("DEPRECATION")
                val data = intent.getParcelableExtra<Intent>(EXTRA_DATA)
                val code = intent.getIntExtra(EXTRA_CODE, 0)
                val mpm = getSystemService(android.media.projection.MediaProjectionManager::class.java)
                val projection = data?.let { runCatching { mpm.getMediaProjection(code, it) }.getOrNull() }
                if (projection != null) {
                    val m = resources.displayMetrics
                    calls.voice.startScreen(projection, m.widthPixels, m.heightPixels, m.densityDpi)
                }
                return START_NOT_STICKY
            }
            ACTION_LEAVE -> {
                calls.leave()
                return START_NOT_STICKY
            }
        }
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, t("Voice calls"), NotificationManager.IMPORTANCE_LOW))
        ServiceCompat.startForeground(this, ID, notification(), types)
        if (watch == null) watch = session.scope.launch {
            combine(calls.channel, calls.muted, calls.deafened) { _, _, _ -> }.collect { nm.notify(ID, notification()) }
        }
        return START_NOT_STICKY
    }

    private fun notification(): Notification {
        val calls = session.calls
        val st = session.store.s
        val ch = calls.channel.value?.let { st.channels[it] }
        val where = when {
            ch == null -> t("Voice")
            ch.guildId != null -> "${ch.name} · ${st.guilds[ch.guildId]?.name ?: ""}"
            else -> st.dmName(ch, t("Empty group"))
        }
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE)
        fun action(a: String, code: Int) = PendingIntent.getService(this, code, Intent(this, VoiceService::class.java).setAction(a), PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(t("Voice Connected"))
            .setContentText(where)
            .setOngoing(true)
            .setContentIntent(open)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .addAction(0, if (calls.muted.value) t("Unmute") else t("Mute"), action(ACTION_MUTE, 1))
            .addAction(0, t("Disconnect"), action(ACTION_LEAVE, 2))
            .build()
    }

    override fun onDestroy() {
        watch?.cancel()
        super.onDestroy()
    }

    companion object {
        const val CHANNEL = "voice"
        const val ID = 7700
        const val ACTION_MUTE = "com.linkord.app.MUTE"
        const val ACTION_LEAVE = "com.linkord.app.LEAVE"
        const val ACTION_PROJECTION = "com.linkord.app.PROJECTION"
        const val ACTION_CAMERA = "com.linkord.app.CAMERA"
        const val EXTRA_CODE = "code"
        const val EXTRA_DATA = "data"
    }
}
