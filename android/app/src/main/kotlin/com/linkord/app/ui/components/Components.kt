package com.linkord.app.ui.components

import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage
import com.linkord.app.session
import com.linkord.core.User
import com.linkord.designsystem.AvatarShape
import com.linkord.designsystem.Linkord
import kotlin.math.absoluteValue

/** A server path (/uploads/...) as a full URL on the server we talk to. */
@Composable
fun mediaUrl(path: String?): String? {
    val ctx = LocalContext.current
    return remember(path) { ctx.session.api.media(path) }
}

/** Placeholder tones for people without a picture, picked from their id so each keeps theirs. */
private val tones = listOf(0xFF5865F2, 0xFF3BA55D, 0xFFE67E22, 0xFFE91E63, 0xFF9B59B6, 0xFF1ABC9C, 0xFF607D8B)

/** A person's picture: a rounded square (--avatar-radius), with their initial when there's none. */
@Composable
fun Avatar(user: User?, size: Dp, modifier: Modifier = Modifier, status: String? = null, speaking: Boolean = false, ring: Color = Linkord.colors.panel) {
    val c = Linkord.colors
    Box(modifier.size(size)) {
        val url = mediaUrl(user?.avatar)
        val speakRing = if (speaking) Modifier.border(2.dp, c.speaking, AvatarShape) else Modifier
        Box(Modifier.size(size).clip(AvatarShape).then(speakRing).background(Color(tones[(user?.id?.hashCode() ?: 0).absoluteValue % tones.size])), contentAlignment = Alignment.Center) {
            if (url != null) {
                AsyncImage(url, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.size(size))
            } else {
                Text(
                    (user?.name ?: "?").take(1).uppercase(),
                    color = Color.White,
                    fontSize = (size.value * 0.42f).sp,
                    fontWeight = FontWeight.SemiBold,
                    style = Linkord.type.body,
                )
            }
        }
        if (status != null) StatusDot(status, size, ring = ring, modifier = Modifier.align(Alignment.BottomEnd))
    }
}

/** The status mark in an avatar's corner (PresenceMark), cut out of the picture by a ring of [ring] around it. */
@Composable
fun StatusDot(status: String, avatar: Dp, modifier: Modifier = Modifier, ring: Color = Linkord.colors.panel) {
    // Like the web's (32% of the avatar, less on big ones): the triangles need the room a dot didn't.
    val d = (avatar.value * 0.34f).coerceIn(11f, 24f).dp
    Box(modifier.offset(d * 0.12f, d * 0.12f).size(d), contentAlignment = Alignment.Center) {
        PresenceDot(status, d * 0.7f, ring, ringWidth = d * 0.15f)
    }
}

/**
 * A status's mark, like the desktop's (lib/presence-marks.ts, designsystem PresenceMarks): triangles from the app icon,
 * online solid, idle the Triforce, Do Not Disturb upside down, offline an outline. [ring]: the colour around it in an
 * avatar's corner, [ringWidth] wide (it also fills the outline's middle); null = a bare mark (menus).
 */
@Composable
fun PresenceDot(status: String, size: Dp, ring: Color? = null, modifier: Modifier = Modifier, ringWidth: Dp = 0.dp) {
    val color = Linkord.colors.status(status)
    val marks = com.linkord.designsystem.PresenceMarks
    androidx.compose.foundation.Canvas(modifier.size(size)) {
        val k = this.size.width / 100f
        val ringPx = ringWidth.toPx() / k
        withTransform({ scale(k, k, androidx.compose.ui.geometry.Offset.Zero) }) {
            if (ring != null && ringPx > 0f) {
                val o = marks.outline(status)
                drawPath(o, ring)
                drawPath(o, ring, style = androidx.compose.ui.graphics.drawscope.Stroke(ringPx * 2, join = androidx.compose.ui.graphics.StrokeJoin.Round))
            }
            val body = marks.body(status)
            if (body != null) drawPath(body, color)
            else {
                if (ring != null) drawPath(marks.inner, ring)
                drawPath(marks.inner, color, style = androidx.compose.ui.graphics.drawscope.Stroke(com.linkord.designsystem.PresenceMarks.OUTLINE, join = androidx.compose.ui.graphics.StrokeJoin.Round))
            }
        }
    }
}

/** A count in a red pill (mentions, DMs). */
@Composable
fun CountBadge(n: Int, modifier: Modifier = Modifier, ring: Color = Linkord.colors.desk) {
    if (n <= 0) return
    Box(
        modifier.clip(CircleShape).background(ring).padding(2.dp).clip(CircleShape).background(Linkord.colors.danger)
            .defaultMinSize(minWidth = 18.dp, minHeight = 18.dp).padding(horizontal = 5.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(if (n > 99) "99+" else n.toString(), color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center, style = Linkord.type.label.copy(letterSpacing = 0.sp))
    }
}

/** A server's tile: its icon, or its initials on a raised square. */
@Composable
fun ServerTile(name: String, icon: String?, size: Dp, modifier: Modifier = Modifier, active: Boolean = false) {
    val c = Linkord.colors
    val url = mediaUrl(icon)
    Box(
        modifier.size(size).clip(AvatarShape).background(if (active) c.brand else c.raised),
        contentAlignment = Alignment.Center,
    ) {
        if (url != null) AsyncImage(url, contentDescription = name, contentScale = ContentScale.Crop, modifier = Modifier.size(size))
        else Text(initials(name), color = if (active) c.onBrand else c.text, fontSize = (size.value * 0.34f).sp, fontWeight = FontWeight.SemiBold, style = Linkord.type.body)
    }
}

/** "Hyrule Castle" -> "HC". Whole characters only (an emoji is two chars), and words starting with a letter or digit. */
fun initials(name: String): String =
    name.split(Regex("\\s+")).filter { it.isNotEmpty() && Character.isLetterOrDigit(it.codePointAt(0)) }.take(3)
        .joinToString("") { String(Character.toChars(it.codePointAt(0))) }.ifEmpty { "?" }

/**
 * The active / unread mark beside a tile: its own bar, fully rounded, clear of the tile's corners (the app's rule
 * for active marks). Tall when active, a dot when unread.
 */
@Composable
fun BoxScope.TileMark(active: Boolean, unread: Boolean) {
    val h = when {
        active -> 28.dp
        unread -> 8.dp
        else -> return
    }
    Box(Modifier.align(Alignment.CenterStart).offset(x = (-1).dp).size(width = 4.dp, height = h).clip(RoundedCornerShape(2.dp)).background(Linkord.colors.brand))
}

@Composable
fun LIcon(icon: ImageVector, modifier: Modifier = Modifier, size: Dp = 20.dp, tint: Color = Linkord.colors.text2) {
    Icon(icon, contentDescription = null, modifier = modifier.size(size), tint = tint)
}

/** A small mono label, like the web client's kickers: "TEXT CHANNELS", "No. 03". */
@Composable
fun Kicker(text: String, modifier: Modifier = Modifier, color: Color = Linkord.colors.text3, maxLines: Int = Int.MAX_VALUE) {
    Text(text.uppercase(), modifier = modifier, style = Linkord.type.label, color = color, maxLines = maxLines, overflow = TextOverflow.Ellipsis)
}

/**
 * One line that never wraps or gets cut: the text shrinks (down to [minSize]) to fit what's left, for labels in tight
 * rows (tab bars, buttons) that a small phone or a long translation would otherwise squeeze.
 */
@Composable
fun FitText(text: String, style: androidx.compose.ui.text.TextStyle, modifier: Modifier = Modifier, color: Color = Color.Unspecified, minSize: androidx.compose.ui.unit.TextUnit = 9.sp) {
    androidx.compose.foundation.text.BasicText(
        text, modifier, style = style.copy(color = if (color != Color.Unspecified) color else style.color), maxLines = 1, softWrap = false,
        overflow = TextOverflow.Ellipsis,
        autoSize = androidx.compose.foundation.text.TextAutoSize.StepBased(minFontSize = minSize, maxFontSize = style.fontSize, stepSize = 0.5.sp),
    )
}

@Composable
fun Chip(text: String, modifier: Modifier = Modifier, selected: Boolean = false) {
    val c = Linkord.colors
    Row(
        modifier.clip(RoundedCornerShape(8.dp)).background(if (selected) c.brandSoft else c.raised)
            .then(if (selected) Modifier.border(1.dp, c.brandTint(0.5f), RoundedCornerShape(8.dp)) else Modifier)
            .padding(horizontal = 8.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) { Text(text, style = Linkord.type.small, color = c.text) }
}

private val brandVectors = HashMap<String, androidx.compose.ui.graphics.vector.ImageVector>()

/**
 * A link's icon: the site's own mark for sites we know (core brandOf: Instagram, Twitter, Steam...), otherwise the chain
 * link, like the web's SiteIcon. Brand marks fill their whole grid, so they get Heroicons' 2px of air to match in size.
 */
fun siteIcon(url: String): androidx.compose.ui.graphics.vector.ImageVector {
    val b = com.linkord.core.brandOf(url) ?: return com.linkord.designsystem.LinkordIcons.Link
    return synchronized(brandVectors) {
        brandVectors.getOrPut(b.id) {
            androidx.compose.ui.graphics.vector.ImageVector.Builder(b.name, 24.dp, 24.dp, 28f, 28f).apply {
                addGroup(translationX = 2f, translationY = 2f)
                addPath(androidx.compose.ui.graphics.vector.addPathNodes(b.path), fill = androidx.compose.ui.graphics.SolidColor(Color.Black))
                clearGroup()
            }.build()
        }
    }
}
