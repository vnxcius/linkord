package com.linkord.designsystem

import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.graphics.vector.group
import androidx.compose.ui.unit.dp
import androidx.compose.ui.graphics.Color

/** One shape of an icon on Heroicons' 24px grid: stroked (1.5, round caps and joins) and/or filled. */
class P(val d: String, val stroke: Boolean = true, val fill: Boolean = false, val width: Float = 1.5f, val evenOdd: Boolean = false)

internal fun icon(name: String, rotate: Float, vararg shapes: P): ImageVector =
    ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f).apply {
        group(rotate = rotate, pivotX = 12f, pivotY = 12f) {
            for (p in shapes) {
                addPath(
                    pathData = addPathNodes(p.d),
                    pathFillType = if (p.evenOdd) PathFillType.EvenOdd else PathFillType.NonZero,
                    fill = if (p.fill) SolidColor(Color.Black) else null,
                    stroke = if (p.stroke) SolidColor(Color.Black) else null,
                    strokeLineWidth = p.width,
                    strokeLineCap = StrokeCap.Round,
                    strokeLineJoin = StrokeJoin.Round,
                )
            }
        }
    }.build()

/**
 * The mark alone (design/linkord-mark.svg): the wings and the Triforce, in one colour. The Direct Messages tile
 * draws it like any other tile's content (Icons.tsx `Mark`).
 */
val LinkordMark: ImageVector by lazy {
    ImageVector.Builder("Mark", 24.dp, 24.dp, 444f, 444f).apply {
        group(translationX = -34f, translationY = -9f) {
            addPath(
                addPathNodes("M176.3 176L68.5 123.4L50.9 159.3L111.3 212.7L66.4 214.7L48.9 250.6L114.7 282.7Z M335.7 176L443.5 123.4L461.1 159.3L400.7 212.7L445.6 214.7L463.1 250.6L397.3 282.7Z"),
                fill = SolidColor(Color.Black), stroke = SolidColor(Color.Black), strokeLineWidth = 20f, strokeLineJoin = StrokeJoin.Round,
            )
            addPath(
                addPathNodes("M256 110L395.7 352L116.3 352Z M188 232.1L324 232.1L256 349.8Z"),
                pathFillType = PathFillType.EvenOdd,
                fill = SolidColor(Color.Black), stroke = SolidColor(Color.Black), strokeLineWidth = 12f, strokeLineJoin = StrokeJoin.Round,
            )
        }
    }.build()
}

/**
 * Presence marks (the web's app/src/lib/presence-marks.ts; keep the numbers in step): triangles from the app icon with
 * rounded corners, in a 100-unit box. online = solid, idle = the Triforce (middle missing), dnd = upside down,
 * offline = an empty outline [OUTLINE] wide.
 */
object PresenceMarks {
    const val ROUND = 0.2f
    const val OUTLINE = 20f
    private const val S = 100f
    private val W = S * (1.14f + ROUND * 0.5f)
    private val H = W * 0.866f
    private const val CX = S / 2
    private val TOP = S / 2 - H / 2 + S * 0.04f
    private val BOT = S / 2 + H / 2 + S * 0.04f
    private val LEFT = CX - W / 2
    private val RIGHT = CX + W / 2
    private val R = S * ROUND

    private fun roundTri(pts: List<Pair<Float, Float>>, r: Float): String {
        val t = r * kotlin.math.sqrt(3f)
        fun along(a: Pair<Float, Float>, b: Pair<Float, Float>, d: Float): Pair<Float, Float> {
            val l = kotlin.math.hypot(b.first - a.first, b.second - a.second)
            return (a.first + (b.first - a.first) / l * d) to (a.second + (b.second - a.second) / l * d)
        }
        val sb = StringBuilder()
        pts.forEachIndexed { i, p ->
            val a = along(p, pts[(i + 2) % 3], t)
            val b = along(p, pts[(i + 1) % 3], t)
            sb.append(if (i == 0) "M" else "L").append("${a.first},${a.second}")
            sb.append("A$r,$r 0 0 1 ${b.first},${b.second}")
        }
        return sb.append("Z").toString()
    }

    private val UP = listOf(CX to TOP, RIGHT to BOT, LEFT to BOT)
    private val DOWN = listOf(LEFT to TOP, RIGHT to TOP, CX to TOP + H)
    private val HOLE = listOf((LEFT + CX) / 2 to (TOP + BOT) / 2, (RIGHT + CX) / 2 to (TOP + BOT) / 2, CX to BOT)
    private val G = (TOP + 2 * BOT) / 3
    private val K = 1 - (OUTLINE * 1.9f) / H
    private val INNER = UP.map { (x, y) -> (CX + (x - CX) * K) to (G + (y - G) * K) }

    private fun path(d: String, evenOdd: Boolean = false) = androidx.compose.ui.graphics.vector.PathParser().parsePathString(d).toPath()
        .apply { if (evenOdd) fillType = PathFillType.EvenOdd }

    val up by lazy { path(roundTri(UP, R)) }
    val down by lazy { path(roundTri(DOWN, R)) }
    val triforce by lazy { path(roundTri(UP, R) + roundTri(HOLE, R * 0.45f), evenOdd = true) }
    val inner by lazy { path(roundTri(INNER, maxOf(0f, R * K - OUTLINE / 2))) }

    /** The outer shape of a status's mark (what a ring is drawn around). */
    fun outline(status: String) = if (status == "dnd") down else up

    /** The mark itself, filled; null for offline (drawn as [inner] stroked [OUTLINE] wide). */
    fun body(status: String) = when (status) {
        "online" -> up
        "idle" -> triforce
        "dnd" -> down
        else -> null
    }
}
