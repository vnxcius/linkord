// Crop / zoom / rotate dialog for profile pictures and banners. The picture is only uploaded when the user
// confirms; it is cropped and compressed here (WebP, no larger than needed), so what the preview shows is
// exactly what gets sent. Animated nameplates (GIF or WebM video) are the exception: a canvas would keep only the
// first frame, so they are sent as they are and the member card crops them when shown.
import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { uploadForm } from '../lib/api';
import { Avatar } from './Avatar';
import { InfoTip } from './ImageSlot';
import { formatSize } from './MessageItem';
import { t } from '../lib/i18n';
import type { User } from '../lib/types';

export type ImageKind = 'avatar' | 'banner' | 'nameplate';

const SPEC = {
  // frame = the crop area on screen; out = the largest picture we keep; max = what the server accepts.
  avatar: { w: 320, h: 320, outW: 512, outH: 512, max: 2 * 1024 * 1024 },
  banner: { w: 480, h: 160, outW: 960, outH: 320, max: 4 * 1024 * 1024 },
  // The member-list card is about 5.5:1; the art sits on its right side.
  nameplate: { w: 440, h: 80, outW: 660, outH: 120, max: 1024 * 1024 },
};
/** What the server accepts for an animated nameplate (sent uncropped). */
const MAX_ANIMATED = 3 * 1024 * 1024;
const MAX_SOURCE = 40 * 1024 * 1024;
const MAX_ZOOM = 5;

interface Props {
  kind: ImageKind;
  file: File;
  user: User;
  onClose: () => void;
}

export function ImageEditor(p: Props) {
  const spec = SPEC[p.kind];
  const video = p.kind === 'nameplate' && p.file.type === 'video/webm';
  const animated = video || (p.kind === 'nameplate' && p.file.type === 'image/gif');
  const max = animated ? MAX_ANIMATED : spec.max;
  const [src, setSrc] = createSignal<string>();
  const [img, setImg] = createSignal<HTMLImageElement>();
  /** A WebM nameplate has no picture to frame; it's ready once the browser can play it. */
  const [videoReady, setVideoReady] = createSignal(false);
  const ready = () => !!img() || videoReady();
  const [loadError, setLoadError] = createSignal<string>();
  const [zoom, setZoom] = createSignal(1);
  const [rot, setRot] = createSignal(0);
  const [pos, setPos] = createSignal({ x: 0, y: 0 });
  const [phase, setPhase] = createSignal<'edit' | 'encoding' | 'upload' | 'finishing'>('edit');
  const [progress, setProgress] = createSignal(0);
  const [error, setError] = createSignal<string>();
  const [estimate, setEstimate] = createSignal<number>();
  let stage!: HTMLCanvasElement;
  let preview!: HTMLCanvasElement;
  let preview2: HTMLCanvasElement | undefined;
  let abort: AbortController | undefined;
  const busy = () => phase() !== 'edit';

  onMount(() => {
    if (p.file.size > MAX_SOURCE) return setLoadError(t('That image is too big. Pick one under 40 MB.'));
    if (!/^image\/(png|jpeg|gif|webp)$/.test(p.file.type) && !video) {
      return setLoadError(
        p.kind === 'nameplate'
          ? t('Pick a PNG, JPG, GIF or WebP image, or a WebM video.')
          : t('Pick a PNG, JPG, GIF or WebP image.'),
      );
    }
    if (animated && p.file.size > MAX_ANIMATED)
      return setLoadError(t('Animated nameplates must be under {size}.', { size: formatSize(MAX_ANIMATED) }));
    const url = URL.createObjectURL(p.file);
    setSrc(url);
    onCleanup(() => URL.revokeObjectURL(url));
    if (video) {
      const v = document.createElement('video');
      v.muted = true;
      v.onloadeddata = () => setVideoReady(true);
      v.onerror = () => setLoadError(t("Couldn't play that video. Try another file."));
      v.src = url;
      return;
    }
    const el = new Image();
    el.onload = () => setImg(el);
    el.onerror = () => setLoadError(t("Couldn't read that image. Try another file."));
    el.src = url;
  });
  onCleanup(() => abort?.abort());

  /** Source size after rotation, and the scale at which it just covers the frame. */
  const dims = createMemo(() => {
    const i = img();
    if (!i) return null;
    const turned = rot() % 180 !== 0;
    const w = turned ? i.naturalHeight : i.naturalWidth;
    const h = turned ? i.naturalWidth : i.naturalHeight;
    return { w, h, cover: Math.max(spec.w / w, spec.h / h) };
  });
  const clamp = (x: number, y: number, z = zoom()) => {
    const d = dims();
    if (!d) return { x: 0, y: 0 };
    const mx = Math.max(0, (d.w * d.cover * z - spec.w) / 2);
    const my = Math.max(0, (d.h * d.cover * z - spec.h) / 2);
    return { x: Math.min(mx, Math.max(-mx, x)), y: Math.min(my, Math.max(-my, y)) };
  };

  /** Draws the framed picture on `ctx` at `k` times the frame size. Used for the stage, previews and the export. */
  const draw = (ctx: CanvasRenderingContext2D, k: number) => {
    const i = img();
    const d = dims();
    if (!i || !d) return;
    ctx.save();
    ctx.clearRect(0, 0, spec.w * k, spec.h * k);
    ctx.imageSmoothingQuality = 'high';
    ctx.translate((spec.w / 2 + pos().x) * k, (spec.h / 2 + pos().y) * k);
    ctx.rotate((rot() * Math.PI) / 180);
    const s = d.cover * zoom() * k;
    ctx.scale(s, s);
    ctx.drawImage(i, -i.naturalWidth / 2, -i.naturalHeight / 2);
    ctx.restore();
  };

  createEffect(() => {
    if (!img()) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    stage.width = spec.w * dpr;
    stage.height = spec.h * dpr;
    draw(stage.getContext('2d')!, dpr);
    // Small previews: how it looks in chat / on the profile card.
    for (const [c, size] of [[preview, p.kind === 'avatar' ? 80 : 240] as const, [preview2, 36] as const]) {
      if (!c) continue;
      const k = size / spec.w;
      c.width = size;
      c.height = Math.round(spec.h * k);
      draw(c.getContext('2d')!, k);
    }
  });

  // The real size after compression, a moment after the framing stops changing.
  createEffect(
    on([ready, zoom, rot, pos], () => {
      if (!ready()) return;
      setEstimate(undefined);
      const timer = setTimeout(() => void encode().then((b) => setEstimate(b.size)), 350);
      onCleanup(() => clearTimeout(timer));
    }),
  );

  /** Crops and compresses. Never larger than the source resolution, and shrunk until it fits the server's limit. */
  const encode = async (): Promise<Blob> => {
    if (animated) return p.file;
    const d = dims()!;
    const srcScale = d.cover * zoom(); // frame px per source px
    const k = Math.min(spec.outW / spec.w, 1 / srcScale, 4);
    const c = document.createElement('canvas');
    c.width = Math.max(64, Math.round(spec.w * k));
    c.height = Math.max(Math.round(64 * (spec.h / spec.w)), Math.round(spec.h * k));
    draw(c.getContext('2d')!, c.width / spec.w);
    const toBlob = (type: string, q: number) => new Promise<Blob | null>((r) => c.toBlob(r, type, q));
    let quality = 0.88;
    let blob = await toBlob('image/webp', quality);
    // Browsers without a WebP encoder return PNG; JPEG is smaller for photos.
    if (!blob || blob.type !== 'image/webp') {
      const bg = c.getContext('2d')!;
      bg.globalCompositeOperation = 'destination-over';
      bg.fillStyle = '#1e1f22';
      bg.fillRect(0, 0, c.width, c.height);
      blob = (await toBlob('image/jpeg', quality)) ?? new Blob();
    }
    while (blob.size > spec.max && quality > 0.4) {
      quality -= 0.12;
      blob = (await toBlob(blob.type, quality)) ?? blob;
    }
    return blob;
  };

  const save = async () => {
    setError(undefined);
    setProgress(0);
    setPhase('encoding');
    abort = new AbortController();
    try {
      const blob = await encode();
      if (blob.size > max) throw new Error(t('That image is still too big after compressing. Try a smaller one.'));
      const fd = new FormData();
      const ext = video ? 'webm' : animated ? 'gif' : blob.type === 'image/webp' ? 'webp' : 'jpg';
      fd.append('file', blob, `${p.kind}.${ext}`);
      setPhase('upload');
      await uploadForm(
        'POST',
        `/users/@me/${p.kind}`,
        fd,
        (f) => {
          setProgress(f);
          if (f >= 1) setPhase('finishing');
        },
        abort.signal,
      );
      p.onClose();
    } catch (e) {
      if ((e as Error).name === 'AbortError') return setPhase('edit');
      setError((e as Error).message || t('Something went wrong.'));
      setPhase('edit');
    }
  };

  const cancel = () => {
    if (busy()) abort?.abort();
    else p.onClose();
  };

  // ---- interaction ----
  let drag: { id: number; x: number; y: number; px: number; py: number } | null = null;
  const onDown = (e: PointerEvent) => {
    if (busy() || !img() || animated) return;
    stage.setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, px: pos().x, py: pos().y };
  };
  const onMove = (e: PointerEvent) => {
    if (!drag || drag.id !== e.pointerId) return;
    const r = stage.getBoundingClientRect();
    const f = spec.w / r.width;
    setPos(clamp(drag.px + (e.clientX - drag.x) * f, drag.py + (e.clientY - drag.y) * f));
  };
  const onUp = () => (drag = null);
  const setZ = (z: number) => {
    const nz = Math.min(MAX_ZOOM, Math.max(1, z));
    setPos((c) => clamp(c.x * (nz / zoom()), c.y * (nz / zoom()), nz));
    setZoom(nz);
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (!busy() && !animated) setZ(zoom() * Math.exp(-e.deltaY / 500));
  };
  const rotate = () => {
    setRot((r) => (r + 90) % 360);
    setZoom(1);
    setPos({ x: 0, y: 0 });
  };
  const reset = () => {
    setRot(0);
    setZoom(1);
    setPos({ x: 0, y: 0 });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      cancel();
    }
  };
  onMount(() => window.addEventListener('keydown', onKey, true));
  onCleanup(() => window.removeEventListener('keydown', onKey, true));

  const title = () =>
    p.kind === 'avatar'
      ? t('Edit your picture')
      : p.kind === 'banner'
        ? t('Edit your banner')
        : t('Edit your nameplate');
  const status = () => {
    switch (phase()) {
      case 'encoding':
        return t('Optimising…');
      case 'upload':
        return t('Uploading… {pct}%', { pct: Math.round(progress() * 100) });
      case 'finishing':
        return t('Finishing…');
    }
    return '';
  };

  return (
    <Portal>
      <div class="img-editor-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy() && p.onClose()}>
        <div class="img-editor" role="dialog" aria-label={title()}>
          <h2>
            {title()}{' '}
            <InfoTip
              text={t('Drag to reposition, scroll or use the slider to zoom. Nothing is uploaded until you save.')}
            />
          </h2>

          <Show when={!loadError()} fallback={<p class="error">{loadError()}</p>}>
            <div class="img-editor-main">
              <div
                class="img-stage"
                classList={{ round: p.kind === 'avatar', loading: !ready() }}
                style={{ 'aspect-ratio': `${spec.w} / ${spec.h}`, 'max-width': `${spec.w}px` }}
              >
                <Show when={animated && src()}>
                  <Show when={video} fallback={<img class="img-stage-anim" src={src()} alt="" />}>
                    <video class="img-stage-anim" src={src()} autoplay muted loop playsinline />
                  </Show>
                </Show>
                <canvas
                  ref={stage}
                  onPointerDown={onDown}
                  onPointerMove={onMove}
                  onPointerUp={onUp}
                  onPointerCancel={onUp}
                  onWheel={onWheel}
                />
              </div>

              <div class="img-side">
                <div class="field-label">{t('Preview')}</div>
                <Show
                  when={p.kind === 'avatar'}
                  fallback={
                    <Show
                      when={p.kind === 'nameplate'}
                      fallback={
                        <div class="img-card-preview">
                          <canvas ref={preview} class="banner" />
                          <b>{p.user.display_name || p.user.username}</b>
                        </div>
                      }
                    >
                      <div class="member img-nameplate-preview">
                        <Show when={animated} fallback={<canvas ref={preview} class="nameplate" />}>
                          <Show when={video} fallback={<img class="nameplate" src={src()} alt="" />}>
                            <video class="nameplate" src={src()} autoplay muted loop playsinline />
                          </Show>
                        </Show>
                        <Avatar user={p.user} size={32} />
                        <span class="member-name">{p.user.display_name || p.user.username}</span>
                      </div>
                    </Show>
                  }
                >
                  <div class="img-avatar-preview">
                    <canvas ref={preview} />
                    <canvas ref={(c) => (preview2 = c)} />
                  </div>
                </Show>
                <Show when={estimate() != null} fallback={<small class="muted">{t('Measuring…')}</small>}>
                  <small class="muted">
                    {t('Will be sent as {size} (original {original})', {
                      size: formatSize(estimate()!),
                      original: formatSize(p.file.size),
                    })}
                  </small>
                </Show>
                <Show when={p.file.type === 'image/gif' || video}>
                  <small class="muted">
                    {animated
                      ? t('Animated nameplates are saved as they are: no cropping, zoom or rotation.')
                      : t('Animated pictures are saved as a still image.')}
                  </small>
                </Show>
              </div>
            </div>

            <div class="img-controls">
              <span class="muted">{t('Zoom')}</span>
              <input
                class="range"
                type="range"
                min="1"
                max={MAX_ZOOM}
                step="0.01"
                value={zoom()}
                disabled={busy() || !img() || animated}
                aria-label={t('Zoom')}
                onInput={(e) => setZ(parseFloat(e.currentTarget.value))}
              />
              <button class="btn small-btn" disabled={busy() || !img() || animated} onClick={rotate}>
                {t('Rotate')}
              </button>
              <button class="btn small-btn" disabled={busy() || !img() || animated} onClick={reset}>
                {t('Reset')}
              </button>
            </div>
          </Show>

          <Show when={busy()}>
            <div
              class="img-progress"
              role="progressbar"
              aria-valuemin="0"
              aria-valuemax="100"
              aria-valuenow={Math.round(progress() * 100)}
            >
              <div class="stat-bar">
                <i
                  classList={{ indeterminate: phase() !== 'upload' }}
                  style={{ width: phase() === 'upload' ? `${progress() * 100}%` : undefined }}
                />
              </div>
              <small class="muted">{status()}</small>
            </div>
          </Show>
          <Show when={error()}>
            <p class="error" role="alert">
              {error()}
            </p>
          </Show>

          <div class="img-footer">
            <button class="btn" onClick={cancel}>
              {busy() ? t('Cancel upload') : t('Cancel')}
            </button>
            <button class="btn primary" disabled={busy() || !ready()} onClick={() => void save()}>
              {error() ? t('Try again') : t('Save')}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
