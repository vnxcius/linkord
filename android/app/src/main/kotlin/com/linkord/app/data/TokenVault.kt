package com.linkord.app.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The session token, encrypted with a key that never leaves the Android Keystore (AES-GCM). Only ciphertext reaches
 * the app's files, so a backup or a copied data folder doesn't carry a usable login.
 */
class TokenVault(context: Context) {
    private val prefs = context.getSharedPreferences("linkord.vault", Context.MODE_PRIVATE)

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    @Volatile private var cached: String? = null
    @Volatile private var loaded = false

    fun get(): String? {
        if (loaded) return cached
        val stored = prefs.getString(TOKEN, null)
        cached = stored?.let { s ->
            runCatching {
                val raw = Base64.decode(s, Base64.NO_WRAP)
                val c = Cipher.getInstance(TRANSFORM)
                c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw, 0, IV))
                String(c.doFinal(raw, IV, raw.size - IV), Charsets.UTF_8)
            }.getOrNull()
        }
        loaded = true
        return cached
    }

    fun set(token: String?) {
        cached = token
        loaded = true
        if (token == null) {
            prefs.edit().remove(TOKEN).apply()
            return
        }
        val c = Cipher.getInstance(TRANSFORM)
        c.init(Cipher.ENCRYPT_MODE, key())
        val out = c.iv + c.doFinal(token.toByteArray(Charsets.UTF_8))
        prefs.edit().putString(TOKEN, Base64.encodeToString(out, Base64.NO_WRAP)).apply()
    }

    private companion object {
        const val ALIAS = "linkord.session"
        const val TOKEN = "token"
        const val TRANSFORM = "AES/GCM/NoPadding"
        const val IV = 12
    }
}
