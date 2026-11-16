package com.linkord.app.data

import com.linkord.core.nameOf
import kotlinx.serialization.json.JsonElement

/** Gateway events that are the app's business rather than the store's (updates, calls ringing...). */
class Events(private val session: Session) {
    fun onEvent(t: String, d: JsonElement) {
        when (t) {
            // Every connection is a moment to check for a release; APP_UPDATE says one just went out. The Android
            // updater (phase 5) hooks in here.
            "READY" -> {
                session.actions.viewing.value?.let { session.actions.maybeAck(it) }
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
            "APP_UPDATE" -> if ((d as? kotlinx.serialization.json.JsonObject)?.get("android")?.toString() == "true") session.updater.check()
        }
    }
}
