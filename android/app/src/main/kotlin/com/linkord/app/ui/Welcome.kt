package com.linkord.app.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.linkord.app.R
import com.linkord.app.ui.components.LIcon
import com.linkord.core.t
import com.linkord.designsystem.Linkord
import com.linkord.designsystem.LinkordIcons
import kotlinx.coroutines.launch

private class Page(val icon: ImageVector?, val title: String, val text: String)

/** The first time the Android app opens: what's different on a phone, in three cards. Kept per phone. */
@Composable
fun Welcome(onDone: () -> Unit) {
    val c = Linkord.colors
    val pages = listOf(
        Page(null, t("Linkord, on your phone"), t("Your servers, DMs and calls, made for one hand. Everything you do here syncs with the desktop app.")),
        Page(LinkordIcons.Switch, t("Swipe between panels"), t("Swipe a chat right for your servers and channels, left for who's there. Swipe a message left to reply, hold it for reactions and more.")),
        Page(LinkordIcons.Phone, t("Calls keep going"), t("Join a voice channel or call from a DM. Leave the app and the call shrinks into a small window; the screen turns off at your ear.")),
    )
    val pager = rememberPagerState { pages.size }
    val scope = rememberCoroutineScope()
    Dialog(onDone, DialogProperties(usePlatformDefaultWidth = false)) {
        Column(Modifier.padding(24.dp).clip(RoundedCornerShape(24.dp)).background(c.panel).padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            HorizontalPager(pager, Modifier.fillMaxWidth().height(300.dp)) { i ->
                val p = pages[i]
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center, modifier = Modifier.fillMaxWidth()) {
                    Box(Modifier.size(96.dp).clip(RoundedCornerShape(28.dp)).background(c.raised), contentAlignment = Alignment.Center) {
                        if (p.icon == null) Image(painterResource(R.drawable.emblem), null, Modifier.size(72.dp))
                        else LIcon(p.icon, size = 44.dp, tint = c.text)
                    }
                    Spacer(Modifier.height(20.dp))
                    Text(p.title, style = Linkord.type.display, textAlign = TextAlign.Center)
                    Spacer(Modifier.height(10.dp))
                    Text(p.text, style = Linkord.type.body, color = c.text2, textAlign = TextAlign.Center)
                }
            }
            Row(Modifier.padding(vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                repeat(pages.size) { i ->
                    Box(Modifier.height(4.dp).width(if (i == pager.currentPage) 18.dp else 6.dp).clip(RoundedCornerShape(2.dp)).background(if (i == pager.currentPage) c.brand else c.lineStrong))
                }
            }
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onDone) { Text(t("Skip"), color = c.text3) }
                Spacer(Modifier.weight(1f))
                Button(
                    onClick = { if (pager.currentPage == pages.lastIndex) onDone() else scope.launch { pager.animateScrollToPage(pager.currentPage + 1) } },
                    colors = ButtonDefaults.buttonColors(containerColor = c.brand, contentColor = c.onBrand),
                ) { Text(if (pager.currentPage == pages.lastIndex) t("Let's go") else t("Next")) }
            }
        }
    }
}
