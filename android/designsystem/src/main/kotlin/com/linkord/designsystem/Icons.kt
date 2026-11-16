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
