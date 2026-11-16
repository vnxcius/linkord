package com.linkord.app.ui.call

import android.annotation.SuppressLint
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import com.linkord.app.session
import com.linkord.app.ui.components.Kicker
import com.linkord.app.ui.components.LIcon
import com.linkord.core.Watch
import com.linkord.core.t
import com.linkord.designsystem.Linkord
import com.linkord.designsystem.LinkordIcons
import kotlinx.coroutines.launch
import org.json.JSONObject
import kotlin.math.abs

/** Where the shared video should be now (seconds), on the server's clock (watch.rs). */
fun expectedPosition(w: Watch, clockSkew: Long): Double =
    if (w.playing && !w.live) w.position + ((System.currentTimeMillis() + clockSkew) - w.updatedAt) / 1000.0 else w.position

/**
 * What the call is watching together: an invitation until you open it (watching is opt-in, like a stream), then the
 * player. Everyone in the call can play, pause and seek; the server keeps the time.
 */
@Composable
fun WatchTile(channelId: String, here: Boolean) {
    val session = LocalContext.current.session
    val st by session.store.state.collectAsState()
    val c = Linkord.colors
    val scope = rememberCoroutineScope()
    val w = st.watches[channelId] ?: return
    val me = st.me?.id
    val open = me != null && me in w.viewers
    fun view(on: Boolean) = scope.launch { runCatching { session.api.send("PUT", "/channels/$channelId/watch/view", mapOf("on" to on)) } }
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp).clip(RoundedCornerShape(16.dp)).background(c.panel)) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            LIcon(LinkordIcons.Tv, size = 18.dp)
            Spacer(Modifier.width(8.dp))
            Kicker(when (w.provider) { "youtube" -> "YouTube"; "twitch" -> "Twitch"; "kick" -> "Kick"; else -> t("Clip") } + " · " +
                com.linkord.core.plural(w.viewers.size, "{n} watching", "{n} watching"), Modifier.weight(1f))
            if (open) Text(t("Hide"), style = Linkord.type.small, color = c.text2, modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable { view(false) }.padding(6.dp))
            if (here) Text(t("Stop"), style = Linkord.type.small, color = c.danger, modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable {
                scope.launch { runCatching { session.api.send("DELETE", "/channels/$channelId/watch") } }
            }.padding(6.dp))
        }
        Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).background(Color.Black), contentAlignment = Alignment.Center) {
            when {
                !open -> Button(
                    onClick = { view(true) }, enabled = here,
                    colors = ButtonDefaults.buttonColors(containerColor = c.brand, contentColor = c.onBrand),
                ) { Text(t("Watch together")) }
                w.ended -> Text(t("Video ended"), color = Color.White)
                w.provider == "clip" -> ClipWatch(channelId, w, st.clockSkew)
                else -> EmbedWatch(channelId, w, st.clockSkew)
            }
        }
    }
}

/** Starts watching a link together (YouTube, Twitch, Kick or a clip of this server). */
@Composable
fun StartWatch(channelId: String, onDone: () -> Unit) {
    val session = LocalContext.current.session
    val scope = rememberCoroutineScope()
    val c = Linkord.colors
    var link by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    androidx.compose.ui.window.Dialog(onDone) {
        Column(Modifier.clip(RoundedCornerShape(18.dp)).background(c.panel).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(t("Watch together"), style = Linkord.type.title)
            OutlinedTextField(link, { link = it; error = null }, singleLine = true, placeholder = { Text("https://youtu.be/…") }, modifier = Modifier.fillMaxWidth())
            error?.let { Text(it, style = Linkord.type.small, color = c.danger) }
            Row {
                TextButton(onClick = onDone) { Text(t("Cancel"), color = c.text2) }
                Spacer(Modifier.weight(1f))
                Button(onClick = {
                    scope.launch {
                        runCatching { session.api.send("PUT", "/channels/$channelId/watch", mapOf("url" to link.trim())) }
                            .onSuccess { onDone() }.onFailure { error = session.describe(it) }
                    }
                }, enabled = link.isNotBlank(), colors = ButtonDefaults.buttonColors(containerColor = c.brand, contentColor = c.onBrand)) { Text(t("Start")) }
            }
        }
    }
}

/** A shared REC clip: played natively, kept in step with the call. */
@OptIn(UnstableApi::class)
@Composable
private fun ClipWatch(channelId: String, w: Watch, skew: Long) {
    val ctx = LocalContext.current
    val session = ctx.session
    val scope = rememberCoroutineScope()
    val player = remember(w.media) {
        ExoPlayer.Builder(ctx).setMediaSourceFactory(DefaultMediaSourceFactory(OkHttpDataSource.Factory(session.http))).build().apply {
            setMediaItem(MediaItem.fromUri("${session.serverUrl()}/uploads/clips/${w.media}.mp4"))
            prepare()
        }
    }
    DisposableEffect(player) { onDispose { player.release() } }
    // The call's time and state into the player.
    LaunchedEffect(w.playing, w.position, w.updatedAt) {
        val want = (expectedPosition(w, skew) * 1000).toLong()
        if (abs(player.currentPosition - want) > 1500) player.seekTo(want)
        player.playWhenReady = w.playing
    }
    // What you do with the player's controls, to everyone.
    DisposableEffect(player) {
        val l = object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                if (isPlaying != w.playing && player.playbackState == Player.STATE_READY) {
                    scope.launch { runCatching { session.api.send("PATCH", "/channels/$channelId/watch", mapOf("playing" to isPlaying, "position" to player.currentPosition / 1000.0)) } }
                }
            }

            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_ENDED) scope.launch { runCatching { session.api.send("PATCH", "/channels/$channelId/watch", mapOf("ended" to true)) } }
            }
        }
        player.addListener(l)
        onDispose { player.removeListener(l) }
    }
    AndroidView({ PlayerView(it).apply { this.player = player } }, Modifier.fillMaxSize())
}

/**
 * YouTube, Twitch and Kick through their own web players, in a small WebView inside the call (the app's only web
 * content). YouTube is driven through its postMessage protocol (no IFrame API script), like the web client's
 * lib/watch.ts; live streams just play.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun EmbedWatch(channelId: String, w: Watch, skew: Long) {
    val session = LocalContext.current.session
    val scope = rememberCoroutineScope()
    val base = session.serverUrl()
    val host = android.net.Uri.parse(base).host ?: "linkord.app"
    var view by remember { mutableStateOf<WebView?>(null) }
    // Our own commands echo back as player events: ignore those for a moment.
    var quietUntil by remember { mutableStateOf(0L) }
    val src = remember(w.provider, w.media) {
        val at = expectedPosition(w, skew).toInt()
        when (w.provider) {
            "youtube" -> "https://www.youtube.com/embed/${w.media}?enablejsapi=1&autoplay=1&playsinline=1&rel=0&start=$at&origin=${android.net.Uri.encode(base)}"
            "twitch" -> if (w.media.startsWith("v")) "https://player.twitch.tv/?video=${w.media}&time=${at}s&parent=$host&autoplay=true" else "https://player.twitch.tv/?channel=${w.media}&parent=$host&autoplay=true"
            else -> "https://player.kick.com/${w.media}?autoplay=true"
        }
    }
    val bridge = remember {
        object {
            @JavascriptInterface
            fun state(json: String) {
                val o = runCatching { JSONObject(json) }.getOrNull() ?: return
                if (System.currentTimeMillis() < quietUntil || w.live) return
                val s = o.optInt("state", -9)
                val time = o.optDouble("time", Double.NaN)
                Handler(Looper.getMainLooper()).post {
                    val cur = session.store.s.watches[channelId] ?: return@post
                    when {
                        s == 0 && !cur.ended -> scope.launch { runCatching { session.api.send("PATCH", "/channels/$channelId/watch", mapOf("ended" to true)) } }
                        s == 1 && !cur.playing -> scope.launch { runCatching { session.api.send("PATCH", "/channels/$channelId/watch", mapOf("playing" to true, "position" to time)) } }
                        s == 2 && cur.playing -> scope.launch { runCatching { session.api.send("PATCH", "/channels/$channelId/watch", mapOf("playing" to false, "position" to time)) } }
                    }
                }
            }
        }
    }
    val html = remember(src) {
        """<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;height:100%;background:#000}iframe{border:0;width:100%;height:100%}</style></head><body>
<iframe id="p" src="$src" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>
<script>
var f=document.getElementById('p');
function post(m){f.contentWindow.postMessage(JSON.stringify(m),'*');}
function cmd(func,args){post({event:'command',func:func,args:args||[],id:1,channel:'widget'});}
var heard=false;var iv=setInterval(function(){if(heard)return clearInterval(iv);post({event:'listening',id:1,channel:'widget'});},250);
window.addEventListener('message',function(e){var m;try{m=JSON.parse(e.data);}catch(x){return;}heard=true;
 if(m.event==='onStateChange')Linkord.state(JSON.stringify({state:m.info,time:window.__t||0}));
 if(m.event==='infoDelivery'&&m.info){if(typeof m.info.currentTime==='number')window.__t=m.info.currentTime;}});
</script></body></html>"""
    }
    // The call's state into the YouTube player.
    LaunchedEffect(view, w.playing, w.position, w.updatedAt) {
        val v = view ?: return@LaunchedEffect
        if (w.provider != "youtube" || w.live) return@LaunchedEffect
        quietUntil = System.currentTimeMillis() + 1200
        val at = expectedPosition(w, skew)
        v.evaluateJavascript("if(Math.abs((window.__t||0)-$at)>2)cmd('seekTo',[$at,true]);cmd('${if (w.playing) "playVideo" else "pauseVideo"}');", null)
    }
    AndroidView(
        factory = { ctx ->
            WebView(ctx).apply {
                // Match the tile: with Compose's default wrap-content the page sees a zero-height viewport and the
                // player collapses to nothing.
                layoutParams = android.view.ViewGroup.LayoutParams(android.view.ViewGroup.LayoutParams.MATCH_PARENT, android.view.ViewGroup.LayoutParams.MATCH_PARENT)
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.mediaPlaybackRequiresUserGesture = false
                webChromeClient = WebChromeClient()
                if (com.linkord.app.BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
                addJavascriptInterface(bridge, "Linkord")
                loadDataWithBaseURL(base, html, "text/html", "utf-8", null)
                view = this
            }
        },
        onRelease = { it.destroy() },
        modifier = Modifier.fillMaxSize(),
    )
}
