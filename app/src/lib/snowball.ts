// Snowball fights (server/src/snowball.rs). Throwing is a request; everyone looking at the channel gets SNOWBALL and draws
// the same thing: a ball arcing across the chat and a splat on the target's message.
import { api } from './api';
import { t } from './i18n';
import { currentChannel, nameOf, state } from './store';
import { attempt, toast } from './ui';

const FLIGHT_MS = 620;
const SPLAT_MS = 2400;

export function throwSnowball(channelId: string, target: string, messageId?: string) {
  attempt(() => api('POST', `/channels/${channelId}/snowball`, { target, message_id: messageId }));
}

/** The message to land on: the one it was thrown at, or the target's latest one on screen. */
function landingSpot(d: SnowballEvent): HTMLElement | null {
  const byId = (id: string) => document.getElementById(`msg-${id}`);
  if (d.message_id && byId(d.message_id)) return byId(d.message_id);
  const list = state.messages[d.channel_id]?.list ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].author.id === d.to) {
      const el = byId(list[i].id);
      if (el) return el;
    }
  }
  return null;
}

export interface SnowballEvent {
  channel_id: string;
  from: string;
  to: string;
  message_id?: string | null;
}

function splat(x: number, y: number, label: string, calm: boolean) {
  const el = document.createElement('div');
  el.className = 'snowball-splat';
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  const text = document.createElement('span');
  text.textContent = label;
  el.append(text);
  document.body.append(el);
  el.animate(
    calm
      ? [{ opacity: 1 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }]
      : [
          { transform: 'translate(-50%, -50%) scale(0.2)', opacity: 1 },
          { transform: 'translate(-50%, -50%) scale(1.15)', opacity: 1, offset: 0.08 },
          { transform: 'translate(-50%, -50%) scale(1)', opacity: 1, offset: 0.14 },
          { transform: 'translate(-50%, -48%) scale(1)', opacity: 1, offset: 0.8 },
          { transform: 'translate(-50%, -44%) scale(1)', opacity: 0 },
        ],
    { duration: SPLAT_MS, easing: 'ease-out' },
  ).finished.finally(() => el.remove());
}

export function onSnowball(d: SnowballEvent) {
  const label = t('{from} hit {to}', { from: nameOf(d.from), to: nameOf(d.to) });
  const looking = currentChannel()?.id === d.channel_id && document.visibilityState === 'visible';
  if (!looking) {
    if (d.to === state.me?.id) toast(t('{name} hit you with a snowball!', { name: nameOf(d.from) }));
    return;
  }
  const chat = document.querySelector('.main');
  if (!chat) return;
  const box = chat.getBoundingClientRect();
  const target = landingSpot(d)?.getBoundingClientRect();
  // Near the start of their message; with nothing of theirs on screen, the middle of the chat.
  const x = target ? Math.min(target.left + 150, box.right - 90) : box.left + box.width / 2;
  const y = target
    ? Math.max(box.top + 90, Math.min(target.top + target.height / 2, box.bottom - 90))
    : box.top + box.height / 2;

  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (calm) return splat(x, y, label, true);
  // From the composer if it's yours, otherwise from whichever side is further away.
  const mine = d.from === state.me?.id;
  const fromX = mine ? box.left + box.width / 2 : x < box.left + box.width / 2 ? box.right - 30 : box.left + 30;
  const fromY = mine ? box.bottom - 70 : box.top + box.height * 0.65;
  const peak = Math.min(fromY, y) - 90;
  const ball = document.createElement('div');
  ball.className = 'snowball';
  document.body.append(ball);
  const at = (px: number, py: number, spin: number, s: number) => ({
    transform: `translate(${px}px, ${py}px) rotate(${spin}deg) scale(${s})`,
  });
  ball
    .animate([at(fromX, fromY, 0, 0.7), at((fromX + x) / 2, peak, 300, 1.1), at(x, y, 620, 0.9)], {
      duration: FLIGHT_MS,
      easing: 'cubic-bezier(0.35, 0.1, 0.65, 0.9)',
    })
    .finished.finally(() => {
      ball.remove();
      splat(x, y, label, false);
    });
}
