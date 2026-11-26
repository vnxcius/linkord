package com.linkord.app.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.linkord.app.session
import com.linkord.app.ui.components.Avatar
import com.linkord.core.Message
import com.linkord.core.nameColor
import com.linkord.core.nameOf
import com.linkord.core.t
import com.linkord.designsystem.Linkord

/**
 * Who reacted (a long press on a reaction): the message's reactions across the top, the one pressed first, and the
 * people behind the one picked, in the order they reacted. Follows the message live (someone reacting meanwhile).
 */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
fun ReactionsSheet(m: Message, guildId: String?, start: String, onDismiss: () -> Unit) {
    val session = LocalContext.current.session
    val st by session.store.state.collectAsState()
    val c = Linkord.colors
    var picked by remember { mutableStateOf(start) }
    val reactions = m.reactions
    // The reaction picked went away (its last person took it back): the first one left.
    val current = reactions.firstOrNull { it.emoji == picked } ?: reactions.firstOrNull()
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = c.panel) {
        Column(Modifier.navigationBarsPadding().padding(bottom = 12.dp)) {
            Text(t("Reactions"), style = Linkord.type.title, color = c.text, modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp))
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                for (r in reactions) {
                    val on = r.emoji == current?.emoji
                    Row(
                        Modifier.clip(RoundedCornerShape(10.dp)).background(if (on) c.brandSoft else c.raised)
                            .border(1.dp, if (on) c.brandTint(0.6f) else Color.Transparent, RoundedCornerShape(10.dp))
                            .clickable { picked = r.emoji }.padding(horizontal = 10.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        ReactionEmoji(r.emoji, 22.dp)
                        Spacer(Modifier.width(6.dp))
                        Text(r.users.size.toString(), style = Linkord.type.mono.copy(color = if (on) c.text else c.text2))
                    }
                }
            }
            LazyColumn(Modifier.fillMaxWidth().heightIn(max = 420.dp)) {
                items(current?.users.orEmpty(), key = { it }) { id ->
                    Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Avatar(st.users[id], 36.dp)
                        Spacer(Modifier.width(12.dp))
                        val color = st.nameColor(guildId, id)?.let { Color(0xFF000000 or it.toLong()) } ?: c.text
                        Text(st.nameOf(id, guildId, t("Unknown")), style = Linkord.type.body, color = color, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
    }
}
