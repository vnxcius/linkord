package com.linkord.app.ui.call

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.linkord.app.session
import com.linkord.app.ui.components.Kicker
import com.linkord.core.t
import com.linkord.designsystem.Linkord
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class Sound(val id: String, @SerialName("guild_id") val guildId: String? = null, val name: String = "", val emoji: String? = null, val volume: Float = 1f, val url: String = "")

/** The soundboard in a call: the server's sounds, then the default ones; a tap plays it for everyone (voice op sound). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SoundboardSheet(guildId: String?, onDismiss: () -> Unit) {
    val session = LocalContext.current.session
    val haptics = LocalHapticFeedback.current
    val c = Linkord.colors
    var mine by remember { mutableStateOf<List<Sound>>(emptyList()) }
    var defaults by remember { mutableStateOf<List<Sound>>(emptyList()) }
    LaunchedEffect(guildId) {
        defaults = runCatching { session.api.get<List<Sound>>("/soundboard/default") }.getOrDefault(emptyList())
        if (guildId != null) mine = runCatching { session.api.get<List<Sound>>("/guilds/$guildId/soundboard") }.getOrDefault(emptyList())
    }
    ModalBottomSheet(onDismiss, containerColor = c.panel) {
        LazyVerticalGrid(
            GridCells.Adaptive(96.dp), Modifier.fillMaxWidth().height(420.dp).navigationBarsPadding(),
            contentPadding = PaddingValues(12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            for ((title, list) in listOf(t("This server") to mine, t("Default") to defaults)) {
                if (list.isEmpty()) continue
                item(span = { GridItemSpan(maxLineSpan) }) { Kicker(title, Modifier.padding(top = 4.dp)) }
                items(list, key = { it.id }) { s ->
                    Column(
                        Modifier.clip(RoundedCornerShape(12.dp)).background(c.raised).clickable {
                            haptics.performHapticFeedback(HapticFeedbackType.ContextClick)
                            session.calls.voice.playSound(s.id)
                        }.padding(10.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Text(s.emoji ?: "🔊", fontSize = 24.sp)
                        Text(s.name, style = Linkord.type.small, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
                    }
                }
            }
        }
    }
}
