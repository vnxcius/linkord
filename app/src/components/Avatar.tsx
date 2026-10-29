import { Show } from 'solid-js';
import { media } from '../lib/api';
import { presenceOf } from '../lib/store';
import type { User } from '../lib/types';
import { displayName } from '../lib/types';

export function Avatar(p: { user?: User | null; size?: number; presence?: boolean; speaking?: boolean }) {
  const size = () => p.size ?? 40;
  const initials = () => displayName(p.user).slice(0, 2).toUpperCase();
  return (
    <div class="avatar" classList={{ speaking: p.speaking }} style={{ width: `${size()}px`, height: `${size()}px` }}>
      <Show
        when={media(p.user?.avatar)}
        fallback={
          <div class="avatar-fallback" style={{ 'font-size': `${size() * 0.38}px` }}>
            {initials()}
          </div>
        }
      >
        {(src) => <img src={src()} alt="" loading="lazy" draggable={false} />}
      </Show>
      <Show when={p.presence && p.user}>
        <span class={`presence ${presenceOf(p.user!.id)}`} style={{ '--ring': `${Math.max(3, size() * 0.07)}px` }} />
      </Show>
    </div>
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
  return (
    <Show when={media(p.icon)} fallback={<span class="guild-abbrev">{abbrev()}</span>}>
      {(src) => <img src={src()} alt="" draggable={false} />}
    </Show>
  );
}
