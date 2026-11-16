package com.linkord.app.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import kotlin.math.sin
import kotlin.random.Random

/**
 * The Christmas theme's snow (desktop Christmas.tsx Snow, much lighter): a few dozen flakes drawn on one canvas,
 * only while it's on screen. Callers leave it out with reduced motion.
 */
@Composable
fun Snowfall(modifier: Modifier = Modifier, count: Int = 48) {
    class Flake(var x: Float, var y: Float, val r: Float, val speed: Float, val drift: Float, val phase: Float)
    val flakes = remember { List(count) { Flake(Random.nextFloat(), Random.nextFloat(), 1.2f + Random.nextFloat() * 2.4f, 0.025f + Random.nextFloat() * 0.05f, 0.004f + Random.nextFloat() * 0.01f, Random.nextFloat() * 6.28f) } }
    var tick by remember { mutableLongStateOf(0L) }
    LaunchedEffect(Unit) {
        var last = 0L
        while (true) withFrameNanos { now ->
            val dt = if (last == 0L) 0f else ((now - last) / 1e9f).coerceAtMost(0.05f)
            last = now
            for (f in flakes) {
                f.y += f.speed * dt
                f.x += sin((now / 1e9f) + f.phase) * f.drift * dt
                if (f.y > 1.02f) { f.y = -0.02f; f.x = Random.nextFloat() }
            }
            tick = now
        }
    }
    Canvas(modifier) {
        @Suppress("UNUSED_EXPRESSION") tick
        for (f in flakes) drawCircle(Color.White.copy(alpha = 0.55f), f.r * density, Offset(f.x * size.width, f.y * size.height))
    }
}
