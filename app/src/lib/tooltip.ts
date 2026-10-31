// Tooltips for anything with a `data-tip`: one element laid over the page (inside the fullscreen element when
// something is fullscreen), placed above the target or below when there's no room, and kept inside the window.
// Drawn outside the target, so cards that clip their overflow (streams, the shared video) never cut them off.

const SHOW_DELAY_MS = 120;
const GAP = 8;

let el: HTMLDivElement | null = null;
let target: HTMLElement | null = null;
let timer: number | undefined;

function hide() {
  clearTimeout(timer);
  target = null;
  el?.classList.remove('show');
}

function place(t: HTMLElement) {
  const text = t.dataset.tip;
  if (!text || !t.isConnected) return hide();
  el ??= Object.assign(document.createElement('div'), { className: 'tooltip-pop', role: 'tooltip' });
  const host = document.fullscreenElement ?? document.body;
  if (el.parentElement !== host) host.append(el);
  el.textContent = text;
  el.classList.add('show');
  const r = t.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const above = r.top - GAP - h >= 4;
  const x = Math.max(6, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 6));
  const y = above ? r.top - GAP - h : Math.min(r.bottom + GAP, innerHeight - h - 4);
  el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

/** Elements that draw their own tooltip (the server list's, which sits beside the tile). */
const ownTooltip = (t: Element) => !!t.closest('.rail-item');

export function initTooltips() {
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const t = (e.target as Element | null)?.closest?.<HTMLElement>('[data-tip]') ?? null;
    if (t === target) return;
    hide();
    if (!t || ownTooltip(t)) return;
    target = t;
    timer = window.setTimeout(() => target === t && place(t), SHOW_DELAY_MS);
  });
  document.addEventListener('pointerout', (e) => {
    if (target && !target.contains(e.relatedTarget as Node | null)) hide();
  });
  // Clicking usually changes what the button does (Mute -> Unmute): show the new label, or nothing if it's gone.
  document.addEventListener('click', () => target && setTimeout(() => target && place(target), 0), true);
  document.addEventListener('pointerdown', () => el?.classList.remove('show'), true);
  addEventListener('scroll', hide, true);
  addEventListener('blur', hide);
  document.addEventListener('fullscreenchange', hide);
}
