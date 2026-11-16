package com.linkord.app.ui.settings

import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import coil3.compose.AsyncImage
import com.linkord.app.session
import com.linkord.app.ui.chat.ScreenScaffold
import com.linkord.app.ui.components.Avatar
import com.linkord.app.ui.components.Kicker
import com.linkord.app.ui.components.LIcon
import com.linkord.app.ui.components.mediaUrl
import com.linkord.core.User
import com.linkord.core.putUser
import com.linkord.core.t
import com.linkord.designsystem.Linkord
import com.linkord.designsystem.LinkordIcons
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.min

/** Which picture is being changed, its frame and the size it's saved at. */
enum class ImageKind(val path: String, val aspect: Float, val outW: Int, val outH: Int) {
    Avatar("avatar", 1f, 512, 512),
    Banner("banner", 3f, 1500, 500),
}

/** Your profile, edited in place: banner and picture (tap to change), name, pronouns, about me. */
@Composable
fun ProfileEditScreen() {
    val ctx = LocalContext.current
    val session = ctx.session
    val st by session.store.state.collectAsState()
    val me = st.me ?: return
    val c = Linkord.colors
    val scope = rememberCoroutineScope()
    val nav = com.linkord.app.ui.LocalNav.current
    // Starts as the name people see now (the username when no display name is set), so it's never blank.
    var name by remember { mutableStateOf(me.name) }
    // Pictures wait for Save like the text: bytes = the new one, null = removed.
    var staged by remember { mutableStateOf(mapOf<ImageKind, ByteArray?>()) }
    var pronouns by remember { mutableStateOf(me.pronouns) }
    var bio by remember { mutableStateOf(me.bio) }
    var busy by remember { mutableStateOf(false) }
    var cropping by remember { mutableStateOf<Pair<ImageKind, Uri>?>(null) }
    // Linkord's own picker (PhotoPicker.kt): the system one was confusing and couldn't reach every photo.
    var picking by remember { mutableStateOf<ImageKind?>(null) }
    fun choose(k: ImageKind) {
        picking = k
    }
    fun remove(k: ImageKind) {
        staged = staged + (k to null)
    }
    val nameChanged = name.trim() != me.name
    val dirty = nameChanged || pronouns != me.pronouns || bio != me.bio || staged.isNotEmpty()
    val bannerShown = if (ImageKind.Banner in staged) staged[ImageKind.Banner] else mediaUrl(me.banner)
    val avatarStaged = ImageKind.Avatar in staged

    ScreenScaffold(t("Profile"), actions = {
        TextButton(enabled = dirty && !busy, onClick = {
            busy = true
            scope.launch {
                runCatching {
                    var u: User? = null
                    for ((kind, bytes) in staged) {
                        u = if (bytes == null) {
                            session.api.raw("DELETE", "/users/@me/${kind.path}")
                            null
                        } else {
                            val body = MultipartBody.Builder().setType(MultipartBody.FORM)
                                .addFormDataPart("file", "${kind.path}.jpg", bytes.toRequestBody("image/jpeg".toMediaType()))
                                .build()
                            session.api.decode<User>(session.api.raw("POST", "/users/@me/${kind.path}", body))
                        }
                    }
                    val fields = buildMap {
                        if (nameChanged) put("display_name", name.trim())
                        if (pronouns != me.pronouns) put("pronouns", pronouns.trim())
                        if (bio != me.bio) put("bio", bio.trim())
                    }
                    if (fields.isNotEmpty()) u = session.api.patch<User>("/users/@me", fields)
                    if (u == null || staged.values.any { it == null }) u = session.api.get<User>("/users/@me")
                    u!!
                }.onSuccess { u ->
                    session.store.update { it.putUser(u).copy(me = it.me?.let { m -> u.copy(status = m.status) }) }
                    session.toast(t("Profile saved"))
                    nav.pop()
                }.onFailure { session.toast(session.describe(it)) }
                busy = false
            }
        }) { Text(t("Save"), color = if (dirty) c.text else c.text3) }
    }) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).imePadding().navigationBarsPadding()) {
            Box(Modifier.fillMaxWidth().height(170.dp)) {
                Box(Modifier.fillMaxWidth().aspectRatio(3f).clickable { choose(ImageKind.Banner) }) {
                    if (bannerShown != null) AsyncImage(bannerShown, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                    else Box(Modifier.fillMaxSize().background(me.accentColor?.let { Color(0xFF000000 or it.toLong()) } ?: c.raised2))
                    EditBadge(Modifier.align(Alignment.TopEnd).padding(10.dp))
                    if (bannerShown != null) Text(t("Remove"), style = Linkord.type.small, color = Color.White, modifier = Modifier.align(Alignment.TopStart).padding(10.dp)
                        .clip(RoundedCornerShape(8.dp)).background(Color.Black.copy(alpha = 0.45f)).clickable { remove(ImageKind.Banner) }.padding(horizontal = 8.dp, vertical = 4.dp))
                }
                Box(Modifier.align(Alignment.BottomStart).offset(x = 16.dp).clickable { choose(ImageKind.Avatar) }) {
                    Box(Modifier.size(96.dp).clip(RoundedCornerShape(30)).background(c.page))
                    when {
                        !avatarStaged -> Avatar(me, 84.dp, Modifier.padding(6.dp))
                        staged[ImageKind.Avatar] != null -> AsyncImage(staged[ImageKind.Avatar], null, contentScale = ContentScale.Crop,
                            modifier = Modifier.padding(6.dp).size(84.dp).clip(com.linkord.designsystem.AvatarShape))
                        else -> Avatar(me.copy(avatar = null), 84.dp, Modifier.padding(6.dp))
                    }
                    EditBadge(Modifier.align(Alignment.BottomEnd))
                }
            }
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(name, { name = it.take(32) }, label = { Text(t("Display Name")) }, placeholder = { Text(me.username) }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(pronouns, { pronouns = it.take(40) }, label = { Text(t("Pronouns")) }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(bio, { bio = it.take(190) }, label = { Text(t("About Me")) }, minLines = 3, maxLines = 8, modifier = Modifier.fillMaxWidth(),
                    supportingText = { Text("${bio.length}/190", style = Linkord.type.label) })
                if (if (avatarStaged) staged[ImageKind.Avatar] != null else me.avatar != null) TextButton(onClick = { remove(ImageKind.Avatar) }) { Text(t("Remove picture"), color = c.danger) }
            }
        }
    }

    picking?.let { kind -> PhotoPicker(kind, onClose = { picking = null }) { uri -> cropping = kind to uri } }
    // Over the picker: cancelling the crop goes back to the photos, finishing closes both.
    cropping?.let { (kind, uri) ->
        ImageCropper(uri, kind, onCancel = { cropping = null }) { bytes ->
            cropping = null
            picking = null
            staged = staged + (kind to bytes)
        }
    }
}

@Composable
/** The pencil over a picture that can be changed. */
fun EditBadge(modifier: Modifier) {
    Box(modifier.size(30.dp).clip(RoundedCornerShape(15.dp)).background(Color.Black.copy(alpha = 0.55f)), contentAlignment = Alignment.Center) {
        LIcon(LinkordIcons.Edit, size = 16.dp, tint = Color.White)
    }
}

/**
 * Pan and pinch a picture inside the frame (square for a picture, 3:1 for a banner), then it's cut and scaled here
 * and sent as JPEG: the server keeps what it gets for still images (it only crops GIFs itself).
 */
@Composable
fun ImageCropper(uri: Uri, kind: ImageKind, onCancel: () -> Unit, onDone: (ByteArray) -> Unit) {
    val ctx = LocalContext.current
    val c = Linkord.colors
    val scope = rememberCoroutineScope()
    val bitmap = remember(uri) {
        runCatching {
            ImageDecoder.decodeBitmap(ImageDecoder.createSource(ctx.contentResolver, uri)) { d, info, _ ->
                d.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                // Big photos are scaled down to something a phone handles easily.
                val long = max(info.size.width, info.size.height)
                if (long > 3000) d.setTargetSampleSize((long / 3000) + 1)
            }
        }.getOrNull()
    }
    Dialog(onCancel, DialogProperties(usePlatformDefaultWidth = false)) {
        Column(Modifier.fillMaxSize().background(Color.Black).statusBarsPadding().navigationBarsPadding()) {
            Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onCancel) { Text(t("Cancel"), color = Color.White) }
                Spacer(Modifier.weight(1f))
                Kicker(if (kind == ImageKind.Avatar) t("Picture") else t("Banner"), color = Color.White.copy(alpha = 0.7f))
                Spacer(Modifier.weight(1f))
            }
            if (bitmap == null) {
                Text(t("That picture can't be opened."), color = Color.White, modifier = Modifier.padding(24.dp))
                return@Column
            }
            var scale by remember { mutableFloatStateOf(1f) }
            var offset by remember { mutableStateOf(Offset.Zero) }
            var frame by remember { mutableStateOf(Size.Zero) }
            var base by remember { mutableFloatStateOf(1f) }
            BoxWithConstraints(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                val density = LocalDensity.current
                val w = constraints.maxWidth * 0.9f
                val h = min(w / kind.aspect, constraints.maxHeight * 0.8f)
                val fw = h * kind.aspect
                frame = Size(fw, h)
                // The picture covers the frame at scale 1.
                base = max(fw / bitmap.width, h / bitmap.height)
                fun clamp(o: Offset, s: Float): Offset {
                    val iw = bitmap.width * base * s
                    val ih = bitmap.height * base * s
                    val mx = max(0f, (iw - fw) / 2)
                    val my = max(0f, (ih - h) / 2)
                    return Offset(o.x.coerceIn(-mx, mx), o.y.coerceIn(-my, my))
                }
                Box(Modifier.fillMaxSize().pointerInput(bitmap) {
                    detectTransformGestures { _, pan, zoom, _ ->
                        scale = (scale * zoom).coerceIn(1f, 6f)
                        offset = clamp(offset + pan, scale)
                    }
                }) {
                    val img = remember(bitmap) { bitmap.asImageBitmap() }
                    Canvas(Modifier.fillMaxSize()) {
                        val iw = bitmap.width * base * scale
                        val ih = bitmap.height * base * scale
                        drawImage(
                            img,
                            dstOffset = IntOffset((center.x - iw / 2 + offset.x).toInt(), (center.y - ih / 2 + offset.y).toInt()),
                            dstSize = IntSize(iw.toInt(), ih.toInt()),
                        )
                        // Shade outside the frame; a round guide for pictures (they show as rounded squares).
                        val left = center.x - fw / 2
                        val top = center.y - h / 2
                        val shade = Color.Black.copy(alpha = 0.6f)
                        drawRect(shade, Offset.Zero, Size(size.width, top))
                        drawRect(shade, Offset(0f, top + h), Size(size.width, size.height - top - h))
                        drawRect(shade, Offset(0f, top), Size(left, h))
                        drawRect(shade, Offset(left + fw, top), Size(size.width - left - fw, h))
                        drawRect(Color.White, Offset(left, top), Size(fw, h), style = Stroke(with(density) { 1.5.dp.toPx() }))
                    }
                }
            }
            Button(
                onClick = {
                    scope.launch {
                        val bytes = withContext(Dispatchers.Default) {
                            // The frame in the picture's own pixels.
                            val s = base * scale
                            val cw = frame.width / s
                            val ch = frame.height / s
                            val cx = bitmap.width / 2f - offset.x / s
                            val cy = bitmap.height / 2f - offset.y / s
                            val x = (cx - cw / 2).coerceIn(0f, bitmap.width - cw)
                            val y = (cy - ch / 2).coerceIn(0f, bitmap.height - ch)
                            val cut = Bitmap.createBitmap(bitmap, x.toInt(), y.toInt(), cw.toInt().coerceAtLeast(1), ch.toInt().coerceAtLeast(1))
                            val out = Bitmap.createScaledBitmap(cut, kind.outW, kind.outH, true)
                            ByteArrayOutputStream().also { out.compress(Bitmap.CompressFormat.JPEG, 90, it) }.toByteArray()
                        }
                        onDone(bytes)
                    }
                },
                colors = ButtonDefaults.buttonColors(containerColor = c.brand, contentColor = c.onBrand),
                modifier = Modifier.fillMaxWidth().padding(16.dp).height(50.dp),
            ) { Text(t("Apply")) }
        }
    }
}

