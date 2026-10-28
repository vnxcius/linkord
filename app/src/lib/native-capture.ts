// Bridge to the desktop app's native screen capture (Windows): source list with thumbnails,
// hardware H.264 frames and per-application audio, delivered over Tauri channels.
import { isWindows } from './desktop';
import { isTauri } from './platform';

export const nativeCaptureAvailable = isTauri && isWindows;

export interface CaptureSource {
  id: string;
  kind: 'screen' | 'window';
  name: string;
  app?: string | null;
  width: number;
  height: number;
  thumbnail?: string | null;
}

export interface CaptureInfo {
  encoder: 'hardware' | 'software';
  /** app: only the shared app · all_but_linkord · system: everything incl. voice chat (Windows 10) · none */
  audio: 'app' | 'all_but_linkord' | 'system' | 'none';
}

/** Per-app audio (and leaving Linkord's own sound out) needs Windows 11. */
export async function captureCapabilities(): Promise<{ per_app_audio: boolean }> {
  if (!nativeCaptureAvailable) return { per_app_audio: false };
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<{ per_app_audio: boolean }>('capture_capabilities').catch(() => ({ per_app_audio: false }));
}

export async function listCaptureSources(): Promise<CaptureSource[]> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke('list_capture_sources');
}

export async function startNativeCapture(
  opts: { source: string; height: number; fps: number; bitrate: number; audio: boolean },
  onVideo: (data: ArrayBuffer) => void,
  onAudio: (pcm: ArrayBuffer) => void,
): Promise<CaptureInfo> {
  const { Channel, invoke } = await import('@tauri-apps/api/core');
  const video = new Channel<ArrayBuffer>();
  video.onmessage = onVideo;
  const audio = new Channel<ArrayBuffer>();
  audio.onmessage = onAudio;
  return invoke('start_capture', { ...opts, onVideo: video, onAudio: audio });
}

export async function switchNativeSource(source: string): Promise<CaptureInfo> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke('capture_switch_source', { source });
}

export async function nativeCommand(cmd: 'stop_capture' | 'capture_keyframe') {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke(cmd).catch(() => {});
}

/** The captured device's own mix format (0 = unknown) and WASAPI gaps since the capture started. */
export interface CaptureAudioStats {
  mix_rate: number;
  mix_channels: number;
  discontinuities: number;
}

export async function captureAudioStats(): Promise<CaptureAudioStats | null> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<CaptureAudioStats>('capture_audio_stats').catch(() => null);
}

/** Where the native video pipeline's time goes since the previous call (ms averages and peaks per stage). */
export interface CaptureVideoStats {
  frames: number;
  busy_skips: number;
  readback_ms: number;
  readback_max_ms: number;
  convert_ms: number;
  convert_max_ms: number;
  encoded: number;
  encode_ms: number;
  encode_max_ms: number;
  threads: number;
  /** Set when the stream stopped on its own (no encoder). */
  error: string | null;
}

export async function captureVideoStats(): Promise<CaptureVideoStats | null> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<CaptureVideoStats | null>('capture_video_stats').catch(() => null);
}

export async function setNativeQuality(height: number, fps: number, bitrate: number) {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('capture_set_quality', { height, fps, bitrate }).catch(() => {});
}
