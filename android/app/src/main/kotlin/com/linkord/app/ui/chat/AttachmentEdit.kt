package com.linkord.app.ui.chat

import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.media.MediaMuxer
import android.net.Uri
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.systemGestureExclusion
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.RangeSlider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.linkord.app.data.Outgoing
import com.linkord.app.session
import com.linkord.app.ui.components.Kicker
import com.linkord.app.ui.components.LIcon
import com.linkord.core.t
import com.linkord.designsystem.Linkord
import com.linkord.designsystem.LinkordIcons
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.nio.ByteBuffer
import kotlin.math.max
import kotlin.math.min

private val Outgoing.isImage get() = type.startsWith("image/")
private val Outgoing.isVideo get() = type.startsWith("video/")
/** Pictures (not GIFs: editing would stop them moving) and videos open in an editor. */
private val Outgoing.editable get() = isVideo || (isImage && type != "image/gif")

/** A small picture of what's about to be sent, and how long it runs when it's a video. */
private class Thumb(val image: Bitmap?, val durationMs: Long)

private fun thumbOf(ctx: Context, f: Outgoing): Thumb {
    var duration = 0L
    var image: Bitmap? = null
    if (f.isVideo) runCatching {
        val r = MediaMetadataRetriever()
        try {
            r.setDataSource(ctx, f.uri)
            duration = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0
            image = r.getScaledFrameAtTime(0, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, 320, 320)
        } finally {
            r.release()
        }
    } else if (f.isImage) image = runCatching {
        ImageDecoder.decodeBitmap(ImageDecoder.createSource(ctx.contentResolver, f.uri)) { d, info, _ ->
            d.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            d.setTargetSampleSize(max(1, max(info.size.width, info.size.height) / 320))
        }
    }.getOrNull()
    return Thumb(image, duration)
}

private fun clock(ms: Long): String {
    val s = ms / 1000
    return "%d:%02d".format(s / 60, s % 60)
}

/**
 * What's attached, above the message box: pictures and videos as thumbnails (a tap opens the editor: crop and rotate a
 * picture, trim a video), other files as a named chip. Each has its own remove button.
 */
@Composable
fun AttachmentStrip(files: List<Outgoing>, onRemove: (Outgoing) -> Unit, onEdit: (Outgoing) -> Unit) {
    val ctx = LocalContext.current
    val c = Linkord.colors
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        for (f in files) {
            if (f.isImage || f.isVideo) {
                val thumb by produceState<Thumb?>(null, f.uri) { value = withContext(Dispatchers.IO) { thumbOf(ctx, f) } }
                Box(
                    Modifier.size(84.dp).clip(RoundedCornerShape(12.dp)).background(c.raised)
                        .clickable(enabled = f.editable) { onEdit(f) }.semantics { contentDescription = f.name },
                ) {
                    thumb?.image?.let { Image(it.asImageBitmap(), null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize()) }
                    if (f.isVideo) Row(
                        Modifier.align(Alignment.BottomStart).padding(5.dp).clip(RoundedCornerShape(6.dp)).background(Color.Black.copy(alpha = 0.6f)).padding(horizontal = 5.dp, vertical = 2.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        LIcon(LinkordIcons.Play, size = 10.dp, tint = Color.White)
                        Spacer(Modifier.width(3.dp))
                        Text(clock(thumb?.durationMs ?: 0), style = Linkord.type.label, color = Color.White, maxLines = 1)
                    } else if (f.type == "image/gif") Text(
                        "GIF", style = Linkord.type.label, color = Color.White,
                        modifier = Modifier.align(Alignment.BottomStart).padding(5.dp).clip(RoundedCornerShape(6.dp)).background(Color.Black.copy(alpha = 0.6f)).padding(horizontal = 5.dp, vertical = 2.dp),
                    )
                    if (f.editable) Dot(LinkordIcons.Edit, t("Edit"), Modifier.align(Alignment.BottomEnd)) { onEdit(f) }
                    Dot(LinkordIcons.Close, t("Remove"), Modifier.align(Alignment.TopEnd)) { onRemove(f) }
                }
            } else Row(
                Modifier.height(84.dp).width(150.dp).clip(RoundedCornerShape(12.dp)).background(c.raised).padding(start = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                LIcon(LinkordIcons.Paperclip, size = 16.dp)
                Spacer(Modifier.width(6.dp))
                Text(f.name, style = Linkord.type.small, color = c.text, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Dot(LinkordIcons.Close, t("Remove"), Modifier.align(Alignment.Top)) { onRemove(f) }
            }
        }
    }
}

/** A small round button over a thumbnail. */
@Composable
private fun Dot(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, modifier: Modifier, onClick: () -> Unit) {
    Box(
        modifier.padding(4.dp).size(26.dp).clip(RoundedCornerShape(13.dp)).background(Color.Black.copy(alpha = 0.6f)).clickable(onClick = onClick)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) { LIcon(icon, size = 14.dp, tint = Color.White) }
}

/** The editor for an attached picture or video; [onDone] gets what to send in its place. */
@Composable
fun AttachmentEditor(f: Outgoing, onCancel: () -> Unit, onDone: (Outgoing) -> Unit) {
    if (f.isVideo) VideoTrimmer(f, onCancel, onDone) else ImageEditor(f, onCancel, onDone)
}

/** Where edited copies wait to be sent (the cache: Android clears it when space runs short). */
private fun outFile(ctx: Context, ext: String) = File(ctx.cacheDir, "outgoing").apply { mkdirs() }.let { File(it, "edit-${System.nanoTime()}.$ext") }

private fun renamed(name: String, ext: String) = name.substringBeforeLast('.', name).ifBlank { "file" } + ".$ext"

// ---------------------------------------------------------------- pictures

/** The shapes a picture can be cut to: its own, or a fixed one. */
private val SHAPES = listOf<Pair<String?, Float?>>(null to null, "1:1" to 1f, "4:3" to 4f / 3, "3:4" to 3f / 4, "16:9" to 16f / 9, "9:16" to 9f / 16)

/**
 * Crop and rotate a picture before sending it: pick a shape, then pan and pinch the picture inside the frame (the
 * profile cropper's way). It's sent as a JPEG of what's in the frame, at the picture's own resolution.
 */
@Composable
private fun ImageEditor(f: Outgoing, onCancel: () -> Unit, onDone: (Outgoing) -> Unit) {
    val ctx = LocalContext.current
    val c = Linkord.colors
    val scope = rememberCoroutineScope()
    val loaded = remember(f.uri) {
        runCatching {
            ImageDecoder.decodeBitmap(ImageDecoder.createSource(ctx.contentResolver, f.uri)) { d, info, _ ->
                d.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                val long = max(info.size.width, info.size.height)
                if (long > 4096) d.setTargetSampleSize((long / 4096) + 1)
            }
        }.getOrNull()
    }
    var bitmap by remember(f.uri) { mutableStateOf(loaded) }
    var shape by remember { mutableStateOf<Float?>(null) }
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    var frame by remember { mutableStateOf(Size.Zero) }
    var base by remember { mutableFloatStateOf(1f) }
    var turned by remember { mutableStateOf(false) }
    fun recentre() {
        scale = 1f
        offset = Offset.Zero
    }
    Dialog(onCancel, DialogProperties(usePlatformDefaultWidth = false)) {
        Column(Modifier.fillMaxSize().background(Color.Black).statusBarsPadding().navigationBarsPadding()) {
            Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onCancel) { Text(t("Cancel"), color = Color.White) }
                Spacer(Modifier.weight(1f))
                Kicker(t("Picture"), color = Color.White.copy(alpha = 0.7f))
                Spacer(Modifier.weight(1f))
                TextButton(enabled = bitmap != null, onClick = {
                    bitmap = bitmap?.let { b -> Bitmap.createBitmap(b, 0, 0, b.width, b.height, Matrix().apply { postRotate(90f) }, true) }
                    turned = true
                    recentre()
                }) { Text(t("Rotate"), color = Color.White) }
            }
            val bmp = bitmap
            if (bmp == null) {
                Text(t("That picture can't be opened."), color = Color.White, modifier = Modifier.padding(24.dp))
                return@Column
            }
            val aspect = shape ?: (bmp.width.toFloat() / bmp.height)
            BoxWithConstraints(Modifier.weight(1f).fillMaxWidth().clipToBounds(), contentAlignment = Alignment.Center) {
                val density = LocalDensity.current
                val maxW = constraints.maxWidth * 0.92f
                val maxH = constraints.maxHeight * 0.92f
                val fw = min(maxW, maxH * aspect)
                val fh = fw / aspect
                frame = Size(fw, fh)
                // The picture covers the frame at scale 1.
                base = max(fw / bmp.width, fh / bmp.height)
                fun clamp(o: Offset, s: Float): Offset {
                    val mx = max(0f, (bmp.width * base * s - fw) / 2)
                    val my = max(0f, (bmp.height * base * s - fh) / 2)
                    return Offset(o.x.coerceIn(-mx, mx), o.y.coerceIn(-my, my))
                }
                Box(Modifier.fillMaxSize().pointerInput(bmp, aspect) {
                    detectTransformGestures { _, pan, zoom, _ ->
                        scale = (scale * zoom).coerceIn(1f, 8f)
                        offset = clamp(offset + pan, scale)
                    }
                }) {
                    val img = remember(bmp) { bmp.asImageBitmap() }
                    Canvas(Modifier.fillMaxSize()) {
                        val iw = bmp.width * base * scale
                        val ih = bmp.height * base * scale
                        drawImage(img, dstOffset = IntOffset((center.x - iw / 2 + offset.x).toInt(), (center.y - ih / 2 + offset.y).toInt()), dstSize = IntSize(iw.toInt(), ih.toInt()))
                        val left = center.x - fw / 2
                        val top = center.y - fh / 2
                        val shade = Color.Black.copy(alpha = 0.65f)
                        drawRect(shade, Offset.Zero, Size(size.width, top))
                        drawRect(shade, Offset(0f, top + fh), Size(size.width, size.height - top - fh))
                        drawRect(shade, Offset(0f, top), Size(left, fh))
                        drawRect(shade, Offset(left + fw, top), Size(size.width - left - fw, fh))
                        drawRect(Color.White, Offset(left, top), Size(fw, fh), style = Stroke(with(density) { 1.5.dp.toPx() }))
                    }
                }
            }
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                for ((label, value) in SHAPES) {
                    val on = shape == value
                    Text(
                        label ?: t("Original"), style = Linkord.type.small, color = if (on) c.onBrand else Color.White, maxLines = 1, softWrap = false,
                        modifier = Modifier.clip(RoundedCornerShape(10.dp)).background(if (on) c.brand else Color.White.copy(alpha = 0.12f))
                            .clickable { shape = value; recentre() }.padding(horizontal = 14.dp, vertical = 8.dp),
                    )
                }
            }
            Button(
                onClick = {
                    // Nothing changed: the picture goes as it was picked.
                    if (shape == null && scale == 1f && !turned) return@Button onDone(f)
                    scope.launch {
                        val out = withContext(Dispatchers.IO) {
                            runCatching {
                                val s = base * scale
                                val cw = (frame.width / s).coerceAtMost(bmp.width.toFloat())
                                val ch = (frame.height / s).coerceAtMost(bmp.height.toFloat())
                                val x = (bmp.width / 2f - offset.x / s - cw / 2).coerceIn(0f, bmp.width - cw)
                                val y = (bmp.height / 2f - offset.y / s - ch / 2).coerceIn(0f, bmp.height - ch)
                                val cut = Bitmap.createBitmap(bmp, x.toInt(), y.toInt(), Math.round(cw).coerceIn(1, bmp.width - x.toInt()), Math.round(ch).coerceIn(1, bmp.height - y.toInt()))
                                val file = outFile(ctx, "jpg")
                                file.outputStream().use { cut.compress(Bitmap.CompressFormat.JPEG, 92, it) }
                                Outgoing(Uri.fromFile(file), renamed(f.name, "jpg"), "image/jpeg", file.length())
                            }.getOrNull()
                        }
                        if (out != null) onDone(out) else ctx.session.toast(t("That picture can't be opened."))
                    }
                },
                colors = ButtonDefaults.buttonColors(containerColor = c.brand, contentColor = c.onBrand),
                modifier = Modifier.fillMaxWidth().padding(16.dp).height(50.dp),
            ) { Text(t("Apply")) }
        }
    }
}

// ---------------------------------------------------------------- videos

/**
 * Trim a video before sending it: drag the two ends (the picture follows the one being moved), and choose whether its
 * sound goes along. Nothing is re-encoded (the part is copied as it is), so it's quick and loses no quality; the cut
 * starts on the key frame at or just before the start.
 */
@Composable
private fun VideoTrimmer(f: Outgoing, onCancel: () -> Unit, onDone: (Outgoing) -> Unit) {
    val ctx = LocalContext.current
    val c = Linkord.colors
    val scope = rememberCoroutineScope()
    val durationMs = remember(f.uri) {
        runCatching {
            val r = MediaMetadataRetriever()
            try {
                r.setDataSource(ctx, f.uri)
                r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()
            } finally {
                r.release()
            }
        }.getOrNull() ?: 0L
    }
    var range by remember { mutableStateOf(0f..durationMs.toFloat()) }
    // The end being moved: its frame is the one shown.
    var shownMs by remember { mutableStateOf(0L) }
    var sound by remember { mutableStateOf(true) }
    var busy by remember { mutableStateOf(false) }
    val frame by produceState<Bitmap?>(null, shownMs) {
        // Wait for the finger to settle: pulling a frame out of a video takes a moment.
        delay(90)
        value = withContext(Dispatchers.IO) {
            runCatching {
                val r = MediaMetadataRetriever()
                try {
                    r.setDataSource(ctx, f.uri)
                    r.getScaledFrameAtTime(shownMs * 1000, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, 1080, 1080)
                } finally {
                    r.release()
                }
            }.getOrNull()
        } ?: value
    }
    Dialog({ if (!busy) onCancel() }, DialogProperties(usePlatformDefaultWidth = false)) {
        Column(Modifier.fillMaxSize().background(Color.Black).statusBarsPadding().navigationBarsPadding()) {
            Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                TextButton(enabled = !busy, onClick = onCancel) { Text(t("Cancel"), color = Color.White) }
                Spacer(Modifier.weight(1f))
                Kicker(t("Video"), color = Color.White.copy(alpha = 0.7f))
                Spacer(Modifier.weight(1f))
                // Balances Cancel, so the title stays centred.
                Spacer(Modifier.width(72.dp))
            }
            if (durationMs <= 0) {
                Text(t("That video can't be edited."), color = Color.White, modifier = Modifier.padding(24.dp))
                return@Column
            }
            Box(Modifier.weight(1f).fillMaxWidth().padding(12.dp), contentAlignment = Alignment.Center) {
                frame?.let { Image(it.asImageBitmap(), null, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize()) }
                if (busy) CircularProgressIndicator(color = Color.White)
            }
            Row(Modifier.fillMaxWidth().padding(horizontal = 32.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(clock(range.start.toLong()), style = Linkord.type.mono, color = Color.White)
                Spacer(Modifier.weight(1f))
                Text(clock((range.endInclusive - range.start).toLong()), style = Linkord.type.bodyStrong, color = Color.White)
                Spacer(Modifier.weight(1f))
                Text(clock(range.endInclusive.toLong()), style = Linkord.type.mono, color = Color.White)
            }
            RangeSlider(
                value = range, enabled = !busy,
                onValueChange = { v ->
                    // At least a second stays.
                    if (v.endInclusive - v.start < min(1000f, durationMs.toFloat())) return@RangeSlider
                    shownMs = (if (v.start != range.start) v.start else v.endInclusive).toLong()
                    range = v
                },
                valueRange = 0f..durationMs.toFloat(),
                colors = SliderDefaults.colors(thumbColor = c.brand, activeTrackColor = c.brand, inactiveTrackColor = Color.White.copy(alpha = 0.2f)),
                // In from the edges and kept from the system's back gesture: dragging the start handle went Back instead.
                modifier = Modifier.fillMaxWidth().systemGestureExclusion().padding(horizontal = 32.dp),
            )
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    t("No sound"), style = Linkord.type.small, color = if (!sound) c.onBrand else Color.White, maxLines = 1,
                    modifier = Modifier.clip(RoundedCornerShape(10.dp)).background(if (!sound) c.brand else Color.White.copy(alpha = 0.12f))
                        .clickable(enabled = !busy) { sound = !sound }.padding(horizontal = 14.dp, vertical = 8.dp),
                )
            }
            Button(
                enabled = !busy,
                onClick = {
                    val whole = range.start < 50f && range.endInclusive > durationMs - 50f
                    if (whole && sound) return@Button onDone(f)
                    busy = true
                    scope.launch {
                        val out = withContext(Dispatchers.IO) {
                            val file = outFile(ctx, "mp4")
                            runCatching {
                                trimVideo(ctx, f.uri, range.start.toLong(), if (whole) Long.MAX_VALUE / 2000 else range.endInclusive.toLong(), sound, file)
                                Outgoing(Uri.fromFile(file), renamed(f.name, "mp4"), "video/mp4", file.length())
                            }.onFailure { file.delete() }.getOrNull()
                        }
                        busy = false
                        if (out != null) onDone(out) else ctx.session.toast(t("That video can't be edited."))
                    }
                },
                colors = ButtonDefaults.buttonColors(containerColor = c.brand, contentColor = c.onBrand),
                modifier = Modifier.fillMaxWidth().padding(16.dp).height(50.dp),
            ) { Text(t("Apply")) }
        }
    }
}

/**
 * Copies [startMs]..[endMs] of a video into an MP4 at [out] without re-encoding: every sample from the key frame at
 * or before the start up to the end, the sound too when [keepAudio]. Throws when the phone can't read the file or MP4
 * can't hold what's in it.
 */
private fun trimVideo(ctx: Context, uri: Uri, startMs: Long, endMs: Long, keepAudio: Boolean, out: File) {
    val ex = MediaExtractor()
    var muxer: MediaMuxer? = null
    try {
        ex.setDataSource(ctx, uri, null)
        val mux = MediaMuxer(out.path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4).also { muxer = it }
        val tracks = HashMap<Int, Int>()
        var bufferSize = 1 shl 20
        for (i in 0 until ex.trackCount) {
            val format = ex.getTrackFormat(i)
            val mime = format.getString(MediaFormat.KEY_MIME) ?: continue
            if (!mime.startsWith("video/") && !(keepAudio && mime.startsWith("audio/"))) continue
            ex.selectTrack(i)
            tracks[i] = mux.addTrack(format)
            if (format.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) bufferSize = max(bufferSize, format.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE))
        }
        require(tracks.isNotEmpty()) { "no tracks" }
        // Phones record sideways and say how to turn it.
        runCatching {
            val r = MediaMetadataRetriever()
            try {
                r.setDataSource(ctx, uri)
                r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull()?.let { mux.setOrientationHint(it) }
            } finally {
                r.release()
            }
        }
        ex.seekTo(startMs * 1000, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)
        mux.start()
        val buffer = ByteBuffer.allocate(bufferSize)
        val info = MediaCodec.BufferInfo()
        val endUs = endMs * 1000
        var baseUs = -1L
        val done = HashSet<Int>()
        while (done.size < tracks.size) {
            val size = ex.readSampleData(buffer, 0)
            if (size < 0) break
            val track = ex.sampleTrackIndex
            val time = ex.sampleTime
            if (time > endUs) {
                // This track is past the end; the others may still have samples before it.
                done += track
                ex.unselectTrack(track)
                continue
            }
            if (baseUs < 0) baseUs = time
            info.set(0, size, (time - baseUs).coerceAtLeast(0), if (ex.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC != 0) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0)
            mux.writeSampleData(tracks.getValue(track), buffer, info)
            ex.advance()
        }
        mux.stop()
    } finally {
        runCatching { muxer?.release() }
        ex.release()
    }
}
