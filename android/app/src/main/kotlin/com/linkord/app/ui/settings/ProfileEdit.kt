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
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import com.linkord.app.session
import com.linkord.app.ui.home.Section
import com.linkord.app.ui.profile.Profile
import com.linkord.app.ui.profile.ProfileLink
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

/**
 * A picture ready to upload: a JPEG already cut to the frame, or a GIF as it is with where to cut it ([crop], the
 * server's Crop JSON: it crops and resizes there and keeps it animated). [preview] is the framed still to show meanwhile.
 */
class Picked(val bytes: ByteArray, val type: String = "image/jpeg", val crop: String? = null, val preview: ByteArray = bytes) {
    fun body(field: String): MultipartBody {
        val b = MultipartBody.Builder().setType(MultipartBody.FORM)
        // The crop goes before the file (users.rs read_image).
        crop?.let { b.addFormDataPart("crop", it) }
        return b.addFormDataPart("file", "$field.${if (type == "image/gif") "gif" else "jpg"}", bytes.toRequestBody(type.toMediaType())).build()
    }
}

/** The web client's banner colours (ColorPicker.tsx PRESETS). */
private val BANNER_COLORS = listOf(0x2b2d31, 0x1f3b4d, 0x3d2f52, 0x5a2a2a, 0x6b4e1f, 0xe3b341, 0x4fb8c4, 0x3ba55d, 0xe5484d, 0xf0b232, 0x8b7cf6, 0xe8e8ea)
private const val MAX_LINKS = 5

/** A birthday as the server keeps it ('MM-DD' or 'YYYY-MM-DD', "" = none), in parts for the three inputs. */
private data class Birthday(val month: Int = 0, val day: Int = 1, val year: String = "") {
    /** Days the month can have (February keeps the 29th: without a year it's allowed). */
    val days: Int get() = if (month == 0) 31 else java.time.Month.of(month).maxLength()
    fun wire(): String = when {
        month == 0 -> ""
        year.length == 4 -> "%s-%02d-%02d".format(year, month, day.coerceAtMost(days))
        else -> "%02d-%02d".format(month, day.coerceAtMost(days))
    }

    companion object {
        fun parse(b: String?): Birthday {
            val parts = b.orEmpty().split('-').mapNotNull { it.toIntOrNull() }
            return when (parts.size) {
                2 -> Birthday(parts[0].coerceIn(1, 12), parts[1].coerceIn(1, 31))
                3 -> Birthday(parts[1].coerceIn(1, 12), parts[2].coerceIn(1, 31), parts[0].toString())
                else -> Birthday()
            }
        }
    }
}

/**
 * Your profile, like the web client's Profile page: a live preview on top (banner, picture, name: tap a picture to
 * change it), then recent pictures, the banner colour, birthday, links and the profile widgets. Text, colour, birthday,
 * links and new pictures wait for Save Changes (the bar at the bottom); a recent picture and the widget switches apply
 * at once, as on the web.
 */
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
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
    var staged by remember { mutableStateOf(mapOf<ImageKind, Picked?>()) }
    var pronouns by remember { mutableStateOf(me.pronouns) }
    var bio by remember { mutableStateOf(me.bio) }
    var accent by remember { mutableStateOf(me.accentColor) }
    var birthday by remember { mutableStateOf(Birthday.parse(me.birthday)) }
    var busy by remember { mutableStateOf(false) }
    var leaving by remember { mutableStateOf(false) }
    var cropping by remember { mutableStateOf<Pair<ImageKind, Uri>?>(null) }
    // Linkord's own picker (PhotoPicker.kt): the system one was confusing and couldn't reach every photo.
    var picking by remember { mutableStateOf<ImageKind?>(null) }

    // Links and the widget switches come with the full profile; recent pictures have their own list.
    var savedLinks by remember { mutableStateOf<List<ProfileLink>?>(null) }
    val links = remember { mutableStateListOf<ProfileLink>() }
    var showStats by remember { mutableStateOf<Boolean?>(null) }
    var showTopSongs by remember { mutableStateOf<Boolean?>(null) }
    var recent by remember { mutableStateOf(emptyList<String>()) }
    LaunchedEffect(me.id) {
        runCatching { session.api.get<Profile>("/users/${me.id}/profile") }.onSuccess { p ->
            savedLinks = p.links
            links.clear()
            links += p.links
            showStats = p.showStats ?: false
            showTopSongs = p.showTopSongs ?: true
        }
    }
    LaunchedEffect(me.avatar) { runCatching { session.api.get<List<String>>("/users/@me/avatars") }.onSuccess { recent = it } }

    fun cleanLinks() = links.map { ProfileLink(it.url.trim(), it.label.trim()) }.filter { it.url.isNotEmpty() }
    val nameChanged = name.trim() != me.name
    val linksChanged = savedLinks != null && cleanLinks() != savedLinks
    val birthdayChanged = birthday.wire() != (me.birthday ?: "")
    // A year is four digits or nothing; the server checks the rest (a real date, not in the future).
    val birthdayOk = birthday.month == 0 || birthday.year.isEmpty() || birthday.year.length == 4
    val dirty = nameChanged || pronouns != me.pronouns || bio != me.bio || accent != me.accentColor || birthdayChanged || linksChanged || staged.isNotEmpty()
    fun reset() {
        name = me.name
        pronouns = me.pronouns
        bio = me.bio
        accent = me.accentColor
        birthday = Birthday.parse(me.birthday)
        staged = emptyMap()
        links.clear()
        links += savedLinks.orEmpty()
    }
    fun apply(u: User) = session.store.update { it.putUser(u).copy(me = it.me?.let { m -> u.copy(status = m.status) }) }
    // Each part is cleared once it's saved, so a failure leaves only what didn't go through.
    fun save(thenLeave: Boolean = false) {
        if (busy || !birthdayOk) return
        busy = true
        scope.launch {
            runCatching {
                for ((kind, picked) in staged.toMap()) {
                    if (picked == null) {
                        session.api.raw("DELETE", "/users/@me/${kind.path}")
                        apply(session.api.get<User>("/users/@me"))
                    } else {
                        apply(session.api.decode<User>(session.api.raw("POST", "/users/@me/${kind.path}", picked.body(kind.path))))
                    }
                    staged = staged - kind
                }
                val fields = buildMap<String, Any> {
                    if (nameChanged) put("display_name", name.trim())
                    if (pronouns != me.pronouns) put("pronouns", pronouns.trim())
                    if (bio != me.bio) put("bio", bio.trim())
                    accent?.let { if (it != me.accentColor) put("accent_color", it) }
                    if (birthdayChanged) put("birthday", birthday.wire())
                    if (linksChanged) put("links", cleanLinks().map { mapOf("url" to it.url, "label" to it.label) })
                }
                if (fields.isNotEmpty()) {
                    val u = session.api.patch<User>("/users/@me", fields)
                    apply(u)
                    // What the server kept (a cleared name falls back to the username, links get their scheme).
                    name = u.name
                    pronouns = u.pronouns
                    bio = u.bio
                    birthday = Birthday.parse(u.birthday)
                    if (linksChanged) runCatching { session.api.get<Profile>("/users/${me.id}/profile") }.onSuccess { p ->
                        savedLinks = p.links
                        links.clear()
                        links += p.links
                    }
                }
            }.onSuccess {
                session.toast(t("Profile saved"))
                if (thenLeave) nav.pop()
            }.onFailure { session.toast(session.describe(it)) }
            busy = false
        }
    }
    fun back() = if (dirty) leaving = true else nav.pop()
    BackHandler(enabled = dirty) { leaving = true }

    val bannerShown: Any? = if (ImageKind.Banner in staged) staged[ImageKind.Banner]?.preview else mediaUrl(me.banner)
    val avatarStaged = ImageKind.Avatar in staged
    val hasAvatar = if (avatarStaged) staged[ImageKind.Avatar] != null else me.avatar != null

    ScreenScaffold(t("Profile"), onBack = ::back) {
        Box(Modifier.fillMaxSize()) {
            Column(
                Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = if (dirty) 96.dp else 24.dp).navigationBarsPadding(),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                // The preview: the top of your profile as people see it, drawn with the unsaved choices.
                Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp).clip(RoundedCornerShape(14.dp)).background(c.panel)) {
                    Box(Modifier.fillMaxWidth().height(156.dp)) {
                        Box(Modifier.fillMaxWidth().height(112.dp).clickable { picking = ImageKind.Banner }) {
                            if (bannerShown != null) AsyncImage(bannerShown, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                            else Box(Modifier.fillMaxSize().background(accent?.let { Color(0xFF000000 or it.toLong()) } ?: c.raised2))
                            EditBadge(Modifier.align(Alignment.TopEnd).padding(10.dp))
                        }
                        Box(Modifier.align(Alignment.BottomStart).offset(x = 14.dp).clickable { picking = ImageKind.Avatar }) {
                            Box(Modifier.size(92.dp).clip(RoundedCornerShape(30)).background(c.panel))
                            when {
                                !avatarStaged -> Avatar(me, 80.dp, Modifier.padding(6.dp))
                                staged[ImageKind.Avatar] != null -> AsyncImage(staged[ImageKind.Avatar]?.preview, null, contentScale = ContentScale.Crop,
                                    modifier = Modifier.padding(6.dp).size(80.dp).clip(com.linkord.designsystem.AvatarShape))
                                else -> Avatar(me.copy(avatar = null), 80.dp, Modifier.padding(6.dp))
                            }
                            EditBadge(Modifier.align(Alignment.BottomEnd))
                        }
                    }
                    Column(Modifier.padding(start = 16.dp, end = 16.dp, top = 6.dp, bottom = 14.dp)) {
                        Text(name.trim().ifEmpty { me.username }, style = Linkord.type.display, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            listOf(me.username, pronouns.trim()).filter { it.isNotEmpty() }.joinToString(" · "),
                            style = Linkord.type.mono, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                        if (bio.isNotBlank()) Text(bio.trim(), style = Linkord.type.small, color = c.text2, maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 8.dp))
                    }
                }
                FlowRow(Modifier.padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    ProfilePill(if (bannerShown != null) t("Change banner") else t("Add banner")) { picking = ImageKind.Banner }
                    if (bannerShown != null) ProfilePill(t("Remove banner"), danger = true) {
                        staged = if (me.banner != null) staged + (ImageKind.Banner to null) else staged - ImageKind.Banner
                    }
                    if (hasAvatar) ProfilePill(t("Remove picture"), danger = true) {
                        staged = if (me.avatar != null) staged + (ImageKind.Avatar to null) else staged - ImageKind.Avatar
                    }
                }

                // Pictures you used before: a tap puts one back, right away.
                if (recent.size > 1) {
                    ProfileTitle(t("Recent pictures"))
                    Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        for (url in recent) {
                            val current = url == me.avatar && !avatarStaged
                            AsyncImage(
                                mediaUrl(url), t("Use this picture"), contentScale = ContentScale.Crop,
                                modifier = Modifier.size(56.dp).clip(com.linkord.designsystem.AvatarShape).background(c.raised)
                                    .border(if (current) 2.dp else 1.dp, if (current) c.brand else c.line, com.linkord.designsystem.AvatarShape)
                                    .clickable(enabled = !current && !busy) {
                                        session.launch {
                                            apply(session.api.decode<User>(session.api.raw("PUT", "/users/@me/avatar", session.api.jsonBody(mapOf("url" to url)))))
                                            staged = staged - ImageKind.Avatar
                                            session.toast(t("Picture updated"))
                                        }
                                    },
                            )
                        }
                    }
                }

                Section {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        OutlinedTextField(name, { name = it.take(32) }, label = { Text(t("Display Name")) }, placeholder = { Text(me.username) }, singleLine = true, modifier = Modifier.fillMaxWidth())
                        OutlinedTextField(pronouns, { pronouns = it.take(40) }, label = { Text(t("Pronouns")) }, singleLine = true, modifier = Modifier.fillMaxWidth())
                        OutlinedTextField(bio, { bio = it.take(190) }, label = { Text(t("About Me")) }, minLines = 3, maxLines = 8, modifier = Modifier.fillMaxWidth(),
                            supportingText = { Text("${bio.length}/190", style = Linkord.type.label) })
                    }
                }

                ProfileTitle(t("Banner colour"))
                Section {
                    FlowRow(Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        for (col in BANNER_COLORS) {
                            val on = accent == col
                            Box(
                                Modifier.size(34.dp).clip(CircleShape).background(Color(0xFF000000 or col.toLong()))
                                    .border(if (on) 3.dp else 1.dp, if (on) c.text else c.line, CircleShape).clickable { accent = col },
                                contentAlignment = Alignment.Center,
                            ) {
                                // The mark reads on light and dark swatches alike.
                                if (on) LIcon(LinkordIcons.Check, size = 16.dp, tint = if (Color(0xFF000000 or col.toLong()).luminance() > 0.5f) Color.Black else Color.White)
                            }
                        }
                    }
                    Text(t("Shown behind your profile when you have no banner image."), style = Linkord.type.small, color = c.text3, modifier = Modifier.padding(16.dp))
                }

                ProfileTitle(t("Birthday"))
                Section {
                    val months = remember { (1..12).map { m -> m to java.time.Month.of(m).getDisplayName(java.time.format.TextStyle.FULL_STANDALONE, ctx.resources.configuration.locales[0]).replaceFirstChar { it.uppercase() } } }
                    ChoiceRow(t("Month"), birthday.month, listOf(0 to t("Not set")) + months) { m -> birthday = birthday.copy(month = m).let { it.copy(day = it.day.coerceAtMost(it.days)) } }
                    if (birthday.month != 0) {
                        ChoiceRow(t("Day"), birthday.day.coerceAtMost(birthday.days), (1..birthday.days).map { it to it.toString() }) { birthday = birthday.copy(day = it) }
                        OutlinedTextField(
                            birthday.year, { v -> birthday = birthday.copy(year = v.filter { it.isDigit() }.take(4)) },
                            label = { Text(t("Year (optional)")) }, singleLine = true, isError = !birthdayOk,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                        )
                    }
                    Text(t("People see a cake next to your name on the day. The year is optional."), style = Linkord.type.small, color = c.text3, modifier = Modifier.padding(16.dp))
                }

                ProfileTitle(t("Links"))
                Section {
                    Text(t("Your website, Steam, Twitch, a playlist..."), style = Linkord.type.small, color = c.text3, modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 14.dp))
                    if (savedLinks == null) Spacer(Modifier.height(14.dp))
                    else {
                        links.forEachIndexed { i, l ->
                            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                                // The site's own mark as soon as the address says which one it is.
                                Box(Modifier.size(36.dp).clip(RoundedCornerShape(10.dp)).background(c.raised), contentAlignment = Alignment.Center) {
                                    LIcon(com.linkord.app.ui.components.siteIcon(l.url), size = 18.dp, tint = c.text2)
                                }
                                Column(Modifier.weight(1f).padding(start = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                    OutlinedTextField(l.label, { links[i] = l.copy(label = it.take(32)) }, label = { Text(t("Name")) }, singleLine = true, modifier = Modifier.fillMaxWidth())
                                    OutlinedTextField(
                                        l.url, { links[i] = l.copy(url = it.take(512)) }, label = { Text(t("Address")) }, singleLine = true,
                                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false),
                                        modifier = Modifier.fillMaxWidth(),
                                    )
                                }
                                Box(
                                    Modifier.size(44.dp).clip(RoundedCornerShape(22.dp)).clickable { links.removeAt(i) }.semantics { contentDescription = t("Remove link") },
                                    contentAlignment = Alignment.Center,
                                ) { LIcon(LinkordIcons.Trash, size = 18.dp, tint = c.danger) }
                            }
                        }
                        if (links.size < MAX_LINKS) Row(
                            Modifier.fillMaxWidth().clickable { links += ProfileLink("", "") }.padding(horizontal = 16.dp, vertical = 14.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            LIcon(LinkordIcons.Plus, size = 18.dp, tint = c.text)
                            Spacer(Modifier.width(12.dp))
                            Text(t("Add link"), style = Linkord.type.body, modifier = Modifier.weight(1f))
                            Text("${links.size}/$MAX_LINKS", style = Linkord.type.label)
                        } else Spacer(Modifier.height(14.dp))
                    }
                }

                // The switches apply at once, like the web client's.
                val stats = showStats
                val songs = showTopSongs
                if (stats != null && songs != null) {
                    ProfileTitle(t("Profile widgets"))
                    Section {
                        SwitchRow(t("Show my stats"), t("Time in voice, messages, longest call... (Settings → Stats)"), stats) { on ->
                            showStats = on
                            session.launch { runCatching { session.api.patch<User>("/users/@me", mapOf("show_stats" to on)) }.onFailure { showStats = !on; throw it } }
                        }
                        SwitchRow(t("Show my top Kass songs"), t("The songs you play most with /play."), songs) { on ->
                            showTopSongs = on
                            session.launch { runCatching { session.api.patch<User>("/users/@me", mapOf("show_top_songs" to on)) }.onFailure { showTopSongs = !on; throw it } }
                        }
                    }
                }
            }
            // Away while typing: over the keyboard it covered the field being filled in.
            UnsavedBar(dirty && !androidx.compose.foundation.layout.WindowInsets.isImeVisible, busy, canSave = birthdayOk, onReset = ::reset, onSave = { save() }, modifier = Modifier.align(Alignment.BottomCenter))
        }
    }

    if (leaving) AlertDialog(
        onDismissRequest = { leaving = false },
        title = { Text(t("Careful — you have unsaved changes!")) },
        text = { Text(t("Save them before you leave, or discard them.")) },
        confirmButton = { TextButton(enabled = birthdayOk, onClick = { leaving = false; save(thenLeave = true) }) { Text(t("Save Changes")) } },
        dismissButton = { TextButton(onClick = { leaving = false; reset(); nav.pop() }) { Text(t("Discard"), color = c.danger) } },
    )
    picking?.let { kind -> PhotoPicker(kind, onClose = { picking = null }) { uri -> cropping = kind to uri } }
    // Over the picker: cancelling the crop goes back to the photos, finishing closes both.
    cropping?.let { (kind, uri) ->
        ImageCropper(uri, kind, allowGif = true, onCancel = { cropping = null }) { picked ->
            cropping = null
            picking = null
            staged = staged + (kind to picked)
        }
    }
}

@Composable
private fun ProfileTitle(text: String) = Kicker(text, Modifier.padding(start = 24.dp, top = 8.dp))

@Composable
private fun ProfilePill(text: String, danger: Boolean = false, onClick: () -> Unit) {
    val c = Linkord.colors
    Text(
        text, style = Linkord.type.small, color = if (danger) c.danger else c.text, maxLines = 1, softWrap = false,
        modifier = Modifier.clip(RoundedCornerShape(10.dp)).background(c.raised).border(1.dp, c.line, RoundedCornerShape(10.dp))
            .clickable(onClick = onClick).padding(horizontal = 12.dp, vertical = 8.dp),
    )
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
fun ImageCropper(uri: Uri, kind: ImageKind, allowGif: Boolean = false, onCancel: () -> Unit, onDone: (Picked) -> Unit) {
    val ctx = LocalContext.current
    val c = Linkord.colors
    val scope = rememberCoroutineScope()
    // A GIF stays a GIF (profile pictures and banners): its first frame is framed here, and the file goes up whole
    // with where to cut it.
    val gif = remember(uri) { allowGif && ctx.contentResolver.getType(uri) == "image/gif" }
    // The picture's own width over the decoded one's (big photos are decoded smaller).
    var sourceScale by remember(uri) { mutableFloatStateOf(1f) }
    val bitmap = remember(uri) {
        runCatching {
            ImageDecoder.decodeBitmap(ImageDecoder.createSource(ctx.contentResolver, uri)) { d, info, _ ->
                d.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                // Big photos are scaled down to something a phone handles easily.
                val long = max(info.size.width, info.size.height)
                if (long > 3000) d.setTargetSampleSize((long / 3000) + 1)
            }.also { b -> sourceScale = imageWidth(ctx, uri)?.let { it / b.width.toFloat() } ?: 1f }
        }.getOrNull()
    }
    Dialog(onCancel, DialogProperties(usePlatformDefaultWidth = false)) {
        Column(Modifier.fillMaxSize().background(Color.Black).statusBarsPadding().navigationBarsPadding()) {
            Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onCancel) { Text(t("Cancel"), color = Color.White) }
                Spacer(Modifier.weight(1f))
                Kicker((if (kind == ImageKind.Avatar) t("Picture") else t("Banner")) + if (gif) " · GIF" else "", color = Color.White.copy(alpha = 0.7f))
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
                        val picked = withContext(Dispatchers.IO) {
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
                            val jpeg = ByteArrayOutputStream().also { out.compress(Bitmap.CompressFormat.JPEG, 90, it) }.toByteArray()
                            val whole = if (gif) runCatching { ctx.contentResolver.openInputStream(uri)?.use { it.readBytes() } }.getOrNull() else null
                            if (whole == null) Picked(jpeg)
                            else {
                                // In the GIF's own pixels (users.rs Crop).
                                val k = sourceScale
                                Picked(whole, "image/gif", "{\"x\":${x * k},\"y\":${y * k},\"w\":${cw * k},\"h\":${ch * k},\"rotate\":0}", preview = jpeg)
                            }
                        }
                        onDone(picked)
                    }
                },
                colors = ButtonDefaults.buttonColors(containerColor = c.brand, contentColor = c.onBrand),
                modifier = Modifier.fillMaxWidth().padding(16.dp).height(50.dp),
            ) { Text(t("Apply")) }
        }
    }
}


/** A picture's width in its own pixels, without decoding it. */
private fun imageWidth(ctx: android.content.Context, uri: Uri): Int? = runCatching {
    val o = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
    ctx.contentResolver.openInputStream(uri)?.use { android.graphics.BitmapFactory.decodeStream(it, null, o) }
    o.outWidth.takeIf { it > 0 }
}.getOrNull()
