import { Show } from 'solid-js';
import { media } from '../lib/api';
import { MARKS, OUTLINE, outline, type Presence } from '../lib/presence-marks';
import { presenceOf, state } from '../lib/store';
import type { User } from '../lib/types';
import { displayName } from '../lib/types';

/** `guildId`: show their server profile picture there, if they set one. */
export function Avatar(p: {
  user?: User | null;
  size?: number;
  presence?: boolean;
  speaking?: boolean;
  guildId?: string | null;
}) {
  const size = () => p.size ?? 40;
  const src = () => (p.guildId && p.user && state.members[p.guildId]?.[p.user.id]?.avatar) || p.user?.avatar;
  const initials = () => displayName(p.user).slice(0, 2).toUpperCase();
  return (
    <div class="avatar" classList={{ speaking: p.speaking }} style={{ width: `${size()}px`, height: `${size()}px` }}>
      <Show
        when={media(src())}
        fallback={
          <div class="avatar-fallback" style={{ 'font-size': `${size() * 0.38}px` }}>
            {initials()}
          </div>
        }
      >
        {(src) => <img src={src()} alt="" loading="lazy" draggable={false} />}
      </Show>
      <Show when={p.presence && p.user}>
        <span
          class={`presence ${markOf(presenceOf(p.user!.id))}`}
          style={{ '--ring': `${Math.max(3, size() * 0.07)}px` }}
        >
          <PresenceMark status={presenceOf(p.user!.id)} ring />
        </span>
      </Show>
    </div>
  );
}

const markOf = (s: string): Presence => (s === 'online' || s === 'idle' || s === 'dnd' ? s : 'offline');

/**
 * A status's mark (lib/presence-marks.ts), in its status colour (CSS `color` on the parent: .presence / .presence-dot).
 * `ring`: drawn in an avatar's corner, cut out of the picture by a ring in --presence-ring, --ring wide.
 */
export function PresenceMark(p: { status: string; ring?: boolean }) {
  const s = () => markOf(p.status);
  return (
    <svg viewBox="0 0 100 100" overflow="visible" aria-hidden="true">
      <Show when={p.ring}>
        <path class="presence-ring" d={outline(s())} />
      </Show>
      <Show
        when={s() !== 'offline'}
        fallback={
          <path
            d={MARKS.inner}
            fill={p.ring ? 'var(--presence-ring)' : 'none'}
            stroke="currentColor"
            stroke-width={OUTLINE}
            stroke-linejoin="round"
          />
        }
      >
        <path
          d={s() === 'idle' ? MARKS.triforce : s() === 'dnd' ? MARKS.down : MARKS.up}
          fill="currentColor"
          fill-rule="evenodd"
        />
      </Show>
    </svg>
  );
}

export function GuildIcon(p: { name: string; icon?: string | null; size?: number }) {
  const abbrev = () =>
    p.name
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .join('')
      .slice(0, 3);
  const icon = (
    <Show when={media(p.icon)} fallback={<span class="guild-abbrev">{abbrev()}</span>}>
      {(src) => <img src={src()} alt="" draggable={false} />}
    </Show>
  );
  // Without a size it fills its tile (the server list); with one it's a small square of its own.
  if (!p.size) return icon;
  return (
    <span
      class="guild-icon-sized"
      style={{ width: `${p.size}px`, height: `${p.size}px`, 'font-size': `${Math.max(8, p.size * 0.38)}px` }}
    >
      {icon}
    </span>
  );
}
