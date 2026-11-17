package com.linkord.app.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.linkord.app.BuildConfig
import com.linkord.app.session
import com.linkord.app.ui.chat.ScreenScaffold
import com.linkord.app.ui.components.Kicker
import com.linkord.core.t
import com.linkord.designsystem.Linkord
import kotlinx.serialization.Serializable
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/** One release of the Android app (server api/updates.rs changelog?app=android, written by android/publish.sh). */
@Serializable
private data class Release(val version: String, val date: String? = null, val notes: String = "")

/** Patch notes are one change per line (a leading "- " is fine), like the web's patch notes page. */
private fun lines(notes: String) = notes.lines().map { it.replace(Regex("^\\s*[-*•]\\s*"), "").trim() }.filter { it.isNotEmpty() }

private fun longDate(iso: String?) = iso?.let {
    runCatching { DateTimeFormatter.ofLocalizedDate(FormatStyle.LONG).format(Instant.parse(it).atZone(ZoneId.systemDefault())) }.getOrNull()
}

/** What changed in the Android app, newest first. */
@Composable
fun PatchNotesScreen() {
    val session = LocalContext.current.session
    val c = Linkord.colors
    var releases by remember { mutableStateOf<List<Release>?>(null) }
    var failed by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        runCatching { session.api.get<List<Release>>("/changelog?app=android") }
            .onSuccess { releases = it }
            .onFailure { failed = session.describe(it) }
    }
    ScreenScaffold(t("Patch notes")) {
        val list = releases ?: return@ScreenScaffold Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            val why = failed
            if (why != null) Text(why, style = Linkord.type.small, color = c.text3, modifier = Modifier.padding(24.dp)) else CircularProgressIndicator(color = c.text3)
        }
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item {
                Text(
                    t("What changed in the Linkord app for Android, newest first. It updates itself when a new version comes out."),
                    style = Linkord.type.small, color = c.text3, modifier = Modifier.padding(horizontal = 4.dp, vertical = 4.dp),
                )
            }
            if (list.isEmpty()) item { Text(t("No patch notes yet."), style = Linkord.type.small, color = c.text3, modifier = Modifier.padding(4.dp)) }
            itemsIndexed(list, key = { _, r -> r.version }) { i, r ->
                Column(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(c.panel).padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(r.version, style = Linkord.type.display)
                        if (i == 0) Tag(t("Latest"), strong = true)
                        if (r.version == BuildConfig.VERSION_NAME) Tag(t("Your version"))
                    }
                    longDate(r.date)?.let { Kicker(it) }
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        for (l in lines(r.notes)) Row {
                            Box(Modifier.padding(top = 8.dp).size(4.dp).clip(RoundedCornerShape(2.dp)).background(c.text3))
                            Spacer(Modifier.width(10.dp))
                            Text(l, style = Linkord.type.body, color = c.text2)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Tag(text: String, strong: Boolean = false) {
    val c = Linkord.colors
    Text(
        text.uppercase(), style = Linkord.type.label, color = if (strong) c.onBrand else c.text2,
        modifier = Modifier.clip(RoundedCornerShape(5.dp)).background(if (strong) c.brand else c.raised).padding(horizontal = 6.dp, vertical = 2.dp),
    )
}
