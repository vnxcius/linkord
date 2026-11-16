package com.linkord.app.data

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.content.ContextCompat
import com.linkord.app.MainActivity
import com.linkord.app.R
import com.linkord.core.Alert
import com.linkord.core.Kind
import com.linkord.core.Markdown
import com.linkord.core.nameOf
import com.linkord.core.t

/**
 * Notifications: from the gateway while the app runs ([alert]) and from FCM while it's closed ([push], data/Push.kt).
 * Both stack into the conversation's one notification (a message seen from both is added once). Channels per kind, grouped per
 * conversation, cleared when the conversation is read here.
 */
class Notifier(private val session: Session) {
    private val ctx: Context get() = session.context
    private val nm = NotificationManagerCompat.from(session.context)

    init {
        val m = ctx.getSystemService(NotificationManager::class.java)
        m.createNotificationChannels(
            listOf(
                NotificationChannel(DMS, t("Direct messages"), NotificationManager.IMPORTANCE_HIGH),
                NotificationChannel(MENTIONS, t("Mentions and replies"), NotificationManager.IMPORTANCE_HIGH),
                NotificationChannel(MESSAGES, t("Other messages"), NotificationManager.IMPORTANCE_DEFAULT),
                NotificationChannel(CALLS, t("Calls"), NotificationManager.IMPORTANCE_HIGH),
            ),
        )
    }

    private fun allowed() = Build.VERSION.SDK_INT < 33 ||
        ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    /** Message ids already shown, so one that arrives from both the gateway and FCM is stacked once. */
    private val shown = object : LinkedHashMap<String, Unit>(64, 0.75f, false) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Unit>?) = size > 200
    }

    fun alert(a: Alert) {
        if (!allowed() || session.gateway.foreground && session.actions.viewing.value == a.channel.id) return
        val st = session.store.s
        val ch = a.channel
        val m = a.message
        val author = st.nameOf(m.author.id, ch.guildId, t("Unknown"))
        val body = Markdown.unescape(Markdown.esc(m.content))
            .replace(Regex("<@&?(\\d+)>")) { "@" + st.nameOf(it.groupValues[1], ch.guildId, t("Unknown")) }
            .replace(Regex("<a?:(\\w+):\\d+>"), ":$1:")
            .ifEmpty { if (m.forwarded != null) t("Forwarded a message") else t("Sent an attachment") }
            .take(200)
        val conversation = when {
            ch.guildId != null -> "#${ch.name} · ${st.guilds[ch.guildId]?.name ?: ""}"
            ch.kind == Kind.GROUP_DM -> ch.name.ifBlank { null }
            else -> null
        }
        message(
            channelId = ch.id,
            kind = when {
                Kind.isPrivate(ch.kind) -> DMS
                a.mentioned -> MENTIONS
                else -> MESSAGES
            },
            conversation = conversation,
            group = ch.kind != Kind.DM,
            author = author,
            authorId = m.author.id,
            text = body,
            messageId = m.id,
        )
    }

    /** A notification the server wrote (push.rs payload: title, body, channel_id, message_id?, author?, conversation?, call?). */
    @android.annotation.SuppressLint("MissingPermission")
    fun push(note: org.json.JSONObject) {
        if (!allowed()) return
        val channelId = note.optString("channel_id").ifEmpty { return }
        if (session.gateway.foreground && session.actions.viewing.value == channelId) return
        val body = note.optString("body")
        if (!note.optBoolean("call")) {
            // A server older than the stacking has no author/conversation: its title stands in for the author.
            val author = note.optString("author").ifEmpty { note.optString("title") }
            val conversation = note.optString("conversation").takeIf { !note.isNull("conversation") && it.isNotEmpty() }
            message(
                channelId = channelId,
                kind = when {
                    note.optBoolean("private") -> DMS
                    note.optBoolean("mentioned") -> MENTIONS
                    else -> MESSAGES
                },
                conversation = conversation,
                group = conversation != null,
                author = author,
                authorId = note.optString("author_id").ifEmpty { author },
                text = body,
                messageId = note.optString("message_id").ifEmpty { null },
            )
            return
        }
        val id = "call-$channelId".hashCode()
        val n = NotificationCompat.Builder(ctx, CALLS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(note.optString("title"))
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(open(channelId, null, id))
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setTimeoutAfter(60_000)
            .build()
        runCatching { nm.notify(id, n) }
    }

    private fun open(channelId: String, messageId: String?, requestCode: Int): PendingIntent {
        val intent = Intent(ctx, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            putExtra(MainActivity.EXTRA_CHANNEL, channelId)
            messageId?.let { putExtra(MainActivity.EXTRA_MESSAGE, it) }
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        return PendingIntent.getActivity(ctx, requestCode, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    /**
     * One notification per conversation, its recent messages stacked (MessagingStyle, last [KEEP]). The messages so far
     * come from the notification on screen, so a process FCM just started continues the stack the last one left.
     */
    @android.annotation.SuppressLint("MissingPermission")
    private fun message(
        channelId: String,
        kind: String,
        conversation: String?,
        group: Boolean,
        author: String,
        authorId: String,
        text: String,
        messageId: String?,
    ) {
        if (messageId != null && shown.put(messageId, Unit) != null) return
        val id = channelId.hashCode()
        val showing = runCatching { nm.activeNotifications.firstOrNull { it.id == id && it.tag == null }?.notification }.getOrNull()
        val style = showing?.let { NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(it) }
            ?: NotificationCompat.MessagingStyle(Person.Builder().setName(t("You")).setKey(session.store.s.me?.id ?: "me").build())
        style.conversationTitle = conversation
        style.isGroupConversation = group
        style.addMessage(text, System.currentTimeMillis(), Person.Builder().setName(author).setKey(authorId).build())
        while (style.messages.size > KEEP) style.messages.removeAt(0)
        // A conversation that was a mention keeps alerting like one even if the next message is a plain one.
        val channel = if (showing != null && kind == MESSAGES && showing.channelId != MESSAGES) showing.channelId else kind
        val n = NotificationCompat.Builder(ctx, channel)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(conversation ?: author)
            .setContentText(text)
            .setStyle(style)
            .setNumber(style.messages.size)
            .setGroup(channelId)
            .setAutoCancel(true)
            .setContentIntent(open(channelId, messageId, id))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .build()
        runCatching { nm.notify(id, n) }
    }

    fun clearChannel(channelId: String) = nm.cancel(channelId.hashCode())

    /** The pushed "is calling you" for a DM call that stopped ringing us (answered, declined, hung up). */
    fun clearCall(channelId: String) = nm.cancel("call-$channelId".hashCode())

    fun clearAll() = nm.cancelAll()

    companion object {
        const val DMS = "dms"
        const val MENTIONS = "mentions"
        const val MESSAGES = "messages"
        const val CALLS = "calls"
        /** Messages a conversation's notification keeps. */
        const val KEEP = 8
    }
}
