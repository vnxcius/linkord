import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js';
import { onOutsideMouseDown } from '../lib/outside-click';
import { downloadFile, filenameFromUrl } from '../lib/download';
import { t } from '../lib/i18n';
import { openExternal } from '../lib/platform';
import { openMenu, setUi, toast, ui, type MenuEntry } from '../lib/ui';
import * as I from './Icons';

/** Menus built from pieces: no separator first, last or twice in a row. */
function tidy(items: MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const item of items) if (item !== 'separator' || (out.length && out.at(-1) !== 'separator')) out.push(item);
  if (out.at(-1) === 'separator') out.pop();
  return out;
}

export function ContextMenu() {
  let el!: HTMLDivElement;
  const [pos, setPos] = createSignal({ x: 0, y: 0 });
  const close = () => setUi('menu', null);
  const onDoc = (e: MouseEvent) => !el.contains(e.target as Node) && close();
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (e.preventDefault(), close());
  onOutsideMouseDown(onDoc);
  onMount(() => {
    document.addEventListener('keydown', onKey);
    window.addEventListener('blur', close);
  });
  onCleanup(() => {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('blur', close);
  });
  createEffect(() => {
    const m = ui.menu!;
    const w = el.offsetWidth || 220;
    const h = el.offsetHeight || 200;
    setPos({ x: Math.min(m.x, innerWidth - w - 8), y: Math.min(m.y, innerHeight - h - 8) });
  });
  return (
    <div
      class="menu context-menu"
      ref={el}
      style={{ left: `${pos().x}px`, top: `${pos().y}px` }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <For each={tidy(ui.menu!.items)}>
        {(item) =>
          item === 'separator' ? (
            <div class="menu-sep" />
          ) : item.render ? (
            <div class="menu-custom">{item.render()}</div>
          ) : (
            <button
              classList={{ danger: item.danger, checked: item.checked }}
              disabled={item.disabled}
              onClick={() => {
                const at = { x: ui.menu!.x, y: ui.menu!.y };
                close();
                item.run?.(at);
              }}
            >
              <span>{item.label}</span>
              <Show when={item.hint}>
                <kbd class="menu-hint">{item.hint}</kbd>
              </Show>
              <Show when={item.checked !== undefined} fallback={item.icon?.()}>
                <span class="check" classList={{ on: item.checked }} />
              </Show>
            </button>
          )
        }
      </For>
    </div>
  );
}

const ZOOM_MIN = 1;
const ZOOM_MAX = 8;

/** Full-screen image viewer: wheel or Ctrl +/- to zoom (around the cursor), drag to move, right-click for more. */
export function Lightbox() {
  const [zoom, setZoom] = createSignal(1);
  const [pan, setPan] = createSignal({ x: 0, y: 0 });
  const [dragging, setDragging] = createSignal(false);
  let img!: HTMLImageElement;
  const close = () => setUi('lightbox', null);
  const url = () => ui.lightbox!;
  createEffect(on(url, () => (setZoom(1), setPan({ x: 0, y: 0 }))));

  /** Zooms to `z`, keeping the point under (cx, cy) in place (the middle of the screen by default). */
  const zoomTo = (z: number, cx = innerWidth / 2, cy = innerHeight / 2) => {
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
    const r = img.getBoundingClientRect();
    // Offset of the point from the image's centre, before and after scaling.
    const ox = cx - (r.left + r.width / 2);
    const oy = cy - (r.top + r.height / 2);
    const k = next / zoom();
    setPan((p) => (next === 1 ? { x: 0, y: 0 } : { x: p.x - ox * (k - 1), y: p.y - oy * (k - 1) }));
    setZoom(next);
  };
  const step = (dir: 1 | -1) => zoomTo(zoom() * (dir > 0 ? 1.25 : 0.8));
  const reset = () => (setZoom(1), setPan({ x: 0, y: 0 }));

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      // Only this: a profile or settings screen under it stays open.
      e.preventDefault();
      e.stopPropagation();
      return close();
    }
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (e.key === '=' || e.key === '+') step(1);
    else if (e.key === '-' || e.key === '_') step(-1);
    else if (e.key === '0') reset();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  onMount(() => window.addEventListener('keydown', onKey, true));
  onCleanup(() => window.removeEventListener('keydown', onKey, true));

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    zoomTo(zoom() * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
  };
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || zoom() === 1) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, pan: pan() };
    setDragging(true);
    const move = (ev: PointerEvent) =>
      setPan({ x: start.pan.x + ev.clientX - start.x, y: start.pan.y + ev.clientY - start.y });
    const up = () => {
      setDragging(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const filename = () => filenameFromUrl(url(), 'image.png');
  const copyImage = async () => {
    try {
      const blob = await (await fetch(url())).blob();
      // The clipboard only takes PNG: anything else is redrawn as one.
      const png =
        blob.type === 'image/png'
          ? blob
          : await new Promise<Blob>((resolve, reject) => {
              const c = document.createElement('canvas');
              c.width = img.naturalWidth;
              c.height = img.naturalHeight;
              c.getContext('2d')!.drawImage(img, 0, 0);
              c.toBlob((b) => (b ? resolve(b) : reject(new Error('png'))), 'image/png');
            });
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      toast(t('Image copied'));
    } catch {
      toast(t("Couldn't copy this image"));
    }
  };
  const menu = (e: MouseEvent) =>
    openMenu(e, [
      { label: t('Copy Image'), icon: () => <I.Copy size={16} />, run: () => void copyImage() },
      { label: t('Save Image'), icon: () => <I.Download size={16} />, run: () => void downloadFile(url(), filename()) },
      {
        label: t('Copy Link'),
        icon: () => <I.Link size={16} />,
        run: () => navigator.clipboard.writeText(url()).then(() => toast(t('Link copied'))),
      },
      { label: t('Open original'), icon: () => <I.External size={16} />, run: () => void openExternal(url()) },
      'separator',
      { label: t('Zoom In'), hint: 'Ctrl +', run: () => step(1) },
      { label: t('Zoom Out'), hint: 'Ctrl -', disabled: zoom() <= ZOOM_MIN, run: () => step(-1) },
      { label: t('Actual Size'), hint: 'Ctrl 0', disabled: zoom() === 1, run: reset },
    ]);

  return (
    <div class="lightbox" onClick={close} onWheel={onWheel}>
      <img
        ref={img}
        src={url()}
        alt=""
        draggable={false}
        classList={{ zoomed: zoom() > 1, dragging: dragging() }}
        style={{ transform: `translate(${pan().x}px, ${pan().y}px) scale(${zoom()})` }}
        onClick={(e) => e.stopPropagation()}
        onDblClick={(e) => (zoom() > 1 ? reset() : zoomTo(2.5, e.clientX, e.clientY))}
        onPointerDown={onPointerDown}
        onContextMenu={menu}
      />
      <div class="lightbox-bar" onClick={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
        <button class="icon-btn" aria-label={t('Zoom Out')} data-tip={t('Zoom Out')} onClick={() => step(-1)}>
          <I.Minus size={18} />
        </button>
        <button class="lightbox-zoom" data-tip={t('Actual Size')} onClick={reset}>
          {Math.round(zoom() * 100)}%
        </button>
        <button class="icon-btn" aria-label={t('Zoom In')} data-tip={t('Zoom In')} onClick={() => step(1)}>
          <I.Plus size={18} />
        </button>
        <span class="lightbox-sep" />
        <button
          class="icon-btn"
          aria-label={t('Save Image')}
          data-tip={t('Save Image')}
          onClick={() => void downloadFile(url(), filename())}
        >
          <I.Download size={18} />
        </button>
        <button class="link-btn" onClick={() => void openExternal(url())}>
          {t('Open original')}
        </button>
        <button class="icon-btn" aria-label={t('Close')} onClick={close}>
          <I.Close size={18} />
        </button>
      </div>
    </div>
  );
}
