// Settings -> Kass: the music bot. He's in every server unless it removes him; here you choose whether servers you
// create start with him, and add or remove him in the servers you manage (server/src/music.rs).
import { createResource, For, Show } from 'solid-js';
import { api } from '../lib/api';
import { COMMANDS } from '../lib/commands';
import { t } from '../lib/i18n';
import { can, P } from '../lib/perms';
import { state } from '../lib/store';
import { attempt } from '../lib/ui';
import { Avatar, GuildIcon } from './Avatar';
import * as I from './Icons';

/** Kass's user, once the client knows him (he's in at least one of your servers). */
export const kassUser = () => Object.values(state.users).find((u) => u.bot && u.username === 'kass');

export function KassPage() {
  const [settings, { mutate }] = createResource(() =>
    api<{ new_servers: boolean }>('GET', '/users/@me/kass').catch(() => ({ new_servers: true })),
  );
  const kass = kassUser;
  const servers = () =>
    Object.values(state.guilds)
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
  const inServer = (gid: string) => {
    const k = kass();
    return !!k && !!state.members[gid]?.[k.id];
  };
  const setNewServers = (on: boolean) =>
    attempt(async () => mutate(await api<{ new_servers: boolean }>('PUT', '/users/@me/kass', { new_servers: on })));
  const toggle = (gid: string) =>
    attempt(
      () => api(inServer(gid) ? 'DELETE' : 'POST', `/guilds/${gid}/bots/music`),
      inServer(gid) ? t('Kass left the server') : t('Kass joined the server'),
    );
  return (
    <div class="kass-page">
      <div class="kass-hero">
        <Show
          when={kass()}
          fallback={
            <span class="kass-hero-icon">
              <I.Music size={34} />
            </span>
          }
        >
          {(k) => <Avatar user={k()} size={72} />}
        </Show>
        <div class="grow">
          <strong>
            Kass <span class="bot-tag">{t('BOT')}</span>
          </strong>
          <p>
            {t(
              "Plays YouTube and Spotify in voice channels. He's in every server unless someone removes him (kicking him does that too); add him back any time.",
            )}
          </p>
        </div>
      </div>

      <section class="set-section">
        <h2>{t('New servers')}</h2>
        <label class="toggle-row">
          <span>
            <strong>{t('Add Kass to every new server I create')}</strong>
            <small>{t('Turn this off to start your servers without him. You can still add him later.')}</small>
          </span>
          <input
            type="checkbox"
            class="switch"
            checked={settings()?.new_servers ?? true}
            disabled={settings.loading}
            onChange={(e) => void setNewServers(e.currentTarget.checked)}
          />
        </label>
      </section>

      <section class="set-section">
        <h2>{t('Your servers')}</h2>
        <p class="set-desc">{t('Adding or removing him needs Manage Server.')}</p>
        <div class="kass-servers">
          <For each={servers()} fallback={<p class="muted">{t("You aren't in any server yet.")}</p>}>
            {(g) => (
              <div class="kass-server">
                <GuildIcon name={g.name} icon={g.icon} size={32} />
                <span class="grow">
                  <strong>{g.name}</strong>
                  <small classList={{ on: inServer(g.id) }}>
                    {inServer(g.id) ? t('Kass is here') : t('Kass was removed')}
                  </small>
                </span>
                <Show when={can(g.id, P.MANAGE_GUILD)} fallback={<span class="muted small">{t('Ask an admin')}</span>}>
                  <button
                    class="btn small-btn"
                    classList={{ primary: !inServer(g.id) }}
                    onClick={() => void toggle(g.id)}
                  >
                    {inServer(g.id) ? t('Remove') : t('Add Kass')}
                  </button>
                </Show>
              </div>
            )}
          </For>
        </div>
      </section>

      <section class="set-section">
        <h2>{t('Commands')}</h2>
        <p class="set-desc">
          {t('Type them in any text channel of a server with Kass, while you are in a voice channel.')}
        </p>
        <div class="kass-commands">
          <For each={COMMANDS}>
            {(c) => (
              <div class="kass-command">
                <code>
                  /{c.name}
                  <Show when={c.option}>{(o) => <span class="muted"> {t(o())}</span>}</Show>
                </code>
                <span>{t(c.description)}</span>
              </div>
            )}
          </For>
        </div>
      </section>
    </div>
  );
}
