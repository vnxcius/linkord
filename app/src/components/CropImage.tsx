// Crops a picture before it's sent (the composer's upload tray): a free box over the picture, dragged by its corners
// and edges to any shape (not tied to a format like 16:9 or 1:1), moved by dragging inside it, or drawn anew by
// dragging outside it; Rotate turns the picture a quarter. What's sent is the box's part at the picture's own
// resolution, in its own format (PNG and WebP stay so, the rest becomes JPEG). Animated pictures never come here: a
// canvas keeps only their first frame.
import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { t } from '../lib/i18n';

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
type Grip = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const GRIPS: Grip[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
/** The smallest box, in screen pixels. */
const MIN = 24;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Pictures the cropper can open and write back (GIFs and SVGs are left as they are). */
export const croppable = (f: File) => /^image\/(png|jpeg|webp|bmp|avif)$/.test(f.type);

/** Draws the picture turned `turns` quarters into a W x H area (W x H = the turned picture's size). */
function paint(ctx: CanvasRenderingContext2D, b: ImageBitmap, turns: number, W: number, H: number) {
  const [dw, dh] = turns % 2 ? [H, W] : [W, H];
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.rotate((turns * Math.PI) / 2);
  ctx.drawImage(b, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}

export function CropImage(p: {
  file: File;
  onCancel: () => void;
  onDone: (f: File) => void;
  /** Shrinks what's sent so its longest side is at most this (custom emoji: small files); default: as it is. */
  maxSide?: number;
}) {
  const [bitmap, setBitmap] = createSignal<ImageBitmap | null>(null);
  const [failed, setFailed] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [turns, setTurns] = createSignal(0);
  /** The box, in the turned picture's pixels. */
  const [box, setBox] = createSignal<Box>({ x: 0, y: 0, w: 0, h: 0 });
  /** Screen pixels per picture pixel. */
  const [scale, setScale] = createSignal(1);
  const [view, setView] = createSignal({ w: innerWidth, h: innerHeight });
  let canvas!: HTMLCanvasElement;
  let stage!: HTMLDivElement;

  const size = () => {
    const b = bitmap();
    if (!b) return { w: 0, h: 0 };
    return turns() % 2 ? { w: b.height, h: b.width } : { w: b.width, h: b.height };
  };
  const whole = () => ({ x: 0, y: 0, ...size() });

  onMount(() => {
    createImageBitmap(p.file, { imageOrientation: 'from-image' })
      .then((b) => {
        setBitmap(b);
        setBox(whole());
      })
      .catch(() => setFailed(true));
    const resize = () => setView({ w: innerWidth, h: innerHeight });
    const keys = (e: KeyboardEvent) => {
      if (e.key === 'Escape') p.onCancel();
      else if (e.key === 'Enter') void apply();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    addEventListener('resize', resize);
    addEventListener('keydown', keys, true);
    onCleanup(() => {
      removeEventListener('resize', resize);
      removeEventListener('keydown', keys, true);
      bitmap()?.close();
    });
  });

  // The picture, fitted to the window, at the screen's resolution.
  createEffect(() => {
    const b = bitmap();
    if (!b) return;
    const { w, h } = size();
    const v = view();
    const s = Math.min(Math.min(v.w - 96, 1100) / w, (v.h * 0.64) / h);
    setScale(s);
    const dpr = devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(w * s * dpr));
    canvas.height = Math.max(1, Math.round(h * s * dpr));
    canvas.style.width = `${w * s}px`;
    canvas.style.height = `${h * s}px`;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(s * dpr, 0, 0, s * dpr, 0, 0);
    ctx.imageSmoothingQuality = 'high';
    paint(ctx, b, turns(), w, h);
  });

  /** Drags a grip (or the whole box) from where the pointer went down. */
  function drag(grip: Grip, from: Box, e: PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    const s = scale();
    const { w: W, h: H } = size();
    const min = Math.min(MIN / s, W, H);
    const [x0, y0] = [e.clientX, e.clientY];
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) / s;
      const dy = (ev.clientY - y0) / s;
      let { x, y, w, h } = from;
      if (grip === 'move') {
        x = clamp(x + dx, 0, W - w);
        y = clamp(y + dy, 0, H - h);
      } else {
        if (grip.includes('w')) {
          const nx = clamp(x + dx, 0, x + w - min);
          w += x - nx;
          x = nx;
        }
        if (grip.includes('e')) w = clamp(w + dx, min, W - x);
        if (grip.includes('n')) {
          const ny = clamp(y + dy, 0, y + h - min);
          h += y - ny;
          y = ny;
        }
        if (grip.includes('s')) h = clamp(h + dy, min, H - y);
      }
      setBox({ x, y, w, h });
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  }

  /** Pressing outside the box starts a new one there, its far corner following the pointer. */
  function drawNew(e: PointerEvent) {
    if (e.button !== 0 || !bitmap()) return;
    const r = stage.getBoundingClientRect();
    const s = scale();
    const { w: W, h: H } = size();
    const min = Math.min(MIN / s, W, H);
    const x = clamp((e.clientX - r.left) / s, 0, W - min);
    const y = clamp((e.clientY - r.top) / s, 0, H - min);
    const from = { x, y, w: min, h: min };
    setBox(from);
    drag('se', from, e);
  }

  const rotate = () => {
    setTurns((n) => (n + 1) % 4);
    setBox(whole());
  };
  const reset = () => {
    setTurns(0);
    setBox(whole());
  };

  async function apply() {
    const b = bitmap();
    if (!b || busy()) return;
    const { w: W, h: H } = size();
    const r = box();
    const x = Math.round(r.x);
    const y = Math.round(r.y);
    const w = clamp(Math.round(r.w), 1, W - x);
    const h = clamp(Math.round(r.h), 1, H - y);
    // Nothing changed: the picture goes as it was picked.
    if (!turns() && x === 0 && y === 0 && w === W && h === H) return p.onDone(p.file);
    setBusy(true);
    const k = p.maxSide ? Math.min(1, p.maxSide / Math.max(w, h)) : 1;
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(w * k));
    out.height = Math.max(1, Math.round(h * k));
    const ctx = out.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.scale(k, k);
    ctx.translate(-x, -y);
    paint(ctx, b, turns(), W, H);
    const type = /^image\/(png|webp)$/.test(p.file.type) ? p.file.type : 'image/jpeg';
    const blob = await new Promise<Blob | null>((done) => out.toBlob(done, type, 0.92));
    setBusy(false);
    if (!blob) return setFailed(true);
    const ext = type === 'image/jpeg' ? 'jpg' : type.slice(6);
    p.onDone(new File([blob], `${p.file.name.replace(/\.[^.]+$/, '') || 'picture'}.${ext}`, { type }));
  }

  const px = (n: number) => `${n * scale()}px`;
  return (
    <Portal>
      <div class="img-editor-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy() && p.onCancel()}>
        <div class="img-editor crop-editor" role="dialog" aria-label={t('Crop picture')}>
          <h2>{t('Crop picture')}</h2>
          <Show when={!failed()} fallback={<p class="error">{t("That picture can't be opened.")}</p>}>
            <div class="crop-wrap">
              <div ref={stage} class="crop-stage" onPointerDown={drawNew}>
                <canvas ref={canvas} />
                <Show when={bitmap()}>
                  {/* The shade around the box is clipped to the picture; the box and its grips aren't (a grip on the
                      picture's edge stays whole). */}
                  <div class="crop-clip">
                    <div
                      class="crop-shade"
                      style={{ left: px(box().x), top: px(box().y), width: px(box().w), height: px(box().h) }}
                    />
                  </div>
                  <div
                    class="crop-box"
                    style={{ left: px(box().x), top: px(box().y), width: px(box().w), height: px(box().h) }}
                    onPointerDown={(e) => drag('move', box(), e)}
                  >
                    <For each={GRIPS}>
                      {(g) => <span class={`crop-grip ${g}`} onPointerDown={(e) => drag(g, box(), e)} />}
                    </For>
                  </div>
                </Show>
              </div>
            </div>
            <div class="img-controls">
              <span class="crop-size muted">
                {Math.round(box().w)} × {Math.round(box().h)}
              </span>
              <span class="crop-spacer" />
              <button class="btn small-btn" disabled={busy() || !bitmap()} onClick={rotate}>
                {t('Rotate')}
              </button>
              <button class="btn small-btn" disabled={busy() || !bitmap()} onClick={reset}>
                {t('Reset')}
              </button>
            </div>
          </Show>
          <div class="img-footer">
            <button class="btn" onClick={() => p.onCancel()}>
              {t('Cancel')}
            </button>
            <button class="btn primary" disabled={busy() || !bitmap() || failed()} onClick={() => void apply()}>
              {t('Apply')}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
