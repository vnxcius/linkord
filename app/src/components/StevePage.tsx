// Settings -> Steve: the Minecraft bot (server/src/steve.rs). He isn't in any server until someone adds him; the
// Minecraft panel (mc-manager) gives him his commands and answers them, so the list below is whatever it sent.
import { For, Show } from 'solid-js';
import { api } from '../lib/api';
import { t } from '../lib/i18n';
import { can, P } from '../lib/perms';
import { prefs, setPrefs } from '../lib/prefs';
import { state } from '../lib/store';
import { attempt } from '../lib/ui';
import { Avatar, GuildIcon } from './Avatar';
import * as I from './Icons';
import { UserVolumeSlider } from './VolumeControl';

/** Steve's user, once the client knows him (he's in at least one of your servers). */
export const steveUser = () => Object.values(state.users).find((u) => u.bot && u.username === 'steve');

export function StevePage() {
  const steve = steveUser;
  const servers = () =>
    Object.values(state.guilds)
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
  const inServer = (gid: string) => {
    const s = steve();
    return !!s && !!state.members[gid]?.[s.id];
  };
  const toggle = (gid: string) =>
    attempt(
      () => api(inServer(gid) ? 'DELETE' : 'POST', `/guilds/${gid}/bots/steve`),
      inServer(gid) ? t('Steve left the server') : t('Steve joined the server'),
    );
  const commands = () => state.botCommands.filter((c) => c.bot_id === steve()?.id || !steve());
  const online = () => {
    const s = steve();
    return !!s && (state.presences[s.id] ?? 'offline') !== 'offline';
  };
  return (
    <div class="kass-page">
      <div class="kass-hero">
        <Show
          when={steve()}
          fallback={
            <span class="kass-hero-icon">
              <I.Gamepad size={34} />
            </span>
          }
        >
          {(s) => <Avatar user={s()} size={72} />}
        </Show>
        <div class="grow">
          <strong>
            Steve <span class="bot-tag">{t('BOT')}</span>
          </strong>
          <p>
            {t(
              "The Minecraft server's bot: whether it's online, who is playing, the address, the mods and the modpack. The Minecraft panel decides what he says.",
            )}
          </p>
        </div>
      </div>

      <section class="set-section">
        <h2>{t('Sounds')}</h2>
        <p class="set-desc">
          {t('How loud his movie lines play for you in calls. Only on this device; also in his right-click menu.')}
        </p>
        <Show when={steve()}>
          {(s) => (
            <UserVolumeSlider
              label={t('Soundboard Volume')}
              value={prefs.soundboardUserVolumes[s().id] ?? 1}
              onChange={(v) => setPrefs({ soundboardUserVolumes: { ...prefs.soundboardUserVolumes, [s().id]: v } })}
            />
          )}
        </Show>
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
                    {inServer(g.id) ? t('Steve is here') : t('Not in this server')}
                  </small>
                </span>
                <Show when={can(g.id, P.MANAGE_GUILD)} fallback={<span class="muted small">{t('Ask an admin')}</span>}>
                  <button
                    class="btn small-btn"
                    classList={{ primary: !inServer(g.id) }}
                    onClick={() => void toggle(g.id)}
                  >
                    {inServer(g.id) ? t('Remove') : t('Add Steve')}
                  </button>
                </Show>
              </div>
            )}
          </For>
        </div>
      </section>

      <section class="set-section">
        <h2>{t('Commands')}</h2>
        <Show
          when={commands().length}
          fallback={
            <p class="set-desc">
              {steve() && !online()
                ? t("Steve is away: the Minecraft panel isn't connected, so his commands are off for now.")
                : t('Add Steve to a server to see his commands.')}
            </p>
          }
        >
          <p class="set-desc">{t('Type them in any text channel of a server with Steve.')}</p>
          <div class="kass-commands">
            <For each={commands()}>
              {(c) => (
                <div class="kass-command">
                  <code>
                    /{c.name}
                    <Show when={c.option}>{(o) => <span class="muted"> {o()}</span>}</Show>
                  </code>
                  <span>{c.description}</span>
                </div>
              )}
            </For>
          </div>
        </Show>
      </section>
    </div>
  );
}
