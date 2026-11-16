package com.linkord.designsystem

import android.provider.Settings
import androidx.compose.animation.core.AnimationSpec
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Linkord's colours (app/src/styles.css): Aço grays (steel-tinted graphite) and Algodão, the brand with no hue
 * (cotton on dark, ink on light). Light has its own values, never the dark ones inverted. Layers: desk (behind
 * everything) -> panel (channel list) -> page (the chat) -> raised (inputs, cards) -> raised2.
 */
@Immutable
data class LinkordColors(
    val dark: Boolean,
    val desk: Color,
    val panel: Color,
    val page: Color,
    val raised: Color,
    val raised2: Color,
    val hover: Color,
    val active: Color,
    val line: Color,
    val lineStrong: Color,
    val text: Color,
    val text2: Color,
    val text3: Color,
    val brand: Color,
    val brandHi: Color,
    /** How strong brand tints are: 1 on dark, 0.45 on light (ink at 13% on white is a muddy block, not a wash). */
    val tint: Float,
    val onBrand: Color,
    val online: Color,
    val speaking: Color,
    val idle: Color,
    val dnd: Color,
    val offline: Color,
    val danger: Color,
) {
    /** rgb(var(--brand-rgb) / calc(a * var(--tint))) */
    fun brandTint(alpha: Float) = brand.copy(alpha = (alpha * tint).coerceIn(0f, 1f))
    val brandSoft get() = brandTint(0.13f)
    val speakingSoft get() = speaking.copy(alpha = if (dark) 0.18f else 0.16f)

    fun status(s: String?) = when (s) {
        "online" -> online
        "idle" -> idle
        "dnd" -> dnd
        else -> offline
    }
}

val DarkColors = LinkordColors(
    dark = true,
    desk = Color(0xFF0C0E11),
    panel = Color(0xFF14171C),
    page = Color(0xFF181C23),
    raised = Color(0xFF20252C),
    raised2 = Color(0xFF272D36),
    hover = Color.White.copy(alpha = 0.045f),
    active = Color.White.copy(alpha = 0.075f),
    line = Color(0xFF222831),
    lineStrong = Color(0xFF2E3540),
    text = Color(0xFFEBEDEF),
    text2 = Color(0xFFB2B7BF),
    text3 = Color(0xFF878F9B),
    brand = Color(0xFFECE8E1),
    brandHi = Color(0xFFFFFFFF),
    tint = 1f,
    onBrand = Color(0xFF151413),
    online = Color(0xFF3BA55D),
    speaking = Color(0xFF3BA55D),
    idle = Color(0xFFF0B232),
    dnd = Color(0xFFD83C3E),
    offline = Color(0xFF80848E),
    danger = Color(0xFFE5484D),
)

val LightColors = LinkordColors(
    dark = false,
    desk = Color(0xFFE3E7ED),
    panel = Color(0xFFF2F4F6),
    page = Color(0xFFFBFBFC),
    raised = Color(0xFFECEFF3),
    raised2 = Color(0xFFE0E4EB),
    hover = Color.Black.copy(alpha = 0.045f),
    active = Color.Black.copy(alpha = 0.075f),
    line = Color(0xFFDCE1E9),
    lineStrong = Color(0xFFC9D1DC),
    text = Color(0xFF16181C),
    text2 = Color(0xFF444A52),
    text3 = Color(0xFF666F7D),
    brand = Color(0xFF22201D),
    brandHi = Color(0xFF000000),
    tint = 0.45f,
    onBrand = Color(0xFFFFFFFF),
    online = Color(0xFF2C8A4B),
    speaking = Color(0xFF2C8A4B),
    idle = Color(0xFFC98A0C),
    dnd = Color(0xFFCF3537),
    offline = Color(0xFF8A8E97),
    danger = Color(0xFFD4363B),
)

/**
 * The Christmas theme (styles.css [data-theme=christmas]): the dark theme's layers in evergreen, the brand (cotton)
 * still the accent; the online/speaking green brighter so it shows against the green.
 */
val ChristmasColors = DarkColors.copy(
    desk = Color(0xFF09130F),
    panel = Color(0xFF0F1E18),
    page = Color(0xFF13251D),
    raised = Color(0xFF1A3026),
    raised2 = Color(0xFF233C30),
    hover = Color(0xFFE2FFEE).copy(alpha = 0.05f),
    active = Color(0xFFE2FFEE).copy(alpha = 0.085f),
    line = Color(0xFF1E362B),
    lineStrong = Color(0xFF2D4A3B),
    text = Color(0xFFEEF4EF),
    text2 = Color(0xFFBBCBC0),
    text3 = Color(0xFF8FA698),
    online = Color(0xFF4CD07F),
    speaking = Color(0xFF4CD07F),
    offline = Color(0xFF8A978F),
)

private fun variable(res: Int, weight: Int) =
    Font(res, FontWeight(weight), variationSettings = FontVariation.Settings(FontVariation.weight(weight)))

/** Geist for text. */
val Geist = FontFamily(listOf(400, 500, 600, 700).map { variable(R.font.geist, it) })

/** Geist Mono for labels, times and counts. */
val GeistMono = FontFamily(listOf(400, 500, 600).map { variable(R.font.geist_mono, it) })

/**
 * Twemoji (CC-BY 4.0, the web client's patched twemoji.woff2 as TTF, COLRv0), so emoji look the same on every client.
 * Used for emoji runs inside text (appendWithEmoji / emojiText), not as a whole-text family. Made by
 * app/scripts/patch-twemoji.py, which also gives this copy a cmap format 14 table: without it Android takes any
 * character followed by U+FE0F from the system emoji font, splitting 🏳️‍🌈 into two pictures.
 */
val Twemoji = FontFamily(Font(R.font.twemoji))

/** Instrument Serif: titles only, 20sp and up (one weight). */
val InstrumentSerif = FontFamily(Font(R.font.instrument_serif))

@Immutable
data class LinkordType(
    /** Big serif titles: a channel's or server's name. */
    val display: TextStyle,
    val title: TextStyle,
    val body: TextStyle,
    val bodyStrong: TextStyle,
    val small: TextStyle,
    /** Running heads, kickers, counts: Geist Mono, a little spaced. */
    val label: TextStyle,
    val mono: TextStyle,
)

private fun type(c: LinkordColors) = LinkordType(
    display = TextStyle(fontFamily = InstrumentSerif, fontSize = 28.sp, lineHeight = 32.sp, color = c.text),
    title = TextStyle(fontFamily = InstrumentSerif, fontSize = 22.sp, lineHeight = 26.sp, color = c.text),
    body = TextStyle(fontFamily = Geist, fontSize = 15.sp, lineHeight = 21.sp, color = c.text),
    bodyStrong = TextStyle(fontFamily = Geist, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, lineHeight = 21.sp, color = c.text),
    small = TextStyle(fontFamily = Geist, fontSize = 13.sp, lineHeight = 18.sp, color = c.text2),
    label = TextStyle(fontFamily = GeistMono, fontWeight = FontWeight.Medium, fontSize = 11.sp, lineHeight = 14.sp, letterSpacing = 0.6.sp, color = c.text3),
    mono = TextStyle(fontFamily = GeistMono, fontSize = 13.sp, lineHeight = 18.sp, color = c.text2),
)

/**
 * One set of springs used everywhere (CLAUDE.md, Android Design: motion). With the system's "Remove animations"
 * every spec snaps.
 */
@Immutable
class LinkordMotion(val reduced: Boolean) {
    fun <T> standard(): FiniteAnimationSpec<T> = if (reduced) snap() else spring(dampingRatio = 0.9f, stiffness = 420f)
    fun <T> emphasized(): FiniteAnimationSpec<T> = if (reduced) snap() else spring(dampingRatio = 0.78f, stiffness = 260f)
    fun <T> quick(): FiniteAnimationSpec<T> = if (reduced) snap() else spring(dampingRatio = Spring.DampingRatioNoBouncy, stiffness = 1400f)
    val offset: FiniteAnimationSpec<IntOffset> get() = if (reduced) snap() else spring(dampingRatio = 0.9f, stiffness = 420f, visibilityThreshold = IntOffset(1, 1))
}

val LocalColors = staticCompositionLocalOf { DarkColors }
val LocalType = staticCompositionLocalOf { type(DarkColors) }
val LocalMotion = staticCompositionLocalOf { LinkordMotion(false) }

object Linkord {
    val colors: LinkordColors @Composable get() = LocalColors.current
    val type: LinkordType @Composable get() = LocalType.current
    val motion: LinkordMotion @Composable get() = LocalMotion.current
}

/** Avatars and server tiles are rounded squares (--avatar-radius: 30%). */
val AvatarShape = RoundedCornerShape(30)
val PanelShape = RoundedCornerShape(14.dp)
val CardShape = RoundedCornerShape(12.dp)
val SmallShape = RoundedCornerShape(8.dp)

private fun scheme(c: LinkordColors): ColorScheme {
    val base = if (c.dark) darkColorScheme() else lightColorScheme()
    return base.copy(
        primary = c.brand, onPrimary = c.onBrand, primaryContainer = c.brandSoft, onPrimaryContainer = c.text,
        secondary = c.text2, onSecondary = c.page, secondaryContainer = c.raised, onSecondaryContainer = c.text,
        tertiary = c.text2, onTertiary = c.page,
        background = c.page, onBackground = c.text, surface = c.page, onSurface = c.text,
        surfaceVariant = c.raised, onSurfaceVariant = c.text2, surfaceTint = Color.Transparent,
        surfaceContainerLowest = c.desk, surfaceContainerLow = c.panel, surfaceContainer = c.panel,
        surfaceContainerHigh = c.raised, surfaceContainerHighest = c.raised2, surfaceBright = c.raised2, surfaceDim = c.desk,
        inverseSurface = c.text, inverseOnSurface = c.page, inversePrimary = c.brand,
        outline = c.lineStrong, outlineVariant = c.line, error = c.danger, onError = Color.White,
        errorContainer = c.danger.copy(alpha = 0.15f), onErrorContainer = c.danger, scrim = Color.Black.copy(alpha = 0.5f),
    )
}

/** Theme preference: follow the system (default), or force one. */
enum class ThemeMode { System, Dark, Light, Christmas }

@Composable
fun LinkordTheme(mode: ThemeMode = ThemeMode.System, content: @Composable () -> Unit) {
    val dark = when (mode) {
        ThemeMode.System -> isSystemInDarkTheme()
        ThemeMode.Dark, ThemeMode.Christmas -> true
        ThemeMode.Light -> false
    }
    val colors = when {
        mode == ThemeMode.Christmas -> ChristmasColors
        dark -> DarkColors
        else -> LightColors
    }
    val context = LocalContext.current
    val reduced = remember(context) {
        Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    }
    val t = remember(colors) { type(colors) }
    val typography = remember(t) {
        // Material's own components (buttons, fields, menus) choose their text colour; ours would override it.
        val t = t.copy(
            display = t.display.copy(color = Color.Unspecified), title = t.title.copy(color = Color.Unspecified),
            body = t.body.copy(color = Color.Unspecified), bodyStrong = t.bodyStrong.copy(color = Color.Unspecified),
            small = t.small.copy(color = Color.Unspecified), label = t.label.copy(color = Color.Unspecified),
            mono = t.mono.copy(color = Color.Unspecified),
        )
        Typography().let { d ->
            d.copy(
                displayLarge = t.display, displayMedium = t.display, displaySmall = t.title,
                headlineLarge = t.display, headlineMedium = t.title, headlineSmall = t.title,
                titleLarge = t.title, titleMedium = t.bodyStrong, titleSmall = t.bodyStrong.copy(fontSize = 14.sp),
                bodyLarge = t.body, bodyMedium = t.body.copy(fontSize = 14.sp), bodySmall = t.small,
                labelLarge = t.bodyStrong.copy(fontSize = 14.sp), labelMedium = t.small, labelSmall = t.label,
            )
        }
    }
    CompositionLocalProvider(LocalColors provides colors, LocalType provides t, LocalMotion provides LinkordMotion(reduced)) {
        MaterialTheme(
            colorScheme = scheme(colors),
            typography = typography,
            shapes = Shapes(extraSmall = SmallShape, small = SmallShape, medium = CardShape, large = PanelShape, extraLarge = RoundedCornerShape(24.dp)),
            content = content,
        )
    }
}
