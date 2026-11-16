package com.linkord.app.ui.settings

import android.net.Uri
import androidx.compose.runtime.Composable
import com.linkord.app.ui.components.MediaPicker
import com.linkord.core.t

/**
 * One picture for a profile or server (picture/icon and banner), from Linkord's own picker (MediaPicker): a tap picks,
 * and the cropper opens over it.
 */
@Composable
fun PhotoPicker(
    kind: ImageKind,
    onClose: () -> Unit,
    title: String = if (kind == ImageKind.Avatar) t("Choose a picture") else t("Choose a banner"),
    onPick: (Uri) -> Unit,
) = MediaPicker(title, videos = false, max = 1, onClose = onClose) { onPick(it.first()) }
