package com.linkord.app.data

import com.linkord.core.State
import com.linkord.core.t

/** A slash command: Kass's (music.rs), or another bot's from READY.bot_commands (Steve). Web: lib/commands.ts. */
data class SlashCommand(val name: String, val option: String? = null, val optional: Boolean = false, val description: String, val botId: String? = null)

object Commands {
    /** Kass's commands; the texts are the web client's, so they're already translated. */
    fun kass() = listOf(
        SlashCommand("play", t("link or search"), description = t("Play YouTube or Spotify (songs, albums, playlists) in your voice channel")),
        SlashCommand("skip", description = t("Skip the current song")),
        SlashCommand("pause", description = t("Pause the music")),
        SlashCommand("resume", description = t("Resume the music")),
        SlashCommand("queue", description = t("Show what is playing and what is next")),
        SlashCommand("repeat", t("song, queue or off"), optional = true, description = t("Repeat the current song or the whole queue")),
        SlashCommand("remove", t("number or name"), description = t("Remove a song from the queue")),
        SlashCommand("stop", description = t("Stop the music and make Kass leave")),
        SlashCommand("snowball", t("@someone"), description = t("Throw a snowball at someone")),
    )

    /** Kass's, then those of the other bots that are members here (none outside servers). */
    fun inChannel(st: State, guildId: String?): List<SlashCommand> {
        if (guildId == null) return kass()
        val others = st.botCommands.filter { st.members[guildId]?.containsKey(it.botId) == true }
            .map { SlashCommand(it.name, it.option, it.optional, it.description, it.botId) }
        return kass() + others
    }

    /** "/play never gonna" -> the command and its text; anything else (unknown commands too) is a message. */
    fun parse(content: String, st: State, guildId: String?): Pair<SlashCommand, String>? {
        val m = Regex("^/([\\w-]+)(?:\\s+([\\s\\S]*))?$").find(content) ?: return null
        val cmd = inChannel(st, guildId).firstOrNull { it.name == m.groupValues[1].lowercase() } ?: return null
        return cmd to m.groupValues[2].trim()
    }
}
