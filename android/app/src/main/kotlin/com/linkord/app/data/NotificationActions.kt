package com.linkord.app.data

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.RemoteInput
import com.linkord.app.session
import com.linkord.core.Message
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The buttons on Linkord's notifications that work without opening the app: Reply (typed in the shade), Mark as read,
 * and Decline on an incoming call. They run in whatever process the tap starts (often a closed app's fresh one, with
 * no gateway), so each is one plain request with the saved token; goAsync keeps the process up until it's done.
 */
class NotificationActions : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val session = context.session
        val channelId = intent.getStringExtra(EXTRA_CHANNEL) ?: return
        val messageId = intent.getStringExtra(EXTRA_MESSAGE)
        val done = goAsync()
        session.scope.launch {
            try {
                when (intent.action) {
                    DECLINE -> {
                        session.notifier.clearCall(channelId)
                        session.calls.decline(channelId)
                    }
                    READ -> {
                        session.notifier.clearChannel(channelId)
                        if (messageId != null) runCatching { session.api.send("POST", "/channels/$channelId/ack", mapOf("message_id" to messageId)) }
                    }
                    REPLY -> {
                        val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(KEY_TEXT)?.toString()?.trim().orEmpty()
                        if (text.isEmpty()) return@launch
                        runCatching {
                            val body = buildJsonObject {
                                put("content", text)
                                put("nonce", System.nanoTime().toString())
                            }
                            val sent = session.api.decode<Message>(session.api.raw("POST", "/channels/$channelId/messages", session.api.jsonBody(body)))
                            // Answering is reading: the conversation is read up to your reply.
                            runCatching { session.api.send("POST", "/channels/$channelId/ack", mapOf("message_id" to sent.id)) }
                            sent
                        }.onSuccess { session.notifier.replied(channelId, text, it.id) }
                            .onFailure { session.notifier.replyFailed(channelId) }
                    }
                }
            } finally {
                done.finish()
            }
        }
    }

    companion object {
        const val REPLY = "com.linkord.app.REPLY"
        const val READ = "com.linkord.app.MARK_READ"
        const val DECLINE = "com.linkord.app.DECLINE_CALL"
        const val KEY_TEXT = "text"
        private const val EXTRA_CHANNEL = "channel"
        private const val EXTRA_MESSAGE = "message"

        /** [mutable]: Reply's intent must be, so the system can add the typed text to it. */
        fun intent(ctx: Context, action: String, channelId: String, messageId: String?, request: Int, mutable: Boolean = false): PendingIntent =
            PendingIntent.getBroadcast(
                ctx, request,
                Intent(ctx, NotificationActions::class.java).setAction(action).putExtra(EXTRA_CHANNEL, channelId).putExtra(EXTRA_MESSAGE, messageId),
                (if (mutable) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE) or PendingIntent.FLAG_UPDATE_CURRENT,
            )
    }
}
