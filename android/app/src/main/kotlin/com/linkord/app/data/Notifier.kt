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
import com.linkord.core.profileOf
import com.linkord.core.t
import kotlinx.coroutines.launch

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
                NotificationChannel(FRIENDS, t("Friend requests"), NotificationManager.IMPORTANCE_HIGH),
                // Incoming DM calls ring like the phone's own calls: its ringtone, repeating (FLAG_INSISTENT) until
                // answered, declined or 60 s. A new channel: an existing channel's sound can't be changed.
                NotificationChannel(RINGING, t("Incoming calls"), NotificationManager.IMPORTANCE_HIGH).apply {
                    setSound(
                        android.media.RingtoneManager.getDefaultUri(android.media.RingtoneManager.TYPE_RINGTONE),
                        android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                            .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION).build(),
                    )
                    enableVibration(true)
                    vibrationPattern = longArrayOf(0, 800, 800)
                    lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
                },
            ),
        )
        // The first builds' plain "Calls" channel, replaced by RINGING.
        m.deleteNotificationChannel("calls")
    }

    private fun allowed() = Build.VERSION.SDK_INT < 33 ||
        ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    /** Message ids already shown, so one that arrives from both the gateway and FCM is stacked once. */
    private val shown = object : LinkedHashMap<String, Unit>(64, 0.75f, false) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Unit>?) = size > 200
    }

    /** Senders' pictures for their notifications, kept while the app runs. */
    private val avatars = android.util.LruCache<String, android.graphics.Bitmap>(64)
    private val avatarHttp by lazy { session.http.newBuilder().callTimeout(3, java.util.concurrent.TimeUnit.SECONDS).build() }

    /**
     * Someone's picture for a notification, downloaded once (blocking: call it off the main thread). At most 3 s, so a
     * slow network never holds a notification back; without it Android shows their initial.
     */
    private fun avatar(path: String?): android.graphics.Bitmap? {
        if (path.isNullOrEmpty() || path == "/icon.png") return null
        val url = session.api.media(path) ?: path
        avatars.get(url)?.let { return it }
        return runCatching {
            avatarHttp.newCall(okhttp3.Request.Builder().url(url).build()).execute().use { r ->
                if (!r.isSuccessful) null else android.graphics.BitmapFactory.decodeStream(r.body.byteStream())
            }
        }.getOrNull()?.let(::rounded)?.also { avatars.put(url, it) }
    }

    /**
     * The picture in the app's avatar shape (designsystem AvatarShape: a square with 30% corners), transparent around
     * it, so the shade shows it like the app does instead of a hard square.
     */
    private fun rounded(src: android.graphics.Bitmap): android.graphics.Bitmap {
        val side = 192
        val out = android.graphics.Bitmap.createBitmap(side, side, android.graphics.Bitmap.Config.ARGB_8888)
        val canvas = android.graphics.Canvas(out)
        val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG or android.graphics.Paint.FILTER_BITMAP_FLAG)
        val r = side * 0.30f
        canvas.drawRoundRect(0f, 0f, side.toFloat(), side.toFloat(), r, r, paint)
        paint.xfermode = android.graphics.PorterDuffXfermode(android.graphics.PorterDuff.Mode.SRC_IN)
        // Fill the square from the middle of the picture (crop, like ContentScale.Crop).
        val crop = minOf(src.width, src.height)
        val from = android.graphics.Rect((src.width - crop) / 2, (src.height - crop) / 2, (src.width + crop) / 2, (src.height + crop) / 2)
        canvas.drawBitmap(src, from, android.graphics.Rect(0, 0, side, side), paint)
        return out
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
        val picture = st.profileOf(m.author.id, ch.guildId)?.avatar ?: m.author.avatar
        // The gateway calls this on the main thread: the picture is fetched on IO, then the notification goes up.
        session.scope.launch(kotlinx.coroutines.Dispatchers.IO) {
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
                picture = avatar(picture),
            )
        }
    }

    /**
     * A relationship changed (gateway): a new incoming friend request is shown (the app may be in the background with
     * the gateway still up, where the server doesn't push); once it's accepted, declined or cancelled it goes away.
     */
    fun relationship(userId: String, before: Int?, after: Int?) {
        if (after == com.linkord.core.Rel.INCOMING && before != com.linkord.core.Rel.INCOMING) {
            val st = session.store.s
            if (!allowed() || st.me?.status == "dnd") return
            val u = st.users[userId] ?: return
            session.scope.launch(kotlinx.coroutines.Dispatchers.IO) { friendRequest(userId, u.name, t("Sent you a friend request"), avatar(u.avatar)) }
        } else if (after != com.linkord.core.Rel.INCOMING && before == com.linkord.core.Rel.INCOMING) {
            nm.cancel(friendTag(userId), 0)
        }
    }

    /** "Ana: Sent you a friend request", opening their profile (Accept is there). One per person. */
    @android.annotation.SuppressLint("MissingPermission")
    private fun friendRequest(userId: String, name: String, text: String, picture: android.graphics.Bitmap?) {
        val intent = Intent(ctx, MainActivity::class.java).apply {
            putExtra(MainActivity.EXTRA_PROFILE, userId)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val open = PendingIntent.getActivity(ctx, friendTag(userId).hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = NotificationCompat.Builder(ctx, FRIENDS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(name)
            .setContentText(text)
            .apply { picture?.let { setLargeIcon(it) } }
            .setAutoCancel(true)
            .setContentIntent(open)
            .setCategory(NotificationCompat.CATEGORY_SOCIAL)
            .build()
        runCatching { nm.notify(friendTag(userId), 0, n) }
    }

    private fun friendTag(userId: String) = "friend-$userId"

    /** A notification the server wrote (push.rs payload: title, body, channel_id, message_id?, author?, conversation?, call?). */
    @android.annotation.SuppressLint("MissingPermission")
    fun push(note: org.json.JSONObject) {
        // A friend request (push.rs on_friend_request): no conversation behind it.
        if (note.optBoolean("friend_request")) {
            val userId = note.optString("user_id").ifEmpty { return }
            if (!allowed()) return
            return friendRequest(userId, note.optString("title"), note.optString("body"), avatar(note.optString("icon")))
        }
        val channelId = note.optString("channel_id").ifEmpty { return }
        // The call stopped ringing us (push.rs on_ring_end): even a closed app hears it this way.
        if (note.optBoolean("call_end")) return clearCall(channelId)
        if (!allowed()) return
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
                // FCM delivers on its own background thread, so the picture can be fetched right here.
                picture = avatar(note.optString("icon")),
            )
            return
        }
        // In front, the app rings itself (Calls.startRing + the incoming call card).
        if (session.gateway.foreground) return
        val id = "call-$channelId".hashCode()
        val face = avatar(note.optString("icon"))
        val caller = Person.Builder().setName(note.optString("title")).setImportant(true)
            .apply { face?.let { setIcon(androidx.core.graphics.drawable.IconCompat.createWithBitmap(it)) } }.build()
        val activity = { request: Int, extra: String ->
            PendingIntent.getActivity(
                ctx, request,
                Intent(ctx, MainActivity::class.java).putExtra(extra, channelId).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        }
        // Full screen over the lock screen like a phone call (the system shows a heads-up instead while the phone is in use).
        val full = activity(id, MainActivity.EXTRA_INCOMING_CALL)
        val n = NotificationCompat.Builder(ctx, RINGING)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(note.optString("title"))
            .setContentText(body)
            .setLargeIcon(face)
            .setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, NotificationActions.intent(ctx, NotificationActions.DECLINE, channelId, null, id + 2), activity(id + 1, MainActivity.EXTRA_ANSWER_CALL)))
            .setFullScreenIntent(full, true)
            .setContentIntent(full)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setTimeoutAfter(60_000)
            .build()
            .apply { flags = flags or android.app.Notification.FLAG_INSISTENT }
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
    @Synchronized
    private fun message(
        channelId: String,
        kind: String,
        conversation: String?,
        group: Boolean,
        author: String,
        authorId: String,
        text: String,
        messageId: String?,
        picture: android.graphics.Bitmap? = null,
    ) {
        if (messageId != null && shown.put(messageId, Unit) != null) return
        val id = channelId.hashCode()
        val showing = runCatching { nm.activeNotifications.firstOrNull { it.id == id && it.tag == null }?.notification }.getOrNull()
        val style = showing?.let { NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(it) }
            ?: NotificationCompat.MessagingStyle(Person.Builder().setName(t("You")).setKey(session.store.s.me?.id ?: "me").build())
        style.conversationTitle = conversation
        style.isGroupConversation = group
        style.addMessage(
            text, System.currentTimeMillis(),
            Person.Builder().setName(author).setKey(authorId)
                .apply { picture?.let { setIcon(androidx.core.graphics.drawable.IconCompat.createWithBitmap(it)) } }.build(),
        )
        while (style.messages.size > KEEP) style.messages.removeAt(0)
        // A conversation that was a mention keeps alerting like one even if the next message is a plain one.
        val channel = if (showing != null && kind == MESSAGES && showing.channelId != MESSAGES) showing.channelId else kind
        post(channelId, channel, style, conversation ?: author, text, messageId ?: showing?.extras?.getString(EXTRA_LAST), quiet = false, picture = picture)
    }

    /**
     * Your reply from the notification (NotificationActions): it joins the conversation's stack as yours, without a
     * sound, and the Reply box stays for another one.
     */
    @android.annotation.SuppressLint("MissingPermission")
    @Synchronized
    fun replied(channelId: String, text: String, messageId: String?) {
        val showing = runCatching { nm.activeNotifications.firstOrNull { it.id == channelId.hashCode() && it.tag == null }?.notification }.getOrNull() ?: return
        val style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(showing) ?: return
        style.addMessage(text, System.currentTimeMillis(), null as Person?)
        while (style.messages.size > KEEP) style.messages.removeAt(0)
        val title = showing.extras.getCharSequence(NotificationCompat.EXTRA_TITLE)?.toString() ?: ""
        post(channelId, showing.channelId, style, title, text, messageId ?: showing.extras.getString(EXTRA_LAST), quiet = true, keepPicture = showing)
    }

    /** The reply couldn't be sent: say so on the notification itself (the app may not be open to show a toast). */
    @android.annotation.SuppressLint("MissingPermission")
    @Synchronized
    fun replyFailed(channelId: String) {
        val showing = runCatching { nm.activeNotifications.firstOrNull { it.id == channelId.hashCode() && it.tag == null }?.notification }.getOrNull() ?: return
        val style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(showing) ?: return
        style.addMessage(t("Your reply couldn't be sent."), System.currentTimeMillis(), null as Person?)
        val title = showing.extras.getCharSequence(NotificationCompat.EXTRA_TITLE)?.toString() ?: ""
        post(channelId, showing.channelId, style, title, "", showing.extras.getString(EXTRA_LAST), quiet = true, keepPicture = showing)
    }

    /** A conversation's notification, with Reply (typed in the shade) and Mark as read. */
    @android.annotation.SuppressLint("MissingPermission")
    private fun post(
        channelId: String, channel: String, style: NotificationCompat.MessagingStyle, title: String, text: String, lastMessageId: String?, quiet: Boolean,
        picture: android.graphics.Bitmap? = null, keepPicture: android.app.Notification? = null,
    ) {
        val id = channelId.hashCode()
        val reply = NotificationCompat.Action.Builder(
            R.drawable.ic_notification, t("Reply"),
            NotificationActions.intent(ctx, NotificationActions.REPLY, channelId, lastMessageId, id + 1, mutable = true),
        )
            .addRemoteInput(androidx.core.app.RemoteInput.Builder(NotificationActions.KEY_TEXT).setLabel(t("Reply")).build())
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
            .setShowsUserInterface(false)
            .build()
        val read = NotificationCompat.Action.Builder(
            R.drawable.ic_notification, t("Mark as read"),
            NotificationActions.intent(ctx, NotificationActions.READ, channelId, lastMessageId, id + 2),
        )
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ)
            .setShowsUserInterface(false)
            .build()
        val n = NotificationCompat.Builder(ctx, channel)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(style)
            // The sender's picture (or, when rebuilding after a reply, the one it already had).
            .apply { if (picture != null) setLargeIcon(picture) else keepPicture?.getLargeIcon()?.let { setLargeIcon(it) } }
            .setNumber(style.messages.size)
            .setGroup(channelId)
            .setAutoCancel(true)
            .setOnlyAlertOnce(quiet)
            .setSilent(quiet)
            .setContentIntent(open(channelId, lastMessageId, id))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .addAction(reply)
            .addAction(read)
            .addExtras(android.os.Bundle().apply { putString(EXTRA_LAST, lastMessageId) })
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
        const val FRIENDS = "friends"
        const val RINGING = "ringing"
        /** The newest message in a conversation's notification (for Mark as read). */
        private const val EXTRA_LAST = "linkord.last_message"
        /** Messages a conversation's notification keeps. */
        const val KEEP = 8
    }
}
