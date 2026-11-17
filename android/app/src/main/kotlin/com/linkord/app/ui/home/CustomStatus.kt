package com.linkord.app.ui.home

import androidx.compose.foundation.background
import com.linkord.designsystem.LinkordIcons
import com.linkord.app.ui.components.LIcon
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.coerceIn
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage
import com.linkord.app.ui.chat.EmojiPicker
import com.linkord.core.StatusEmoji
import com.linkord.designsystem.emojiText
import com.linkord.app.session
import com.linkord.app.ui.components.Kicker
import com.linkord.core.t
import com.linkord.designsystem.Linkord
import java.time.LocalDate
import java.time.ZoneId

/** Your custom status (activities.rs, type 4): an emoji and a line, clearing itself when you say. */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun CustomStatusSheet(onDismiss: () -> Unit) {
    val session = LocalContext.current.session
    val cur = session.store.s.customStatus
    val c = Linkord.colors
    var emoji by remember { mutableStateOf(cur?.emoji?.takeIf { it.name.isNotBlank() }) }
    var picking by remember { mutableStateOf(false) }
    val st by session.store.state.collectAsState()
    // The picker gets what the screen can spare (small phones): the sheet's other rows stay on screen.
    val pickerHeight = (LocalConfiguration.current.screenHeightDp * 0.42f).dp.coerceIn(220.dp, 360.dp)
    var text by remember { mutableStateOf(cur?.state ?: "") }
    var clear by remember { mutableStateOf<Long?>(null) }
    val options = listOf(
        null to t("Don't clear"),
        30L * 60_000 to t("30 minutes"),
        3600_000L to t("1 hour"),
        4 * 3600_000L to t("4 hours"),
        -1L to t("Today"),
    )
    ModalBottomSheet(onDismiss, containerColor = c.panel) {
        Column(Modifier.padding(horizontal = 16.dp).navigationBarsPadding().padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(t("Set a custom status"), style = Linkord.type.title)
            Row(verticalAlignment = Alignment.CenterVertically) {
                // The emoji: a tile that opens the picker (every emoji, the servers' own included). Empty, it shows a
                // muted glyph, not an emoji: an emoji there looked like one you had set.
                val e = emoji
                Box(
                    Modifier.size(52.dp).clip(RoundedCornerShape(12.dp)).background(if (picking) c.active else c.raised).clickable { picking = !picking }
                        .semantics { contentDescription = t("Choose an emoji") },
                    contentAlignment = Alignment.Center,
                ) {
                    when {
                        e == null -> LIcon(LinkordIcons.SmileSolid, size = 24.dp, tint = c.text3)
                        e.id != null -> AsyncImage(session.api.emojiUrl(e.id ?: "", e.animated), ":${e.name}:", Modifier.size(30.dp))
                        else -> Text(emojiText(e.name), fontSize = 26.sp, maxLines = 1)
                    }
                }
                OutlinedTextField(text, { text = it.take(128) }, singleLine = true, modifier = Modifier.weight(1f).padding(start = 8.dp), placeholder = { Text(t("What's happening?"), maxLines = 1, overflow = TextOverflow.Ellipsis) })
            }
            if (picking) Column {
                EmojiPicker(st, null, height = pickerHeight) { v ->
                    // "name:id" for a server's emoji, the character otherwise (EmojiPicker).
                    val custom = Regex("^(\\w+):(\\d+)$").find(v)
                    emoji = if (custom != null) {
                        val (name, id) = custom.destructured
                        StatusEmoji(id = id, name = name, animated = st.emojis.values.any { l -> l.any { it.id == id && it.animated } })
                    } else StatusEmoji(name = v)
                    picking = false
                }
                if (emoji != null) TextButton(onClick = { emoji = null; picking = false }) { Text(t("Remove"), color = c.danger) }
            }
            Kicker(t("Clear after"))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                for ((ms, label) in options) {
                    val on = clear == ms
                    Text(label, style = Linkord.type.small, color = if (on) c.onBrand else c.text, modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(if (on) c.brand else c.raised).clickable { clear = ms }.padding(horizontal = 10.dp, vertical = 6.dp))
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (cur != null) TextButton(onClick = {
                    session.launch { session.actions.setCustomStatus(null, null, null) }
                    onDismiss()
                }) { Text(t("Clear Status"), color = c.danger) }
                Button(
                    onClick = {
                        val expires = when (val ms = clear) {
                            null -> null
                            -1L -> LocalDate.now().plusDays(1).atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli()
                            else -> System.currentTimeMillis() + ms
                        }
                        session.launch { session.actions.setCustomStatus(emoji, text, expires) }
                        onDismiss()
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = c.brand, contentColor = c.onBrand),
                    modifier = Modifier.weight(1f),
                ) { Text(t("Save")) }
            }
        }
    }
}
