package com.linkord.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * Against a real local server with dev login on (LINKORD_TEST_URL, e.g. http://localhost:7700, or the throwaway one
 * tests/run-local.sh starts): sign in, READY into the store, a message sent over REST comes back over the gateway.
 * Skipped when LINKORD_TEST_URL isn't set.
 */
class ServerTest {
    private val base = System.getenv("LINKORD_TEST_URL")

    @Test
    fun signInReadyAndMessages() = runBlocking {
        assumeTrue("LINKORD_TEST_URL not set", base != null)
        val http = OkHttpClient()
        var token: String? = null
        val api = Api(http, { base!! }, { token })
        val name = "android.test.${System.currentTimeMillis() % 100000}"
        token = api.post<JsonObject>("/auth/dev", mapOf("username" to name))["token"]!!.jsonPrimitive.content
        val friend = "android.friend.${System.currentTimeMillis() % 100000}"
        var friendToken: String? = null
        val friendApi = Api(http, { base!! }, { friendToken })
        friendToken = friendApi.post<JsonObject>("/auth/dev", mapOf("username" to friend))["token"]!!.jsonPrimitive.content

        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val gateway = Gateway(http, store, scope, { base!! }, { token })
        gateway.connect()
        withTimeout(10_000) { store.state.first { it.ready } }
        assertEquals(name, store.s.me?.username)

        // A DM from the friend reaches us over the gateway, counts as a mention and alerts.
        var alerted: Alert? = null
        store.onAlert = { alerted = it }
        val me = store.s.me!!.id
        val friendId = friendApi.get<User>("/users/@me").id
        friendApi.send("PUT", "/users/@me/relationships/$me")
        api.send("PUT", "/users/@me/relationships/$friendId")
        withTimeout(10_000) { store.state.first { it.relationships[friendId] == Rel.FRIEND } }
        val dm = friendApi.post<Channel>("/users/@me/channels", mapOf("recipient_id" to me))
        withTimeout(10_000) { store.state.first { it.channels[dm.id] != null } }
        friendApi.send("POST", "/channels/${dm.id}/messages", mapOf("content" to "hi **there** <@$me>"))
        withTimeout(10_000) { store.state.first { (it.mentions[dm.id] ?: 0) > 0 } }
        assertTrue(alerted?.mentioned == true)
        assertEquals(dm.id, store.s.channels[dm.id]?.id)

        // Paging into the store and our own message coming back.
        val page = api.get<List<Message>>("/channels/${dm.id}/messages?limit=50")
        store.update { it.mergeLatest(dm.id, page) }
        assertEquals("hi **there** <@$me>", store.s.bucket(dm.id).list.last().content)
        api.send("POST", "/channels/${dm.id}/messages", mapOf("content" to "hello back", "nonce" to "n1"))
        withTimeout(10_000) { store.state.first { s -> s.bucket(dm.id).list.any { it.content == "hello back" } } }

        // Sessions know this is the Android app.
        val sessions = api.get<List<SessionInfo>>("/auth/sessions")
        assertEquals("android", sessions.first { it.current }.client)
        gateway.disconnect()
    }
}
