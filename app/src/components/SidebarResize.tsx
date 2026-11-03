// The handle between a sidebar and the chat: drag it or use the arrow keys, double-click to go back to the default.
// Widths are per device (prefs.navWidth / marginWidth, 0 = default) and reach the CSS as --nav-w / --margin-w, set on
// .layout (App.tsx). The right one is shared by the margin and the Friends page's Active Now.
import { setPrefs } from '../lib/prefs';
import { t } from '../lib/i18n';

const LIMITS = { nav: [220, 480], margin: [240, 560] } as const;
const KEY_STEP = 16;

const clamp = (side: 'nav' | 'margin', px: number) =>
  Math.round(Math.max(LIMITS[side][0], Math.min(LIMITS[side][1], px)));

/** What the layout sets. It gives way to the window, so a wide sidebar can't squeeze the chat out when the window shrinks. */
export const sidebarWidth = (px: number) => (px ? `min(${px}px, 30vw)` : undefined);

export function SidebarResize(p: { side: 'nav' | 'margin'; inline?: boolean }) {
  const key = () => (p.side === 'nav' ? 'navWidth' : 'marginWidth');
  const current = () => {
    const el = document.querySelector(p.side === 'nav' ? '.nav-pane' : '.margin.side-panel, .active-now');
    return el?.getBoundingClientRect().width ?? 0;
  };
  const resize = (e: PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = current();
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      setPrefs({ [key()]: clamp(p.side, p.side === 'nav' ? w0 + dx : w0 - dx) });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing-x');
    };
    document.body.classList.add('resizing-x');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const wider = (e.key === 'ArrowRight') === (p.side === 'nav');
    setPrefs({ [key()]: clamp(p.side, current() + (wider ? KEY_STEP : -KEY_STEP)) });
  };
  return (
    <div
      class={`sidebar-resize for-${p.side}`}
      classList={{ inline: p.inline }}
      role="separator"
      aria-orientation="vertical"
      aria-label={p.side === 'nav' ? t('Resize channel list') : t('Resize side panel')}
      tabIndex={0}
      title={t('Drag to resize; double-click to reset')}
      onPointerDown={resize}
      onDblClick={() => setPrefs({ [key()]: 0 })}
      onKeyDown={onKeyDown}
    />
  );
}
