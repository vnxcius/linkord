package com.linkord.app.ui.profile

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import com.linkord.app.session
import com.linkord.app.ui.LocalNav
import com.linkord.app.ui.Screen
import com.linkord.app.ui.chat.MarkdownText
import com.linkord.app.ui.chat.MdTap
import com.linkord.app.ui.chat.openLink
import com.linkord.app.ui.components.Avatar
import com.linkord.app.ui.components.Kicker
import com.linkord.app.ui.components.LIcon
import com.linkord.app.ui.components.ServerTile
import com.linkord.app.ui.components.mediaUrl
import com.linkord.app.ui.home.activityLine
import com.linkord.core.Rel
import com.linkord.core.User
import com.linkord.core.can
import com.linkord.core.memberRoles
import com.linkord.core.nameOf
import com.linkord.core.presenceOf
import com.linkord.core.profileOf
import com.linkord.core.t
import com.linkord.designsystem.Linkord
import com.linkord.designsystem.LinkordIcons
import kotlinx.coroutines.launch
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

@Serializable
data class Badge(val id: String, val tier: Int? = null)

@Serializable
data class ProfileLink(val url: String, val label: String = "")

fun linkName(l: ProfileLink): String = com.linkord.core.linkName(l.url, l.label)

@Serializable
data class Profile(
    val user: User,
    @SerialName("mutual_friends") val mutualFriends: List<User> = emptyList(),
    @SerialName("mutual_guilds") val mutualGuilds: List<String> = emptyList(),
    @SerialName("created_at") val createdAt: String? = null,
    val links: List<ProfileLink> = emptyList(),
    val note: String = "",
    val badges: List<Badge> = emptyList(),
    /** Only on your own profile: the widget switches (Edit Profile). */
    @SerialName("show_stats") val showStats: Boolean? = null,
    @SerialName("show_top_songs") val showTopSongs: Boolean? = null,
)

private val TIERS = listOf("bronze", "silver", "gold", "platinum", "diamond")
private val LADDERS = setOf("member", "calls", "played", "games", "live", "watch", "sounds", "snowball", "clips", "views", "recorded")

/** A badge's picture (the web client's assets/badges): milestones are <id>-<tier>.svg, the others <id>.svg. */
fun badgeArt(b: Badge): String {
    val name = when {
        b.id.startsWith("christmas_") -> "christmas"
        b.id in LADDERS && b.tier != null -> "${b.id}-${TIERS[b.tier.coerceIn(0, 4)]}"
        else -> b.id
    }
    return "file:///android_asset/badges/$name.svg"
}

/** Someone's full profile: banner, picture, who they are, what you share, and what you can do. */
@OptIn(ExperimentalLayoutApi::class, ExperimentalFoundationApi::class)
@Composable
fun ProfileScreen(userId: String, guildId: String?) {
    val ctx = LocalContext.current
    val session = ctx.session
    val st by session.store.state.collectAsState()
    val nav = LocalNav.current
    val c = Linkord.colors
    val scope = rememberCoroutineScope()
    var profile by remember { mutableStateOf<Profile?>(null) }
    LaunchedEffect(userId) { runCatching { session.api.get<Profile>("/users/$userId/profile") }.onSuccess { profile = it } }
    val user = st.profileOf(userId, guildId) ?: profile?.user ?: return
    val me = st.me?.id == userId
    val rel = st.relationships[userId]

    Column(Modifier.fillMaxSize().background(c.page).verticalScroll(rememberScrollState()).navigationBarsPadding()) {
        Box(Modifier.fillMaxWidth().height(180.dp)) {
            val banner = mediaUrl(user.banner ?: profile?.user?.banner)
            // A tap opens the banner or picture full screen, where it can be zoomed (ImageViewer).
            if (banner != null) AsyncImage(
                banner, t("Banner"), contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize().clickable { nav.push(Screen.Image(banner, "${user.username}-banner")) },
            )
            else Box(Modifier.fillMaxSize().background((user.accentColor ?: profile?.user?.accentColor)?.let { Color(0xFF000000 or it.toLong()) } ?: c.raised2))
            Box(Modifier.statusBarsPadding().padding(8.dp).size(40.dp).clip(RoundedCornerShape(20.dp)).background(Color.Black.copy(alpha = 0.35f)).clickable { nav.pop() }, contentAlignment = Alignment.Center) {
                LIcon(LinkordIcons.Back, tint = Color.White)
            }
            val avatar = mediaUrl(user.avatar)
            Box(
                Modifier.align(Alignment.BottomStart).offset(x = 16.dp, y = 46.dp).clip(RoundedCornerShape(30))
                    .then(if (avatar != null) Modifier.clickable { nav.push(Screen.Image(avatar, "${user.username}-avatar")) } else Modifier),
            ) {
                Box(Modifier.size(104.dp).clip(RoundedCornerShape(30)).background(c.page))
                Avatar(user, 92.dp, Modifier.padding(6.dp), status = st.presenceOf(userId), ring = c.page)
            }
        }
        Column(Modifier.padding(start = 16.dp, end = 16.dp, top = 58.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(st.nameOf(userId, guildId, user.name), style = Linkord.type.display)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(user.username, style = Linkord.type.mono)
                val pronouns = profile?.user?.pronouns ?: user.pronouns
                if (pronouns.isNotEmpty()) Text(" · $pronouns", style = Linkord.type.small)
            }
            activityLine(st, userId)?.let { Text(it, style = Linkord.type.small, color = c.text2) }
            st.activities[userId]?.firstOrNull { it.type == 0 }?.let { com.linkord.app.ui.extras.GameCard(it, Modifier.padding(top = 8.dp)) }
        }

        if (!me) Row(Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Action(LinkordIcons.ChatBubble, t("Message"), Modifier.weight(1f), primary = true) {
                scope.launch {
                    // Straight to the conversation: screens and the members panel close.
                    runCatching { session.actions.dmChannel(userId).id }.onSuccess { id -> nav.stack.clear(); nav.openChat(id) }.onFailure { session.toast(session.describe(it)) }
                }
            }
            when (rel) {
                Rel.FRIEND -> Action(LinkordIcons.Users, t("Friends"), Modifier.weight(1f)) {}
                Rel.INCOMING -> Action(LinkordIcons.Check, t("Accept"), Modifier.weight(1f)) { scope.launch { runCatching { session.actions.friendRequest(userId) } } }
                Rel.OUTGOING -> Action(LinkordIcons.Close, t("Cancel request"), Modifier.weight(1f)) { scope.launch { runCatching { session.actions.removeRelationship(userId) } } }
                Rel.BLOCKED -> Action(LinkordIcons.Close, t("Unblock"), Modifier.weight(1f)) { scope.launch { runCatching { session.actions.removeRelationship(userId) } } }
                else -> if (!user.bot) Action(LinkordIcons.UserPlus, t("Add Friend"), Modifier.weight(1f)) {
                    scope.launch { runCatching { session.actions.friendRequest(userId) }.onFailure { session.toast(session.describe(it)) } }
                }
            }
        } else Spacer(Modifier.height(16.dp))

        profile?.badges?.takeIf { it.isNotEmpty() }?.let { badges ->
            // Tap a badge to see what it is (tap it again to hide).
            var open by remember { mutableStateOf<Badge?>(null) }
            FlowRow(Modifier.padding(horizontal = 16.dp).padding(bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                for (b in badges) {
                    val info = describeBadge(b)
                    Box(
                        Modifier.clip(RoundedCornerShape(8.dp)).background(if (open == b) c.raised2 else Color.Transparent)
                            .clickable { open = if (open == b) null else b }.padding(3.dp),
                    ) { AsyncImage(badgeArt(b), info?.name ?: b.id, modifier = Modifier.size(30.dp)) }
                }
            }
            open?.let { b ->
                val info = describeBadge(b)
                Row(
                    Modifier.padding(horizontal = 16.dp).padding(bottom = 10.dp).fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(c.raised)
                        .clickable { open = null }.padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    AsyncImage(badgeArt(b), null, modifier = Modifier.size(44.dp))
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(info?.name ?: b.id, style = Linkord.type.bodyStrong)
                        if (info?.tierName != null) Kicker(info.tierName)
                        if (info != null && info.line.isNotEmpty()) Text(info.line, style = Linkord.type.small, color = c.text2)
                    }
                }
            }
        }
        Card {
            val bio = user.bio.ifEmpty { profile?.user?.bio ?: "" }
            if (bio.isNotEmpty()) {
                Kicker(t("About Me"))
                MarkdownText(bio, guildId, onTap = { if (it is MdTap.Url) openLink(ctx, it.url) })
                Spacer(Modifier.height(12.dp))
            }
            profile?.createdAt?.let {
                Kicker(t("Member Since"))
                Text(runCatching { DateTimeFormatter.ofLocalizedDate(FormatStyle.LONG).format(Instant.parse(it).atZone(ZoneId.systemDefault())) }.getOrDefault(""), style = Linkord.type.body)
            }
            if (guildId != null) {
                val roles = st.memberRoles(guildId, userId)
                val manage = st.can(guildId, com.linkord.core.Perm.MANAGE_ROLES)
                var editingRoles by remember { mutableStateOf(false) }
                if (editingRoles) com.linkord.app.ui.settings.MemberRolesSheet(guildId, userId) { editingRoles = false }
                if (roles.isNotEmpty() || manage) {
                    Spacer(Modifier.height(12.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Kicker(t("Roles"), Modifier.weight(1f))
                        if (manage) Text(t("Edit roles"), style = Linkord.type.small, color = c.brandHi,
                            modifier = Modifier.clip(RoundedCornerShape(6.dp)).clickable { editingRoles = true }.padding(horizontal = 6.dp, vertical = 2.dp))
                    }
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(top = 4.dp)) {
                        for (r in roles) Row(Modifier.clip(RoundedCornerShape(8.dp)).background(c.raised).padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                            Box(Modifier.size(10.dp).clip(RoundedCornerShape(5.dp)).background(r.color?.takeIf { it != 0 }?.let { Color(0xFF000000 or it.toLong()) } ?: c.text3))
                            Spacer(Modifier.width(6.dp))
                            Text(r.name, style = Linkord.type.small, color = c.text)
                        }
                    }
                }
            }
            profile?.links?.takeIf { it.isNotEmpty() }?.let { links ->
                Spacer(Modifier.height(12.dp))
                Kicker(t("Links"))
                // Chips side by side, each with its site's mark (Instagram, Steam...) and name, like the web profile.
                FlowRow(Modifier.padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (l in links) Row(
                        Modifier.height(36.dp).clip(RoundedCornerShape(18.dp)).background(c.raised).border(1.dp, c.line, RoundedCornerShape(18.dp))
                            .clickable { openLink(ctx, l.url) }.padding(start = 10.dp, end = 14.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        LIcon(com.linkord.app.ui.components.siteIcon(l.url), size = 18.dp, tint = c.text2)
                        Spacer(Modifier.width(7.dp))
                        Text(linkName(l), style = Linkord.type.bodyStrong, color = c.text, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
                    }
                }
            }
        }
        val p = profile
        if (p != null && !me && (p.mutualGuilds.isNotEmpty() || p.mutualFriends.isNotEmpty())) Card {
            if (p.mutualGuilds.isNotEmpty()) {
                Kicker(com.linkord.core.plural(p.mutualGuilds.size, "{n} Mutual Server", "{n} Mutual Servers"))
                for (g in p.mutualGuilds.mapNotNull { st.guilds[it] }) Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).clickable {
                        // To that server: its last channel, or its channel list.
                        nav.stack.clear()
                        session.actions.selectView(g.id)
                        val ch = session.store.s.selected[g.id]
                        if (ch != null && session.store.s.channels[ch] != null) nav.openChat(ch) else nav.openHome()
                    }.padding(vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    ServerTile(g.name, g.icon, 32.dp)
                    Spacer(Modifier.width(10.dp))
                    Text(g.name, style = Linkord.type.body)
                }
            }
            if (p.mutualFriends.isNotEmpty()) {
                Spacer(Modifier.height(8.dp))
                Kicker(com.linkord.core.plural(p.mutualFriends.size, "{n} Mutual Friend", "{n} Mutual Friends"))
                for (f in p.mutualFriends) Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Avatar(f, 32.dp)
                    Spacer(Modifier.width(10.dp))
                    Text(f.name, style = Linkord.type.body)
                }
            }
        }
        if (guildId != null && !me && st.members[guildId]?.containsKey(userId) == true) ModerationCard(guildId, userId, user)
        if (!me && rel != Rel.BLOCKED && !user.bot) Text(
            t("Block"), style = Linkord.type.body.copy(fontWeight = FontWeight.Medium), color = c.danger,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 20.dp).clickable { scope.launch { runCatching { session.actions.blockUser(userId) }.onFailure { session.toast(session.describe(it)) } } },
        )
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun Card(content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp).clip(RoundedCornerShape(14.dp)).background(Linkord.colors.panel).padding(16.dp)) { content() }
}

@Composable
private fun Action(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, modifier: Modifier, primary: Boolean = false, onClick: () -> Unit) {
    val c = Linkord.colors
    Row(
        modifier.clip(RoundedCornerShape(12.dp)).background(if (primary) c.brand else c.raised).clickable(onClick = onClick).padding(vertical = 12.dp),
        horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically,
    ) {
        LIcon(icon, size = 18.dp, tint = if (primary) c.onBrand else c.text)
        Spacer(Modifier.width(8.dp))
        Text(label, style = Linkord.type.bodyStrong, color = if (primary) c.onBrand else c.text)
    }
}
