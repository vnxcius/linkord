import { createMemo, For, Show } from 'solid-js';
import { Nameplate } from './Nameplate';
import { media } from '../lib/api';
import { t } from '../lib/i18n';
import { memberRoles, nameColor, nameOf, presenceOf, state } from '../lib/store';
import { openMenu, openProfile } from '../lib/ui';
import { ActivityBadge, ActivityLine } from './Activity';
import { Avatar } from './Avatar';
import { memberMenu } from './Profile';

/** Member list: hoisted roles first (online only), then Online, then Offline. Shown in the margin, or as a
 *  drawer on narrow windows. */
export function Members(p: { guildId: string; drawer?: boolean }) {
  const groups = createMemo(() => {
    const ids = Object.keys(state.members[p.guildId] ?? {}).filter((id) => state.users[id]);
    ids.sort((a, b) => nameOf(a, p.guildId).localeCompare(nameOf(b, p.guildId)));
    const hoisted = Object.values(state.roles[p.guildId] ?? {})
      .filter((r) => r.hoist && r.id !== p.guildId)
      .sort((a, b) => b.position - a.position);
    const placed = new Set<string>();
    const out: { title: string; ids: string[] }[] = [];
    for (const role of hoisted) {
      const inRole = ids.filter(
        (id) =>
          !placed.has(id) &&
          presenceOf(id) !== 'offline' &&
          memberRoles(p.guildId, id).find((r) => r.hoist)?.id === role.id,
      );
      inRole.forEach((id) => placed.add(id));
      if (inRole.length) out.push({ title: role.name, ids: inRole });
    }
    const online = ids.filter((id) => !placed.has(id) && presenceOf(id) !== 'offline');
    const offline = ids.filter((id) => presenceOf(id) === 'offline');
    if (online.length) out.push({ title: t('Online'), ids: online });
    if (offline.length) out.push({ title: t('Offline'), ids: offline });
    return out;
  });
  const owner = () => state.guilds[p.guildId]?.owner_id;
  return (
    <aside class="members" classList={{ drawer: p.drawer }}>
      <For each={groups()}>
        {(g) => (
          <>
            <div class="group-title">
              <span>{g.title}</span>
              <span>{String(g.ids.length).padStart(2, '0')}</span>
            </div>
            <For each={g.ids}>
              {(id) => (
                <button
                  class="member"
                  classList={{ offline: presenceOf(id) === 'offline', 'has-nameplate': !!state.users[id]?.nameplate }}
                  onClick={(e) => openProfile(id, e, p.guildId)}
                  onContextMenu={(e) => openMenu(e, memberMenu(id, p.guildId))}
                >
                  <Show when={media(state.users[id]?.nameplate)}>{(src) => <Nameplate src={src()} lazy />}</Show>
                  <Avatar user={state.users[id]} size={32} presence />
                  <span class="member-text">
                    <span class="member-name-row">
                      <span class="member-name" style={{ color: nameColor(p.guildId, id) }}>
                        {nameOf(id, p.guildId)}
                      </span>
                      <Show when={state.users[id]?.bot}>
                        <span class="bot-tag">{t('BOT')}</span>
                      </Show>
                      <Show when={id === owner()}>
                        <span class="owner-crown" title={t('Server owner')}>
                          ♛
                        </span>
                      </Show>
                    </span>
                    <ActivityLine userId={id} />
                  </span>
                  <ActivityBadge userId={id} />
                </button>
              )}
            </For>
          </>
        )}
      </For>
    </aside>
  );
}
