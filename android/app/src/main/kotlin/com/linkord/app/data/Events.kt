package com.linkord.app.data

import com.linkord.core.nameOf
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement

/** Gateway events that are the app's business rather than the store's (updates, calls ringing...). */
class Events(private val session: Session) {
    fun onEvent(t: String, d: JsonElement) {
        when (t) {
            // Every connection is a moment to check for a release; APP_UPDATE says one just went out. The Android
            // updater (phase 5) hooks in here.
            "READY" -> {
                // READY marks every channel's messages as stale (the store): the one on screen reloads right away
                // (missed messages show up, new ones are taken in again), and is marked read once it has.
                session.actions.viewing.value?.let { id ->
                    session.scope.launch { runCatching { session.actions.loadMessages(id) }.onFailure { session.actions.maybeAck(id) } }
                }
                session.updater.check()
                session.push.start()
            }
            "SNOWBALL" -> {
                val o = d as? kotlinx.serialization.json.JsonObject ?: return
                fun s(k: String) = (o[k] as? kotlinx.serialization.json.JsonPrimitive)?.content
                val st = session.store.s
                val from = s("from") ?: return
                val to = s("to") ?: return
                val ch = s("channel_id")?.let { st.channels[it] }
                val name = { id: String -> st.nameOf(id, ch?.guildId, com.linkord.core.t("Unknown")) }
                if (to == st.me?.id) session.toast(com.linkord.core.t("{name} hit you with a snowball!", "name" to name(from)))
                else if (session.actions.viewing.value == ch?.id) session.toast("❄ " + com.linkord.core.t("{from} hit {to}", "from" to name(from), "to" to name(to)))
            }
            // Read on another device (or here): that conversation's notification goes away.
            "MESSAGE_ACK" -> {
                val o = d as? kotlinx.serialization.json.JsonObject ?: return
                val cid = (o["channel_id"] as? kotlinx.serialization.json.JsonPrimitive)?.content ?: return
                val mid = (o["message_id"] as? kotlinx.serialization.json.JsonPrimitive)?.content ?: return
                session.notifier.read(cid, mid)
            }
            "APP_UPDATE" -> if ((d as? kotlinx.serialization.json.JsonObject)?.get("android")?.toString() == "true") session.updater.check()
        }
    }
}
