package com.linkord.app.ui.components

import android.Manifest
import android.app.Activity
import android.content.ContentUris
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.provider.Settings
import android.util.LruCache
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
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
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import coil3.compose.AsyncImage
import com.linkord.app.session
import com.linkord.core.t
import com.linkord.designsystem.Linkord
import com.linkord.designsystem.LinkordIcons
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** A photo or video on this phone (MediaStore), and the album (folder) it's in. */
private class Media(val uri: Uri, val video: Boolean, val durationMs: Long, val album: Long, val albumName: String)

private class Album(val id: Long?, val name: String, val cover: Media, val count: Int)

/** How much of the phone's media Linkord may see. Android 14+ lets people allow only the items they pick. */
private enum class Access { All, Some, None }

private fun granted(ctx: Context, p: String) = ContextCompat.checkSelfPermission(ctx, p) == PackageManager.PERMISSION_GRANTED

private fun accessOf(ctx: Context, videos: Boolean): Access = when {
    Build.VERSION.SDK_INT >= 33 && granted(ctx, Manifest.permission.READ_MEDIA_IMAGES) &&
        (!videos || granted(ctx, Manifest.permission.READ_MEDIA_VIDEO)) -> Access.All
    Build.VERSION.SDK_INT >= 34 && granted(ctx, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) -> Access.Some
    Build.VERSION.SDK_INT < 33 && granted(ctx, Manifest.permission.READ_EXTERNAL_STORAGE) -> Access.All
    else -> Access.None
}

/**
 * What to ask for. Photos and videos are one permission group on Android 13+ (one dialog: "photos and videos"), and
 * asking for USER_SELECTED too on 14+ is what makes the system offer "Allow all" next to "Allow limited access".
 */
private fun permissionsFor(videos: Boolean): Array<String> = when {
    Build.VERSION.SDK_INT >= 33 -> buildList {
        add(Manifest.permission.READ_MEDIA_IMAGES)
        if (videos) add(Manifest.permission.READ_MEDIA_VIDEO)
        if (Build.VERSION.SDK_INT >= 34) add(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)
    }.toTypedArray()
    else -> arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
}

private tailrec fun Context.activity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.activity()
    else -> null
}

/** Everything Linkord may see, newest first: photos, and videos too when asked. */
private suspend fun loadMedia(ctx: Context, videos: Boolean): List<Media> = withContext(Dispatchers.IO) {
    val files = MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL)
    val images = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
    val movies = MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
    val type = MediaStore.Files.FileColumns.MEDIA_TYPE
    val selection = if (videos) "$type IN (${MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE}, ${MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO})"
    else "$type = ${MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE}"
    val projection = arrayOf(
        MediaStore.MediaColumns._ID, type, MediaStore.MediaColumns.DURATION,
        MediaStore.MediaColumns.BUCKET_ID, MediaStore.MediaColumns.BUCKET_DISPLAY_NAME,
    )
    val list = ArrayList<Media>()
    runCatching {
        ctx.contentResolver.query(files, projection, selection, null, "${MediaStore.MediaColumns.DATE_ADDED} DESC")?.use { c ->
            while (c.moveToNext()) {
                val video = c.getInt(1) == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO
                // Each item by its own collection's uri, so the composer gets its name and type like any picked file.
                val uri = ContentUris.withAppendedId(if (video) movies else images, c.getLong(0))
                list += Media(uri, video, if (c.isNull(2)) 0 else c.getLong(2), c.getLong(3), c.getString(4) ?: "")
            }
        }
    }
    list
}

/** "All" first, then the albums with the most items (Camera, Screenshots, WhatsApp Images...). */
private fun albumsOf(items: List<Media>, videos: Boolean): List<Album> {
    if (items.isEmpty()) return emptyList()
    val all = Album(null, if (videos) t("All photos and videos") else t("All photos"), items.first(), items.size)
    return listOf(all) + items.groupBy { it.album }.map { (id, list) ->
        Album(id, list.first().albumName.ifBlank { t("Other") }, list.first(), list.size)
    }.sortedByDescending { it.count }
}

/** Video frames come from Android's own thumbnail cache (Coil can't decode videos without an extra library). */
private val videoThumbs = LruCache<Uri, ImageBitmap>(150)

@Composable
private fun Thumb(m: Media, modifier: Modifier) {
    if (!m.video) {
        AsyncImage(m.uri, null, contentScale = ContentScale.Crop, modifier = modifier)
        return
    }
    val ctx = LocalContext.current
    val bmp by produceState(videoThumbs.get(m.uri), m.uri) {
        if (value == null) value = withContext(Dispatchers.IO) {
            runCatching { ctx.contentResolver.loadThumbnail(m.uri, android.util.Size(320, 320), null).asImageBitmap() }.getOrNull()
        }?.also { videoThumbs.put(m.uri, it) }
    }
    bmp?.let { Image(it, null, contentScale = ContentScale.Crop, modifier = modifier) } ?: Box(modifier)
}

private fun duration(ms: Long): String {
    val s = ms / 1000
    return if (s >= 3600) "%d:%02d:%02d".format(s / 3600, s / 60 % 60, s % 60) else "%d:%02d".format(s / 60, s % 60)
}

/**
 * Linkord's own media picker: the phone's albums and photos (and videos, for chat) in the app's look, after asking to
 * see them. [max] 1 = a tap picks (pictures and banners, which go on to the cropper; the picker stays underneath, so
 * cancelling the crop comes back here). More = tap to select, numbered in the order picked, then Add.
 */
@Composable
fun MediaPicker(title: String, videos: Boolean, max: Int, onClose: () -> Unit, onDone: (List<Uri>) -> Unit) {
    val ctx = LocalContext.current
    val c = Linkord.colors
    val permissions = remember(videos) { permissionsFor(videos) }
    var access by remember { mutableStateOf(accessOf(ctx, videos)) }
    // Android stops showing its dialog after people say no twice: then only Settings can turn it on.
    var blocked by remember { mutableStateOf(false) }
    var items by remember { mutableStateOf<List<Media>?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    var album by remember { mutableStateOf<Long?>(null) }
    var selected by remember { mutableStateOf(listOf<Uri>()) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        access = accessOf(ctx, videos)
        val activity = ctx.activity()
        blocked = access == Access.None && activity != null && permissions.none { p -> activity.shouldShowRequestPermissionRationale(p) }
        reload++
    }
    // Back from Settings or from choosing which items to share: look again.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        access = accessOf(ctx, videos)
        if (access != Access.None) blocked = false
        reload++
    }
    // The picker opening is the moment to ask, once; after a "no", the button asks again.
    LaunchedEffect(Unit) { if (access == Access.None) ask.launch(permissions) }
    LaunchedEffect(access, reload) {
        items = if (access == Access.None) emptyList() else loadMedia(ctx, videos)
        // Something selected that isn't visible any more (deleted, access narrowed) is dropped.
        val there = items.orEmpty().mapTo(HashSet()) { it.uri }
        selected = selected.filter { it in there }
    }
    fun tap(m: Media) {
        if (max == 1) return onDone(listOf(m.uri))
        selected = when {
            m.uri in selected -> selected - m.uri
            selected.size >= max -> {
                ctx.session.toast(t("You can add up to {max} at once.", "max" to max.toString()))
                selected
            }
            else -> selected + m.uri
        }
    }

    Dialog(onClose, DialogProperties(usePlatformDefaultWidth = false)) {
        Column(Modifier.fillMaxSize().background(c.page).statusBarsPadding()) {
            Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 12.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(48.dp).clip(RoundedCornerShape(24.dp)).clickable(onClick = onClose), contentAlignment = Alignment.Center) {
                    LIcon(LinkordIcons.Close, size = 22.dp, tint = c.text)
                }
                Text(title, style = Linkord.type.title, color = c.text, modifier = Modifier.weight(1f))
                if (max > 1 && selected.isNotEmpty()) Button(
                    onClick = { onDone(selected) },
                    colors = ButtonDefaults.buttonColors(containerColor = c.brand, contentColor = c.onBrand),
                ) { Text(t("Add {n}", "n" to selected.size.toString())) }
            }
            if (access == Access.None) {
                AskForMedia(blocked, videos) {
                    if (blocked) ctx.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", ctx.packageName, null)))
                    else ask.launch(permissions)
                }
                return@Column
            }
            if (access == Access.Some) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp).clip(RoundedCornerShape(10.dp)).background(c.raised)
                        .padding(start = 14.dp, end = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(t("Linkord can only see the photos you chose."), style = Linkord.type.small, color = c.text2, modifier = Modifier.weight(1f))
                    TextButton(onClick = { ask.launch(permissions) }) { Text(t("Allow all photos"), color = c.text) }
                }
            }
            val list = items
            val albums = remember(list) { albumsOf(list.orEmpty(), videos) }
            if (albums.size > 2) {
                LazyRow(contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    items(albums, key = { it.id ?: -1L }) { a ->
                        val on = album == a.id
                        Row(
                            Modifier.clip(RoundedCornerShape(10.dp)).background(if (on) c.brand else c.raised).clickable { album = a.id }
                                .padding(start = 4.dp, end = 10.dp, top = 4.dp, bottom = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Thumb(a.cover, Modifier.size(28.dp).clip(RoundedCornerShape(6.dp)))
                            Text(a.name, style = Linkord.type.small, color = if (on) c.onBrand else c.text, maxLines = 1,
                                modifier = Modifier.padding(start = 8.dp).widthIn(max = 160.dp))
                            Text(a.count.toString(), style = Linkord.type.label, color = if (on) c.onBrand.copy(alpha = 0.7f) else c.text3,
                                modifier = Modifier.padding(start = 6.dp))
                        }
                    }
                }
            }
            val shown = remember(list, album) { list.orEmpty().filter { album == null || it.album == album } }
            when {
                list == null -> Spacer(Modifier.weight(1f))
                shown.isEmpty() -> Box(Modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
                    Text(
                        if (access == Access.Some) t("No photos shared with Linkord yet. Tap Allow all photos to choose.")
                        else if (videos) t("No photos or videos on this phone yet.") else t("No photos on this phone yet."),
                        color = c.text2, textAlign = TextAlign.Center,
                    )
                }
                else -> {
                    val grid = rememberLazyGridState()
                    LaunchedEffect(album) { grid.scrollToItem(0) }
                    LazyVerticalGrid(
                        GridCells.Adaptive(92.dp),
                        state = grid,
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(2.dp),
                        horizontalArrangement = Arrangement.spacedBy(2.dp),
                        verticalArrangement = Arrangement.spacedBy(2.dp),
                    ) {
                        items(shown, key = { it.uri.toString() }) { m ->
                            val order = if (max > 1) selected.indexOf(m.uri) else -1
                            Box(Modifier.aspectRatio(1f).background(c.raised).clickable { tap(m) }) {
                                // A selected item sits back a little behind a brand ring, so the choice reads at a glance.
                                Thumb(m, Modifier.fillMaxSize().then(if (order >= 0) Modifier.padding(6.dp).clip(RoundedCornerShape(6.dp)) else Modifier))
                                if (m.video) Text(
                                    duration(m.durationMs), style = Linkord.type.label, color = Color.White,
                                    modifier = Modifier.align(Alignment.BottomStart).padding(6.dp).clip(RoundedCornerShape(4.dp))
                                        .background(Color.Black.copy(alpha = 0.55f)).padding(horizontal = 4.dp, vertical = 1.dp),
                                )
                                if (max > 1) Box(
                                    Modifier.align(Alignment.TopEnd).padding(6.dp).size(24.dp).clip(CircleShape)
                                        .then(
                                            if (order >= 0) Modifier.background(c.brand)
                                            else Modifier.background(Color.Black.copy(alpha = 0.25f)).border(1.5.dp, Color.White, CircleShape),
                                        ),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    if (order >= 0) Text((order + 1).toString(), style = Linkord.type.label, color = c.onBrand)
                                }
                            }
                        }
                        item(span = { GridItemSpan(maxLineSpan) }) { Spacer(Modifier.navigationBarsPadding()) }
                    }
                }
            }
        }
    }
}

@Composable
private fun AskForMedia(blocked: Boolean, videos: Boolean, onAsk: () -> Unit) {
    val c = Linkord.colors
    Column(
        Modifier.fillMaxSize().padding(32.dp).navigationBarsPadding(),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(Modifier.size(72.dp).clip(RoundedCornerShape(20.dp)).background(c.raised), contentAlignment = Alignment.Center) {
            LIcon(LinkordIcons.Photo, size = 34.dp, tint = c.text2)
        }
        Text(t("Let Linkord see your photos"), style = Linkord.type.title, color = c.text, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 20.dp))
        Text(
            when {
                blocked -> t("Photo access is off for Linkord. Turn on Photos and videos in Settings, under Permissions.")
                videos -> t("To share photos and videos, allow Linkord to see them on this phone. Nothing is sent until you send it.")
                else -> t("To pick a picture, allow Linkord to see the photos on this phone. Nothing is sent until you save.")
            },
            color = c.text2, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 8.dp),
        )
        Button(
            onClick = onAsk,
            colors = ButtonDefaults.buttonColors(containerColor = c.brand, contentColor = c.onBrand),
            modifier = Modifier.padding(top = 24.dp),
        ) { Text(if (blocked) t("Open Settings") else t("Allow access")) }
    }
}
