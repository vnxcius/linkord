// League of Legends on profiles (owner, 2026-11-12): the widget beside the full profile (rank, top champions, recent
// games, from Riot's API through GET /users/{id}/league, server/src/league.rs) and its settings (link a Riot ID, show
// it to others). Lobby/queue/champion presence lives in Activity.tsx GameCard and lib/league.ts.
import { createResource, createSignal, For, Show } from 'solid-js';
import { Avatar } from './Avatar';
import { api } from '../lib/api';
import { lang, t } from '../lib/i18n';
import {
  art,
  askToJoin,
  dismissLeaguePrompt,
  inviteSummoner,
  leagueMe,
  leaguePrompts,
  type LeagueActivity,
  type LeaguePrompt,
  leagueSignedIn,
  phaseName,
  queueName,
  rankedQueueName,
  rankEmblem,
  rankName,
} from '../lib/league';
import { gameOf, nameOf, state } from '../lib/store';
import { isTauri } from '../lib/platform';
import type { Message } from '../lib/types';
import { GameIcon } from './Activity';
import { attempt, setUi, toast } from '../lib/ui';
import * as I from './Icons';
import { num } from './StatsPage';
import { formatDuration } from './VideoPlayer';

export interface LeagueAccount {
  game_name: string;
  tag_line: string;
  platform: string;
}

interface Ranked {
  queue: string;
  tier: string;
  rank: string;
  lp: number;
  wins: number;
  losses: number;
  hot_streak?: boolean;
}

interface Mastery {
  champion_id: number;
  champion?: string | null;
  icon: string;
  level: number;
  points: number;
}

interface Match {
  id: string;
  champion?: string | null;
  icon: string;
  win: boolean;
  remake: boolean;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  placement?: number | null;
  queue_id: number;
  mode: string;
  duration: number;
  ended_at: number;
}

interface LeagueProfile {
  game_name?: string | null;
  tag_line?: string | null;
  level?: number | null;
  icon?: string | null;
  ranked: Ranked[];
  mastery_score?: number;
  masteries: Mastery[];
  matches: Match[];
  updated_at: number;
}

/** "3 hours ago", in the UI language. */
function ago(ms: number): string {
  const s = (ms - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(lang(), { numeric: 'auto' });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, size] of units) if (Math.abs(s) >= size) return rtf.format(Math.round(s / size), unit);
  return rtf.format(0, 'minute');
}

const winRate = (r: Ranked) => Math.round((r.wins / Math.max(1, r.wins + r.losses)) * 100);

/** The full profile's League tab: Riot ID and level, ranks, top champions, the last few games. */
export function LeagueCard(p: { userId: string; account: LeagueAccount; isMe: boolean; shown?: boolean }) {
  const [data, { mutate }] = createResource(
    () => p.userId,
    (id) => api<LeagueProfile>('GET', `/users/${id}/league`),
  );
  // The server keeps the profile (asking Riot only when a game was played): Update asks for all of it again.
  const [updating, setUpdating] = createSignal(false);
  const update = async () => {
    setUpdating(true);
    try {
      mutate(await api<LeagueProfile>('GET', `/users/${p.userId}/league?refresh=true`));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setUpdating(false);
    }
  };
  const name = () => data()?.game_name ?? p.account.game_name;
  const tag = () => data()?.tag_line ?? p.account.tag_line;
  return (
    <section class="widget-card league-card" aria-label="League of Legends">
      <header class="widget-head league-head">
        <Show when={data()?.icon}>
          {(src) => (
            <span class="league-icon">
              <img src={art(src())} alt="" />
              <Show when={data()?.level}>{(lv) => <em>{lv()}</em>}</Show>
            </span>
          )}
        </Show>
        <div class="grow">
          <span class="label">League of Legends</span>
          <h3>
            {name()}
            <span class="league-tag">#{tag()}</span>
          </h3>
        </div>
        <Show when={data()}>
          {(d) => (
            <button
              class="league-update"
              disabled={updating()}
              data-tip={t('Updated {when}', { when: ago(d().updated_at) })}
              aria-label={t('Update')}
              onClick={() => void update()}
            >
              <I.Refresh size={15} class={updating() ? 'spin' : undefined} />
              <span>{updating() ? t('Updating…') : t('Update')}</span>
            </button>
          )}
        </Show>
      </header>
      <Show
        when={data()}
        fallback={
          <p class="muted small">{data.error ? t("Couldn't load this League profile right now.") : t('Loading…')}</p>
        }
      >
        {(d) => (
          <>
            <div class="league-ranks">
              <For
                each={d().ranked}
                fallback={
                  <div class="league-rank unranked">
                    <span class="league-emblem">
                      <I.Crown size={20} />
                    </span>
                    <div>
                      <span class="label">{t('Ranked')}</span>
                      <strong>{t('Unranked this season')}</strong>
                    </div>
                  </div>
                }
              >
                {(r) => (
                  <div class="league-rank">
                    <span class="league-emblem">
                      <img src={rankEmblem(r.tier)} alt="" loading="lazy" />
                    </span>
                    <div class="grow">
                      <span class="label">{rankedQueueName(r.queue)}</span>
                      <strong>
                        {rankName(r.tier, r.rank)} <span class="league-lp">{t('{lp} LP', { lp: r.lp })}</span>
                      </strong>
                      <small>
                        {t('{wins}W {losses}L', { wins: r.wins, losses: r.losses })} ·{' '}
                        {t('{rate}% win rate', { rate: winRate(r) })}
                        <Show when={r.hot_streak}> · {t('On a streak')}</Show>
                      </small>
                    </div>
                  </div>
                )}
              </For>
            </div>

            <Show when={d().masteries.length}>
              <div class="league-section">
                <span class="label">{t('Top champions')}</span>
                <Show when={d().mastery_score}>
                  {(score) => (
                    <span class="league-score" data-tip={t('Total mastery score')}>
                      {num(score())}
                    </span>
                  )}
                </Show>
              </div>
              <div class="league-masteries">
                <For each={d().masteries}>
                  {(m) => (
                    <div class="league-mastery" data-tip={m.champion ?? undefined}>
                      <span class="league-champ">
                        <img src={art(m.icon)} alt="" loading="lazy" />
                        <em>{m.level}</em>
                      </span>
                      <small>{compactPoints(m.points)}</small>
                    </div>
                  )}
                </For>
              </div>
            </Show>

            <Show when={d().matches.length}>
              <div class="league-section">
                <span class="label">{t('Recent games')}</span>
              </div>
              <ol class="league-matches">
                <For each={d().matches}>
                  {(m) => (
                    <li
                      class="league-match"
                      classList={{ win: m.win && !m.remake, loss: !m.win && !m.remake, remake: m.remake }}
                    >
                      <span class="league-champ small">
                        <img src={art(m.icon)} alt="" loading="lazy" />
                      </span>
                      <div class="grow">
                        <strong>
                          <span class="league-result">
                            {m.remake
                              ? t('Remake')
                              : m.placement
                                ? t('#{n} place', { n: m.placement })
                                : m.win
                                  ? t('Victory')
                                  : t('Defeat')}
                          </span>
                          <span class="league-kda">
                            {m.kills}/{m.deaths}/{m.assists}
                          </span>
                        </strong>
                        <small>{[m.champion, queueName(m.queue_id, null, m.mode)].filter(Boolean).join(' · ')}</small>
                      </div>
                      <div class="league-match-meta">
                        <span>{formatDuration(m.duration)}</span>
                        <small>{ago(m.ended_at)}</small>
                      </div>
                    </li>
                  )}
                </For>
              </ol>
            </Show>
          </>
        )}
      </Show>
      <Show when={p.isMe && p.shown === false}>
        <button class="widget-hidden" onClick={() => setUi('modal', { type: 'settings', tab: 'profile' })}>
          <I.EyeOff size={14} /> {t('Only you can see this. Show it in Settings → Profile.')}
        </button>
      </Show>
    </section>
  );
}

/** 112912 -> "113k", 1.2M; mastery points get big. */
function compactPoints(n: number): string {
  return new Intl.NumberFormat(lang(), { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

interface AccountState {
  enabled: boolean;
  account: LeagueAccount | null;
  show: boolean;
}

/** Settings -> Profile: link a Riot ID (or the one signed in to League on this PC) and show the widget. */
export function LeagueSettings() {
  const [mine, { mutate }] = createResource(() => api<AccountState>('GET', '/league/account').catch(() => null));
  const [riotId, setRiotId] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const link = (id: string) =>
    attempt(async () => {
      setBusy(true);
      try {
        const account = await api<LeagueAccount>('PUT', '/league/account', { riot_id: id.trim() });
        // Linking means you want it on your profile; it can be hidden again right here.
        if (!mine()?.show) await api('PATCH', '/users/@me', { show_league: true });
        mutate((m) => m && { ...m, account, show: true });
        setRiotId('');
      } finally {
        setBusy(false);
      }
    }, t('League account linked'));
  const unlink = () =>
    attempt(async () => {
      await api('DELETE', '/league/account');
      mutate((m) => m && { ...m, account: null });
    });
  const setShow = (on: boolean) =>
    attempt(async () => {
      await api('PATCH', '/users/@me', { show_league: on });
      mutate((m) => m && { ...m, show: on });
    });
  const signedIn = () => {
    const id = leagueSignedIn();
    const acc = mine()?.account;
    return id && (!acc || `${acc.game_name}#${acc.tag_line}`.toLowerCase() !== id.toLowerCase()) ? id : null;
  };
  return (
    <Show when={mine()?.enabled && mine()}>
      {(m) => (
        <div class="league-settings">
          <label class="set-row" classList={{ disabled: !m().account }}>
            <span class="set-row-text">
              <strong>{t('Show my League of Legends profile')}</strong>
              <small>{t('Rank, top champions and recent games, from your Riot account.')}</small>
            </span>
            <input
              type="checkbox"
              class="switch"
              checked={m().show && !!m().account}
              disabled={!m().account}
              onChange={(e) => void setShow(e.currentTarget.checked)}
            />
          </label>
          <Show
            when={m().account}
            fallback={
              <div class="song-search-bar">
                <input
                  value={riotId()}
                  maxLength={24}
                  placeholder={t('Riot ID (Name#TAG)')}
                  aria-label={t('Riot ID (Name#TAG)')}
                  onInput={(e) => setRiotId(e.currentTarget.value)}
                  onKeyDown={(e) => e.key === 'Enter' && riotId().includes('#') && void link(riotId())}
                />
                <button
                  class="btn small-btn"
                  disabled={busy() || !riotId().includes('#')}
                  onClick={() => void link(riotId())}
                >
                  {t('Link')}
                </button>
              </div>
            }
          >
            {(acc) => (
              <div class="league-linked">
                <I.Check size={14} />
                <span class="grow">{t('Linked to {riotId}', { riotId: `${acc().game_name}#${acc().tag_line}` })}</span>
                <button class="btn small-btn" onClick={() => void unlink()}>
                  {t('Unlink')}
                </button>
              </div>
            )}
          </Show>
          <Show when={signedIn()}>
            {(id) => (
              <button class="btn small-btn league-use" disabled={busy()} onClick={() => void link(id())}>
                {t('Use {riotId} (signed in to League)', { riotId: id() })}
              </button>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}

/** Lobby invites through Linkord, as cards in the top right (lib/league.ts): someone asks to join your lobby (Invite
 *  has your League client invite them), or invites you to theirs (Join asks them back, and their app invites you
 *  without asking again). */
export function LeaguePrompts() {
  return (
    <Show when={leaguePrompts.length}>
      <div class="league-prompts">
        <For each={leaguePrompts}>{(p) => <LeaguePromptCard prompt={p} />}</For>
      </div>
    </Show>
  );
}

function LeaguePromptCard(p: { prompt: LeaguePrompt }) {
  const [busy, setBusy] = createSignal(false);
  const user = () => state.users[p.prompt.user_id];
  const done = () => dismissLeaguePrompt(p.prompt.key);
  const accept = async () => {
    setBusy(true);
    try {
      if (p.prompt.kind === 'join') {
        await inviteSummoner(p.prompt.summoner_id!, p.prompt.puuid);
        toast(t('Invited {name} to your lobby', { name: nameOf(p.prompt.user_id) }));
        done();
      } else if (await askToJoin(p.prompt.user_id)) {
        toast(t('The invite is on its way to your League client'));
        done();
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const queue = () => {
    const l = p.prompt.league;
    return l ? (queueName(l.queue_id, l.queue, l.mode) ?? phaseName(l.phase)) : undefined;
  };
  return (
    <div class="league-prompt" role="alertdialog" aria-label={t('League of Legends lobby')}>
      <div class="league-prompt-head">
        <Show when={user()}>{(u) => <Avatar user={u()} size={40} />}</Show>
        <div class="league-prompt-text">
          <strong>{nameOf(p.prompt.user_id)}</strong>
          <span>
            {p.prompt.kind === 'join' ? t('wants to join your League lobby') : t('invited you to their League lobby')}
          </span>
          <Show when={p.prompt.kind === 'invite' && queue()}>{(q) => <small>{q()}</small>}</Show>
        </div>
      </div>
      <div class="league-prompt-actions">
        <button class="btn" onClick={done}>
          {p.prompt.kind === 'join' ? t('Ignore') : t('Decline')}
        </button>
        <button
          class="btn primary"
          disabled={busy() || (p.prompt.kind === 'invite' && !leagueMe())}
          data-tip={p.prompt.kind === 'invite' && !leagueMe() ? t('Open League of Legends to join') : undefined}
          onClick={() => void accept()}
        >
          {p.prompt.kind === 'join' ? t('Invite') : t('Join')}
        </button>
      </div>
    </div>
  );
}

/** A "join my lobby" message (type 8, sent with the composer's League button), like Discord's activity invite: the
 *  lobby as it is now (the host's live activity; the one in the message once they've left it) and Join, which asks
 *  their app to invite you, approved by the message itself. */
export function LobbyInviteCard(p: { message: Message }) {
  const host = () => p.message.author.id;
  const mine = () => host() === state.me?.id;
  const sent = () => (p.message.embeds[0] as unknown as { league?: LeagueActivity } | undefined)?.league;
  const game = () => gameOf(host());
  // Still in a lobby: the live one. Gone into queue/game or closed: the invite is over.
  const live = () => (game()?.league?.phase === 'lobby' ? game()!.league : undefined);
  const lobby = () => live() ?? sent();
  const party = () => (lobby()?.party && lobby()!.party!.max > 1 ? lobby()!.party : undefined);
  const full = () => !!party() && party()!.size >= party()!.max;
  const queue = () => {
    const l = lobby();
    return l ? queueName(l.queue_id, l.queue, l.mode) : undefined;
  };
  const [asked, setAsked] = createSignal(false);
  const join = async () => {
    if (await askToJoin(host(), p.message.id)) {
      setAsked(true);
      setTimeout(() => setAsked(false), 15_000);
    }
  };
  const state_ = (): { label: string; tip?: string; can: boolean } => {
    if (!live()) return { label: t('Lobby closed'), can: false };
    if (full()) return { label: t('Lobby full'), can: false };
    if (asked()) return { label: t('Invite on its way'), can: false };
    if (!isTauri) return { label: t('Join'), tip: t('Join from the Linkord desktop app'), can: false };
    if (!leagueMe()) return { label: t('Join'), tip: t('Open League of Legends to join'), can: false };
    return { label: t('Join'), can: true };
  };
  return (
    <div class="lobby-invite" classList={{ closed: !live() }}>
      <span class="label">{t('League of Legends · Lobby invite')}</span>
      <div class="lobby-invite-body">
        <GameIcon src={game()?.icon} size={52} />
        <div class="lobby-invite-text">
          <strong>{t("{name}'s lobby", { name: nameOf(host()) })}</strong>
          <span>
            {[queue(), live() ? phaseName('lobby') : t('Not in a lobby anymore')].filter(Boolean).join(' · ')}
          </span>
          <Show when={party()}>
            {(pt) => (
              <span class="league-party" data-tip={t('{size} of {max}', { size: pt().size, max: pt().max })}>
                <For each={Array.from({ length: pt().max }, (_, i) => i < pt().size)}>
                  {(filled) => <i classList={{ filled }} />}
                </For>
                <small>
                  {pt().size}/{pt().max}
                </small>
              </span>
            )}
          </Show>
        </div>
        <Show when={!mine()}>
          <button
            class="btn primary lobby-invite-join"
            disabled={!state_().can}
            data-tip={state_().tip}
            onClick={() => void join()}
          >
            {state_().label}
          </button>
        </Show>
      </div>
    </div>
  );
}
