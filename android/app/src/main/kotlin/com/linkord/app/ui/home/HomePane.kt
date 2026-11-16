package com.linkord.app.ui.home

import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.DropdownMenu
import androidx.compose.foundation.combinedClickable
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.linkord.app.session
import com.linkord.app.ui.components.Avatar
import com.linkord.app.ui.components.CountBadge
import com.linkord.app.ui.components.LIcon
import com.linkord.core.dmMentions
import com.linkord.core.t
import com.linkord.core.totalMentions
import com.linkord.designsystem.Linkord
import com.linkord.designsystem.LinkordIcons

/** The home pane: one of the four tabs, with the bottom bar (shown only here, never over the chat). */
@Composable
fun HomePane(tab: Tab, onTab: (Tab) -> Unit, onOpenChannel: (String) -> Unit, modifier: Modifier = Modifier) {
    val motion = Linkord.motion
    val session = LocalContext.current.session
    val theme by session.prefs.theme.collectAsState()
    Box(modifier.fillMaxSize()) {
    Column(Modifier.fillMaxSize().background(Linkord.colors.desk)) {
        UpdateBanner()
        AnimatedContent(tab, transitionSpec = { fadeIn(motion.quick()) togetherWith fadeOut(motion.quick()) }, modifier = Modifier.weight(1f), label = "tab") { t ->
            when (t) {
                Tab.Home -> ServersTab(onOpenChannel)
                Tab.Messages -> MessagesTab(onOpenChannel)
                Tab.Mentions -> MentionsTab(onOpenChannel)
                Tab.You -> YouTab()
            }
        }
        com.linkord.app.ui.call.CallBar()
        BottomBar(tab, onTab)
    }
    // The Christmas theme snows over the home pane (never with "Remove animations").
    if (theme == com.linkord.designsystem.ThemeMode.Christmas && !motion.reduced) com.linkord.app.ui.components.Snowfall(Modifier.fillMaxSize())
    }
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun BottomBar(tab: Tab, onTab: (Tab) -> Unit) {
    val session = LocalContext.current.session
    val nav = com.linkord.app.ui.LocalNav.current
    val st by session.store.state.collectAsState()
    val c = Linkord.colors
    Row(
        Modifier.fillMaxWidth().background(c.desk).navigationBarsPadding().height(60.dp).padding(horizontal = 8.dp),
        horizontalArrangement = Arrangement.SpaceAround,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Item(LinkordIcons.HomeSolid, t("Home"), tab == Tab.Home, badge = st.totalMentions() - st.dmMentions()) { onTab(Tab.Home) }
        Item(LinkordIcons.ChatBubble, t("Messages"), tab == Tab.Messages, badge = st.dmMentions()) { onTab(Tab.Messages) }
        Item(LinkordIcons.At, t("Mentions"), tab == Tab.Mentions) { onTab(Tab.Mentions) }
        // You: a tap opens the tab, holding it picks your status (online/idle/DND/invisible) or a custom status.
        var statusMenu by remember { mutableStateOf(false) }
        var customSheet by remember { mutableStateOf(false) }
        val haptics = androidx.compose.ui.platform.LocalHapticFeedback.current
        Box {
            Column(
                Modifier.clip(RoundedCornerShape(12.dp)).combinedClickable(
                    // Already on You: a second tap opens Edit Profile.
                    onClick = { if (tab == Tab.You) nav.push(com.linkord.app.ui.Screen.EditProfile) else onTab(Tab.You) },
                    onLongClick = {
                        haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress)
                        statusMenu = true
                    },
                ).padding(horizontal = 14.dp, vertical = 6.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Avatar(st.me, 24.dp, status = st.me?.status?.let { if (it == "invisible") "offline" else it })
                Text(t("You"), style = Linkord.type.label, color = if (tab == Tab.You) c.text else c.text3, modifier = Modifier.padding(top = 3.dp))
                Box(Modifier.padding(top = 3.dp).width(if (tab == Tab.You) 18.dp else 0.dp).height(3.dp).clip(RoundedCornerShape(2.dp)).background(c.brand))
            }
            DropdownMenu(statusMenu, { statusMenu = false }) {
                val cs = st.customStatus
                DropdownMenuItem(
                    text = { Text(cs?.let { listOfNotNull(it.emoji?.name, it.state).joinToString(" ") }?.ifBlank { null } ?: t("Set a custom status"), maxLines = 1) },
                    leadingIcon = { LIcon(LinkordIcons.Smile, size = 18.dp) },
                    onClick = { statusMenu = false; customSheet = true },
                )
                HorizontalDivider(color = c.line)
                for ((s, label) in listOf("online" to t("Online"), "idle" to t("Idle"), "dnd" to t("Do Not Disturb"), "invisible" to t("Invisible"))) {
                    DropdownMenuItem(
                        text = { Text(label) },
                        leadingIcon = { com.linkord.app.ui.components.PresenceDot(if (s == "invisible") "offline" else s, 12.dp) },
                        trailingIcon = { if (st.me?.status == s) LIcon(LinkordIcons.Check, size = 16.dp, tint = c.text) },
                        onClick = {
                            statusMenu = false
                            session.launch { session.actions.setStatus(s) }
                        },
                    )
                }
            }
        }
        if (customSheet) CustomStatusSheet { customSheet = false }
    }
}

@Composable
private fun Item(icon: ImageVector, label: String, active: Boolean, badge: Int = 0, onClick: () -> Unit) {
    val c = Linkord.colors
    Column(Modifier.clip(RoundedCornerShape(12.dp)).clickable(onClick = onClick).padding(horizontal = 14.dp, vertical = 6.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Box {
            // The active tab's mark is its own bar above the icon, fully rounded.
            Box(Modifier.size(24.dp), contentAlignment = Alignment.Center) { LIcon(icon, size = 24.dp, tint = if (active) c.text else c.text3) }
            if (badge > 0) CountBadge(badge, Modifier.align(Alignment.TopEnd).padding(start = 14.dp))
        }
        Text(label, style = Linkord.type.label, color = if (active) c.text else c.text3, modifier = Modifier.padding(top = 3.dp))
        Box(Modifier.padding(top = 3.dp).width(if (active) 18.dp else 0.dp).height(3.dp).clip(RoundedCornerShape(2.dp)).background(c.brand))
    }
}

/** A release is out: one line at the top of the home pane, with the download's progress. */
@Composable
private fun UpdateBanner() {
    val session = LocalContext.current.session
    val state by session.updater.state.collectAsState()
    val c = Linkord.colors
    val (text, action) = when (val s = state) {
        is com.linkord.app.data.UpdateState.Available -> t("Linkord {version} is available.", "version" to s.update.version) to (t("Update") to { session.updater.install(s.update) })
        is com.linkord.app.data.UpdateState.Downloading -> t("Updating…") + " ${(s.progress * 100).toInt()}%" to null
        is com.linkord.app.data.UpdateState.Installing -> t("Updating…") to null
        is com.linkord.app.data.UpdateState.Failed -> s.reason to (t("Retry") to { session.updater.install(s.update) })
        com.linkord.app.data.UpdateState.None -> return
    }
    Row(
        Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 8.dp, vertical = 4.dp).clip(RoundedCornerShape(12.dp)).background(c.brandSoft).padding(start = 14.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text, style = Linkord.type.small, color = c.text, modifier = Modifier.weight(1f))
        if (action != null) Text(
            action.first, style = Linkord.type.bodyStrong, color = c.onBrand,
            modifier = Modifier.clip(RoundedCornerShape(10.dp)).background(c.brand).clickable(onClick = action.second).padding(horizontal = 12.dp, vertical = 6.dp),
        )
    }
}
