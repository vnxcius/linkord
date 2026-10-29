// Invite links in chat show a card like Discord's: the server, how many are online, and a Join button
// that joins right there and opens the server (or "Joined" to jump to it).
import { createResource, createSignal, Show } from 'solid-js';
import { acceptInvite, selectView } from '../lib/actions';
import { api, knownServers } from '../lib/api';
import { plural, t } from '../lib/i18n';
import { state } from '../lib/store';
import type { GuildInfo, User } from '../lib/types';
import { attempt } from '../lib/ui';
import { GuildIcon } from './Avatar';

interface InvitePreview {
  code: string;
  guild: GuildInfo;
  member_count: number;
  online_count?: number;
  inviter: User;
}

/** Invite codes from links to this Linkord server in a message, in order, without repeats. */
export function inviteCodes(content: string): string[] {
  // Any address of this server counts (the usual one and direct access).
  const origins = knownServers().map((o) => o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(?:${origins.join('|')})/invite/([A-Za-z0-9]+)`, 'g');
  return [...new Set([...content.matchAll(re)].map((m) => m[1]))].slice(0, 3);
}

export const isInviteUrl = (url: string) => knownServers().some((o) => url.startsWith(`${o}/invite/`));

// Many messages can show the same invite; fetch each once per session.
const cache = new Map<string, Promise<InvitePreview | null>>();
const preview = (code: string) => {
  if (!cache.has(code))
    cache.set(
      code,
      api<InvitePreview>('GET', `/invites/${code}`).catch(() => null),
    );
  return cache.get(code)!;
};

export function InviteCard(p: { code: string; mine: boolean }) {
  const [info] = createResource(() => p.code, preview);
  const [joining, setJoining] = createSignal(false);
  const joined = () => !!info() && !!state.guilds[info()!.guild.id];
  const join = async () => {
    const i = info();
    if (!i) return;
    if (joined()) return selectView(i.guild.id);
    setJoining(true);
    await attempt(() => acceptInvite(p.code));
    setJoining(false);
  };
  return (
    <div class="invite-card">
      <div class="invite-head">
        {info() === null
          ? t("You received an invite, but it's invalid.")
          : p.mine
            ? t('You sent an invite to join a server')
            : t("You've been invited to join a server")}
      </div>
      <Show
        when={!info.loading}
        fallback={
          <div class="invite-body">
            <span class="invite-icon skeleton" />
            <span class="grow skeleton invite-skel" />
          </div>
        }
      >
        <Show
          when={info()}
          fallback={
            <div class="invite-body">
              <span class="invite-icon invalid">?</span>
              <div class="grow">
                <strong class="invite-name invalid">{t('Invalid invite')}</strong>
                <div class="muted small">{t('Ask for a new invite.')}</div>
              </div>
            </div>
          }
        >
          {(i) => (
            <div class="invite-body">
              <span class="invite-icon">
                <GuildIcon name={i().guild.name} icon={i().guild.icon} />
              </span>
              <div class="grow invite-info">
                <strong class="invite-name">{i().guild.name}</strong>
                <div class="invite-counts">
                  <Show when={i().online_count != null}>
                    <span>
                      <i class="dot online" />
                      {plural(i().online_count!, '{n} Online', '{n} Online')}
                    </span>
                  </Show>
                  <span>
                    <i class="dot" />
                    {plural(i().member_count, '{n} Member', '{n} Members')}
                  </span>
                </div>
              </div>
              <button
                class="btn invite-join"
                classList={{ joined: joined() }}
                disabled={joining()}
                onClick={() => void join()}
              >
                {joined() ? t('Joined') : joining() ? t('Joining…') : t('Join')}
              </button>
            </div>
          )}
        </Show>
      </Show>
    </div>
  );
}
