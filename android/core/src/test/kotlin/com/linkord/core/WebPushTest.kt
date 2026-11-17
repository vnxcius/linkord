package com.linkord.core

import org.junit.Assert.assertEquals
import org.junit.Test
import java.security.KeyFactory
import java.security.interfaces.ECPrivateKey
import java.security.spec.PKCS8EncodedKeySpec
import java.util.Base64

/** WebPush.decrypt opens what an independent RFC 8291 encryptor (Node's crypto, the same scheme as server push.rs) sealed. */
class WebPushTest {
    private fun b(s: String) = Base64.getDecoder().decode(s)

    @Test
    fun opensANodeSealedNotification() {
        val priv = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(b("MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgwN2YdfhBst8ppKIvhQBqzfuTACPHO2motyYo7bBI4/ChRANCAASeuRlWye9mNdUZIlJ8jqWVPIZsa9+99InXlEThKCktXa28LM0Uzc4ovs2dlpRt8Gfos/hXSTfzA2KZLAN919lm"))) as ECPrivateKey
        val text = WebPush.decrypt(b("YQtTNw4GuhSxGyq1jOcZ2AAAEABBBJQlrw3R4VGxEkl/8u9brhZ6g9FRnPtcvWMKdcvIp2haPJSVAX75kjYhh7IgXfT6vhZAaRvNJsjSeZjXEyzh9b4lt/K+6LUCmAeHUDYeBY2Der+hZZBJo8RWtKlcIrd6UQsRdgZWcrh0OqXdi2xQzuGx9b9rtg=="), priv, b("BJ65GVbJ72Y11RkiUnyOpZU8hmxr3730ideUROEoKS1drbwszRTNzii+zZ2WlG3wZ+iz+FdJN/MDYpksA33X2WY="), b("RQiL8CioaMW8IGB+lub9TQ=="))
        assertEquals("{\"title\":\"zelda\",\"body\":\"oi ❤️\"}", text)
    }
}
