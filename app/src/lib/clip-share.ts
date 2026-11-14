// Sharing a REC clip or VOD (Windows app): uploads the local file to the server (server/src/clips.rs) in 50 MB parts,
// read straight off disk through the asset protocol (a range at a time: a 1 GB VOD never sits in memory), and
// resumes from where the server says it is after a dropped part. The file then lives at a public link anyone can open.

import { convertFileSrc } from '@tauri-apps/api/core';
import { api, getToken, serverUrl } from './api';
import { t } from './i18n';
import type { SharedClip } from './types';

/** Bytes of a local file, from a one-byte range ("bytes 0-0/<size>"). */
async function sizeOf(url: string): Promise<number> {
  const res = await fetch(url, { headers: { range: 'bytes=0-0' } });
  const total = res.headers.get('content-range')?.split('/')[1];
  if (total) return Number(total);
  return Number(res.headers.get('content-length') ?? 0) || (await res.arrayBuffer()).byteLength;
}

async function part(url: string, from: number, to: number): Promise<ArrayBuffer> {
  const res = await fetch(url, { headers: { range: `bytes=${from}-${to - 1}` } });
  const data = await res.arrayBuffer();
  // A server that ignores ranges sends everything: cut the part out.
  return res.status === 206 ? data : data.slice(from, to);
}

/** Uploads `path` and returns the shared clip; `progress` gets 0..1 as parts arrive. */
export async function shareFile(
  path: string,
  info: { title: string; game: string; kind: 'clip' | 'vod' },
  progress: (done: number) => void = () => {},
): Promise<SharedClip> {
  const url = convertFileSrc(path);
  const size = await sizeOf(url);
  if (!size) throw new Error(t("Couldn't read that file."));
  const { upload_id, chunk } = await api<{ upload_id: string; chunk: number }>('POST', '/clips', { size, ...info });
  let offset = 0;
  let failures = 0;
  while (offset < size) {
    const data = await part(url, offset, Math.min(size, offset + chunk));
    const res = await fetch(`${serverUrl()}/api/clips/uploads/${upload_id}?offset=${offset}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${getToken() ?? ''}` },
      body: data,
    }).catch(() => null);
    if (res?.ok || res?.status === 409) {
      // 409: the server has a different amount (a part went through but its answer didn't): go on from there.
      offset = (await res.json()).received;
      failures = 0;
      progress(offset / size);
      continue;
    }
    if (++failures >= 3) {
      await api('DELETE', `/clips/uploads/${upload_id}`).catch(() => {});
      throw new Error(t('The upload failed. Check your connection and try again.'));
    }
    await new Promise((r) => setTimeout(r, 1000 * failures));
  }
  return api<SharedClip>('POST', `/clips/uploads/${upload_id}/finish`);
}
