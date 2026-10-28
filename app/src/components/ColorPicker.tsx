// Colour picker: a swatch button that opens a saturation/brightness field, hue slider, hex input and
// presets in the theme's palette. Replaces the browser's native colour input.
import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { t } from '../lib/i18n';

const PRESETS = ['#2b2d31', '#1f3b4d', '#3d2f52', '#5a2a2a', '#6b4e1f', '#e3b341', '#4fb8c4', '#3ba55d', '#e5484d', '#f0b232', '#8b7cf6', '#e8e8ea'];

type Hsv = { h: number; s: number; v: number };

function hexToHsv(hex: string): Hsv {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => x / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
}

function hsvToHex({ h, s, v }: Hsv): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255);
  };
  return `#${[f(5), f(3), f(1)].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

const validHex = (s: string) => /^#[0-9a-f]{6}$/i.test(s);

export function ColorPicker(p: { value: string; onChange: (hex: string) => void; label?: string }) {
  const [open, setOpen] = createSignal(false);
  const [pos, setPos] = createSignal({ x: 0, y: 0 });
  const [hsv, setHsv] = createSignal(hexToHsv(validHex(p.value) ? p.value : '#2b2d31'));
  const [text, setText] = createSignal(p.value);
  let button!: HTMLButtonElement;
  let pop!: HTMLDivElement;

  // Follow outside changes (e.g. "reset") without fighting the drag in progress.
  createEffect(() => {
    if (validHex(p.value) && p.value.toLowerCase() !== hsvToHex(hsv())) setHsv(hexToHsv(p.value));
    setText(p.value);
  });

  const commit = (next: Hsv) => {
    setHsv(next);
    const hex = hsvToHex(next);
    setText(hex);
    p.onChange(hex);
  };
  const toggle = () => {
    const r = button.getBoundingClientRect();
    const w = 252;
    const h = 330;
    setPos({ x: Math.min(r.left, innerWidth - w - 12), y: r.bottom + 8 + h > innerHeight ? Math.max(12, r.top - h - 8) : r.bottom + 8 });
    setOpen(!open());
  };

  const drag = (el: HTMLElement, apply: (fx: number, fy: number) => void) => (e: PointerEvent) => {
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      apply(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)));
    };
    move(e);
    el.onpointermove = (ev) => ev.buttons & 1 && move(ev);
  };

  const onDoc = (e: MouseEvent) => open() && !pop?.contains(e.target as Node) && !button.contains(e.target as Node) && setOpen(false);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && open()) {
      e.stopPropagation();
      setOpen(false);
    }
  };
  onMount(() => {
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey, true);
  });
  onCleanup(() => {
    document.removeEventListener('mousedown', onDoc);
    window.removeEventListener('keydown', onKey, true);
  });

  return (
    <>
      <button type="button" class="color-swatch-btn" ref={button} onClick={toggle} aria-label={p.label ?? t('Pick a colour')}>
        <span class="color-swatch" style={{ background: p.value }} />
        <span class="color-hex">{p.value.toUpperCase()}</span>
      </button>
      <Show when={open()}>
        <Portal>
          <div class="color-pop" ref={pop} style={{ left: `${pos().x}px`, top: `${pos().y}px` }}>
            <div
              class="color-sv"
              style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv().h} 100% 50%))` }}
              onPointerDown={(e) => drag(e.currentTarget, (x, y) => commit({ ...hsv(), s: x, v: 1 - y }))(e)}
            >
              <span class="color-sv-thumb" style={{ left: `${hsv().s * 100}%`, top: `${(1 - hsv().v) * 100}%`, background: hsvToHex(hsv()) }} />
            </div>
            <div class="color-hue" onPointerDown={(e) => drag(e.currentTarget, (x) => commit({ ...hsv(), h: x * 359.9 }))(e)}>
              <span class="color-hue-thumb" style={{ left: `${(hsv().h / 360) * 100}%`, background: `hsl(${hsv().h} 100% 50%)` }} />
            </div>
            <div class="color-row">
              <span class="color-swatch big" style={{ background: hsvToHex(hsv()) }} />
              <input
                class="color-input"
                value={text()}
                maxLength={7}
                spellcheck={false}
                onInput={(e) => {
                  const v = e.currentTarget.value.trim();
                  const hex = v.startsWith('#') ? v : `#${v}`;
                  setText(v);
                  if (validHex(hex)) commit(hexToHsv(hex.toLowerCase()));
                }}
              />
            </div>
            <div class="color-presets">
              <For each={PRESETS}>
                {(c) => <button type="button" class="color-preset" classList={{ on: c === p.value.toLowerCase() }} style={{ background: c }} aria-label={c} onClick={() => commit(hexToHsv(c))} />}
              </For>
            </div>
          </div>
        </Portal>
      </Show>
    </>
  );
}
