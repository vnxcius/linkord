package com.linkord.app.ui.chat

import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import com.linkord.app.session
import com.linkord.app.ui.LocalNav
import com.linkord.app.ui.components.LIcon
import com.linkord.designsystem.LinkordIcons

/** A chat video full screen (Media3), streamed with the app's HTTP client; plays at once, stops when closed. */
@OptIn(UnstableApi::class)
@Composable
fun VideoViewer(url: String, name: String, startMs: Long = 0) {
    val ctx = LocalContext.current
    val nav = LocalNav.current
    val player = remember(url) {
        ExoPlayer.Builder(ctx)
            .setMediaSourceFactory(DefaultMediaSourceFactory(OkHttpDataSource.Factory(ctx.session.http)))
            .build()
            .apply {
                setMediaItem(MediaItem.fromUri(url), startMs)
                prepare()
                playWhenReady = true
            }
    }
    DisposableEffect(player) { onDispose { player.release() } }
    Box(Modifier.fillMaxSize().background(Color.Black)) {
        AndroidView(factory = { PlayerView(it).apply { this.player = player; setShowNextButton(false); setShowPreviousButton(false) } }, modifier = Modifier.fillMaxSize())
        Box(
            Modifier.align(Alignment.TopStart).statusBarsPadding().padding(8.dp).size(44.dp).clip(RoundedCornerShape(22.dp))
                .background(Color.Black.copy(alpha = 0.4f)).clickable { nav.pop() },
            contentAlignment = Alignment.Center,
        ) { LIcon(LinkordIcons.Close, tint = Color.White) }
    }
}
