// Settings -> Stats: everything Pottira measures about you (GET /users/@me/stats, server/src/api/users.rs stats).
// Most numbers are counted from what's stored (messages, reactions...); time streaming, sounds, songs and the like
// are measured as they happen, since 0.2.15 (stats.rs).
import { createResource, createSignal, For, Show, type JSX } from 'solid-js';
import { api, emojiUrl } from '../lib/api';
import { dateLocale, msg, t } from '../lib/i18n';
import { dmName, state } from '../lib/store';
import { toast } from '../lib/ui';
import { isPrivate } from '../lib/types';
import { GuildIcon } from './Avatar';
import * as I from './Icons';
import { formatSize } from './MessageItem';

interface Stats {
  created_at: string;
  voice_seconds: number;
  messages: number;
  attachments: number;
  reactions: number;
  servers: number;
  friends: number;
  upload_bytes: number;
  upload_quota: number;
  servers_owned?: number;
  avatars?: number;
  invites_created?: number;
  invite_uses?: number;
  emojis_uploaded?: number;
  sounds_uploaded?: number;
  reactions_received?: number;
  mentions_received?: number;
  pins?: number;
  threads?: number;
  message_stats?: {
    images: number;
    voice_notes: number;
    replies: number;
    forwards: number;
    edited: number;
    links: number;
    words: number;
    characters: number;
    first_at: string | null;
    active_days: number;
  };
  top_emoji?: { emoji: string; count: number }[];
  top_channels?: { channel_id: string; count: number }[];
  /** [weekday 0 = Sunday, hour, messages], in our time zone. */
  activity?: [number, number, number][];
  counters?: Record<string, number>;
  games?: { name: string; icon: string | null; seconds: number; last_played: string }[];
}

export const num = (n: number | undefined) => (n ?? 0).toLocaleString(dateLocale());
const shortDate = (d: string) =>
  new Date(d).toLocaleDateString(dateLocale(), { year: 'numeric', month: 'short', day: 'numeric' });
const longDate = (d: string) =>
  new Date(d).toLocaleDateString(dateLocale(), { year: 'numeric', month: 'long', day: 'numeric' });

/** "76 h 12 min", "45 min": always hours, however long (owner, 2026-11-03). <Duration> offers days on click. */
export function duration(seconds: number | undefined) {
  const s = Math.max(0, Math.floor(seconds ?? 0));
  const m = Math.floor((s % 3600) / 60);
  const hours = Math.floor(s / 3600);
  return hours ? t('{h} h {m} min', { h: num(hours), m }) : t('{m} min', { m });
}

/** A time on screen: in hours, and from a day up, clicking it switches between hours and days. */
export function Duration(p: { seconds: number | undefined }) {
  const [days, setDays] = createSignal(false);
  const s = () => Math.max(0, Math.floor(p.seconds ?? 0));
  const inDays = () => t('{d} d {h} h', { d: num(Math.floor(s() / 86400)), h: Math.floor((s() % 86400) / 3600) });
  return (
    <Show when={s() >= 86400} fallback={duration(s())}>
      <button
        type="button"
        class="duration-toggle"
        data-tip={t('Switch between hours and days')}
        onClick={(e) => {
          e.stopPropagation();
          setDays(!days());
        }}
      >
        {days() ? inDays() : duration(s())}
      </button>
    </Show>
  );
}

function Tile(p: { label: string; value: JSX.Element; hint?: string }) {
  return (
    <div class="stat" data-tip={p.hint}>
      <span class="stat-label">{p.label}</span>
      <strong>{p.value}</strong>
    </div>
  );
}

function Block(p: { title: string; note?: string; children: JSX.Element }) {
  return (
    <section class="set-section stats-block">
      <h2>{p.title}</h2>
      <Show when={p.note}>
        <p class="set-desc">{p.note}</p>
      </Show>
      {p.children}
    </section>
  );
}

const DAY_KEYS = [0, 1, 2, 3, 4, 5, 6];

/** When you write: weekdays down, hours across, deeper gold for busier hours. */
function Heatmap(p: { cells: [number, number, number][] }) {
  const grid = () => {
    const g = DAY_KEYS.map(() => Array<number>(24).fill(0));
    for (const [d, h, n] of p.cells) if (g[d] && h >= 0 && h < 24) g[d][h] = n;
    return g;
  };
  const max = () => Math.max(1, ...p.cells.map((c) => c[2]));
  // Monday first, like most of the world; weekday names in the app's language.
  const order = [1, 2, 3, 4, 5, 6, 0];
  const dayName = (d: number) =>
    new Date(2024, 0, 7 + d).toLocaleDateString(dateLocale(), { weekday: 'short' }).replace('.', '');
  const dayLong = (d: number) => new Date(2024, 0, 7 + d).toLocaleDateString(dateLocale(), { weekday: 'long' });
  const busiest = () => {
    let best = { d: 0, h: 0, n: 0 };
    grid().forEach((row, d) => row.forEach((n, h) => n > best.n && (best = { d, h, n })));
    return best;
  };
  return (
    <div class="heatmap-wrap">
      <div class="heatmap" role="img" aria-label={t('Messages by weekday and hour')}>
        <For each={order}>
          {(d) => (
            <>
              <span class="heatmap-day">{dayName(d)}</span>
              <For each={grid()[d]}>
                {(n, h) => (
                  <i
                    class="heatmap-cell"
                    style={{ '--v': n ? 0.18 + 0.82 * (n / max()) : 0 }}
                    data-tip={t('{day} {hour}:00 · {n} messages', { day: dayName(d), hour: h(), n: num(n) })}
                  />
                )}
              </For>
            </>
          )}
        </For>
        <span />
        <For each={Array.from({ length: 24 }, (_, h) => h)}>
          {(h) => <span class="heatmap-hour">{h % 6 === 0 ? `${h}h` : ''}</span>}
        </For>
      </div>
      <Show when={busiest().n}>
        <p class="muted small">
          {t('Your busiest time: {day} around {hour}:00.', { day: dayLong(busiest().d), hour: busiest().h })}
        </p>
      </Show>
    </div>
  );
}

/** A reaction as stored: a character, or "name:id" for server emoji. */
export function ReactionEmoji(p: { emoji: string }) {
  const custom = () => p.emoji.match(/^(\w+):(\d+)$/);
  return (
    <Show when={custom()} fallback={<span class="stats-emoji">{p.emoji}</span>}>
      {(m) => <img class="stats-emoji custom" src={emojiUrl(m()[2], false)} alt={`:${m()[1]}:`} />}
    </Show>
  );
}

function ChannelLabel(p: { id: string }) {
  const ch = () => state.channels[p.id];
  const guild = () => (ch()?.guild_id ? state.guilds[ch()!.guild_id!] : undefined);
  return (
    <Show when={ch()} fallback={<span class="muted">{t("A channel you can't see anymore")}</span>}>
      {(c) => (
        <span class="stats-channel">
          <Show when={guild()} fallback={<I.At size={14} />}>
            {(g) => <GuildIcon name={g().name} icon={g().icon} size={18} />}
          </Show>
          <span class="grow">{isPrivate(c().kind) ? dmName(c()) : `#${c().name}`}</span>
          <Show when={guild()}>{(g) => <span class="muted small">{g().name}</span>}</Show>
        </span>
      )}
    </Show>
  );
}

/** A ranked list with a bar per row (share of the first). */
function Ranked<T>(p: {
  items: T[];
  value: (x: T) => number;
  label: (x: T) => JSX.Element;
  format?: (n: number) => JSX.Element;
}) {
  const top = () => Math.max(1, ...p.items.map(p.value));
  return (
    <div class="ranked">
      <For each={p.items}>
        {(x) => (
          <div class="ranked-row">
            <div class="ranked-label">{p.label(x)}</div>
            <div class="ranked-bar">
              <i style={{ width: `${(p.value(x) / top()) * 100}%` }} />
            </div>
            <span class="ranked-value">{(p.format ?? num)(p.value(x))}</span>
          </div>
        )}
      </For>
    </div>
  );
}

const GAME_SINCE = msg('Measured since Pottira 0.2.15, like everything below that happens live.');

export function StatsPage() {
  const [stats] = createResource(() =>
    api<Stats>('GET', `/users/@me/stats?tz=${-new Date().getTimezoneOffset()}`).catch(() => null),
  );
  const c = (key: string) => stats()?.counters?.[key] ?? 0;
  const m = () => stats()?.message_stats;
  const id = () => state.me!.id;
  return (
    <Show
      when={stats()}
      fallback={<p class="muted">{stats.loading ? t('Loading…') : t("Couldn't load your stats.")}</p>}
    >
      {(s) => (
        <div class="stats-page">
          <div class="stats-hero">
            <div>
              <span class="stat-label">{t('Member since')}</span>
              <strong title={longDate(s().created_at)}>{shortDate(s().created_at)}</strong>
            </div>
            <div>
              <span class="stat-label">{t('Time in voice')}</span>
              <strong>
                <Duration seconds={s().voice_seconds} />
              </strong>
            </div>
            <div>
              <span class="stat-label">{t('Messages sent')}</span>
              <strong>{num(s().messages)}</strong>
            </div>
            <div>
              <span class="stat-label">{t('Days you wrote')}</span>
              <strong>{num(m()?.active_days)}</strong>
            </div>
          </div>

          <Block
            title={t('Messages')}
            note={m()?.first_at ? t('Your first message: {date}.', { date: longDate(m()!.first_at!) }) : undefined}
          >
            <div class="stat-grid">
              <Tile label={t('Words')} value={num(m()?.words)} />
              <Tile label={t('Characters')} value={num(m()?.characters)} />
              <Tile label={t('Replies')} value={num(m()?.replies)} />
              <Tile label={t('Forwarded')} value={num(m()?.forwards)} />
              <Tile label={t('Edited')} value={num(m()?.edited)} />
              <Tile label={t('Links shared')} value={num(m()?.links)} />
              <Tile label={t('Files shared')} value={num(s().attachments)} />
              <Tile label={t('Pictures')} value={num(m()?.images)} />
              <Tile label={t('Voice messages')} value={num(m()?.voice_notes)} />
              <Tile label={t('Pins')} value={num(s().pins)} />
              <Tile label={t('Threads started')} value={num(s().threads)} />
              <Tile label={t('Times mentioned')} value={num(s().mentions_received)} />
              <Tile label={t('Reactions added')} value={num(s().reactions)} />
              <Tile label={t('Reactions received')} value={num(s().reactions_received)} />
            </div>
          </Block>

          <Show when={s().activity?.length}>
            <Block title={t('When you write')}>
              <Heatmap cells={s().activity!} />
            </Block>
          </Show>

          <Show when={s().top_channels?.length || s().top_emoji?.length}>
            <div class="stats-pair">
              <Show when={s().top_channels?.length}>
                <Block title={t('Where you talk most')}>
                  <Ranked
                    items={s().top_channels!}
                    value={(x) => x.count}
                    label={(x) => <ChannelLabel id={x.channel_id} />}
                  />
                </Block>
              </Show>
              <Show when={s().top_emoji?.length}>
                <Block title={t('Your favourite reactions')}>
                  <Ranked
                    items={s().top_emoji!}
                    value={(x) => x.count}
                    label={(x) => <ReactionEmoji emoji={x.emoji} />}
                  />
                </Block>
              </Show>
            </div>
          </Show>

          <Block title={t('Voice & video')}>
            <div class="stat-grid">
              <Tile label={t('Time in voice')} value={<Duration seconds={s().voice_seconds} />} />
              <Tile label={t('Longest call')} value={<Duration seconds={c('longest_voice_seconds')} />} />
              <Tile label={t('Times you joined voice')} value={num(c('voice_sessions'))} />
              <Tile label={t('Calls started')} value={num(c('calls_started'))} />
              <Tile label={t('Time streaming')} value={<Duration seconds={c('stream_seconds')} />} />
              <Tile label={t('Streams started')} value={num(c('streams_started'))} />
              <Tile label={t('Time watching streams')} value={<Duration seconds={c('stream_watch_seconds')} />} />
              <Tile label={t('Streams watched')} value={num(c('streams_watched'))} />
              <Tile label={t('Time on camera')} value={<Duration seconds={c('camera_seconds')} />} />
              <Tile label={t('Time muted')} value={<Duration seconds={c('muted_seconds')} />} />
              <Tile label={t('Time deafened')} value={<Duration seconds={c('deafened_seconds')} />} />
            </div>
          </Block>

          <Block title={t('Fun')}>
            <div class="stat-grid">
              <Tile label={t('Watching together')} value={<Duration seconds={c('watch_together_seconds')} />} />
              <Tile label={t('Videos shared')} value={num(c('videos_shared'))} />
              <Tile label={t('Sounds played')} value={num(c('sounds_played'))} />
              <Tile label={t('Songs queued for Kass')} value={num(c('songs_queued'))} />
              <Tile label={t('Kass commands')} value={num(c('kass_commands'))} />
              <Tile label={t('Statuses set')} value={num(c('statuses_set'))} />
              <Tile label={t('Time playing games')} value={<Duration seconds={c('game_seconds')} />} />
              <Tile label={t('Games played')} value={num(c('games_started'))} />
            </div>
          </Block>

          <Show when={s().games?.length}>
            <Block title={t('Most played')}>
              <Ranked
                items={s().games!}
                value={(g) => g.seconds}
                format={(n) => <Duration seconds={n} />}
                label={(g) => (
                  <span class="stats-game">
                    <Show
                      when={g.icon}
                      fallback={
                        <span class="stats-game-icon">
                          <I.Gamepad size={16} />
                        </span>
                      }
                    >
                      {(src) => <img class="stats-game-icon" src={src()} alt="" />}
                    </Show>
                    <span class="grow">{g.name}</span>
                  </span>
                )}
              />
            </Block>
          </Show>

          <Block title={t('Account')}>
            <div class="stat-grid">
              <Tile label={t('Servers')} value={num(s().servers)} />
              <Tile label={t('Servers you own')} value={num(s().servers_owned)} />
              <Tile label={t('Friends')} value={num(s().friends)} />
              <Tile label={t('Invites created')} value={num(s().invites_created)} />
              <Tile label={t('People who used your invites')} value={num(s().invite_uses)} />
              <Tile label={t('Emoji uploaded')} value={num(s().emojis_uploaded)} />
              <Tile label={t('Sounds uploaded')} value={num(s().sounds_uploaded)} />
              <Tile label={t('Profile pictures')} value={num(s().avatars)} />
              <div class="stat">
                <span class="stat-label">{t('User ID')}</span>
                <span class="stat-id">
                  <code>{id()}</code>
                  <button
                    class="icon-btn tiny"
                    aria-label={t('Copy User ID')}
                    data-tip={t('Copy')}
                    onClick={() => navigator.clipboard.writeText(id()).then(() => toast(t('ID copied')))}
                  >
                    <I.Copy size={14} />
                  </button>
                </span>
              </div>
              <div class="stat">
                <span class="stat-label">{t('Upload space')}</span>
                <strong>
                  {t('{used} of {total}', { used: formatSize(s().upload_bytes), total: formatSize(s().upload_quota) })}
                </strong>
                <div class="stat-bar">
                  <i style={{ width: `${Math.min(100, (s().upload_bytes / s().upload_quota) * 100)}%` }} />
                </div>
              </div>
            </div>
          </Block>
          <p class="muted small">
            {t("Time in voice is counted from Pottira 0.1.14 on. Deleted messages don't count.")} {t(GAME_SINCE)}
          </p>
        </div>
      )}
    </Show>
  );
}
