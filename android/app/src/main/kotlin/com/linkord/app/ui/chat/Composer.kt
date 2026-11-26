package com.linkord.app.ui.chat

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.imeAnimationTarget
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.input.InputTransformation
import androidx.compose.foundation.text.input.TextFieldLineLimits
import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.foundation.content.MediaType
import androidx.compose.foundation.content.TransferableContent
import androidx.compose.foundation.content.consume
import androidx.compose.foundation.content.contentReceiver
import androidx.compose.foundation.content.hasMediaType
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.activity.compose.BackHandler
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.linkord.app.data.Actions
import com.linkord.app.data.Outgoing
import com.linkord.app.session
import com.linkord.app.ui.components.Avatar
import com.linkord.app.ui.components.LIcon
import com.linkord.core.Channel
import com.linkord.core.Message
import com.linkord.core.User
import com.linkord.core.dmName
import com.linkord.core.nameOf
import com.linkord.core.t
import com.linkord.designsystem.Linkord
import com.linkord.designsystem.LinkordIcons
import kotlinx.coroutines.launch

/**
 * The message box. Mentions are typed as "@Name" and sent as <@id> (the web client's lib/mentions.ts); long text
 * goes as message.txt, like Discord.
 */
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class, androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
fun Composer(
    channel: Channel,
    replyTo: Message?,
    editing: Message?,
    onCancelReply: () -> Unit,
    onCancelEdit: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val session = LocalContext.current.session
    val st by session.store.state.collectAsState()
    val c = Linkord.colors
    val haptics = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    // The field keeps its text in a TextFieldState (pasting pictures needs the state-based field); the code below
    // reads and writes it as a TextFieldValue through `value`.
    val field = remember(channel.id) { TextFieldState(Drafts.get(channel.id)) }
    val fieldValue = remember(field) { FieldValue(field) }
    var value by fieldValue
    val files = remember(channel.id) { mutableStateListOf<Outgoing>() }
    // "@Name" -> user id, for what was picked from the suggestions.
    val picked = remember(channel.id) { HashMap<String, String>() }
    var attachMenu by remember { mutableStateOf(false) }
    // The attached picture or video open in its editor (AttachmentEdit.kt).
    var fileEdit by remember { mutableStateOf<Outgoing?>(null) }
    // ":name:" -> <:name:id>, for server emoji picked from the sheet.
    val pickedEmoji = remember(channel.id) { HashMap<String, String>() }
    // The emoji panel takes the keyboard's place under the box, like WhatsApp, so what you're typing stays in view.
    var emojiPanel by remember { mutableStateOf(false) }
    // Its search box has the keyboard: the panel shrinks to a strip of results above it.
    var searching by remember { mutableStateOf(false) }
    val keyboard = LocalSoftwareKeyboardController.current
    val fieldFocus = remember { FocusRequester() }

    LaunchedEffect(editing?.id) {
        editing?.let { value = TextFieldValue(displayMentions(it.content, st, channel.guildId, picked), TextRange(it.content.length)) }
    }

    // Voice messages, like WhatsApp: hold the mic to record, release to send, slide left to cancel, slide up to lock
    // (then delete / pause and play back / send). VoiceRecording.kt.
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val vn = remember(channel.id) { VoiceNoteState() }
    androidx.compose.runtime.DisposableEffect(vn) { onDispose { vn.cancel() } }
    RecordingTicker(vn)
    val askMic = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    fun startRecording(): Boolean {
        val r = VoiceNoteRecorder(ctx)
        return runCatching { r.start() }.onSuccess {
            vn.recorder = r
            vn.paused = false
            vn.mode = RecMode.Holding
        }.onFailure {
            r.cancel()
            session.toast(t("Couldn't start recording."))
        }.isSuccess
    }
    fun sendRecording() {
        val rec = vn.recorder ?: return
        vn.recorder = null
        vn.mode = RecMode.Idle
        vn.paused = false
        val done = rec.finish()
        if (done == null) session.toast(t("Hold on a little longer: that was too short to send."))
        else {
            session.actions.sendVoice(channel.id, done.first, done.second, done.third, replyTo?.id)
            onCancelReply()
            haptics.performHapticFeedback(HapticFeedbackType.Confirm)
        }
    }

    // Linkord's own picker (MediaPicker): photos and videos, up to 10, in the order picked.
    var pickingMedia by remember { mutableStateOf(false) }
    val documents = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris -> files += uris.map { session.actions.describeUri(it) } }
    // Pictures, GIFs and videos pasted into the box, or sent from the keyboard (its GIFs and stickers), are attached.
    val editingNow by androidx.compose.runtime.rememberUpdatedState(editing)
    val receiveMedia: (TransferableContent) -> TransferableContent? = receive@{ content ->
        if (editingNow != null || !(content.hasMediaType(MediaType.Image) || content.hasMediaType(VIDEO))) return@receive content
        val clip = content.clipEntry.clipData
        val fallback = content.clipMetadata.clipDescription?.takeIf { it.mimeTypeCount > 0 }?.getMimeType(0)
        for (i in 0 until clip.itemCount) {
            val uri = clip.getItemAt(i).uri ?: continue
            session.actions.takePasted(uri, fallback) { out -> if (out != null) files += out else session.toast(t("Couldn't attach that.")) }
        }
        content.consume { it.uri != null }
    }

    fun send() {
        var text = toWire(value.text.trim(), picked, st, channel)
        for ((k, v) in pickedEmoji) text = text.replace(k, v)
        if (editing != null) {
            scope.launch { runCatching { session.actions.editMessage(editing, text) }.onFailure { session.toast(session.describe(it)) } }
            onCancelEdit()
        } else {
            if (text.isEmpty() && files.isEmpty()) return
            // "/play ..." goes to the bot (unknown commands are sent as text).
            val cmd = if (files.isEmpty()) com.linkord.app.data.Commands.parse(text, st, channel.guildId) else null
            if (cmd != null) {
                session.actions.runCommand(channel.id, cmd.first.name, cmd.second)
                value = TextFieldValue("")
                Drafts.set(channel.id, "")
                return
            }
            session.actions.sendMessage(channel.id, text, replyTo?.id, files.toList())
            onCancelReply()
            files.clear()
        }
        haptics.performHapticFeedback(HapticFeedbackType.Confirm)
        value = TextFieldValue("")
        Drafts.set(channel.id, "")
        session.actions.resetTyping()
    }

    // Typing "/" lists the commands of the bots here (Kass, Steve), like the web client.
    val commandQuery = Regex("^/([\\w-]*)$").find(value.text)?.groupValues?.get(1)?.lowercase()
    val commands = remember(commandQuery, st.botCommands, channel.id) {
        if (commandQuery == null) emptyList() else com.linkord.app.data.Commands.inChannel(st, channel.guildId).filter { it.name.startsWith(commandQuery) }
    }
    val query = mentionQuery(value)
    val suggestions = remember(query, st.members, channel.id) { if (query == null) emptyList() else suggest(query, st, channel) }

    val density = LocalDensity.current
    val imeInsets = WindowInsets.ime
    val imeTarget = WindowInsets.imeAnimationTarget
    val navInsets = WindowInsets.navigationBars
    val imePx = imeInsets.getBottom(density)
    val navPx = navInsets.getBottom(density)
    // The panel is as tall as the keyboard was (so switching between them doesn't move the box), within what the
    // screen can spare on a small phone.
    val screenPx = with(density) { LocalConfiguration.current.screenHeightDp.dp.roundToPx() }
    LaunchedEffect(Unit) {
        snapshotFlow { imeInsets.getBottom(density) to imeTarget.getBottom(density) }.collect { (now, target) ->
            if (now == target && now > navInsets.getBottom(density) + with(density) { 120.dp.roundToPx() } && !searching) KeyboardHeight.px = now
        }
    }
    val panelPx = (KeyboardHeight.px.takeIf { it > 0 } ?: (with(density) { 300.dp.roundToPx() } + navPx))
        .coerceIn(with(density) { 220.dp.roundToPx() } + navPx, maxOf(screenPx / 2, with(density) { 220.dp.roundToPx() } + navPx))
    val searchPx = with(density) { 156.dp.roundToPx() }
    // Opening hides the keyboard; once it has gone, the keyboard coming back for the message box (a tap on it, or the
    // keyboard button) closes the panel when it's fully up, so the box doesn't jump.
    LaunchedEffect(emojiPanel) {
        if (!emojiPanel) {
            searching = false
            return@LaunchedEffect
        }
        var wentDown = false
        snapshotFlow { Triple(imeInsets.getBottom(density), imeTarget.getBottom(density), searching) }.collect { (now, target, search) ->
            val nav = navInsets.getBottom(density)
            if (target <= nav) wentDown = true
            else if (wentDown && !search && now == target) emojiPanel = false
        }
    }
    BackHandler(enabled = emojiPanel) { emojiPanel = false }
    fun insertEmoji(e: String) {
        val custom = Regex("^(\\w+):(\\d+)$").find(e)
        val insert = if (custom != null) {
            val (name, id) = custom.destructured
            val animated = st.emojis.values.any { l -> l.any { it.id == id && it.animated } }
            pickedEmoji[":$name:"] = "<${if (animated) "a" else ""}:$name:$id>"
            ":$name: "
        } else e
        val at = value.selection.start.coerceIn(0, value.text.length)
        val text = value.text.substring(0, at) + insert + value.text.substring(at)
        value = TextFieldValue(text, TextRange(at + insert.length))
        Drafts.set(channel.id, text)
    }

    Column(modifier.fillMaxWidth().background(c.page)) {
    Column(Modifier.fillMaxWidth().animateContentSize()) {
        if (commands.isNotEmpty()) Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp).clip(RoundedCornerShape(14.dp)).background(c.raised).padding(vertical = 4.dp)) {
            for (cmd in commands.take(8)) Column(
                Modifier.fillMaxWidth().clickable {
                    if (cmd.option == null) {
                        session.actions.runCommand(channel.id, cmd.name, "")
                        value = TextFieldValue("")
                    } else value = TextFieldValue("/${cmd.name} ", TextRange(cmd.name.length + 2))
                }.padding(horizontal = 12.dp, vertical = 8.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("/${cmd.name}", style = Linkord.type.bodyStrong)
                    cmd.option?.let { Text("  $it", style = Linkord.type.mono) }
                    Spacer(Modifier.weight(1f))
                    Text(cmd.botId?.let { st.users[it]?.name } ?: "Kass", style = Linkord.type.label)
                }
                Text(cmd.description, style = Linkord.type.small, color = c.text3, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (suggestions.isNotEmpty()) Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp).clip(RoundedCornerShape(14.dp)).background(c.raised).padding(vertical = 4.dp)) {
            for (u in suggestions) Row(
                Modifier.fillMaxWidth().clickable {
                    val name = st.nameOf(u.id, channel.guildId, u.username)
                    val start = value.text.lastIndexOf('@', value.selection.start - 1)
                    val text = value.text.substring(0, start) + "@$name " + value.text.substring(value.selection.start)
                    picked["@$name"] = u.id
                    value = TextFieldValue(text, TextRange(start + name.length + 2))
                }.padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Avatar(u, 26.dp)
                Spacer(Modifier.width(10.dp))
                Text(st.nameOf(u.id, channel.guildId, u.username), style = Linkord.type.body, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(u.username, style = Linkord.type.label)
            }
        }
        val bar = when {
            editing != null -> t("Editing message") to onCancelEdit
            replyTo != null -> t("Replying to {name}", "name" to st.nameOf(replyTo.author.id, channel.guildId, t("Unknown"))) to onCancelReply
            else -> null
        }
        AnimatedVisibility(bar != null) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                LIcon(if (editing != null) LinkordIcons.Edit else LinkordIcons.Reply, size = 16.dp)
                Spacer(Modifier.width(8.dp))
                Text(bar?.first ?: "", style = Linkord.type.small, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                LIcon(LinkordIcons.Close, size = 18.dp, modifier = Modifier.clip(RoundedCornerShape(9.dp)).clickable { bar?.second?.invoke(); if (editing != null) value = TextFieldValue("") })
            }
        }
        // What's attached: pictures and videos as thumbnails (a tap edits one), other files by name.
        if (files.isNotEmpty()) AttachmentStrip(files.toList(), onRemove = { files.remove(it) }, onEdit = { fileEdit = it })
        fileEdit?.let { f ->
            AttachmentEditor(f, onCancel = { fileEdit = null }) { edited ->
                val i = files.indexOf(f)
                if (i >= 0) files[i] = edited
                fileEdit = null
            }
        }
        if (vn.mode == RecMode.Locked) LockedRecorder(vn, ::sendRecording)
        else Row(Modifier.fillMaxWidth().padding(start = 8.dp, end = 8.dp, top = 4.dp, bottom = 8.dp), verticalAlignment = Alignment.Bottom) {
            if (vn.mode == RecMode.Holding || vn.mode == RecMode.Cancelling) HoldingStrip(vn, Modifier.weight(1f)) else {
            if (editing == null) Box {
                RoundButton(LinkordIcons.Plus) { attachMenu = true }
                DropdownMenu(attachMenu, { attachMenu = false }) {
                    DropdownMenuItem(text = { Text(t("Photos and videos")) }, leadingIcon = { LIcon(LinkordIcons.AddImage) }, onClick = {
                        attachMenu = false
                        pickingMedia = true
                    })
                    DropdownMenuItem(text = { Text(t("Files")) }, leadingIcon = { LIcon(LinkordIcons.Paperclip) }, onClick = {
                        attachMenu = false
                        documents.launch("*/*")
                    })
                }
                if (pickingMedia) com.linkord.app.ui.components.MediaPicker(t("Photos and videos"), videos = true, max = 10, onClose = { pickingMedia = false }) { uris ->
                    pickingMedia = false
                    files += uris.map { session.actions.describeUri(it) }
                }
            }
            Spacer(Modifier.width(6.dp))
            Box(Modifier.weight(1f).clip(RoundedCornerShape(20.dp)).background(c.raised).padding(horizontal = 14.dp, vertical = 11.dp)) {
                if (value.text.isEmpty()) Text(placeholder(channel, st), style = Linkord.type.body, color = c.text3, maxLines = 1, overflow = TextOverflow.Ellipsis)
                BasicTextField(
                    field,
                    // What's typed (not what the code puts in): the typing indicator and the draft.
                    inputTransformation = InputTransformation {
                        val now = toString()
                        if (now.length > originalText.length && now.isNotBlank()) session.actions.sendTyping(channel.id)
                        Drafts.set(channel.id, now)
                    },
                    textStyle = Linkord.type.body.copy(color = c.text),
                    cursorBrush = SolidColor(c.brand),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                    lineLimits = TextFieldLineLimits.MultiLine(maxHeightInLines = 6),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 21.dp).focusRequester(fieldFocus).contentReceiver(receiveMedia),
                )
            }
            Spacer(Modifier.width(4.dp))
            Box(
                Modifier.size(44.dp).clip(RoundedCornerShape(22.dp)).clickable {
                    if (!emojiPanel) {
                        keyboard?.hide()
                        emojiPanel = true
                    } else {
                        // Back to the keyboard: the panel closes once it's up.
                        fieldFocus.requestFocus()
                        keyboard?.show()
                    }
                },
                contentAlignment = Alignment.Center,
            ) {
                LIcon(if (emojiPanel) LinkordIcons.Keyboard else LinkordIcons.Smile, size = 22.dp, tint = if (emojiPanel) c.text else c.text2)
            }
            }
            val canSend = value.text.isNotBlank() || files.isNotEmpty()
            if (!canSend && editing == null) {
                Spacer(Modifier.width(6.dp))
                HoldToRecordMic(
                    vn,
                    hasPermission = { androidx.core.content.ContextCompat.checkSelfPermission(ctx, android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED },
                    askPermission = { askMic.launch(android.Manifest.permission.RECORD_AUDIO) },
                    start = ::startRecording,
                    send = ::sendRecording,
                )
            }
            AnimatedVisibility(canSend) {
                Row {
                    Spacer(Modifier.width(6.dp))
                    Box(Modifier.size(44.dp).clip(RoundedCornerShape(22.dp)).background(c.brand).clickable(onClick = ::send), contentAlignment = Alignment.Center) {
                        LIcon(if (editing != null) LinkordIcons.Check else LinkordIcons.Send, size = 20.dp, tint = c.onBrand)
                    }
                }
            }
        }
        if (value.text.length > Actions.MAX_MESSAGE) Text(
            t("{n} / {max}: sends as message.txt", "n" to value.text.length, "max" to Actions.MAX_MESSAGE),
            style = Linkord.type.label, modifier = Modifier.padding(start = 16.dp, bottom = 6.dp),
        )
    }
        // Under the box: the keyboard's room (or the navigation bar's), or the emoji panel in its place.
        val bottomPx = if (emojiPanel) maxOf(panelPx, imePx + if (searching) searchPx else 0) else maxOf(imePx, navPx)
        if (emojiPanel) Box(Modifier.fillMaxWidth().height(with(density) { bottomPx.toDp() }).clipToBounds()) {
            val pickerPx = if (searching) maxOf(bottomPx - imePx, searchPx) else panelPx - navPx
            EmojiPicker(st, channel.guildId, height = with(density) { pickerPx.toDp() }, onSearchFocus = { searching = it }, onPick = ::insertEmoji)
        } else Spacer(Modifier.height(with(density) { bottomPx.toDp() }))
    }
}

/** The keyboard's last full height (px, from the screen's bottom), for the emoji panel that takes its place. */
private object KeyboardHeight {
    var px = 0
}

@Composable
private fun RoundButton(icon: androidx.compose.ui.graphics.vector.ImageVector, onClick: () -> Unit) {
    Box(Modifier.size(44.dp).clip(RoundedCornerShape(22.dp)).background(Linkord.colors.raised).clickable(onClick = onClick), contentAlignment = Alignment.Center) {
        LIcon(icon, size = 22.dp, tint = Linkord.colors.text)
    }
}

private fun placeholder(ch: Channel, st: com.linkord.core.State) =
    if (ch.guildId != null) t("Message #{channel}", "channel" to ch.name) else t("Message {name}", "name" to st.dmName(ch, t("Empty group")))

/** The word being typed after an "@", if any. */
private fun mentionQuery(v: TextFieldValue): String? {
    val upTo = v.text.substring(0, v.selection.start.coerceAtMost(v.text.length))
    val at = upTo.lastIndexOf('@')
    if (at < 0 || (at > 0 && !upTo[at - 1].isWhitespace())) return null
    val q = upTo.substring(at + 1)
    return if (q.length <= 32 && q.none { it.isWhitespace() }) q.lowercase() else null
}

/** People to mention here: the server's members, or the DM's people, matching what's typed. */
private fun suggest(q: String, st: com.linkord.core.State, ch: Channel): List<User> {
    val ids = if (ch.guildId != null) st.members[ch.guildId]?.keys ?: emptySet() else ch.recipients?.map { it.id }?.toSet() ?: emptySet()
    return ids.mapNotNull { st.users[it] }
        .filter { u -> u.username.startsWith(q) || st.nameOf(u.id, ch.guildId, "").lowercase().startsWith(q) }
        .sortedBy { st.nameOf(it.id, ch.guildId, "").lowercase() }
        .take(6)
}

/** "@Name" back to <@id> for what was picked or what matches someone here exactly. */
private fun toWire(text: String, picked: Map<String, String>, st: com.linkord.core.State, ch: Channel): String {
    var out = text
    for ((name, id) in picked.entries.sortedByDescending { it.key.length }) out = out.replace(name, "<@$id>")
    return out
}

/** For editing: <@id> as "@Name", remembered so it goes back as the mention. */
private fun displayMentions(content: String, st: com.linkord.core.State, guildId: String?, picked: HashMap<String, String>): String =
    Regex("<@(\\d+)>").replace(content) { m ->
        val name = "@" + st.nameOf(m.groupValues[1], guildId, t("Unknown"))
        picked[name] = m.groupValues[1]
        name
    }

/** The box's text as a TextFieldValue (what the mention, emoji and command code reads and writes), over the field's
 *  TextFieldState. */
private class FieldValue(private val state: TextFieldState) {
    operator fun getValue(thisRef: Any?, property: kotlin.reflect.KProperty<*>): TextFieldValue = TextFieldValue(state.text.toString(), state.selection)

    operator fun setValue(thisRef: Any?, property: kotlin.reflect.KProperty<*>, v: TextFieldValue) {
        state.edit {
            replace(0, length, v.text)
            selection = v.selection
        }
    }
}

private val VIDEO = MediaType("video/*")

/** Unsent text per channel, kept while the app runs. */
object Drafts {
    private val map = HashMap<String, String>()
    fun get(id: String) = map[id] ?: ""
    fun set(id: String, text: String) {
        if (text.isEmpty()) map.remove(id) else map[id] = text
    }
}

