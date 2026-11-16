package com.linkord.app.ui.call

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.linkord.app.data.Route
import com.linkord.app.session
import com.linkord.app.ui.LocalNav
import com.linkord.app.ui.Screen
import com.linkord.app.ui.components.Avatar
import com.linkord.app.ui.components.Kicker
import com.linkord.app.ui.components.LIcon
import com.linkord.core.Kind
import com.linkord.core.dmName
import com.linkord.core.nameOf
import com.linkord.core.t
import com.linkord.core.voiceMembers
import com.linkord.designsystem.AvatarShape
import com.linkord.designsystem.Linkord
import com.linkord.designsystem.LinkordIcons
import com.linkord.voice.VoiceStatus

/** Joins a call, asking for the microphone first if needed. */
@Composable
fun rememberJoin(): (String) -> Unit {
    val ctx = LocalContext.current
    val session = ctx.session
    var pending by remember { mutableStateOf<String?>(null) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        val ch = pending
        pending = null
        if (ok && ch != null) session.calls.join(ch) else if (!ok) session.toast(t("Linkord needs the microphone for calls."))
    }
    return { ch ->
        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) session.calls.join(ch)
        else {
            pending = ch
            ask.launch(Manifest.permission.RECORD_AUDIO)
        }
    }
}

/** A call full screen: everyone as a tile (green ring while they talk), and the controls at thumb height. */
@Composable
fun CallScreen(channelId: String, onOpenChat: (String) -> Unit) {
    val session = LocalContext.current.session
    val st by session.store.state.collectAsState()
    val nav = LocalNav.current
    val calls = session.calls
    val inCall by calls.channel.collectAsState()
    val speaking by calls.voice.speaking.collectAsState()
    val status by calls.voice.status.collectAsState()
    val muted by calls.muted.collectAsState()
    val deafened by calls.deafened.collectAsState()
    val route by calls.route.collectAsState()
    val c = Linkord.colors
    val join = rememberJoin()
    val haptics = LocalHapticFeedback.current
    val ch = st.channels[channelId] ?: return
    val here = inCall == channelId
    val people = st.voiceMembers(channelId)
    val me = st.me?.id
    var volumeFor by remember { mutableStateOf<String?>(null) }
    var watched by remember { mutableStateOf(setOf<String>()) }
    // Stop receiving streams nobody here looks at any more (and when the screen goes away).
    androidx.compose.runtime.DisposableEffect(Unit) { onDispose { watched.forEach { calls.voice.watch(it, false) } } }

    Column(Modifier.fillMaxSize().background(c.desk).statusBarsPadding().navigationBarsPadding()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(44.dp).clip(RoundedCornerShape(22.dp)).clickable { nav.pop() }, contentAlignment = Alignment.Center) { LIcon(LinkordIcons.Chevron, size = 22.dp, tint = c.text) }
            Column(Modifier.weight(1f)) {
                val kicker = when {
                    !here -> t("Voice")
                    status == VoiceStatus.Reconnecting -> t("Reconnecting…")
                    status == VoiceStatus.Connecting -> t("Connecting…")
                    else -> t("Voice Connected")
                }
                Kicker(kicker, color = if (here && status == VoiceStatus.Connected) c.online else c.text3)
                Text(if (ch.guildId != null) ch.name else st.dmName(ch, t("Empty group")), style = Linkord.type.title, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Box(Modifier.size(44.dp).clip(RoundedCornerShape(22.dp)).clickable { nav.pop(); onOpenChat(channelId) }, contentAlignment = Alignment.Center) {
                LIcon(LinkordIcons.ChatBubble, size = 20.dp, tint = c.text2)
            }
        }
        WatchTile(channelId, here)
        if (people.isEmpty()) Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
            Text(t("No one's here yet."), style = Linkord.type.small, color = c.text3)
        } else LazyVerticalGrid(
            GridCells.Fixed(if (people.size <= 2) 1 else 2), Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            items(people, key = { it.userId }) { v ->
                val talking = (v.userId == me && "me" in speaking) || v.userId in speaking
                val ring by animateColorAsState(if (talking) c.speaking else Color.Transparent, Linkord.motion.quick(), label = "ring")
                Box(
                    Modifier.fillMaxWidth().aspectRatio(if (people.size <= 2) 1.6f else 1f).clip(RoundedCornerShape(16.dp)).background(c.panel)
                        .border(3.dp, ring, RoundedCornerShape(16.dp))
                        .clickable(enabled = v.userId != me) { volumeFor = v.userId },
                    contentAlignment = Alignment.Center,
                ) {
                    val showStream = v.selfStream && v.userId in watched && here
                    when {
                        showStream -> VideoSurface(v.userId, "screen", Modifier.fillMaxSize())
                        v.userId == me && "camera" in calls.voice.sending.collectAsState().value -> SelfCamera(Modifier.fillMaxSize())
                        v.selfVideo && here -> VideoSurface(v.userId, "camera", Modifier.fillMaxSize())
                        else -> Avatar(st.users[v.userId], 72.dp)
                    }
                    if (v.selfStream && here && v.userId != me && !showStream) Text(
                        t("Watch Stream"), style = Linkord.type.bodyStrong, color = c.onBrand,
                        modifier = Modifier.align(Alignment.TopCenter).padding(top = 12.dp).clip(RoundedCornerShape(10.dp)).background(c.brand)
                            .clickable { watched = watched + v.userId; calls.voice.watch(v.userId, true) }.padding(horizontal = 12.dp, vertical = 6.dp),
                    )
                    Row(Modifier.align(Alignment.BottomStart).padding(10.dp).clip(RoundedCornerShape(8.dp)).background(Color.Black.copy(alpha = 0.45f)).padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(st.nameOf(v.userId, ch.guildId, t("Unknown")), style = Linkord.type.small, color = Color.White, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (v.selfDeaf || v.selfMute) {
                            Spacer(Modifier.width(6.dp))
                            LIcon(if (v.selfDeaf) LinkordIcons.HeadphonesOff else LinkordIcons.MicOff, size = 14.dp, tint = Color.White)
                        }
                    }
                    if (v.selfStream) Text("LIVE", style = Linkord.type.label, color = Color.White, modifier = Modifier.align(Alignment.TopEnd).padding(10.dp).clip(RoundedCornerShape(4.dp)).background(c.danger).padding(horizontal = 6.dp, vertical = 2.dp))
                    DropdownMenu(volumeFor == v.userId, { volumeFor = null }) {
                        var vol by remember { mutableStateOf(1f) }
                        Column(Modifier.padding(horizontal = 16.dp).width(220.dp)) {
                            Kicker(t("User Volume"))
                            Slider(vol, { vol = it; calls.voice.setUserVolume(v.userId, it) }, valueRange = 0f..2f)
                        }
                        DropdownMenuItem(text = { Text(t("Profile")) }, onClick = { volumeFor = null; nav.push(Screen.Profile(v.userId, ch.guildId)) })
                        if (v.userId != me) com.linkord.app.ui.profile.VoiceModItems(ch.guildId, v.userId) { volumeFor = null }
                    }
                }
            }
        }
        // Push to talk: hold to talk (Settings -> Voice).
        if (here && session.prefs.pushToTalk) {
            var held by remember { mutableStateOf(false) }
            Box(
                Modifier.fillMaxWidth().padding(horizontal = 16.dp).height(64.dp).clip(RoundedCornerShape(18.dp))
                    .background(if (held) c.speaking else c.raised2)
                    .pointerInput(Unit) {
                        detectTapGestures(onPress = {
                            held = true; calls.voice.talking = true
                            haptics.performHapticFeedback(HapticFeedbackType.ContextClick)
                            tryAwaitRelease()
                            held = false; calls.voice.talking = false
                        })
                    },
                contentAlignment = Alignment.Center,
            ) { Text(if (held) t("Talking…") else t("Hold to talk"), style = Linkord.type.bodyStrong, color = if (held) Color.White else c.text) }
        }
        // The controls, at thumb height.
        @OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
        androidx.compose.foundation.layout.FlowRow(
            Modifier.fillMaxWidth().padding(16.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterHorizontally),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (!here) {
                Box(
                    Modifier.fillMaxWidth().height(54.dp).clip(RoundedCornerShape(16.dp)).background(c.online).clickable {
                        haptics.performHapticFeedback(HapticFeedbackType.Confirm)
                        join(channelId)
                    },
                    contentAlignment = Alignment.Center,
                ) { Text(if (ch.kind == Kind.VOICE) t("Join Voice") else t("Join Call"), style = Linkord.type.bodyStrong, color = Color.White, textAlign = TextAlign.Center) }
            } else {
                Control(if (muted || deafened) LinkordIcons.MicOff else LinkordIcons.Mic, on = muted || deafened, label = if (muted) t("Unmute") else t("Mute")) {
                    haptics.performHapticFeedback(HapticFeedbackType.ToggleOn)
                    calls.toggleMute()
                }
                Control(if (deafened) LinkordIcons.HeadphonesOff else LinkordIcons.Headphones, on = deafened, label = if (deafened) t("Undeafen") else t("Deafen")) {
                    haptics.performHapticFeedback(HapticFeedbackType.ToggleOn)
                    calls.toggleDeafen()
                }
                val sending by calls.voice.sending.collectAsState()
                val ctx = LocalContext.current
                val askCamera = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
                    if (ok) startCamera(ctx)
                }
                if ("camera" in sending) Control(LinkordIcons.Switch, on = false, label = t("Switch camera")) { calls.voice.switchCamera(ctx) }
                Control(LinkordIcons.Camera, on = "camera" in sending, label = t("Camera")) {
                    if ("camera" in sending) calls.voice.stopCamera()
                    else if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) startCamera(ctx)
                    else askCamera.launch(Manifest.permission.CAMERA)
                }
                val askScreen = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
                    if (r.resultCode == android.app.Activity.RESULT_OK && r.data != null) ContextCompat.startForegroundService(
                        ctx,
                        android.content.Intent(ctx, com.linkord.app.VoiceService::class.java).setAction(com.linkord.app.VoiceService.ACTION_PROJECTION)
                            .putExtra(com.linkord.app.VoiceService.EXTRA_CODE, r.resultCode).putExtra(com.linkord.app.VoiceService.EXTRA_DATA, r.data),
                    )
                }
                Control(LinkordIcons.Screen, on = "screen" in sending, label = t("Share Your Screen")) {
                    if ("screen" in sending) calls.voice.stopScreen()
                    else askScreen.launch(ctx.getSystemService(android.media.projection.MediaProjectionManager::class.java).createScreenCaptureIntent())
                }
                var startWatch by remember { mutableStateOf(false) }
                if (st.watches[channelId] == null) Control(LinkordIcons.Tv, on = false, label = t("Watch together")) { startWatch = true }
                if (startWatch) StartWatch(channelId) { startWatch = false }
                var board by remember { mutableStateOf(false) }
                Control(LinkordIcons.Music, on = false, label = t("Soundboard")) { board = true }
                if (board) SoundboardSheet(ch.guildId) { board = false }
                var routes by remember { mutableStateOf(false) }
                Box {
                    Control(if (route == Route.Speaker) LinkordIcons.VolumeHigh else LinkordIcons.Phone, on = false, label = t("Audio output")) { routes = true }
                    DropdownMenu(routes, { routes = false }) {
                        for (r in calls.routes()) DropdownMenuItem(
                            text = { Text(when (r) { Route.Speaker -> t("Speaker"); Route.Earpiece -> t("Phone"); Route.Bluetooth -> t("Bluetooth"); Route.Wired -> t("Headphones") }) },
                            trailingIcon = { if (r == route) LIcon(LinkordIcons.Check, tint = c.text) },
                            onClick = { calls.setRoute(r); routes = false },
                        )
                    }
                }
                Box(Modifier.size(60.dp).clip(AvatarShape).background(c.danger).clickable {
                    haptics.performHapticFeedback(HapticFeedbackType.Confirm)
                    calls.leave()
                    nav.pop()
                }, contentAlignment = Alignment.Center) { LIcon(LinkordIcons.Hangup, size = 26.dp, tint = Color.White) }
            }
        }
    }
}

@Composable
private fun Control(icon: ImageVector, on: Boolean, label: String, onClick: () -> Unit) {
    val c = Linkord.colors
    Box(
        Modifier.size(60.dp).clip(AvatarShape).background(if (on) c.text else c.raised2).clickable(onClickLabel = label, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { LIcon(icon, size = 26.dp, tint = if (on) c.page else c.text) }
}

/** On every other screen while in a call: where you are, mute and leave; tap to open the call. */
@Composable
fun CallBar(modifier: Modifier = Modifier) {
    val session = LocalContext.current.session
    val st by session.store.state.collectAsState()
    val nav = LocalNav.current
    val calls = session.calls
    val channelId by calls.channel.collectAsState()
    val muted by calls.muted.collectAsState()
    val status by calls.voice.status.collectAsState()
    val speaking by calls.voice.speaking.collectAsState()
    val c = Linkord.colors
    val id = channelId ?: return
    val ch = st.channels[id]
    Row(
        modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp).clip(RoundedCornerShape(14.dp)).background(c.raised2)
            .clickable { nav.push(Screen.Call(id)) }.padding(start = 14.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(10.dp).clip(RoundedCornerShape(5.dp)).background(if (status == VoiceStatus.Connected) (if (speaking.isNotEmpty()) c.speaking else c.online) else c.idle))
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(if (status == VoiceStatus.Reconnecting) t("Reconnecting…") else t("Voice Connected"), style = Linkord.type.label, color = if (status == VoiceStatus.Connected) c.online else c.idle)
            Text(
                ch?.let { if (it.guildId != null) "${it.name} · ${st.guilds[it.guildId]?.name ?: ""}" else st.dmName(it, t("Empty group")) } ?: "",
                style = Linkord.type.small, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
        Box(Modifier.size(40.dp).clip(RoundedCornerShape(20.dp)).clickable { calls.toggleMute() }, contentAlignment = Alignment.Center) {
            LIcon(if (muted) LinkordIcons.MicOff else LinkordIcons.Mic, tint = if (muted) c.danger else c.text)
        }
        Box(Modifier.size(40.dp).clip(RoundedCornerShape(20.dp)).clickable { calls.leave() }, contentAlignment = Alignment.Center) {
            LIcon(LinkordIcons.Hangup, tint = c.danger)
        }
    }
}

/** A DM call ringing you: who's calling, Decline and Accept. */
@Composable
fun IncomingCall(modifier: Modifier = Modifier) {
    val session = LocalContext.current.session
    val st by session.store.state.collectAsState()
    val inCall by session.calls.channel.collectAsState()
    val nav = LocalNav.current
    val join = rememberJoin()
    val c = Linkord.colors
    val me = st.me?.id ?: return
    val ringing = st.calls.entries.firstOrNull { (ch, who) -> me in who && inCall != ch } ?: return
    val ch = st.channels[ringing.key] ?: return
    val caller = st.voiceMembers(ch.id).firstOrNull()?.let { st.users[it.userId] }
    Row(
        modifier.fillMaxWidth().padding(8.dp).clip(RoundedCornerShape(18.dp)).background(c.raised2).padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Avatar(caller, 44.dp)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Kicker(t("Incoming call"))
            Text(st.dmName(ch, t("Empty group")), style = Linkord.type.bodyStrong, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Box(Modifier.size(48.dp).clip(RoundedCornerShape(24.dp)).background(c.danger).clickable { session.calls.decline(ch.id) }, contentAlignment = Alignment.Center) {
            LIcon(LinkordIcons.Hangup, tint = Color.White)
        }
        Spacer(Modifier.width(10.dp))
        Box(Modifier.size(48.dp).clip(RoundedCornerShape(24.dp)).background(c.online).clickable {
            join(ch.id)
            nav.push(Screen.Call(ch.id))
        }, contentAlignment = Alignment.Center) { LIcon(LinkordIcons.Phone, tint = Color.White) }
    }
}


/** Someone's camera or stream, decoded onto this surface while it's on screen. */
@Composable
fun VideoSurface(userId: String, source: String, modifier: Modifier = Modifier) {
    val session = LocalContext.current.session
    androidx.compose.ui.viewinterop.AndroidView(
        factory = { ctx ->
            android.view.SurfaceView(ctx).apply {
                holder.addCallback(object : android.view.SurfaceHolder.Callback {
                    override fun surfaceCreated(h: android.view.SurfaceHolder) = session.calls.voice.video.attach(userId, source, h.surface)
                    override fun surfaceChanged(h: android.view.SurfaceHolder, f: Int, w: Int, ht: Int) {}
                    override fun surfaceDestroyed(h: android.view.SurfaceHolder) = session.calls.voice.video.detach(userId, source)
                })
            }
        },
        modifier = modifier,
    )
}


/** The camera needs the call's service to be a camera one first (Android 14+), then the camera starts. */
private fun startCamera(ctx: android.content.Context) {
    ContextCompat.startForegroundService(ctx, android.content.Intent(ctx, com.linkord.app.VoiceService::class.java).setAction(com.linkord.app.VoiceService.ACTION_CAMERA))
    ctx.session.calls.voice.startCamera(ctx)
}


/** Your own camera on your tile. */
@Composable
fun SelfCamera(modifier: Modifier = Modifier) {
    val session = LocalContext.current.session
    androidx.compose.ui.viewinterop.AndroidView(
        factory = { ctx ->
            android.view.SurfaceView(ctx).apply {
                holder.addCallback(object : android.view.SurfaceHolder.Callback {
                    override fun surfaceCreated(h: android.view.SurfaceHolder) = session.calls.voice.cameraPreview(h.surface)
                    override fun surfaceChanged(h: android.view.SurfaceHolder, f: Int, w: Int, ht: Int) {}
                    override fun surfaceDestroyed(h: android.view.SurfaceHolder) = session.calls.voice.cameraPreview(null)
                })
            }
        },
        modifier = modifier,
    )
}

/** Picture-in-picture: who's in the call, the ones talking lit, and the first video when there is one. */
@Composable
fun CallPip() {
    val session = LocalContext.current.session
    val st by session.store.state.collectAsState()
    val channel by session.calls.channel.collectAsState()
    val speaking by session.calls.voice.speaking.collectAsState()
    val c = Linkord.colors
    val ch = channel ?: return Box(Modifier.fillMaxSize().background(c.desk))
    val people = st.voiceMembers(ch)
    val me = st.me?.id
    val video = people.firstOrNull { it.selfVideo && it.userId != me }
    Box(Modifier.fillMaxSize().background(c.desk), contentAlignment = Alignment.Center) {
        if (video != null) VideoSurface(video.userId, "camera", Modifier.fillMaxSize())
        else Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            for (v in people.take(4)) {
                val talking = (v.userId == me && "me" in speaking) || v.userId in speaking
                Avatar(st.users[v.userId], 40.dp, speaking = talking)
            }
        }
    }
}
