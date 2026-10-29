// Phone gestures (<= 760px). A sideways swipe that starts on a message replies to it (swipe left); anywhere
// else in the chat, right goes back to the channel list and left opens the member list. Right closes the
// member drawer or a side panel (search, pins); left on the channel list returns to the open chat.
import { currentChannel } from './store';
import { Kind } from './types';
import { isMobile, replyTo, setUi, ui } from './ui';

/** Sideways travel (or a quick flick) that switches panes. */
const COMMIT_PX = 70;
const FLICK_PX = 40;
const FLICK_PX_PER_MS = 0.5;
/** A message slides at most this far; past REPLY_PX letting go replies. */
const MESSAGE_MAX_PX = 90;
const REPLY_PX = 56;

/** Things with their own touch handling (typing, seeking, sliders, players) or over the chat. */
const IGNORE =
  'input, textarea, select, [contenteditable="true"], iframe, .vp, .voice-note, .context-menu, .profile-card, .modal, .lightbox, .emoji-picker';

interface Gesture {
  x: number;
  y: number;
  at: number;
  target: HTMLElement;
  axis: 'x' | 'y' | null;
  /** The message being swiped, when it can be replied to. */
  message: HTMLElement | null;
  dx: number;
  ready: boolean;
}

let g: Gesture | null = null;

function scrollsSideways(el: HTMLElement | null, root: HTMLElement) {
  for (; el && el !== root; el = el.parentElement) {
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    const overflow = getComputedStyle(el).overflowX;
    if (overflow === 'auto' || overflow === 'scroll') return true;
  }
  return false;
}

const canReply = (msg: HTMLElement) =>
  !msg.matches('.pending, .failed, .selecting, .editing') &&
  !!document.querySelector('.chat .composer textarea:not([disabled])');

/** Slides the message back into place. */
function release(msg: HTMLElement) {
  msg.classList.remove('swipe-ready');
  msg.classList.add('swipe-return');
  msg.style.setProperty('--swipe', '0px');
  setTimeout(() => {
    msg.classList.remove('swiping', 'swipe-return');
    msg.style.removeProperty('--swipe');
  }, 200);
}

function openMembers() {
  const c = currentChannel();
  if (c?.guild_id && c.kind === Kind.Text && !ui.panel) setUi('membersDrawer', true);
}

function finish(s: Gesture) {
  if (s.message && s.dx < 0) {
    release(s.message);
    const channel = currentChannel();
    if (s.ready && channel) replyTo(channel.id, s.message.id.replace(/^msg-/, ''));
    return;
  }
  const dist = Math.abs(s.dx);
  const flick = dist > FLICK_PX && dist / (performance.now() - s.at) > FLICK_PX_PER_MS;
  if (dist < COMMIT_PX && !flick) return;
  const t = s.target;
  if (s.dx > 0) {
    if (t.closest('.members.drawer') || ui.membersDrawer) setUi('membersDrawer', false);
    else if (t.closest('.side-panel')) setUi('panel', null);
    else if (t.closest('.main')) setUi('mobilePane', 'nav');
  } else if (t.closest('.nav-pane')) {
    if (currentChannel()) setUi('mobilePane', 'main');
  } else if (t.closest('.main') && !t.closest('.members, .side-panel')) {
    openMembers();
  }
}

/** Listens for swipes on the app's layout (does nothing above phone width). */
export function initSwipes(root: HTMLElement) {
  root.addEventListener(
    'touchstart',
    (e) => {
      g = null;
      if (!isMobile() || e.touches.length !== 1 || ui.menu || ui.profile || ui.modal || ui.lightbox) return;
      const target = e.target as HTMLElement;
      if (target.closest(IGNORE) || scrollsSideways(target, root)) return;
      const message = target.closest<HTMLElement>('.chat .message');
      const { clientX: x, clientY: y } = e.touches[0];
      g = {
        x,
        y,
        at: performance.now(),
        target,
        axis: null,
        message: message && canReply(message) ? message : null,
        dx: 0,
        ready: false,
      };
    },
    { passive: true },
  );
  root.addEventListener(
    'touchmove',
    (e) => {
      if (!g) return;
      const dx = e.touches[0].clientX - g.x;
      const dy = e.touches[0].clientY - g.y;
      if (!g.axis) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        g.axis = Math.abs(dx) > Math.abs(dy) * 1.5 ? 'x' : 'y';
        if (g.axis === 'y') return void (g = null);
      }
      // Sideways: keep the list from scrolling under the finger.
      if (e.cancelable) e.preventDefault();
      g.dx = dx;
      if (!g.message) return;
      const shift = Math.max(Math.min(dx, 0), -MESSAGE_MAX_PX);
      const ready = shift <= -REPLY_PX;
      if (ready && !g.ready) navigator.vibrate?.(8);
      g.ready = ready;
      g.message.classList.add('swiping');
      g.message.classList.toggle('swipe-ready', ready);
      g.message.style.setProperty('--swipe', `${shift}px`);
    },
    { passive: false },
  );
  const end = () => {
    const s = g;
    g = null;
    if (s?.axis === 'x') finish(s);
  };
  root.addEventListener('touchend', end);
  root.addEventListener('touchcancel', () => {
    if (g?.message) release(g.message);
    g = null;
  });
}
