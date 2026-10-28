// Saving media to disk. The desktop app writes into the Downloads folder through a native command
// (WebView2 ignores <a download> for files from another origin); browsers get a normal download.

import { t } from './i18n';
import { isTauri, openExternal } from './platform';
import { toast } from './ui';

/** Strips what Windows doesn't allow in file names. */
export function safeFilename(name: string, fallback = 'download') {
  const clean = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '');
  return clean.slice(0, 180) || fallback;
}

export function filenameFromUrl(url: string, fallback = 'video.mp4') {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
    return safeFilename(last.includes('.') ? last : fallback, fallback);
  } catch {
    return fallback;
  }
}

/** Downloads `url` as `filename`, reporting progress from 0 to 1 (NaN when the size is unknown). */
export async function downloadFile(url: string, filename: string, onProgress?: (p: number) => void) {
  const name = safeFilename(filename);
  let res: Response;
  try {
    res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch {
    // Other sites' files may not allow cross-origin reads; let the browser fetch it instead.
    toast(t("Couldn't download here — opening it in your browser"));
    return void openExternal(url);
  }
  const total = Number(res.headers.get('content-length')) || 0;
  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = res.body!.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.(total ? received / total : NaN);
  }
  const blob = new Blob(chunks as BlobPart[], { type: res.headers.get('content-type') ?? undefined });

  if (isTauri) {
    const { invoke } = await import('@tauri-apps/api/core');
    const path = await invoke<string>('save_download', new Uint8Array(await blob.arrayBuffer()), {
      headers: { 'x-filename': encodeURIComponent(name) },
    });
    toast(t('Saved to {path}', { path }), 5000);
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}
