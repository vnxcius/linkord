package com.linkord.app.data

import android.content.Context
import android.util.Base64
import androidx.core.content.edit
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.linkord.app.session
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import org.json.JSONObject
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.SecureRandom
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.security.spec.PKCS8EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlin.coroutines.resume

@Serializable
private data class FcmConfig(
    @SerialName("project_id") val projectId: String,
    @SerialName("app_id") val appId: String,
    @SerialName("api_key") val apiKey: String,
    @SerialName("sender_id") val senderId: String,
)

/**
 * Notifications while the app is closed: Firebase Cloud Messaging carries them (server fcm.rs), sealed for this
 * phone with the same Web Push encryption the server uses for browsers (RFC 8291), so Google only carries ciphertext.
 * The Firebase settings come from our server (GET /api/push/fcm), so the APK holds none; no server settings = off.
 */
class Push(private val session: Session) {
    private val prefs = session.context.getSharedPreferences("linkord.push", Context.MODE_PRIVATE)
    @Volatile var registered = false
        private set

    /** This phone's push keys: a P-256 pair and a 16-byte secret, made once. */
    private fun keys(): Triple<ECPrivateKey, ByteArray, ByteArray> {
        val stored = prefs.getString("private", null)
        if (stored != null) {
            val priv = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(Base64.decode(stored, Base64.NO_WRAP))) as ECPrivateKey
            return Triple(priv, Base64.decode(prefs.getString("public", ""), Base64.NO_WRAP), Base64.decode(prefs.getString("auth", ""), Base64.NO_WRAP))
        }
        val kp = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val pub = com.linkord.core.WebPush.uncompressed(kp.public as ECPublicKey)
        val auth = ByteArray(16).also { SecureRandom().nextBytes(it) }
        prefs.edit {
            putString("private", Base64.encodeToString(kp.private.encoded, Base64.NO_WRAP))
            putString("public", Base64.encodeToString(pub, Base64.NO_WRAP))
            putString("auth", Base64.encodeToString(auth, Base64.NO_WRAP))
        }
        return Triple(kp.private as ECPrivateKey, pub, auth)
    }

    /** After each READY: start Firebase with the server's settings and register this phone's token. */
    fun start() {
        session.scope.launch {
            runCatching {
                val pkg = session.context.packageName
                val cfg = runCatching { session.api.get<FcmConfig>("/push/fcm?package=$pkg") }.getOrNull() ?: return@launch
                val app = FirebaseApp.getApps(session.context).firstOrNull { it.name == FirebaseApp.DEFAULT_APP_NAME }
                    ?: FirebaseApp.initializeApp(
                        session.context,
                        FirebaseOptions.Builder().setProjectId(cfg.projectId).setApplicationId(cfg.appId).setApiKey(cfg.apiKey).setGcmSenderId(cfg.senderId).build(),
                    )
                val token = suspendCancellableCoroutine<String?> { cont ->
                    app.get(FirebaseMessaging::class.java).token.addOnCompleteListener { t -> cont.resume(if (t.isSuccessful) t.result else null) }
                } ?: return@launch
                register(token)
            }.onFailure { session.reporter.report("warn", "Push: couldn't start FCM", it) }
        }
    }

    suspend fun register(token: String) {
        val (_, pub, auth) = keys()
        val b64 = { b: ByteArray -> Base64.encodeToString(b, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP) }
        session.api.send(
            "POST", "/push/subscriptions",
            mapOf("endpoint" to "fcm:$token", "keys" to mapOf("p256dh" to b64(pub), "auth" to b64(auth)), "lang" to com.linkord.core.I18n.lang),
        )
        registered = true
    }

    /** Opens a sealed notification (RFC 8291 aes128gcm, one record) into its JSON. */
    fun open(sealed: ByteArray): JSONObject? = runCatching {
        val (priv, pub, auth) = keys()
        JSONObject(com.linkord.core.WebPush.decrypt(sealed, priv, pub, auth))
    }.getOrNull()
}

/** Where FCM delivers: a new token is registered, a message is opened and shown. */
class LinkordMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        val s = applicationContext.session
        if (s.vault.get() == null) return
        s.scope.launch { runCatching { s.push.register(token) } }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val s = applicationContext.session
        val sealed = message.data["p"]?.let { runCatching { Base64.decode(it, Base64.DEFAULT) }.getOrNull() } ?: return
        val note = s.push.open(sealed) ?: return
        s.notifier.push(note)
    }
}
