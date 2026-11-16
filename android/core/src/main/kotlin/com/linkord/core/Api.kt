package com.linkord.core

import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.serializer
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** The server answered with an error. `message` is the server's own English text (translate it with serverError). */
class ApiException(val status: Int, message: String) : IOException(message)

private val JSON_TYPE = "application/json".toMediaType()

/**
 * REST under /api with `Authorization: Bearer <token>` (server/src/api). Like the web client's api(): a 429 waits the
 * time the server asks for (at most 10 s) and tries once more; errors carry the server's message.
 */
class Api(
    val http: OkHttpClient,
    private val baseUrl: () -> String,
    private val token: () -> String?,
) {
    val base: String get() = baseUrl()

    /** Turns a server path like /uploads/... into a full URL (other URLs are returned as they are). */
    fun media(path: String?): String? = when {
        path.isNullOrEmpty() -> null
        path.startsWith("/") -> base + path
        else -> path
    }

    fun emojiUrl(id: String, animated: Boolean = false) = "$base/uploads/emojis/$id.${if (animated) "gif" else "png"}"

    suspend fun raw(method: String, path: String, body: RequestBody? = null, retry: Boolean = true): String {
        val req = Request.Builder().url("$base/api$path").apply {
            token()?.let { header("Authorization", "Bearer $it") }
            method(method, body ?: if (method == "GET" || method == "DELETE") null else ByteArray(0).toRequestBody(null))
        }.build()
        val res = http.newCall(req).await()
        val text = res.use { it.body.string() }
        if (res.code == 429 && retry) {
            val wait = runCatching { LinkordJson.parseToJsonElement(text).jsonObject["retry_after"]?.jsonPrimitive?.doubleOrNull }
                .getOrNull() ?: 1.0
            delay((wait.coerceAtMost(10.0) * 1000).toLong() + 50)
            return raw(method, path, body, false)
        }
        if (!res.isSuccessful) {
            val msg = runCatching { LinkordJson.parseToJsonElement(text).jsonObject["error"]?.jsonPrimitive?.content }.getOrNull()
            throw ApiException(res.code, msg ?: res.message.ifEmpty { "HTTP ${res.code}" })
        }
        return text
    }

    suspend inline fun <reified T> get(path: String): T = decode(raw("GET", path))
    suspend inline fun <reified T> post(path: String, body: Any? = null): T = decode(raw("POST", path, jsonBody(body)))
    suspend inline fun <reified T> patch(path: String, body: Any? = null): T = decode(raw("PATCH", path, jsonBody(body)))
    suspend inline fun <reified T> put(path: String, body: Any? = null): T = decode(raw("PUT", path, jsonBody(body)))
    suspend inline fun <reified T> delete(path: String): T = decode(raw("DELETE", path))

    /** For requests whose answer doesn't matter. */
    suspend fun send(method: String, path: String, body: Any? = null) {
        raw(method, path, jsonBody(body))
    }

    inline fun <reified T> decode(text: String): T = decodeWith(serializer<T>(), text)

    @Suppress("UNCHECKED_CAST")
    fun <T> decodeWith(s: KSerializer<T>, text: String): T =
        if (s.descriptor.serialName == "kotlin.Unit") Unit as T else LinkordJson.decodeFromString(s, text.ifEmpty { "null" })

    fun jsonBody(body: Any?): RequestBody? = when (body) {
        null -> null
        is RequestBody -> body
        is JsonElement -> body.toString().toRequestBody(JSON_TYPE)
        is String -> body.toRequestBody(JSON_TYPE)
        is Map<*, *> -> toJson(body).toString().toRequestBody(JSON_TYPE)
        else -> error("unsupported body ${body::class}")
    }
}

/** Plain maps/lists/primitives -> JSON (for small request bodies). */
fun toJson(v: Any?): JsonElement = when (v) {
    null -> kotlinx.serialization.json.JsonNull
    is JsonElement -> v
    is String -> kotlinx.serialization.json.JsonPrimitive(v)
    is Number -> kotlinx.serialization.json.JsonPrimitive(v)
    is Boolean -> kotlinx.serialization.json.JsonPrimitive(v)
    is Map<*, *> -> JsonObject(v.entries.filter { it.value != null }.associate { (k, x) -> k.toString() to toJson(x) })
    is Iterable<*> -> kotlinx.serialization.json.JsonArray(v.map { toJson(it) })
    else -> error("unsupported json value ${v::class}")
}

suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    cont.invokeOnCancellation { runCatching { cancel() } }
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
            if (!cont.isCancelled) cont.resumeWithException(e)
        }

        override fun onResponse(call: Call, response: Response) {
            cont.resume(response)
        }
    })
}
