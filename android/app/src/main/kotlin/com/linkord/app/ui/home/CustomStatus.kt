package com.linkord.app.ui.home

import androidx.compose.foundation.background
import com.linkord.designsystem.LinkordIcons
import com.linkord.app.ui.components.LIcon
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.material3.LocalTextStyle
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
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
    var emoji by remember { mutableStateOf(cur?.emoji?.name ?: "") }
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
                // The placeholder is a muted glyph, not an emoji: an emoji there looked like one you had set.
                OutlinedTextField(
                    emoji,
                    { emoji = it.take(16) },
                    singleLine = true,
                    modifier = Modifier.width(76.dp),
                    textStyle = LocalTextStyle.current.copy(textAlign = TextAlign.Center),
                    placeholder = {
                        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { LIcon(LinkordIcons.SmileSolid, size = 22.dp, tint = c.text3) }
                    },
                )
                OutlinedTextField(text, { text = it.take(128) }, singleLine = true, modifier = Modifier.weight(1f).padding(start = 8.dp), placeholder = { Text(t("What's happening?")) })
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
