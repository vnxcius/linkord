package com.linkord.app.ui.chat

import android.content.ClipData
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.os.Environment
import android.provider.MediaStore
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import com.linkord.app.data.Session
import com.linkord.app.session
import com.linkord.core.t
import com.linkord.designsystem.Linkord
import com.linkord.designsystem.LinkordIcons
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Holding a picture in a message (MessageItem provides it): opens the message's quick actions with the picture's own
 * (save, share, copy link) on top. Null outside a chat, where a picture only opens.
 */
val LocalImageHold = compositionLocalOf<((url: String, name: String) -> Unit)?> { null }

/** A picture's bytes and type, downloaded (off the main thread). */
private suspend fun fetch(session: Session, url: String): Pair<ByteArray, String> = withContext(Dispatchers.IO) {
    session.http.newCall(okhttp3.Request.Builder().url(url).build()).execute().use { r ->
        check(r.isSuccessful) { "HTTP ${r.code}" }
        r.body.bytes() to (r.header("Content-Type")?.substringBefore(';')?.trim() ?: "image/png")
    }
}

/** A file name for it: the attachment's own, else the address's last part, with an extension that fits the type. */
private fun fileName(url: String, name: String, type: String): String {
    val base = name.ifBlank { url.substringBefore('?').substringAfterLast('/') }.ifBlank { "image" }.replace(Regex("[\\\\/:*?\"<>|]"), "_")
    val ext = android.webkit.MimeTypeMap.getSingleton().getExtensionFromMimeType(type) ?: "png"
    return if (base.contains('.')) base else "$base.$ext"
}

/** Into the phone's gallery, Pictures/Linkord (no permission needed from Android 10 on). */
suspend fun saveImage(ctx: Context, session: Session, url: String, name: String) {
    runCatching {
        val (bytes, type) = fetch(session, url)
        withContext(Dispatchers.IO) {
            val values = ContentValues().apply {
                put(MediaStore.Images.Media.DISPLAY_NAME, fileName(url, name, type))
                put(MediaStore.Images.Media.MIME_TYPE, type)
                put(MediaStore.Images.Media.RELATIVE_PATH, "${Environment.DIRECTORY_PICTURES}/Linkord")
                put(MediaStore.Images.Media.IS_PENDING, 1)
            }
            val resolver = ctx.contentResolver
            val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) ?: error("no media store")
            resolver.openOutputStream(uri)!!.use { it.write(bytes) }
            resolver.update(uri, ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING, 0) }, null, null)
        }
    }.onSuccess { session.toast(t("Saved to Pictures/Linkord")) }.onFailure { session.toast(t("Couldn't save the image.")) }
}

/** The picture itself to another app (the share sheet), through the FileProvider (res/xml/shared_files.xml). */
suspend fun shareImage(ctx: Context, session: Session, url: String, name: String) {
    runCatching {
        val (bytes, type) = fetch(session, url)
        val file = withContext(Dispatchers.IO) {
            val dir = File(ctx.cacheDir, "shared").apply { mkdirs() }
            dir.listFiles()?.forEach { it.delete() } // only the latest one is kept
            File(dir, fileName(url, name, type)).apply { writeBytes(bytes) }
        }
        val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.files", file)
        val send = Intent(Intent.ACTION_SEND).setType(type).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        send.clipData = ClipData.newRawUri(null, uri)
        ctx.startActivity(Intent.createChooser(send, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }.onFailure { session.toast(t("Couldn't share the image.")) }
}

/** Save, Share and Copy Link (and Open in Browser when asked) as sheet rows; [done] closes the sheet first. */
@Composable
fun ImageActionRows(url: String, name: String, browser: Boolean = false, done: (then: () -> Unit) -> Unit) {
    val ctx = LocalContext.current
    val session = ctx.session
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    SheetAction(LinkordIcons.Download, t("Save Image")) { done { session.launch { saveImage(ctx, session, url, name) } } }
    SheetAction(LinkordIcons.Forward, t("Share")) { done { session.launch { shareImage(ctx, session, url, name) } } }
    SheetAction(LinkordIcons.Link, t("Copy Link")) {
        scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("link", url))) }
        done { session.toast(t("Link copied")) }
    }
    if (browser) SheetAction(LinkordIcons.External, t("Open in Browser")) { done { openLink(ctx, url) } }
}

/** The full-screen viewer's long press: the picture's actions in a sheet. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ImageSheet(url: String, name: String, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismiss, containerColor = Linkord.colors.panel) {
        Column(Modifier.navigationBarsPadding().padding(bottom = 12.dp)) {
            ImageActionRows(url, name, browser = true) { then -> onDismiss(); then() }
        }
    }
}
