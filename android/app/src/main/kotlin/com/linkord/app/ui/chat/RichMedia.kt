package com.linkord.app.ui.chat

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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.produceState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import coil3.compose.AsyncImage
import com.linkord.app.session
import com.linkord.app.ui.LocalNav
import com.linkord.app.ui.Screen
import com.linkord.app.ui.components.Kicker
import com.linkord.app.ui.components.LIcon
import com.linkord.app.ui.components.ServerTile
import com.linkord.app.ui.extras.phaseName
import com.linkord.core.Attachment
import com.linkord.core.Embed
import com.linkord.core.InvitePreview
import com.linkord.core.LinkPlayer
import com.linkord.core.Message
import com.linkord.core.State
import com.linkord.core.gameOf
import com.linkord.core.nameOf
import com.linkord.core.plural
import com.linkord.core.t
import com.linkord.designsystem.Linkord
import com.linkord.designsystem.LinkordIcons
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import okhttp3.Request

/**
 * What plays in the chat right now (an inline video, a song, a site's player): one at a time, like the web client's
 * pauseChatVideo. Starting another stops this one; leaving the app stops it too.
 */
object ChatPlayback {
    var current by mutableStateOf<String?>(null)
}

/**
 * First frames of chat videos, for their posters: read once per video while the app runs (the retriever only fetches what
 * it needs, mostly the start of the file), small enough to keep a few dozen.
 */
private object VideoFrames {
    val cache = android.util.LruCache<String, androidx.compose.ui.graphics.ImageBitmap>(40)

    fun first(url: String): androidx.compose.ui.graphics.ImageBitmap? = runCatching {
        val r = android.media.MediaMetadataRetriever()
        try {
            r.setDataSource(url, emptyMap())
            val bmp = r.getScaledFrameAtTime(0, android.media.MediaMetadataRetriever.OPTION_CLOSEST_SYNC, 640, 640) ?: return null
            bmp.asImageBitmap().also { cache.put(url, it) }
        } finally {
            r.release()
        }
    }.getOrNull()
}

/** Stops [id] when the app goes to the background (its player would otherwise keep going in a cached process). */
@Composable
private fun StopWhenHidden(id: String) {
    LifecycleEventEffect(Lifecycle.Event.ON_STOP) { if (ChatPlayback.current == id) ChatPlayback.current = null }
}

private fun player(ctx: android.content.Context, url: String): ExoPlayer =
    ExoPlayer.Builder(ctx)
        .setMediaSourceFactory(DefaultMediaSourceFactory(OkHttpDataSource.Factory(ctx.session.http)))
        .build()
        .apply {
            setMediaItem(MediaItem.fromUri(url))
            prepare()
            playWhenReady = true
        }

private fun clock(ms: Long): String {
    val s = (ms / 1000).coerceAtLeast(0)
    return if (s >= 3600) "%d:%02d:%02d".format(s / 3600, s / 60 % 60, s % 60) else "%d:%02d".format(s / 60, s % 60)
}

/**
 * A video in the chat, played where it is (the web's VideoPlayer): a poster with a play button until tapped, then
 * Media3 with its controls; the fullscreen button continues in the full-screen viewer. Nothing loads before the tap,
 * so a long chat stays light. [checking]: the server is still looking at the file (videos.rs), so a format the phone
 * can't show may get a copy that it can.
 */
@OptIn(UnstableApi::class)
@Composable
fun InlineVideo(id: String, url: String, name: String, ratio: Float?, poster: String? = null, durationMs: Long? = null, checking: Boolean = false) {
    val ctx = LocalContext.current
    val nav = LocalNav.current
    val c = Linkord.colors
    val playing = ChatPlayback.current == id
    val aspect = (ratio ?: (16f / 9f)).coerceIn(0.5f, 2.4f)
    var noPicture by remember(url) { mutableStateOf(false) }
    var failed by remember(url) { mutableStateOf(false) }
    Column(Modifier.padding(top = 4.dp)) {
        Box(
            Modifier.then(if (aspect < 1f) Modifier.width(220.dp) else Modifier.widthIn(max = 320.dp).fillMaxWidth())
                .aspectRatio(aspect).clip(RoundedCornerShape(10.dp)).background(Color.Black),
            contentAlignment = Alignment.Center,
        ) {
            if (playing && !failed) {
                StopWhenHidden(id)
                val p = remember(url) { player(ctx, url) }
                DisposableEffect(p) {
                    val l = object : Player.Listener {
                        override fun onTracksChanged(tracks: Tracks) {
                            // Sound but no picture: a format this phone can't decode (HEVC, 10-bit...).
                            noPicture = tracks.groups.isNotEmpty() && tracks.groups.none { it.type == C.TRACK_TYPE_VIDEO && it.isSupported }
                        }

                        override fun onPlayerError(error: PlaybackException) {
                            failed = true
                        }
                    }
                    p.addListener(l)
                    onDispose {
                        p.removeListener(l)
                        p.release()
                        if (ChatPlayback.current == id) ChatPlayback.current = null
                    }
                }
                AndroidView(
                    factory = { v ->
                        PlayerView(v).apply {
                            this.player = p
                            setShowNextButton(false)
                            setShowPreviousButton(false)
                            setFullscreenButtonClickListener {
                                val at = p.currentPosition
                                ChatPlayback.current = null
                                nav.push(Screen.Video(url, name, at))
                            }
                        }
                    },
                    modifier = Modifier.fillMaxSize(),
                )
            } else {
                if (poster != null) AsyncImage(poster, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                else {
                    // No poster from the server: the video's first frame, like the web player's preview.
                    val frame by produceState(VideoFrames.cache.get(url), url) {
                        if (value == null) value = withContext(Dispatchers.IO) { VideoFrames.first(url) }
                    }
                    frame?.let { androidx.compose.foundation.Image(it, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize()) }
                }
                if (failed) Text(t("This video can't be played here."), style = Linkord.type.small, color = Color.White, modifier = Modifier.padding(16.dp))
                else Box(
                    Modifier.size(52.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.55f)).clickable { ChatPlayback.current = id },
                    contentAlignment = Alignment.Center,
                ) { LIcon(LinkordIcons.Play, size = 24.dp, tint = Color.White) }
                durationMs?.takeIf { it > 0 }?.let {
                    Text(
                        clock(it), style = Linkord.type.label, color = Color.White,
                        modifier = Modifier.align(Alignment.BottomEnd).padding(8.dp).clip(RoundedCornerShape(4.dp))
                            .background(Color.Black.copy(alpha = 0.6f)).padding(horizontal = 5.dp, vertical = 2.dp),
                    )
                }
            }
        }
        if (noPicture && playing) Row(Modifier.padding(top = 6.dp).widthIn(max = 320.dp), verticalAlignment = Alignment.CenterVertically) {
            LIcon(LinkordIcons.Warning, size = 14.dp, tint = c.text3)
            Spacer(Modifier.width(6.dp))
            Text(
                if (checking) t("This video's format doesn't show here. Linkord is making a copy that does; it appears by itself.")
                else t("This video's picture can't be shown here (its format), only the sound. Download it to watch."),
                style = Linkord.type.small, color = c.text3,
            )
        }
    }
}

/** An audio file in the chat: play, pause and seek right there (the web's <audio controls>). */
@OptIn(UnstableApi::class)
@Composable
fun InlineAudio(id: String, url: String, a: Attachment) {
    val ctx = LocalContext.current
    val c = Linkord.colors
    val playing = ChatPlayback.current == id
    var p by remember(url) { mutableStateOf<ExoPlayer?>(null) }
    var position by remember(url) { mutableFloatStateOf(0f) }
    var length by remember(url) { mutableStateOf((a.durationSecs ?: 0.0).times(1000).toLong()) }
    var now by remember(url) { mutableStateOf(0L) }
    if (playing) StopWhenHidden(id)
    // Another player started (or the app left): pause, keep the place.
    LaunchedEffect(playing) { if (!playing) p?.pause() }
    LaunchedEffect(playing, p) {
        while (playing) {
            p?.let { pl ->
                if (pl.duration > 0) {
                    length = pl.duration
                    position = pl.currentPosition.toFloat() / pl.duration
                }
                now = pl.currentPosition
                if (pl.playbackState == Player.STATE_ENDED) {
                    ChatPlayback.current = null
                    pl.seekTo(0)
                    pl.pause()
                }
            }
            delay(200)
        }
    }
    DisposableEffect(url) { onDispose { p?.release() } }
    Row(
        Modifier.padding(top = 4.dp).widthIn(max = 320.dp).fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(c.raised)
            .padding(start = 8.dp, end = 12.dp, top = 8.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(40.dp).clip(CircleShape).background(c.brand).clickable {
                if (playing) ChatPlayback.current = null
                else {
                    val pl = p ?: player(ctx, url).also { p = it }
                    pl.play()
                    ChatPlayback.current = id
                }
            },
            contentAlignment = Alignment.Center,
        ) { LIcon(if (playing) LinkordIcons.Pause else LinkordIcons.Play, size = 18.dp, tint = c.onBrand) }
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(a.filename, style = Linkord.type.small, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Slider(
                value = position,
                onValueChange = { v ->
                    position = v
                    p?.let { pl -> if (pl.duration > 0) pl.seekTo((v * pl.duration).toLong()) }
                },
                enabled = p != null,
                colors = SliderDefaults.colors(thumbColor = c.brand, activeTrackColor = c.brand, inactiveTrackColor = c.raised2),
                modifier = Modifier.heightIn(max = 28.dp),
            )
        }
        Spacer(Modifier.width(8.dp))
        Text("${clock(now)} / ${clock(length)}", style = Linkord.type.label)
    }
}

private const val TEXT_PREVIEW_BYTES = 16 * 1024

/** A text file (message.txt and the like): its card, then the first lines, opened with Show more (web TextFileView). */
@Composable
fun TextFilePreview(a: Attachment, url: String, onOpen: () -> Unit) {
    val session = LocalContext.current.session
    val c = Linkord.colors
    var text by remember(url) { mutableStateOf<String?>(null) }
    var open by remember(url) { mutableStateOf(false) }
    LaunchedEffect(url) {
        text = withContext(Dispatchers.IO) {
            runCatching {
                session.http.newCall(Request.Builder().url(url).header("Range", "bytes=0-${TEXT_PREVIEW_BYTES - 1}").build()).execute().use { r ->
                    if (!r.isSuccessful) "" else String(r.body.bytes().take(TEXT_PREVIEW_BYTES).toByteArray(), Charsets.UTF_8)
                }
            }.getOrDefault("")
        }
    }
    Column(Modifier.widthIn(max = 360.dp)) {
        FileCard(a, LinkordIcons.Paperclip, onOpen)
        val body = text
        if (!body.isNullOrEmpty()) {
            val long = body.length > 600 || body.lines().size > 8
            Text(
                body, style = Linkord.type.small.copy(fontFamily = FontFamily.Monospace), color = c.text2,
                maxLines = if (open) Int.MAX_VALUE else 8, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 4.dp).fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(c.raised).padding(10.dp),
            )
            if (long) Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(if (open) t("Show less") else t("Show more"), style = Linkord.type.small, color = c.brandHi, modifier = Modifier.clickable { open = !open })
                if (open && a.size > TEXT_PREVIEW_BYTES) Text(t("Open the file to read the rest."), style = Linkord.type.label, modifier = Modifier.padding(start = 10.dp))
            }
        }
    }
}

/**
 * YouTube, TikTok, Reels...: the site's poster with a play button, then the site's own player in place (the web's
 * VideoLinkEmbed). The player is a small page with the site's iframe, loaded from the server's origin like watch
 * together's, so the sites see linkord.app as the embedding page (Twitch's `parent`).
 */
@Composable
fun VideoLinkEmbed(id: String, e: Embed, player: LinkPlayer, base: String) {
    val ctx = LocalContext.current
    val c = Linkord.colors
    val playing = ChatPlayback.current == id
    val accent = Color(player.color)
    Column(
        Modifier.padding(top = 6.dp).widthIn(max = 360.dp).fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(c.raised).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(7.dp).clip(CircleShape).background(accent))
            Spacer(Modifier.width(6.dp))
            Text(listOfNotNull(e.siteName ?: player.provider, e.author).joinToString(" · "), style = Linkord.type.label, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            Box(Modifier.size(28.dp).clip(CircleShape).clickable { openLink(ctx, e.url) }, contentAlignment = Alignment.Center) {
                LIcon(LinkordIcons.External, size = 15.dp, tint = c.text3)
            }
        }
        e.title?.let { Text(it, style = Linkord.type.bodyStrong, color = c.brandHi, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.clickable { openLink(ctx, e.url) }) }
        if (!player.vertical) e.description?.let { Text(it, style = Linkord.type.small, maxLines = 2, overflow = TextOverflow.Ellipsis) }
        Box(
            Modifier.padding(top = 4.dp).then(if (player.vertical) Modifier.width(220.dp).aspectRatio(9f / 16f) else Modifier.fillMaxWidth().aspectRatio(16f / 9f))
                .clip(RoundedCornerShape(8.dp)).background(Color.Black),
            contentAlignment = Alignment.Center,
        ) {
            if (playing) {
                StopWhenHidden(id)
                DisposableEffect(id) { onDispose { if (ChatPlayback.current == id) ChatPlayback.current = null } }
                // YouTube refuses to play ("This video is unavailable") unless it's told the embedding page, like
                // watch together's player; playsinline keeps it in the card.
                val src = if (player.provider == "YouTube") "${player.src}&playsinline=1&origin=${android.net.Uri.encode(base)}" else player.src
                val html = """<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;height:100%;background:#000}iframe{border:0;width:100%;height:100%}</style></head><body>
<iframe src="$src" allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowfullscreen></iframe>
</body></html>"""
                AndroidView(
                    factory = { v ->
                        WebView(v).apply {
                            // Match the frame: with Compose's default wrap-content the page gets no height.
                            layoutParams = android.view.ViewGroup.LayoutParams(android.view.ViewGroup.LayoutParams.MATCH_PARENT, android.view.ViewGroup.LayoutParams.MATCH_PARENT)
                            settings.javaScriptEnabled = true
                            settings.domStorageEnabled = true
                            settings.mediaPlaybackRequiresUserGesture = false
                            webChromeClient = WebChromeClient()
                            loadDataWithBaseURL(base, html, "text/html", "utf-8", null)
                        }
                    },
                    onRelease = { it.destroy() },
                    modifier = Modifier.fillMaxSize(),
                )
            } else {
                e.image?.let { AsyncImage(it, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize()) }
                Box(
                    Modifier.size(56.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.6f)).clickable { ChatPlayback.current = id },
                    contentAlignment = Alignment.Center,
                ) { LIcon(LinkordIcons.Play, size = 26.dp, tint = Color.White) }
            }
        }
    }
}

/**
 * The page the sites' players are embedded in: the server's own HTTPS address (release builds, the direct address too).
 * YouTube refuses an http:// page ("This video is unavailable"), so a dev build talking to http://127.0.0.1 uses
 * linkord.app's; nothing is loaded from it, it's only who the players see as the embedding site.
 */
fun playerOrigin(server: String): String = if (server.startsWith("https://")) server.trimEnd('/') else "https://linkord.app"

/** Invite previews, fetched once per code while the app runs (many messages can show the same invite). */
private object InviteCache {
    val known = HashMap<String, InvitePreview?>()
}

/** An invite link in a message: the server it leads to, how many are there, and Join (web InviteCard). */
@Composable
fun InviteCard(code: String, mine: Boolean) {
    val session = LocalContext.current.session
    val st by session.store.state.collectAsState()
    val nav = LocalNav.current
    val c = Linkord.colors
    var loaded by remember(code) { mutableStateOf(InviteCache.known.containsKey(code)) }
    var info by remember(code) { mutableStateOf(InviteCache.known[code]) }
    var joining by remember(code) { mutableStateOf(false) }
    LaunchedEffect(code) {
        if (loaded) return@LaunchedEffect
        info = runCatching { session.api.get<InvitePreview>("/invites/$code") }.getOrNull()
        InviteCache.known[code] = info
        loaded = true
    }
    val i = info
    val joined = i != null && st.guilds.containsKey(i.guild.id)
    Column(
        Modifier.padding(top = 6.dp).widthIn(max = 360.dp).fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(c.raised).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Kicker(
            when {
                loaded && i == null -> t("You received an invite, but it's invalid.")
                mine -> t("You sent an invite to join a server")
                else -> t("You've been invited to join a server")
            },
        )
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (i == null) {
                Box(Modifier.size(48.dp).clip(RoundedCornerShape(14.dp)).background(c.raised2), contentAlignment = Alignment.Center) {
                    if (loaded) Text("?", style = Linkord.type.title, color = c.text3)
                }
                Spacer(Modifier.width(12.dp))
                if (loaded) Column {
                    Text(t("Invalid invite"), style = Linkord.type.bodyStrong, color = c.danger)
                    Text(t("Ask for a new invite."), style = Linkord.type.small)
                }
                return@Row
            }
            ServerTile(i.guild.name, i.guild.icon, 48.dp)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(i.guild.name, style = Linkord.type.bodyStrong, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    i.onlineCount?.let { n ->
                        Box(Modifier.size(8.dp).clip(CircleShape).background(c.online))
                        Text(plural(n, "{n} Online", "{n} Online"), style = Linkord.type.label, modifier = Modifier.padding(start = 4.dp, end = 10.dp))
                    }
                    Box(Modifier.size(8.dp).clip(CircleShape).background(c.text3))
                    Text(plural(i.memberCount, "{n} Member", "{n} Members"), style = Linkord.type.label, modifier = Modifier.padding(start = 4.dp))
                }
            }
            Button(
                onClick = {
                    if (joined) {
                        session.actions.selectView(i.guild.id)
                        nav.openHome()
                    } else {
                        joining = true
                        session.launch {
                            try {
                                session.actions.acceptInvite(code)
                                nav.openHome()
                            } finally {
                                joining = false
                            }
                        }
                    }
                },
                enabled = !joining,
                colors = ButtonDefaults.buttonColors(containerColor = if (joined) c.raised2 else c.online, contentColor = if (joined) c.text else Color.White),
            ) { Text(if (joined) t("Joined") else if (joining) t("Joining…") else t("Join")) }
        }
    }
}

/** League's icon from Discord's detectable list, for when the host isn't in League any more (web lib/league.ts). */
private const val LEAGUE_ICON = "https://cdn.discordapp.com/app-icons/1402418696126992445/7c99428541032ac02ec6981d88b78fb7.png?size=128"

/**
 * A "join my lobby" message (type 8): the lobby as it is now (the host's live activity, or the one in the message once
 * they've left it), like the web's LobbyInviteCard. Joining needs League on a computer, so the phone says where.
 */
@Composable
fun LobbyInviteCard(st: State, m: Message, guildId: String?) {
    val c = Linkord.colors
    val host = m.author.id
    val game = st.gameOf(host)
    val live = game?.league?.takeIf { it.phase == "lobby" }
    val lobby = live ?: m.embeds.firstOrNull { it.type == "league_invite" }?.league
    val icon = if (live != null) game.icon ?: LEAGUE_ICON else LEAGUE_ICON
    val party = lobby?.party?.takeIf { it.max > 1 }
    val full = party != null && party.size >= party.max
    Column(
        Modifier.padding(top = 6.dp).widthIn(max = 360.dp).fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(c.raised).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Kicker(t("League of Legends · Lobby invite"))
        Row(verticalAlignment = Alignment.CenterVertically) {
            AsyncImage(icon, null, contentScale = ContentScale.Crop, modifier = Modifier.size(44.dp).clip(RoundedCornerShape(10.dp)))
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(t("{name}'s lobby", "name" to st.nameOf(host, guildId, m.author.username)), style = Linkord.type.bodyStrong, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    listOfNotNull(lobby?.queue ?: lobby?.mode, if (live != null) phaseName("lobby") else t("Not in a lobby anymore")).joinToString(" · "),
                    style = Linkord.type.small, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            party?.let { Text("${it.size}/${it.max}", style = Linkord.type.mono.copy(color = c.text2), modifier = Modifier.padding(start = 8.dp)) }
        }
        Text(
            when {
                live == null -> t("Lobby closed")
                full -> t("Lobby full")
                else -> t("Join from the Linkord desktop app")
            },
            style = Linkord.type.small, color = c.text3,
        )
    }
}
