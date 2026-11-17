package com.linkord.core

import java.math.BigInteger
import java.security.KeyFactory
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** Opening the notifications server push.rs seals for this phone (RFC 8291 aes128gcm): plain JVM, tested in core. */
object WebPush {
    /** RFC 8291 aes128gcm, one record, for the receiver ([priv], its uncompressed [pub], [auth] secret). */
    fun decrypt(sealed: ByteArray, priv: ECPrivateKey, pub: ByteArray, auth: ByteArray): String {
    val salt = sealed.copyOfRange(0, 16)
    val idLen = sealed[20].toInt() and 0xFF
    val serverPub = sealed.copyOfRange(21, 21 + idLen)
    val ct = sealed.copyOfRange(21 + idLen, sealed.size)
    val ka = KeyAgreement.getInstance("ECDH")
    ka.init(priv)
    ka.doPhase(publicKeyOf(serverPub, priv), true)
    val shared = ka.generateSecret()
    val ikm = hkdf(auth, shared, "WebPush: info\u0000".toByteArray() + pub + serverPub, 32)
    val cek = hkdf(salt, ikm, "Content-Encoding: aes128gcm\u0000".toByteArray(), 16)
    val nonce = hkdf(salt, ikm, "Content-Encoding: nonce\u0000".toByteArray(), 12)
    val c = Cipher.getInstance("AES/GCM/NoPadding")
    c.init(Cipher.DECRYPT_MODE, SecretKeySpec(cek, "AES"), GCMParameterSpec(128, nonce))
    val plain = c.doFinal(ct)
    // The record ends with the 0x02 delimiter (and maybe zero padding before it).
    var end = plain.size - 1
    while (end > 0 && plain[end].toInt() == 0) end--
    return String(plain, 0, end, Charsets.UTF_8)
    }

    fun hkdf(salt: ByteArray, ikm: ByteArray, info: ByteArray, len: Int): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(salt, "HmacSHA256"))
        val prk = mac.doFinal(ikm)
        mac.init(SecretKeySpec(prk, "HmacSHA256"))
        mac.update(info)
        mac.update(1)
        return mac.doFinal().copyOf(len)
    }

    fun uncompressed(k: ECPublicKey): ByteArray {
        fun fixed(b: BigInteger) = b.toByteArray().let { if (it.size > 32) it.copyOfRange(it.size - 32, it.size) else ByteArray(32 - it.size) + it }
        return byteArrayOf(4) + fixed(k.w.affineX) + fixed(k.w.affineY)
    }

    fun publicKeyOf(raw: ByteArray, onCurveOf: ECPrivateKey): ECPublicKey {
        val x = BigInteger(1, raw.copyOfRange(1, 33))
        val y = BigInteger(1, raw.copyOfRange(33, 65))
        return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(ECPoint(x, y), onCurveOf.params)) as ECPublicKey
    }
}
