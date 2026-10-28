import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { t } from '../lib/i18n';
import { openExternal } from '../lib/platform';
import { setUi, ui } from '../lib/ui';
import * as I from './Icons';

export function ContextMenu() {
  let el!: HTMLDivElement;
  const [pos, setPos] = createSignal({ x: 0, y: 0 });
  const close = () => setUi('menu', null);
  const onDoc = (e: MouseEvent) => !el.contains(e.target as Node) && close();
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
  onMount(() => {
    setTimeout(() => document.addEventListener('mousedown', onDoc));
    document.addEventListener('keydown', onKey);
    window.addEventListener('blur', close);
  });
  onCleanup(() => {
    document.removeEventListener('mousedown', onDoc);
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
    <div class="menu context-menu" ref={el} style={{ left: `${pos().x}px`, top: `${pos().y}px` }} onContextMenu={(e) => e.preventDefault()}>
      <For each={ui.menu!.items}>
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
                close();
                item.run?.();
              }}
            >
              <span>{item.label}</span>
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

export function Lightbox() {
  const close = () => setUi('lightbox', null);
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
  onMount(() => document.addEventListener('keydown', onKey));
  onCleanup(() => document.removeEventListener('keydown', onKey));
  return (
    <div class="lightbox" onClick={close}>
      <img src={ui.lightbox!} alt="" onClick={(e) => e.stopPropagation()} />
      <div class="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <button class="link-btn" onClick={() => void openExternal(ui.lightbox!)}>
          {t('Open original')}
        </button>
        <button class="icon-btn" aria-label={t('Close')} onClick={close}>
          <I.Close size={18} />
        </button>
      </div>
    </div>
  );
}
