package com.linkord.app.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import com.linkord.app.session
import com.linkord.app.ui.LocalNav
import com.linkord.app.ui.Screen
import com.linkord.app.ui.components.Avatar
import com.linkord.app.ui.components.Kicker
import com.linkord.app.ui.components.LIcon
import com.linkord.app.ui.components.mediaUrl
import com.linkord.core.t
import com.linkord.designsystem.Linkord
import com.linkord.designsystem.LinkordIcons
import kotlinx.coroutines.launch

/** You: your card, your status, and the way into settings. */
@Composable
fun YouTab() {
    val session = LocalContext.current.session
    val st by session.store.state.collectAsState()
    val nav = LocalNav.current
    val c = Linkord.colors
    val scope = rememberCoroutineScope()
    val me = st.me ?: return
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        Box(Modifier.fillMaxWidth().height(168.dp).clickable { nav.push(Screen.EditProfile) }) {
            val banner = mediaUrl(me.banner)
            if (banner != null) AsyncImage(banner, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
            else Box(Modifier.fillMaxSize().background(me.accentColor?.let { Color(0xFF000000 or it.toLong()) } ?: c.raised2))
            Box(Modifier.align(Alignment.BottomStart).offset(x = 16.dp, y = 40.dp).clip(RoundedCornerShape(30)).background(c.desk).clickable { nav.push(Screen.EditProfile) }.padding(5.dp)) {
                Avatar(me, 84.dp)
            }
        }
        Column(Modifier.padding(start = 16.dp, end = 16.dp, top = 52.dp)) {
            Text(me.name, style = Linkord.type.display)
            Text(me.username, style = Linkord.type.mono)
            activityLine(st, me.id)?.let { Text(it, style = Linkord.type.small, modifier = Modifier.padding(top = 6.dp)) }
        }
        Spacer(Modifier.height(20.dp))
        var statusSheet by remember { mutableStateOf(false) }
        Section {
            val cs = st.customStatus
            Entry(LinkordIcons.Smile, cs?.let { listOfNotNull(it.emoji?.name, it.state).joinToString(" ") }?.ifBlank { null } ?: t("Set a custom status")) { statusSheet = true }
        }
        if (statusSheet) CustomStatusSheet { statusSheet = false }
        Spacer(Modifier.height(12.dp))
        Section {
            Kicker(t("Status"), Modifier.padding(start = 16.dp, top = 12.dp, bottom = 4.dp))
            val statuses = listOf("online" to t("Online"), "idle" to t("Idle"), "dnd" to t("Do Not Disturb"), "invisible" to t("Invisible"))
            for ((s, label) in statuses) {
                Row(
                    Modifier.fillMaxWidth().clickable { scope.launch { runCatching { session.actions.setStatus(s) }.onFailure { session.toast(session.describe(it)) } } }
                        .padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    com.linkord.app.ui.components.PresenceDot(if (s == "invisible") "offline" else s, 12.dp)
                    Spacer(Modifier.width(14.dp))
                    Text(label, style = Linkord.type.body, modifier = Modifier.weight(1f))
                    if (me.status == s) LIcon(LinkordIcons.Check, size = 18.dp, tint = c.text)
                }
            }
        }
        Spacer(Modifier.height(12.dp))
        Section {
            Entry(LinkordIcons.UserCircle, t("Profile")) { nav.push(Screen.Profile(me.id, null)) }
            Entry(LinkordIcons.EditProfile, t("Edit Profile")) { nav.push(Screen.EditProfile) }
            Entry(LinkordIcons.Rec, t("Shared clips")) { nav.push(Screen.SharedClips) }
            Entry(LinkordIcons.Chart, t("Stats")) { nav.push(Screen.Stats) }
            Entry(LinkordIcons.Gear, t("Settings")) { nav.push(Screen.Settings) }
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
fun Section(content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp).clip(RoundedCornerShape(14.dp)).background(Linkord.colors.panel), verticalArrangement = Arrangement.Top) { content() }
}

@Composable
fun Entry(icon: ImageVector, label: String, trailing: String? = null, danger: Boolean = false, onClick: () -> Unit) {
    val c = Linkord.colors
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
        LIcon(icon, tint = if (danger) c.danger else c.text2)
        Spacer(Modifier.width(14.dp))
        Text(label, style = Linkord.type.body, color = if (danger) c.danger else c.text, modifier = Modifier.weight(1f))
        if (trailing != null) Text(trailing, style = Linkord.type.small, color = c.text3)
        if (!danger) LIcon(LinkordIcons.ChevronRight, size = 16.dp, tint = c.text3)
    }
}
