// User settings: a full-window screen (like Discord's) with a sidebar of pages. Server settings stay
import { Slider } from './ui/slider';
import { Nameplate } from './Nameplate';
// a dialog in SettingsModals.tsx.
import {
  createEffect,
  createResource,
  createSignal,
  For,
  Index,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
  on,
  type JSX,
} from 'solid-js';
import { api, apiBlob, media } from '../lib/api';
import { describeDevice } from '../lib/device';
import { logout, logoutEverywhere } from '../lib/actions';
import { autostartEnabled, checkForUpdates, setAutostart, update, updating } from '../lib/desktop';
import { normalizePath } from '../lib/game-match';
import {
  currentGame,
  detectableName,
  gameDetectionAvailable,
  gameFor,
  refreshGames,
  runningApps,
  scanApps,
} from '../lib/games';
import { nativeKeybinds, setRecording } from '../lib/keybinds';
import {
  ACTIONS,
  comboParts,
  keyFromEvent,
  keyFromMouse,
  modifierOf,
  modsFromEvent,
  modsLabel,
  sameCombo,
  type Combo,
  type KeyAction,
  type Keybind,
} from '../lib/keys';
import { dateLocale, LANGUAGES, msg, plural, systemLang, t, type LangPref } from '../lib/i18n';
import { isTauri, notify, openExternal } from '../lib/platform';
import { disablePush, enablePush, pushState, TEST_DELAY, testPush } from '../lib/push';
import { openPage } from '../lib/route';
import { getMic } from '../lib/media-devices';
import { prefs, setPrefs, type SoundKind } from '../lib/prefs';
import { sounds } from '../lib/sounds';
import { state } from '../lib/store';
import { attempt, isMobile, setUi, toast } from '../lib/ui';
import { openCamera, restartMic, setOutputDevice, syncVad, toggleDeafen, toggleMute, voiceUi } from '../lib/voice';
import { clearDictionary, SPELL_LANGUAGES, spellLanguage } from '../lib/spellcheck';
import { systemTheme } from '../lib/theme';
import { celebrate, nextHoliday } from '../lib/holidays';
import { flySanta } from '../lib/santa';
import { musicTitle, nextSong } from '../lib/christmas-music';
import { FavoriteGamesSettings } from './FavoriteGames';
import { GameIcon, SpotifyIcon } from './Activity';
import { Avatar } from './Avatar';
import { ColorPicker } from './ColorPicker';
import { ImageEditor, type ImageKind } from './ImageEditor';
import { ImageSlot, InfoTip } from './ImageSlot';
import { UsernameEditor } from './Username';
import * as I from './Icons';
import { accentCss } from './Profile';
import { StatsPage } from './StatsPage';
import { KassPage } from './KassPage';
import { StevePage } from './StevePage';
import { showChristmas, showRelease, startTour } from './Onboarding';
import { parseBirthday } from './Birthday';
import { brandOf } from '../lib/brand-icons';
import { linkHost, type ProfileLink, type ProfileSong, SongPlayer } from './ProfileWidgets';
import { type Draft, SoundEditor } from './Soundboard';

type Page =
  | 'account'
  | 'sessions'
  | 'profile'
  | 'stats'
  | 'kass'
  | 'steve'
  | 'connections'
  | 'voice'
  | 'keybinds'
  | 'games'
  | 'notifications'
  | 'language'
  | 'appearance'
  | 'favorite-games'
  | 'app';

interface Connection {
  type: 'discord' | 'spotify';
  id: string;
  username: string | null;
  linked_at: string;
  show_on_profile?: boolean;
  show_activity?: boolean;
  revoked?: boolean;
}

/**
 * Connections (Spotify) is on hold (owner, 2026-10-31): its page and the server side stay, the tab is hidden.
 * Flip this to bring it back.
 */
const SHOW_CONNECTIONS = false;

const NAV: { group: string; pages: [Page, string, (p: { size?: number }) => JSX.Element][] }[] = [
  {
    group: msg('User settings'),
    pages: [
      ['account', msg('My Account'), I.Account],
      ['profile', msg('Profile'), I.EditProfile],
      ['favorite-games', msg('Favorite Games'), I.Gamepad],
      ['stats', msg('Stats'), I.Chart],
      ['sessions', msg('Sessions'), I.Desktop],
      ['kass', msg('Kass'), I.Music],
      ['steve', msg('Steve'), I.Gamepad],
      ...(SHOW_CONNECTIONS
        ? [['connections', msg('Connections'), I.Link] as [Page, string, (p: { size?: number }) => JSX.Element]]
        : []),
    ],
  },
  {
    group: msg('App settings'),
    pages: [
      ['voice', msg('Voice & Video'), I.Mic],
      ['keybinds', msg('Keybinds'), I.Keyboard],
      ...(gameDetectionAvailable
        ? [['games', msg('Registered Games'), I.Gamepad] as [Page, string, (p: { size?: number }) => JSX.Element]]
        : []),
      ['notifications', msg('Notifications'), I.Bell],
      ['appearance', msg('Appearance'), I.Appearance],
      ['language', msg('Language'), I.Language],
      ...(isTauri
        ? [['app', msg('Desktop App'), I.AppIcon] as [Page, string, (p: { size?: number }) => JSX.Element]]
        : []),
    ],
  },
];

const TITLES: Record<Page, string> = {
  account: msg('My Account'),
  sessions: msg('Sessions'),
  profile: msg('Profile'),
  stats: msg('Stats'),
  kass: msg('Kass'),
  steve: msg('Steve'),
  connections: msg('Connections'),
  voice: msg('Voice & Video'),
  keybinds: msg('Keybinds'),
  games: msg('Registered Games'),
  notifications: msg('Notifications'),
  language: msg('Language'),
  appearance: msg('Appearance'),
  'favorite-games': msg('Favorite Games'),
  app: msg('Desktop App'),
};

export function Settings(p: { tab?: string }) {
  const legacy: Record<string, Page> = {
    connections: SHOW_CONNECTIONS ? 'connections' : 'account',
    profile: 'profile',
    sessions: 'sessions',
    stats: 'stats',
    kass: 'kass',
    steve: 'steve',
    voice: 'voice',
    keybinds: 'keybinds',
    notifications: 'notifications',
    language: 'language',
    appearance: 'appearance',
    'favorite-games': 'favorite-games',
    app: 'app',
  };
  const [page, setPage] = createSignal<Page>(legacy[p.tab ?? ''] ?? 'account');
  // Phones show the page list first, then one page at a time.
  const [navOpen, setNavOpen] = createSignal(isMobile() && !p.tab);
  const open = (id: Page) => {
    setPage(id);
    setNavOpen(false);
  };
  const [connections, { refetch: refetchConnections }] = createResource(
    () => state.connectionsVersion + 1,
    () => api<Connection[]>('GET', '/users/@me/connections').catch(() => [] as Connection[]),
  );
  const discord = () => connections()?.find((c) => c.type === 'discord');
  const close = () => setUi('modal', null);
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented && close();
  onMount(() => window.addEventListener('keydown', onKey));
  onCleanup(() => window.removeEventListener('keydown', onKey));

  return (
    <div class="settings-screen" classList={{ 'nav-open': navOpen() }} role="dialog" aria-label={t('Settings')}>
      <aside class="settings-side">
        <nav class="settings-nav">
          <For each={NAV}>
            {(g) => (
              <>
                <div class="settings-group">{t(g.group)}</div>
                <For each={g.pages}>
                  {([id, label, Icon]) => (
                    <button classList={{ active: page() === id && !navOpen() }} onClick={() => open(id)}>
                      <Icon size={18} />
                      {t(label)}
                    </button>
                  )}
                </For>
              </>
            )}
          </For>
        </nav>
        <div class="settings-foot">
          <button class="settings-logout" onClick={() => void logout()}>
            <I.Logout size={17} /> {t('Log Out')}
          </button>
          {/* One link per line: side by side they wrapped mid-row in this narrow column. */}
          <nav class="settings-links">
            <button onClick={() => (close(), openPage('changelog'))}>{t('Patch notes')}</button>
            <button onClick={() => (close(), showRelease())}>{t("What's new in 1.0")}</button>
            <button onClick={() => (close(), showChristmas())}>{t('Christmas greeting')}</button>
            <button onClick={() => (close(), startTour())}>{t('Take the tour')}</button>
          </nav>
          <div class="settings-version">
            Linkord {__APP_VERSION__} · {isTauri ? (nativeKeybinds ? 'Windows' : t('Desktop')) : 'Web'}
          </div>
          <div class="settings-version">
            {t('Emoji by')}{' '}
            <a href="https://github.com/jdecked/twemoji" target="_blank" rel="noreferrer">
              Twemoji
            </a>{' '}
            (CC-BY 4.0)
          </div>
        </div>
      </aside>
      <main class="settings-main">
        <div class="settings-content">
          <h1>
            <button class="icon-btn settings-back" aria-label={t('All settings')} onClick={() => setNavOpen(true)}>
              <I.Back size={22} />
            </button>
            {t(TITLES[page()])}
          </h1>
          <Switch>
            <Match when={page() === 'account'}>
              <AccountPage discord={discord()} loading={connections.loading} onEditProfile={() => open('profile')} />
            </Match>
            <Match when={page() === 'profile'}>
              <ProfilePage />
            </Match>
            <Match when={page() === 'stats'}>
              <StatsPage />
            </Match>
            <Match when={page() === 'kass'}>
              <KassPage />
            </Match>
            <Match when={page() === 'steve'}>
              <StevePage />
            </Match>
            <Match when={page() === 'connections'}>
              <ConnectionsPage
                connections={connections() ?? []}
                loading={connections.loading}
                refetch={refetchConnections}
              />
            </Match>
            <Match when={page() === 'voice'}>
              <VoicePage onKeybinds={() => open('keybinds')} />
            </Match>
            <Match when={page() === 'keybinds'}>
              <KeybindsPage />
            </Match>
            <Match when={page() === 'notifications'}>
              <NotificationsPage />
            </Match>
            <Match when={page() === 'games'}>
              <GamesPage />
            </Match>
            <Match when={page() === 'appearance'}>
              <AppearancePage />
            </Match>
            <Match when={page() === 'favorite-games'}>
              <FavoriteGamesSettings />
            </Match>
            <Match when={page() === 'language'}>
              <LanguagePage />
            </Match>
            <Match when={page() === 'sessions'}>
              <SessionsPage />
            </Match>
            <Match when={page() === 'app'}>
              <AppPage />
            </Match>
          </Switch>
        </div>
      </main>
      <button class="settings-close" onClick={close} aria-label={t('Close settings')}>
        <span>
          <I.Close size={18} />
        </span>
        ESC
      </button>
    </div>
  );
}

// ---------- connections ----------

/** Discord's Connections page: link Spotify to show what you're listening to. */
function ConnectionsPage(p: { connections: Connection[]; loading: boolean; refetch: () => void }) {
  const [config] = createResource(() =>
    api<{ spotify?: boolean }>('GET', '/auth/config').catch(() => ({ spotify: false })),
  );
  const spotify = () => p.connections.find((c) => c.type === 'spotify');
  const [waiting, setWaiting] = createSignal(false);
  const connect = async () => {
    // Browsers only allow pop-ups opened right in the click, so open it first and point it at Spotify after.
    const popup = isTauri ? null : window.open('', '_blank');
    try {
      const { url } = await api<{ url: string }>('GET', '/connections/spotify/authorize');
      if (isTauri) await openExternal(url);
      else if (popup) popup.location.href = url;
      else location.href = url;
      setWaiting(true);
    } catch (e) {
      popup?.close();
      toast(e instanceof Error ? e.message : String(e));
    }
  };
  createEffect(() => spotify() && setWaiting(false));
  const patch = (body: Partial<Connection>) =>
    attempt(async () => (await api('PATCH', '/users/@me/connections/spotify', body), p.refetch()));
  return (
    <>
      <Section
        title={t('Add accounts to your profile')}
        description={t('Linked accounts can show on your profile and as your status, like what you are listening to.')}
      >
        <div class="conn-services">
          <button
            class="conn-service"
            aria-label={t('Connect Spotify')}
            data-tip={config()?.spotify ? t('Connect Spotify') : t('Spotify is not set up on this server')}
            disabled={!config()?.spotify || !!spotify()}
            onClick={() => void connect()}
          >
            <SpotifyIcon size={34} />
          </button>
        </div>
        <Show when={waiting() && !spotify()}>
          <p class="muted small">{t('Finish connecting in the Spotify page that opened, then come back here.')}</p>
        </Show>
      </Section>
      <Show when={spotify()}>
        {(c) => (
          <div class="set-card conn-account">
            <div class="conn-account-head">
              <SpotifyIcon size={30} />
              <div class="grow">
                <strong>{c().username}</strong>
                <div class="muted small">Spotify</div>
              </div>
              <button
                class="icon-btn"
                aria-label={t('Disconnect Spotify')}
                data-tip={t('Disconnect')}
                onClick={() =>
                  void attempt(
                    async () => (await api('DELETE', '/users/@me/connections/spotify'), p.refetch()),
                    t('Spotify disconnected'),
                  )
                }
              >
                <I.Close size={18} />
              </button>
            </div>
            <Show when={c().revoked}>
              <div class="notice row">
                <span class="grow">
                  {t('Linkord lost access to this Spotify account. Reconnect to show what you are listening to.')}
                </span>
                <button class="btn small-btn" onClick={() => void connect()}>
                  {t('Reconnect')}
                </button>
              </div>
            </Show>
            <SwitchRow
              label={t('Display on profile')}
              checked={!!c().show_on_profile}
              onChange={(v) => void patch({ show_on_profile: v })}
            />
            <SwitchRow
              label={t('Display Spotify as your status')}
              hint={t('Shows the song you are playing on your profile and under your name while you are online.')}
              checked={!!c().show_activity}
              onChange={(v) => void patch({ show_activity: v })}
            />
          </div>
        )}
      </Show>
    </>
  );
}

// ---------- building blocks ----------

function Section(p: { title: string; description?: string; children: JSX.Element }) {
  return (
    <section class="set-section">
      <h2>{p.title}</h2>
      <Show when={p.description}>
        <p class="set-desc">{p.description}</p>
      </Show>
      {p.children}
    </section>
  );
}

function SwitchRow(p: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  extra?: JSX.Element;
}) {
  return (
    <label class="set-row" classList={{ disabled: p.disabled }}>
      <span class="set-row-text">
        <strong>{p.label}</strong>
        <Show when={p.hint}>
          <small>{p.hint}</small>
        </Show>
      </span>
      {p.extra}
      <input
        type="checkbox"
        class="switch"
        checked={p.checked}
        disabled={p.disabled}
        onChange={(e) => p.onChange(e.currentTarget.checked)}
      />
    </label>
  );
}

function Seg<T extends string>(p: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div class="seg set-seg">
      <For each={p.options}>
        {([v, label]) => (
          <button type="button" classList={{ active: p.value === v }} onClick={() => p.onChange(v)}>
            {label}
          </button>
        )}
      </For>
    </div>
  );
}

function Keys(p: { combo: Combo | null | undefined }) {
  return (
    <Show when={p.combo} fallback={<span class="muted">{t('Not set')}</span>}>
      {(c) => (
        <span class="kbd-combo">
          <For each={comboParts(c())}>{(k) => <kbd>{t(k)}</kbd>}</For>
        </span>
      )}
    </Show>
  );
}

// ---------- My Account ----------

function AccountPage(p: { discord?: Connection; loading: boolean; onEditProfile: () => void }) {
  const me = () => state.users[state.me!.id] ?? state.me!;
  const owned = () => Object.values(state.guilds).filter((g) => g.owner_id === me().id);
  const [confirming, setConfirming] = createSignal(false);
  const [typed, setTyped] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const remove = async () => {
    setBusy(true);
    setError('');
    try {
      await api('DELETE', '/users/@me', { confirm: typed().trim() });
      toast(t('Your account was deleted'));
      setTimeout(() => void logout(), 800);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <>
      <div class="account-card">
        <div class="account-banner" style={{ 'background-color': accentCss(me().accent_color) ?? '#2b2d31' }}>
          <Show when={media(me().banner)}>{(src) => <img src={src()} alt="" />}</Show>
        </div>
        <div class="account-head">
          <div class="account-avatar">
            <Avatar user={me()} size={80} />
          </div>
          <div class="account-names">
            <strong>{me().display_name || me().username}</strong>
            <span>@{me().username}</span>
          </div>
          <button class="btn primary" onClick={p.onEditProfile}>
            {t('Edit profile')}
          </button>
        </div>
        <dl class="account-facts">
          <div>
            <dt>{t('Display name')}</dt>
            <dd>{me().display_name || <span class="muted">{t('Not set — people see your username')}</span>}</dd>
          </div>
          <div>
            <dt>{t('Username')}</dt>
            <dd>
              <UsernameEditor />
            </dd>
          </div>
        </dl>
      </div>

      <Section
        title={t('Connections')}
        description={t('Discord is how you sign in. Your Linkord profile started as a copy of your Discord profile.')}
      >
        <Show
          when={p.discord}
          fallback={
            <div class="set-card muted small">
              {p.loading ? t('Loading…') : t('No Discord account linked (this is a test login).')}
            </div>
          }
        >
          {(d) => (
            <div class="set-card conn-card">
              <span class="conn-icon big">
                <I.Connection size={22} />
              </span>
              <div class="grow">
                <strong>Discord</strong>
                <div class="muted small">
                  @{d().username ?? t('unknown')} ·{' '}
                  {t('linked {date}', {
                    date: new Date(d().linked_at).toLocaleDateString(dateLocale(), {
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                    }),
                  })}
                </div>
              </div>
              <span class="tag ok">
                <I.Check size={13} /> {t('Connected')}
              </span>
              <button
                class="icon-btn"
                data-tip={t('Copy Discord ID')}
                aria-label={t('Copy Discord ID')}
                onClick={() => navigator.clipboard.writeText(d().id).then(() => toast(t('Discord ID copied')))}
              >
                <I.Copy size={16} />
              </button>
            </div>
          )}
        </Show>
      </Section>

      <Section title={t('Delete account')}>
        <div class="set-card danger-card">
          <div class="danger-row">
            <span class="danger-icon">
              <I.Warning size={20} />
            </span>
            <div class="grow">
              <strong>{t('Delete your Linkord account')}</strong>
              <p class="muted small">
                {t(
                  'You leave every server, group and friendship, your profile is wiped and your Discord account is unlinked. Messages you sent stay, shown as "Deleted User". This can\'t be undone — signing in with Discord again creates a brand-new account.',
                )}
              </p>
            </div>
            <Show when={!confirming()}>
              <button class="btn danger" onClick={() => setConfirming(true)}>
                {t('Delete account')}
              </button>
            </Show>
          </div>
          <Show when={confirming()}>
            <div class="danger-confirm">
              <Show when={owned().length}>
                <p class="notice">
                  {plural(owned().length, 'You own a server:', 'You own {n} servers:')}{' '}
                  <strong>
                    {owned()
                      .map((g) => g.name)
                      .join(', ')}
                  </strong>
                  .{' '}
                  {plural(
                    owned().length,
                    'Delete it from the server settings first.',
                    'Delete them from the server settings first.',
                  )}
                </p>
              </Show>
              <label class="field">
                <span>{t('Type your username ({username}) to confirm', { username: me().username })}</span>
                <input
                  value={typed()}
                  onInput={(e) => setTyped(e.currentTarget.value)}
                  autocomplete="off"
                  spellcheck={false}
                />
              </label>
              <Show when={error()}>
                <p class="error">{error()}</p>
              </Show>
              <div class="row">
                <button class="btn" onClick={() => (setConfirming(false), setTyped(''), setError(''))}>
                  {t('Cancel')}
                </button>
                <button
                  class="btn danger"
                  disabled={busy() || typed().trim() !== me().username || owned().length > 0}
                  onClick={() => void remove()}
                >
                  {busy() ? t('Deleting…') : t('Delete my account forever')}
                </button>
              </div>
            </div>
          </Show>
        </div>
      </Section>
    </>
  );
}

// ---------- Profile ----------

const IMAGE_TYPES = 'image/png,image/jpeg,image/gif,image/webp';

function ProfilePage() {
  const me = () => state.users[state.me!.id] ?? state.me!;
  // Links, the profile song and the widget switches come with the full profile.
  const [mine, { mutate: setMine }] = createResource(
    () => state.me!.id,
    (id) =>
      api<{ links?: ProfileLink[]; song?: ProfileSong | null; show_stats?: boolean; show_top_songs?: boolean }>(
        'GET',
        `/users/${id}/profile`,
      ).catch(() => null),
  );
  const saved = () => ({
    name: me().display_name ?? '',
    bio: me().bio,
    pronouns: me().pronouns ?? '',
    accent: accentCss(me().accent_color) ?? '#2b2d31',
    birthday: me().birthday ?? '',
    links: JSON.stringify(mine()?.links ?? []),
  });
  const [name, setName] = createSignal(saved().name);
  const [bio, setBio] = createSignal(saved().bio);
  const [pronouns, setPronouns] = createSignal(saved().pronouns);
  const [accent, setAccent] = createSignal(saved().accent);
  const [birthday, setBirthday] = createSignal(saved().birthday);
  const [links, setLinks] = createSignal<ProfileLink[]>([]);
  createEffect(
    on(
      () => mine()?.links,
      (l) => l && setLinks(l.map((x) => ({ ...x }))),
    ),
  );
  const linksDirty = () => JSON.stringify(links().filter((l) => l.url.trim() || l.label.trim())) !== saved().links;
  const [saving, setSaving] = createSignal(false);
  const dirty = () =>
    name() !== saved().name ||
    bio() !== saved().bio ||
    pronouns() !== saved().pronouns ||
    accent() !== saved().accent ||
    birthday() !== saved().birthday ||
    (!!mine() && linksDirty());
  const reset = () => {
    setName(saved().name);
    setBio(saved().bio);
    setPronouns(saved().pronouns);
    setAccent(saved().accent);
    setBirthday(saved().birthday);
    setLinks((mine()?.links ?? []).map((x) => ({ ...x })));
  };
  const [editing, setEditing] = createSignal<{ kind: ImageKind; file: File } | null>(null);
  const pick = (kind: ImageKind, input: HTMLInputElement) => {
    const file = input.files?.[0];
    input.value = ''; // so picking the same file again still fires
    if (file) setEditing({ kind, file });
  };
  const [recent, { mutate: setRecent }] = createResource(
    () => me().avatar ?? '',
    // The server keeps the last 5; slice too in case an older server sends more.
    () =>
      api<string[]>('GET', '/users/@me/avatars')
        .then((l) => l.slice(0, 5))
        .catch(() => []),
  );
  const forget = (url: string) =>
    attempt(async () => {
      await api('DELETE', '/users/@me/avatars', { url });
      setRecent((l) => (l ?? []).filter((x) => x !== url));
    }, t('Picture removed'));
  const [plates] = createResource(() => api<string[]>('GET', '/nameplates').catch(() => []));
  const setPlate = (url: string) => attempt(() => api('PUT', '/users/@me/nameplate', { url }), t('Nameplate updated'));
  const restore = (url: string) => attempt(() => api('PUT', '/users/@me/avatar', { url }), t('Avatar updated'));
  const removeImage = (which: 'avatar' | 'banner') =>
    attempt(() => api('DELETE', `/users/@me/${which}`), t(which === 'avatar' ? 'Avatar removed' : 'Banner removed'));
  const save = async () => {
    setSaving(true);
    const kept = links().filter((l) => l.url.trim() || l.label.trim());
    await attempt(async () => {
      await api('PATCH', '/users/@me', {
        display_name: name(),
        bio: bio(),
        pronouns: pronouns().trim(),
        accent_color: parseInt(accent().slice(1), 16),
        birthday: birthday(),
        ...(mine() && linksDirty() ? { links: kept } : {}),
      });
      if (mine() && linksDirty()) {
        // The server tidies them (https:// added...): show what it kept.
        const fresh = await api<{ links?: ProfileLink[] }>('GET', `/users/${state.me!.id}/profile`);
        setMine((m) => (m ? { ...m, links: fresh.links ?? [] } : m));
        setLinks((fresh.links ?? []).map((x) => ({ ...x })));
      }
    }, t('Profile saved'));
    setSaving(false);
  };
  const setWidget = (key: 'show_stats' | 'show_top_songs', on: boolean) =>
    attempt(async () => {
      await api('PATCH', '/users/@me', { [key]: on });
      setMine((m) => (m ? { ...m, [key]: on } : m));
    });
  const preview = () => ({ ...me(), display_name: name() || null, bio: bio() });

  /** The bio box grows with its text instead of scrolling. */
  const fit = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };

  return (
    <div class="profile-studio">
      {/* The profile as others see it, edited in place: banner, picture, name and about me are all clickable. */}
      <div class="studio-card">
        <div class="edit-banner-wrap">
          <label class="edit-banner" style={{ 'background-color': accent() }}>
            <Show when={media(me().banner)}>{(src) => <img src={src()} alt="" />}</Show>
            <span class="edit-overlay">
              <I.AddImage size={20} /> {me().banner ? t('Change banner') : t('Add banner')}
            </span>
            <input type="file" accept={IMAGE_TYPES} hidden onChange={(e) => pick('banner', e.currentTarget)} />
          </label>
          <Show when={me().banner}>
            <button
              class="edit-remove"
              aria-label={t('Remove banner')}
              data-tip={t('Remove banner')}
              onClick={() => void removeImage('banner')}
            >
              <I.Close size={14} />
            </button>
          </Show>
        </div>
        <div class="profile-avatar edit-avatar-wrap studio-avatar">
          <label class="edit-avatar">
            <Avatar user={me()} size={104} />
            <span class="edit-overlay round">
              <I.Photo size={20} />
              <small>{t('Change')}</small>
            </span>
            <input type="file" accept={IMAGE_TYPES} hidden onChange={(e) => pick('avatar', e.currentTarget)} />
          </label>
          <Show when={me().avatar}>
            <button
              class="edit-remove"
              aria-label={t('Remove picture')}
              data-tip={t('Remove picture')}
              onClick={() => void removeImage('avatar')}
            >
              <I.Close size={14} />
            </button>
          </Show>
        </div>
        <div class="studio-body">
          <label class="inline-field">
            <span class="sr-only">{t('Display name')}</span>
            <input
              class="inline-edit inline-name"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              placeholder={me().username}
              maxLength={32}
              spellcheck={false}
            />
            <I.Edit size={15} class="inline-pen" />
          </label>
          <div class="profile-username">{me().username}</div>
          <label class="inline-field pronouns-field">
            <span class="sr-only">{t('Pronouns')}</span>
            <input
              class="inline-edit inline-pronouns"
              value={pronouns()}
              onInput={(e) => setPronouns(e.currentTarget.value)}
              placeholder={t('Add your pronouns')}
              maxLength={40}
              spellcheck={false}
            />
            <I.Edit size={13} class="inline-pen" />
          </label>
          <div class="studio-section">
            <div class="label">
              {t('About me')} <em class="counter">{bio().length}/190</em>
            </div>
            <label class="inline-field">
              <span class="sr-only">{t('About me')}</span>
              <textarea
                class="inline-edit inline-bio"
                ref={(el) => queueMicrotask(() => fit(el))}
                value={bio()}
                onInput={(e) => {
                  setBio(e.currentTarget.value);
                  fit(e.currentTarget);
                }}
                maxLength={190}
                rows={1}
                placeholder={t('Click to say a little about yourself')}
              />
              <I.Edit size={15} class="inline-pen" />
            </label>
          </div>
        </div>
      </div>
      <small class="muted edit-hint">
        {t(
          'Click your banner, picture, name or about me to change them. Leave the name empty to show your username. Pictures: PNG, JPG, GIF or WebP; GIFs stay animated.',
        )}
      </small>

      <div class="studio-options">
        <div class="set-card studio-option" classList={{ wide: (recent() ?? []).length <= 1 }}>
          <div class="field-label">
            {t('Banner colour')} <InfoTip text={t('Shown behind your profile when you have no banner image.')} />
          </div>
          <ColorPicker value={accent()} onChange={setAccent} label={t('Banner colour')} />
        </div>
        <Show when={(recent() ?? []).length > 1}>
          <div class="set-card studio-option">
            <div class="field-label">{t('Recent pictures')}</div>
            <div class="avatar-history" aria-label={t('Recent pictures')}>
              <For each={recent()}>
                {(url) => (
                  <div class="avatar-history-slot">
                    <button
                      class="avatar-history-item"
                      classList={{ current: url === me().avatar }}
                      title={t('Use this picture')}
                      aria-label={t('Use this picture')}
                      disabled={url === me().avatar}
                      onClick={() => void restore(url)}
                    >
                      <img src={media(url)} alt="" loading="lazy" />
                    </button>
                    <Show when={url !== me().avatar}>
                      <button
                        class="avatar-history-remove"
                        aria-label={t('Remove from recent pictures')}
                        data-tip={t('Remove from recent pictures')}
                        onClick={() => void forget(url)}
                      >
                        <I.Close size={10} />
                      </button>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>

      <div class="studio-options">
        <div class="set-card studio-option">
          <div class="field-label">
            {t('Birthday')}{' '}
            <InfoTip text={t('People see a cake next to your name on the day. The year is optional.')} />
          </div>
          <BirthdayPicker value={birthday()} onChange={setBirthday} />
        </div>
        <div class="set-card studio-option">
          <div class="field-label">
            {t('Profile widgets')} <InfoTip text={t('Cards next to your full profile.')} />
          </div>
          <div class="widget-switches">
            <SwitchRow
              label={t('Show my stats')}
              hint={t('Time in voice, messages, longest call... (Settings → Stats)')}
              checked={!!mine()?.show_stats}
              disabled={!mine()}
              onChange={(v) => void setWidget('show_stats', v)}
            />
            <SwitchRow
              label={t('Show my top Kass songs')}
              hint={t('The songs you play most with /play.')}
              checked={mine()?.show_top_songs ?? true}
              disabled={!mine()}
              onChange={(v) => void setWidget('show_top_songs', v)}
            />
          </div>
        </div>
        <div class="set-card studio-option wide">
          <div class="field-label">
            {t('Links')} <em class="counter">{links().length}/5</em>
          </div>
          <LinksEditor links={links()} onChange={setLinks} />
        </div>
        <div class="set-card studio-option wide">
          <div class="field-label">
            {t('Profile song')}{' '}
            <InfoTip
              text={t(
                'Up to 30 seconds people can play from your full profile. It plays quietly, and only when they press play (unless they turned on autoplay).',
              )}
            />
          </div>
          <ProfileSongEditor
            song={mine()?.song ?? null}
            onChange={(song) => setMine((m) => (m ? { ...m, song } : m))}
          />
          <SwitchRow
            label={t("Play people's profile songs by themselves")}
            hint={t('When you open a full profile. Off: they wait for you to press play.')}
            checked={prefs.profileSongAutoplay}
            onChange={(v) => setPrefs({ profileSongAutoplay: v })}
          />
        </div>
        <div class="set-card studio-option wide">
          <ImageSlot
            label={t('Nameplate')}
            info={t('Shown behind your name in the member list, faded on the right side.')}
            has={!!me().nameplate}
            accept={`${IMAGE_TYPES},video/webm`}
            onPick={(i) => pick('nameplate', i)}
            onRemove={() => void attempt(() => api('DELETE', '/users/@me/nameplate'), t('Nameplate removed'))}
          >
            <div class="nameplate-picker">
              <div class="member" style={{ background: 'var(--bg-1)', 'pointer-events': 'none' }}>
                <Show when={media(me().nameplate)}>{(src) => <Nameplate src={src()} />}</Show>
                <Avatar user={me()} size={32} />
                <span class="member-name">{preview().display_name || me().username}</span>
              </div>
              <div class="nameplate-options">
                <For each={plates()}>
                  {(url) => (
                    <button
                      class="nameplate-option"
                      classList={{ current: url === me().nameplate }}
                      aria-label={t('Use this nameplate')}
                      title={t('Use this nameplate')}
                      disabled={url === me().nameplate}
                      onClick={() => void setPlate(url)}
                    >
                      <Nameplate src={media(url)!} lazy />
                    </button>
                  )}
                </For>
              </div>
            </div>
          </ImageSlot>
        </div>
      </div>

      <Show when={editing()}>
        {(e) => <ImageEditor kind={e().kind} file={e().file} user={me()} onClose={() => setEditing(null)} />}
      </Show>
      <Show when={dirty()}>
        <div class="save-bar">
          <span>{t('You have unsaved changes.')}</span>
          <button class="link-btn" onClick={reset}>
            {t('Reset')}
          </button>
          <button class="btn primary" disabled={saving()} onClick={() => void save()}>
            {saving() ? t('Saving…') : t('Save changes')}
          </button>
        </div>
      </Show>
    </div>
  );
}

// ---------- birthday, links, profile song ----------

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Month and day, and the year if you want people to see it. Value: 'MM-DD', 'YYYY-MM-DD' or ''. */
function BirthdayPicker(p: { value: string; onChange: (v: string) => void }) {
  const b = () => parseBirthday(p.value);
  const months = () =>
    Array.from({ length: 12 }, (_, i) => new Date(2000, i, 1).toLocaleDateString(dateLocale(), { month: 'long' }));
  const daysIn = (m: number) => (m ? new Date(2000, m, 0).getDate() : 31);
  // Only whole dates go out (or none at all): half-picked ones stay here until the day is picked too.
  const emit = (month: number, day: number, year?: number) => {
    if (!month && !day) return p.onChange('');
    if (!month || !day) return;
    const d = Math.min(day, daysIn(month));
    p.onChange(year ? `${year}-${pad2(month)}-${pad2(d)}` : `${pad2(month)}-${pad2(d)}`);
  };
  // Month first, so the day list fits it.
  const [month, setMonth] = createSignal(b()?.month ?? 0);
  const [day, setDay] = createSignal(b()?.day ?? 0);
  const [year, setYear] = createSignal(b()?.year ? String(b()!.year) : '');
  createEffect(
    on(
      () => p.value,
      () => {
        setMonth(b()?.month ?? 0);
        setDay(b()?.day ?? 0);
        setYear(b()?.year ? String(b()!.year) : '');
      },
    ),
  );
  const validYear = () => {
    const y = parseInt(year(), 10);
    return y >= 1900 && y <= new Date().getFullYear() ? y : undefined;
  };
  return (
    <div class="birthday-picker">
      <select
        aria-label={t('Month')}
        value={month()}
        onChange={(e) => {
          setMonth(+e.currentTarget.value);
          emit(+e.currentTarget.value, day(), validYear());
        }}
      >
        <option value={0}>{t('Month')}</option>
        <For each={months()}>{(m, i) => <option value={i() + 1}>{m}</option>}</For>
      </select>
      <select
        aria-label={t('Day')}
        value={day()}
        onChange={(e) => {
          setDay(+e.currentTarget.value);
          emit(month(), +e.currentTarget.value, validYear());
        }}
      >
        <option value={0}>{t('Day')}</option>
        <For each={Array.from({ length: daysIn(month()) }, (_, i) => i + 1)}>
          {(d) => <option value={d}>{d}</option>}
        </For>
      </select>
      <input
        class="birthday-year"
        inputMode="numeric"
        maxLength={4}
        placeholder={t('Year (optional)')}
        aria-label={t('Year (optional)')}
        value={year()}
        onInput={(e) => {
          setYear(e.currentTarget.value.replace(/\D/g, ''));
          if (!year() || validYear()) emit(month(), day(), validYear());
        }}
      />
      <Show when={p.value}>
        <button class="link-btn" onClick={() => p.onChange('')}>
          {t('Remove')}
        </button>
      </Show>
    </div>
  );
}

/** Up to 5 links: a name (optional: the site's name shows instead) and the address. */
/** Rows by position (Index, not For): each keystroke makes a new link object, and For would rebuild its row. */
function LinksEditor(p: { links: ProfileLink[]; onChange: (l: ProfileLink[]) => void }) {
  const set = (i: number, patch: Partial<ProfileLink>) =>
    p.onChange(p.links.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <div class="links-editor">
      <Index each={p.links} fallback={<p class="muted small">{t('Your website, Steam, Twitch, a playlist...')}</p>}>
        {(l, i) => (
          <div class="link-row">
            {/* The site's icon as soon as the address is recognised. */}
            <I.SiteIcon url={l().url} size={18} class="link-site" />
            <input
              class="link-label"
              value={l().label}
              maxLength={32}
              placeholder={
                l().url
                  ? (brandOf(l().url)?.name ?? linkHost(l().url.includes('://') ? l().url : `https://${l().url}`))
                  : t('Name')
              }
              aria-label={t('Name')}
              onInput={(e) => set(i, { label: e.currentTarget.value })}
            />
            <input
              class="link-url"
              value={l().url}
              maxLength={512}
              placeholder="https://"
              aria-label={t('Address')}
              spellcheck={false}
              onInput={(e) => set(i, { url: e.currentTarget.value })}
            />
            <button
              class="icon-btn"
              aria-label={t('Remove link')}
              data-tip={t('Remove link')}
              onClick={() => p.onChange(p.links.filter((_, j) => j !== i))}
            >
              <I.Close size={14} />
            </button>
          </div>
        )}
      </Index>
      <Show when={p.links.length < 5}>
        <button class="btn small-btn" onClick={() => p.onChange([...p.links, { label: '', url: '' }])}>
          <I.Plus size={14} /> {t('Add link')}
        </button>
      </Show>
    </div>
  );
}

const MAX_SONG_SECONDS = 30;
const MAX_SONG_SOURCE = 15 * 1024 * 1024;

interface SongHit {
  id: string;
  title: string;
  uploader?: string | null;
  duration: number;
  thumbnail: string;
}

const songLength = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s) % 60).padStart(2, '0')}`;

/** Finds a song to use instead of a file. Picking one hands its audio to the same trim editor a file goes to. */
function SongSearch(p: { onPick: (f: File) => void; onClose: () => void }) {
  const [query, setQuery] = createSignal('');
  const [hits, setHits] = createSignal<SongHit[] | null>(null);
  const [searching, setSearching] = createSignal(false);
  const [getting, setGetting] = createSignal<string | null>(null);
  const search = () => {
    const q = query().trim();
    if (q.length < 2 || searching()) return;
    setSearching(true);
    void attempt(async () => {
      try {
        setHits(await api<SongHit[]>('GET', `/users/@me/profile-song/search?q=${encodeURIComponent(q)}`));
      } finally {
        setSearching(false);
      }
    });
  };
  const use = (hit: SongHit) => {
    setGetting(hit.id);
    void attempt(async () => {
      try {
        const audio = await apiBlob('POST', '/users/@me/profile-song/audio', { id: hit.id });
        // The editor offers the file's name as the title.
        p.onPick(
          new File([audio], `${hit.title.replace(/[\\/:*?"<>|]/g, ' ').slice(0, 76)}.mp3`, { type: 'audio/mpeg' }),
        );
      } finally {
        setGetting(null);
      }
    });
  };
  return (
    <div class="song-search">
      <div class="song-search-bar">
        <input
          type="search"
          value={query()}
          maxLength={100}
          placeholder={t('Search for a song')}
          aria-label={t('Search for a song')}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Enter' && search()}
          ref={(el) => queueMicrotask(() => el.focus())}
        />
        <button class="btn small-btn" disabled={searching() || query().trim().length < 2} onClick={search}>
          {searching() ? t('Searching…') : t('Search')}
        </button>
        <button class="icon-btn" aria-label={t('Close')} data-tip={t('Close')} onClick={p.onClose}>
          <I.Close size={16} />
        </button>
      </div>
      <Show when={hits()}>
        {(list) => (
          <div class="song-search-results">
            <For each={list()} fallback={<p class="empty-hint">{t('Nothing found.')}</p>}>
              {(hit) => (
                <div class="song-hit">
                  <img src={hit.thumbnail} alt="" loading="lazy" />
                  <div class="grow">
                    <strong>{hit.title}</strong>
                    <span class="muted small">
                      {[hit.uploader, songLength(hit.duration)].filter(Boolean).join(' · ')}
                    </span>
                  </div>
                  <button class="btn small-btn" disabled={!!getting()} onClick={() => use(hit)}>
                    {getting() === hit.id ? t('Getting it…') : t('Use')}
                  </button>
                </div>
              )}
            </For>
          </div>
        )}
      </Show>
    </div>
  );
}

/** Pick an audio file and the part of it (up to 30 s) your profile plays; later trim it again or remove it. */
function ProfileSongEditor(p: { song: ProfileSong | null; onChange: (s: ProfileSong | null) => void }) {
  const [file, setFile] = createSignal<File | null>(null);
  const [editing, setEditing] = createSignal(false);
  const [searching, setSearching] = createSignal(false);
  let input!: HTMLInputElement;
  const pick = (f?: File) => {
    input.value = '';
    if (!f) return;
    if (f.size > MAX_SONG_SOURCE) return toast(t('Pick a file up to 15 MB; you choose the part that plays next'));
    setEditing(false);
    setSearching(false);
    setFile(f);
  };
  const upload = (f: File, d: Draft) =>
    attempt(async () => {
      const fd = new FormData();
      fd.append(
        'payload_json',
        JSON.stringify({ title: d.name.trim(), volume: d.volume, trim_start: d.start, trim_end: d.end }),
      );
      fd.append('file', f, f.name);
      p.onChange(await api<ProfileSong>('POST', '/users/@me/profile-song', fd));
      setFile(null);
    }, t('Profile song saved'));
  const update = (s: ProfileSong, d: Draft) =>
    attempt(async () => {
      const trimmed = Math.abs(d.start - (s.trim_start ?? 0)) > 0.005 || Math.abs(d.end - (s.trim_end ?? 0)) > 0.005;
      p.onChange(
        await api<ProfileSong>('PATCH', '/users/@me/profile-song', {
          title: d.name.trim(),
          volume: d.volume,
          ...(trimmed ? { trim_start: d.start, trim_end: d.end } : {}),
        }),
      );
      setEditing(false);
    }, t('Profile song saved'));
  const remove = () =>
    attempt(async () => {
      await api('DELETE', '/users/@me/profile-song');
      p.onChange(null);
      setEditing(false);
    }, t('Profile song removed'));
  return (
    <div class="profile-song-editor">
      <input
        ref={input}
        type="file"
        accept="audio/*,.mp3,.ogg,.wav,.webm,.m4a"
        hidden
        onChange={(e) => pick(e.currentTarget.files?.[0])}
      />
      <Show
        when={file()}
        keyed
        fallback={
          <Show
            when={p.song}
            keyed
            fallback={
              <div class="profile-song-choose">
                <button class="btn small-btn" onClick={() => input.click()}>
                  <I.Music size={14} /> {t('Choose a song')}
                </button>
                <button class="btn small-btn" onClick={() => setSearching(true)}>
                  <I.Search size={14} /> {t('Search for a song')}
                </button>
              </div>
            }
          >
            {(s) => (
              <>
                <div class="profile-song-row">
                  <SongPlayer song={s} autoplay={false} />
                  <button
                    class="icon-btn"
                    aria-label={t('Edit')}
                    data-tip={t('Edit')}
                    onClick={() => setEditing(!editing())}
                  >
                    <I.Edit size={16} />
                  </button>
                  <button
                    class="icon-btn"
                    aria-label={t('Choose another song')}
                    data-tip={t('Choose another song')}
                    onClick={() => input.click()}
                  >
                    <I.Music size={16} />
                  </button>
                  <button
                    class="icon-btn"
                    aria-label={t('Search for a song')}
                    data-tip={t('Search for a song')}
                    onClick={() => setSearching(!searching())}
                  >
                    <I.Search size={16} />
                  </button>
                  <button
                    class="icon-btn danger"
                    aria-label={t('Remove')}
                    data-tip={t('Remove')}
                    onClick={() => void remove()}
                  >
                    <I.Trash size={16} />
                  </button>
                </div>
                <Show when={editing() && s.source}>
                  <SoundEditor
                    song
                    maxSeconds={MAX_SONG_SECONDS}
                    source={s.source!}
                    initial={{
                      name: s.title,
                      emoji: '',
                      volume: s.volume,
                      start: s.trim_start ?? 0,
                      end: s.trim_end ?? 0,
                    }}
                    saveLabel={t('Save')}
                    onSave={(d) => update(s, d)}
                    onCancel={() => setEditing(false)}
                  />
                </Show>
              </>
            )}
          </Show>
        }
      >
        {(f) => (
          <SoundEditor
            song
            maxSeconds={MAX_SONG_SECONDS}
            source={f}
            initial={{ name: f.name.replace(/\.[^.]+$/, '').slice(0, 80), emoji: '', volume: 1, start: 0, end: 0 }}
            saveLabel={t('Upload')}
            onSave={(d) => upload(f, d)}
            onCancel={() => setFile(null)}
          />
        )}
      </Show>
      <Show when={searching() && !file()}>
        <SongSearch onPick={pick} onClose={() => setSearching(false)} />
      </Show>
    </div>
  );
}

// ---------- Sessions ----------

interface Session {
  id: string;
  current: boolean;
  online: boolean;
  client: string | null;
  user_agent: string | null;
  created_at: string;
  last_seen_at: string | null;
}

/** "3 days ago", in the app's language. */
function timeAgo(date: string): string {
  const format = new Intl.RelativeTimeFormat(dateLocale(), { numeric: 'auto' });
  const minutes = Math.round((new Date(date).getTime() - Date.now()) / 60000);
  if (Math.abs(minutes) < 60) return format.format(minutes, 'minute');
  if (Math.abs(minutes) < 1440) return format.format(Math.round(minutes / 60), 'hour');
  return format.format(Math.round(minutes / 1440), 'day');
}

function SessionRow(p: { session: Session; onEnd: () => void }) {
  const device = () => describeDevice(p.session.client, p.session.user_agent);
  const name = () => (device().app ? t('Linkord app') : (device().browser ?? t('Unknown device')));
  const lastUsed = () => {
    if (p.session.current || p.session.online) return t('Active now');
    return t('Last active {when}', { when: timeAgo(p.session.last_seen_at ?? p.session.created_at) });
  };
  const signedIn = () =>
    t('Signed in {date}', {
      date: new Date(p.session.created_at).toLocaleDateString(dateLocale(), {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }),
    });
  return (
    <div class="session-row">
      <span class="session-icon">{device().mobile ? <I.MobileDevice size={22} /> : <I.Desktop size={22} />}</span>
      <div class="grow">
        <strong>{[name(), device().os].filter(Boolean).join(' · ')}</strong>
        <span class="muted small">
          {lastUsed()} · {signedIn()}
        </span>
      </div>
      <button class="btn small-btn" onClick={p.onEnd}>
        {t('Log Out')}
      </button>
    </div>
  );
}

function SessionsPage() {
  const [sessions, { refetch }] = createResource(() => api<Session[]>('GET', '/auth/sessions').catch(() => null));
  const current = () => sessions()?.find((s) => s.current);
  const others = () => sessions()?.filter((s) => !s.current) ?? [];
  const end = (s: Session) =>
    void attempt(async () => {
      await api('DELETE', `/auth/sessions/${s.id}`);
      await refetch();
    }, t('Device logged out'));
  return (
    <>
      <Show when={sessions() === null}>
        <p class="empty-hint">{t("Couldn't load your devices.")}</p>
      </Show>
      <Show when={current()}>
        {(s) => (
          <Section title={t('This device')}>
            <div class="set-card">
              <SessionRow session={s()} onEnd={() => void logout()} />
            </div>
          </Section>
        )}
      </Show>
      <Show when={sessions()}>
        <Section title={t('Other devices')}>
          <div class="set-card">
            <For each={others()} fallback={<p class="empty-hint">{t('No other devices are signed in.')}</p>}>
              {(s) => <SessionRow session={s} onEnd={() => end(s)} />}
            </For>
          </div>
        </Section>
        <Section
          title={t('Log out everywhere')}
          description={t('Every device signed in to this account is signed out, including this one.')}
        >
          <button
            class="btn danger-ghost session-everywhere"
            onClick={() =>
              setUi('modal', {
                type: 'confirm',
                title: t('Log out everywhere'),
                body: t('Every device signed in to this account is signed out, including this one.'),
                action: t('Log out everywhere'),
                run: logoutEverywhere,
              })
            }
          >
            <I.Logout size={17} /> {t('Log out everywhere')}
          </button>
        </Section>
      </Show>
    </>
  );
}

// ---------- Voice & Video ----------

/**
 * Live input level: from the voice pipeline when connected, otherwise from a local capture. The mic test plays your
 * mic back on your speakers; in a call it deafens you while it runs (so the call doesn't hear the test and you
 * don't hear the call over it) and undeafens you after.
 */
function useMicLevel() {
  const [level, setLevel] = createSignal(0);
  const [monitoring, setMonitoring] = createSignal(false);
  let monitorGain: GainNode | null = null;
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  let raf = 0;
  /** We deafened you for the test: undeafen when it ends (and mute again if you were muted before). */
  let deafenedForTest = false;
  let mutedBefore = false;
  const stop = () => {
    cancelAnimationFrame(raf);
    stream?.getTracks().forEach((t) => t.stop());
    void ctx?.close();
    stream = null;
    ctx = null;
    monitorGain = null;
  };
  const endTest = () => {
    if (deafenedForTest && voiceUi.deafened && voiceUi.channelId) {
      void toggleDeafen();
      if (mutedBefore && !voiceUi.muted) void toggleMute();
    }
    deafenedForTest = false;
  };
  // Starting the test in a call (or joining one during it) deafens you; stopping it gives your state back.
  createEffect(
    on([monitoring, () => voiceUi.channelId], ([testing, channel]) => {
      if (testing && channel && !voiceUi.deafened && !deafenedForTest) {
        deafenedForTest = true;
        mutedBefore = voiceUi.muted;
        void toggleDeafen();
      } else if (!testing) endTest();
    }),
  );
  // Undeafening yourself (or leaving the call) mid-test ends the test.
  createEffect(() => {
    const deaf = voiceUi.deafened;
    const channel = voiceUi.channelId;
    if (deafenedForTest && (!deaf || !channel)) {
      deafenedForTest = false;
      setMonitoring(false);
    }
  });
  createEffect(() => {
    void prefs.inputDevice; // reopen on a device change (getMic reads it)
    const out = prefs.outputDevice;
    const ns = prefs.noiseMode === 'standard';
    const testing = monitoring();
    // Hearing yourself, the echo canceller would treat your own voice coming out of the speakers as echo and eat it.
    const ec = prefs.echoCancellation && !testing;
    stop();
    if (voiceUi.channelId && !testing) return;
    getMic({ noiseSuppression: ns, echoCancellation: ec, autoGainControl: true })
      .then((s) => {
        stream = s;
        const c = new AudioContext() as AudioContext & { setSinkId?: (id: string) => Promise<void> };
        ctx = c;
        void c.setSinkId?.(out === 'default' ? '' : out).catch(() => {});
        const an = c.createAnalyser();
        an.fftSize = 1024;
        const src = c.createMediaStreamSource(s);
        src.connect(an);
        // Mic test: play the mic back on the chosen speakers.
        monitorGain = c.createGain();
        monitorGain.gain.value = testing ? 1 : 0;
        src.connect(monitorGain).connect(c.destination);
        const buf = new Float32Array(an.fftSize);
        const tick = () => {
          an.getFloatTimeDomainData(buf);
          let sum = 0;
          for (const v of buf) sum += v * v;
          setLevel(Math.sqrt(sum / buf.length));
          raf = requestAnimationFrame(tick);
        };
        tick();
      })
      .catch(() => {});
  });
  onCleanup(() => {
    stop();
    endTest();
  });
  return {
    level: () => (voiceUi.channelId && !monitoring() ? voiceUi.level : level()),
    monitoring,
    setMonitoring,
  };
}

// Meter is logarithmic so quiet speech is visible: -60 dB .. 0 dB.
const toMeter = (rms: number) => Math.max(0, Math.min(1, (20 * Math.log10(Math.max(rms, 1e-6)) + 60) / 60));
const fromMeter = (x: number) => 10 ** ((x * 60 - 60) / 20);

export function useDevices() {
  const [devices, { refetch }] = createResource(() =>
    navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]),
  );
  const onChange = () => void refetch();
  onMount(() => navigator.mediaDevices?.addEventListener('devicechange', onChange));
  onCleanup(() => navigator.mediaDevices?.removeEventListener('devicechange', onChange));
  const list = (kind: MediaDeviceKind) =>
    (devices() ?? []).filter((d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications');
  return { inputs: () => list('audioinput'), outputs: () => list('audiooutput'), cameras: () => list('videoinput') };
}

/** Plays the join chime on the chosen output device, regardless of sound settings. */
async function testOutput(deviceId: string) {
  const ctx = new AudioContext() as AudioContext & { setSinkId?: (id: string) => Promise<void> };
  await ctx.setSinkId?.(deviceId === 'default' ? '' : deviceId).catch(() => {});
  [523.25, 659.25, 783.99].forEach((f, i) => {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    const t = ctx.currentTime + i * 0.14;
    osc.frequency.value = f;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.12, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.32);
  });
  setTimeout(() => void ctx.close(), 1000);
}

/** Discord's Registered Games: what's detected now, sharing it, adding a game it missed, removing one. */
function GamesPage() {
  onMount(() => void scanApps());
  const timer = setInterval(() => void scanApps(), 5000);
  onCleanup(() => clearInterval(timer));
  // Programs with a window that aren't games yet, one entry per executable.
  const addable = () => {
    const seen = new Set<string>();
    return runningApps()
      .filter((a) => a.window && !gameFor(a) && !seen.has(a.path) && seen.add(a.path))
      .sort((a, b) => a.window!.title.localeCompare(b.window!.title));
  };
  const [pick, setPick] = createSignal('');
  const save = (patch: Partial<typeof prefs>) => {
    setPrefs(patch);
    void refreshGames();
  };
  const add = () => {
    const app = addable().find((a) => a.path === pick());
    if (!app) return;
    save({
      customGames: [
        ...prefs.customGames,
        { name: app.window!.title.trim().slice(0, 128), path: normalizePath(app.path) },
      ],
    });
    setPick('');
  };
  return (
    <>
      <Section title={t('Activity Privacy')}>
        <div class="set-card">
          <SwitchRow
            label={t('Share your detected activities with others')}
            hint={t('Shows the game you are playing under your name and on your profile.')}
            checked={prefs.shareActivity}
            onChange={(v) => save({ shareActivity: v })}
          />
        </div>
      </Section>
      <Section
        title={t('Registered Games')}
        description={t("Linkord detects the games you play. Add one it missed, or remove one you don't want shown.")}
      >
        <div class="now-playing" classList={{ playing: !!currentGame() }}>
          <Show
            when={currentGame()}
            fallback={
              <div class="now-playing-text">
                <strong>{t('No game detected')}</strong>
                <span>{t('What are you playing?')}</span>
              </div>
            }
          >
            {(g) => (
              <>
                <GameIcon src={g().icon} size={40} />
                <div class="now-playing-text">
                  <span class="now-playing-label">{t('Now Playing')}</span>
                  <strong>{g().name}</strong>
                </div>
                <Show when={g().applicationId}>
                  <button
                    class="btn ghost small-btn"
                    onClick={() => save({ hiddenGames: [...prefs.hiddenGames, g().applicationId!] })}
                  >
                    {t('Not a game')}
                  </button>
                </Show>
              </>
            )}
          </Show>
        </div>
        <div class="add-game">
          <div class="select-wrap">
            <select value={pick()} onChange={(e) => setPick(e.currentTarget.value)}>
              <option value="">{t('Select an open program')}</option>
              <For each={addable()}>{(a) => <option value={a.path}>{a.window!.title}</option>}</For>
            </select>
            <I.Chevron size={16} />
          </div>
          <button class="btn primary" disabled={!pick()} onClick={add}>
            {t('Add it!')}
          </button>
        </div>
        <Show when={prefs.customGames.length || prefs.hiddenGames.length}>
          <div class="set-card game-list">
            <For each={prefs.customGames}>
              {(g, i) => (
                <div class="game-row">
                  <GameIcon size={32} />
                  <span class="game-row-text">
                    <input
                      class="game-name-input"
                      value={g.name}
                      maxLength={128}
                      aria-label={t('Game name')}
                      onChange={(e) => {
                        const name = e.currentTarget.value.trim();
                        if (name)
                          save({ customGames: prefs.customGames.map((x, j) => (j === i() ? { ...x, name } : x)) });
                      }}
                    />
                    <small title={g.path}>{g.path.slice(g.path.lastIndexOf('/') + 1)}</small>
                  </span>
                  <button
                    class="icon-btn"
                    aria-label={t('Remove')}
                    data-tip={t('Remove')}
                    onClick={() => save({ customGames: prefs.customGames.filter((_, j) => j !== i()) })}
                  >
                    <I.Close size={18} />
                  </button>
                </div>
              )}
            </For>
            <For each={prefs.hiddenGames}>
              {(id) => (
                <div class="game-row hidden-game">
                  <GameIcon size={32} />
                  <span class="game-row-text">
                    <strong>{detectableName(id)}</strong>
                    <small>{t('Not detected')}</small>
                  </span>
                  <button
                    class="btn ghost small-btn"
                    onClick={() => save({ hiddenGames: prefs.hiddenGames.filter((x) => x !== id) })}
                  >
                    {t('Detect again')}
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Section>
    </>
  );
}

function DeviceSelect(p: {
  label: string;
  icon: JSX.Element;
  value: string;
  devices: MediaDeviceInfo[];
  fallback: string;
  onChange: (id: string) => void;
}) {
  return (
    <label class="field device-field">
      <span>{p.label}</span>
      <div class="select-wrap">
        <span class="select-icon">{p.icon}</span>
        {/* `selected` per option, not just `value` on the select: the devices load after the select renders, and a
            value with no matching option yet falls back to the first one ("System default") for good. */}
        <select onChange={(e) => p.onChange(e.currentTarget.value)}>
          <option value="default" selected={p.value === 'default'}>
            {t('System default')}
          </option>
          <For each={p.devices}>
            {(d) => (
              <option value={d.deviceId} selected={d.deviceId === p.value}>
                {d.label || p.fallback}
              </option>
            )}
          </For>
          {/* The chosen device isn't connected right now: keep showing it (the default is used meanwhile). */}
          <Show when={p.devices && p.value !== 'default' && !p.devices.some((d) => d.deviceId === p.value)}>
            <option value={p.value} selected>
              {t('Unavailable device')}
            </option>
          </Show>
        </select>
        <I.Chevron size={16} />
      </div>
    </label>
  );
}

function VoicePage(p: { onKeybinds: () => void }) {
  const { inputs, outputs, cameras } = useDevices();
  const { level, monitoring, setMonitoring } = useMicLevel();
  const threshold = () => (prefs.autoSensitivity && voiceUi.channelId ? voiceUi.threshold : prefs.sensitivity);
  const set = (patch: Parameters<typeof setPrefs>[0], restart = false) => {
    setPrefs(patch);
    syncVad();
    if (restart) void restartMic();
  };
  const pttBinds = () => prefs.keybinds.filter((b) => b.action === 'ptt' && b.combo);

  const [preview, setPreview] = createSignal<MediaStream | null>(null);
  const stopPreview = () => {
    preview()
      ?.getTracks()
      .forEach((t) => t.stop());
    setPreview(null);
  };
  const startPreview = () => openCamera().then(setPreview, () => toast(t('Could not open that camera')));
  onCleanup(stopPreview);

  return (
    <>
      <Section title={t('Devices')}>
        <div class="set-card">
          <div class="device-grid">
            <DeviceSelect
              label={t('Microphone')}
              icon={<I.Mic size={17} />}
              value={prefs.inputDevice}
              devices={inputs()}
              fallback={t('Microphone')}
              onChange={(id) => set({ inputDevice: id }, true)}
            />
            <DeviceSelect
              label={t('Speakers')}
              icon={<I.Headphones size={17} />}
              value={prefs.outputDevice}
              devices={outputs()}
              fallback={t('Speakers')}
              onChange={(id) => void setOutputDevice(id)}
            />
          </div>
          <div class="mic-test">
            <div class="meter" classList={{ manual: false }}>
              <div
                class="meter-fill"
                classList={{ hot: level() > threshold() }}
                style={{ width: `${toMeter(level()) * 100}%` }}
              />
            </div>
            <button
              class="btn"
              classList={{ primary: monitoring() }}
              title={voiceUi.channelId && !monitoring() ? t('You will be deafened during the test') : undefined}
              onClick={() => setMonitoring(!monitoring())}
            >
              <I.Mic size={16} /> {monitoring() ? t('Stop test') : t('Test microphone')}
            </button>
            <button class="btn" onClick={() => void testOutput(prefs.outputDevice)}>
              <I.Speaker size={16} /> {t('Test speakers')}
            </button>
          </div>
          <small class="muted">
            {voiceUi.channelId && !monitoring() ? t('Your live mic level in voice.') : t('Talk to see your mic level.')}
          </small>
          <Show when={monitoring()}>
            <small class="muted">
              {t('You are hearing your own mic. Use headphones to avoid feedback.')}
              <Show when={voiceUi.channelId}> {t("You're deafened in the call until the test ends.")}</Show>
            </small>
          </Show>
        </div>
      </Section>

      <Section title={t('Input mode')}>
        <div class="choice-grid">
          <button
            class="choice"
            classList={{ active: prefs.inputMode === 'voice' }}
            onClick={() => set({ inputMode: 'voice' })}
          >
            <I.Mic size={22} />
            <strong>{t('Voice Activity')}</strong>
            <small>{t('Your mic opens when you speak.')}</small>
          </button>
          <button
            class="choice"
            classList={{ active: prefs.inputMode === 'ptt' }}
            onClick={() => set({ inputMode: 'ptt' })}
          >
            <I.Keyboard size={22} />
            <strong>{t('Push to Talk')}</strong>
            <small>{t('Your mic opens only while you hold a key.')}</small>
          </button>
        </div>
        <Show when={prefs.inputMode === 'voice'}>
          <div class="set-card">
            <SwitchRow
              label={t('Automatically determine input sensitivity')}
              checked={prefs.autoSensitivity}
              onChange={(v) => set({ autoSensitivity: v })}
            />
            <Show when={!prefs.autoSensitivity}>
              <div class="meter manual">
                <div
                  class="meter-fill"
                  classList={{ hot: level() > threshold() }}
                  style={{ width: `${toMeter(level()) * 100}%` }}
                />
                <input
                  type="range"
                  class="meter-range"
                  min="0"
                  max="1"
                  step="0.005"
                  value={toMeter(prefs.sensitivity)}
                  onInput={(e) => set({ sensitivity: fromMeter(+e.currentTarget.value) })}
                />
              </div>
              <small class="muted">{t("Drag the handle: the bar turns green when you'd be transmitting.")}</small>
            </Show>
          </div>
        </Show>
        <Show when={prefs.inputMode === 'ptt'}>
          <div class="set-card">
            <div class="set-row static">
              <span class="set-row-text">
                <strong>{t('Push to talk keys')}</strong>
                <small>
                  <Show when={pttBinds().length} fallback={t('No key yet — add one in Keybinds.')}>
                    <span class="kbd-list">
                      <For each={pttBinds()}>{(b) => <Keys combo={b.combo} />}</For>
                    </span>
                  </Show>
                </small>
              </span>
              <button class="btn" onClick={p.onKeybinds}>
                {t('Edit keybinds')}
              </button>
            </div>
            <label class="field">
              <span>{t('Release delay — {ms} ms', { ms: prefs.pttReleaseDelay })}</span>
              <Slider
                min={0}
                max={1000}
                step={20}
                value={prefs.pttReleaseDelay}
                onInput={(v) => setPrefs({ pttReleaseDelay: v })}
              />
              <small class="muted">
                {t("Keeps your mic open briefly after you let go, so your last word isn't cut off.")}
              </small>
            </label>
          </div>
        </Show>
      </Section>

      <Section title={t('Soundboard')}>
        <div class="set-card">
          <label class="field">
            <span>{t('Soundboard volume — {n}%', { n: Math.round(prefs.soundboardVolume * 100) })}</span>
            <Slider
              min={0}
              max={100}
              value={Math.round(prefs.soundboardVolume * 100)}
              onInput={(v) => setPrefs({ soundboardVolume: v / 100 })}
            />
            <small class="muted">
              {t(
                "How loud everyone's soundboard sounds play for you. Right-click someone to change or mute just theirs.",
              )}
            </small>
          </label>
        </div>
      </Section>

      <Section title={t('Voice processing')}>
        <div class="set-card">
          <div class="set-row static">
            <span class="set-row-text">
              <strong>
                {t('Noise suppression')}
                <Show when={voiceUi.denoiser === 'rnnoise'}>
                  <span class="tag ok">{t('RNNoise active')}</span>
                </Show>
              </strong>
              <small>{t('Advanced uses a neural network to remove keyboards, fans, dogs and room noise.')}</small>
            </span>
          </div>
          <Seg
            value={prefs.noiseMode}
            options={[
              ['off', t('Off')],
              ['standard', t('Standard')],
              ['advanced', t('Advanced')],
            ]}
            onChange={(v) => set({ noiseMode: v }, true)}
          />
          <SwitchRow
            label={t('Echo cancellation')}
            hint={t('Stops others hearing themselves when you use speakers.')}
            checked={prefs.echoCancellation}
            onChange={(v) => set({ echoCancellation: v }, true)}
          />
        </div>
      </Section>

      <Section title={t('Video')}>
        <div class="set-card">
          <DeviceSelect
            label={t('Camera')}
            icon={<I.Camera size={17} />}
            value={prefs.videoDevice}
            devices={cameras()}
            fallback={t('Camera')}
            onChange={(id) => {
              setPrefs({ videoDevice: id });
              if (preview()) {
                stopPreview();
                void startPreview();
              }
            }}
          />
          <div class="camera-preview">
            <Show
              when={preview()}
              fallback={
                <button class="btn" onClick={() => void startPreview()}>
                  <I.Camera size={16} /> {t('Test video')}
                </button>
              }
            >
              {(s) => (
                <>
                  <video autoplay muted playsinline ref={(el) => (el.srcObject = s())} />
                  <button class="btn" onClick={stopPreview}>
                    {t('Stop preview')}
                  </button>
                </>
              )}
            </Show>
          </div>
          <Show when={voiceUi.camera}>
            <small class="muted">{t('A new camera applies the next time you turn your camera on.')}</small>
          </Show>
        </div>
      </Section>
    </>
  );
}

// ---------- Keybinds ----------

/** Click, then press a key (with modifiers), a modifier alone, or a middle/side mouse button. */
function KeyRecorder(p: { combo: Combo | null; onChange: (c: Combo) => void; autoStart?: boolean }) {
  const [active, setActive] = createSignal(false);
  const [mods, setMods] = createSignal(0);
  let el!: HTMLButtonElement;
  let pendingModifier: { vk: number; label: string } | null = null;

  const finish = (c: Combo) => {
    stop();
    p.onChange(c);
  };
  const onDown = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    const k = keyFromEvent(e);
    if (e.key === 'Escape' && !modsFromEvent(e)) return stop();
    if (!k) return;
    const m = modsFromEvent(e, k.vk);
    if (modifierOf(k.vk)) {
      pendingModifier = k;
      setMods(m | modifierOf(k.vk));
      return;
    }
    finish({ vk: k.vk, mods: m, label: k.label });
  };
  const onUp = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const k = keyFromEvent(e);
    // A modifier pressed and released on its own (e.g. Left Ctrl as push to talk).
    if (k && pendingModifier?.vk === k.vk) return finish({ vk: k.vk, mods: modsFromEvent(e, k.vk), label: k.label });
    pendingModifier = null;
    setMods(modsFromEvent(e));
  };
  const onMouse = (e: MouseEvent) => {
    const k = keyFromMouse(e);
    if (!k) {
      if (!el.contains(e.target as Node)) stop();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    finish({ vk: k.vk, mods: modsFromEvent(e), label: k.label });
  };
  function stop() {
    window.removeEventListener('keydown', onDown, true);
    window.removeEventListener('keyup', onUp, true);
    window.removeEventListener('mousedown', onMouse, true);
    window.removeEventListener('blur', stop);
    pendingModifier = null;
    setMods(0);
    setActive(false);
    setRecording(false);
  }
  const start = () => {
    if (active()) return;
    setActive(true);
    setRecording(true);
    window.addEventListener('keydown', onDown, true);
    window.addEventListener('keyup', onUp, true);
    window.addEventListener('mousedown', onMouse, true);
    window.addEventListener('blur', stop);
  };
  onMount(() => p.autoStart && start());
  onCleanup(() => active() && stop());

  return (
    <button class="key-recorder" classList={{ recording: active() }} ref={el} onClick={start}>
      <Show when={active()} fallback={<Keys combo={p.combo} />}>
        <span class="rec-dot" />
        {mods() ? `${modsLabel(mods()).join(' + ')} + …` : t('Press a key…')}
      </Show>
    </button>
  );
}

function KeybindsPage() {
  const [fresh, setFresh] = createSignal<string | null>(null);
  const binds = () => prefs.keybinds;
  const write = (next: Keybind[]) => {
    const hadPtt = prefs.keybinds.some((b) => b.action === 'ptt' && b.combo);
    const hasPtt = next.some((b) => b.action === 'ptt' && b.combo);
    setPrefs({ keybinds: next });
    if (hasPtt && !hadPtt && prefs.inputMode !== 'ptt') {
      setPrefs({ inputMode: 'ptt' });
      toast(t('Input mode switched to Push to Talk'));
    } else if (!hasPtt && hadPtt && prefs.inputMode === 'ptt') {
      setPrefs({ inputMode: 'voice' });
      toast(t('Input mode switched back to Voice Activity'));
    }
    syncVad();
  };
  const patch = (id: string, change: Partial<Keybind>) =>
    write(binds().map((b) => (b.id === id ? { ...b, ...change } : b)));
  const add = () => {
    const id = Math.random().toString(36).slice(2, 10);
    setFresh(id);
    setPrefs({ keybinds: [...binds(), { id, action: 'toggle-mute', combo: null }] });
  };
  const conflict = (b: Keybind) => binds().find((o) => o.id !== b.id && sameCombo(o.combo, b.combo));

  return (
    <>
      <div class="set-card intro-card">
        <span class="intro-icon">
          <I.Keyboard size={22} />
        </span>
        <div>
          <strong>
            {nativeKeybinds ? t('Keybinds work everywhere') : t('Keybinds work while Linkord is focused')}
          </strong>
          <p class="muted small">
            {nativeKeybinds
              ? t(
                  'In games, in other apps, with Linkord minimized or closed to the tray. Keys still reach the app you are using.',
                )
              : isTauri
                ? t('Global keybinds are available in the Windows app.')
                : t('Use the Windows desktop app for keybinds that work in games and other apps.')}{' '}
            {t('Combine keys with Ctrl, Shift, Alt or Win, or use the middle and side mouse buttons.')}
          </p>
        </div>
      </div>

      <div class="kb-list">
        <div class="kb-head">
          <span>{t('Action')}</span>
          <span>{t('Keybind')}</span>
        </div>
        <For each={binds()} fallback={<div class="set-card muted small">{t('No keybinds yet.')}</div>}>
          {(b) => (
            <div class="kb-row">
              <div class="kb-action">
                <div class="select-wrap">
                  <select
                    value={b.action}
                    onChange={(e) => patch(b.id, { action: e.currentTarget.value as KeyAction })}
                  >
                    <For each={Object.entries(ACTIONS)}>{([id, a]) => <option value={id}>{t(a.label)}</option>}</For>
                  </select>
                  <I.Chevron size={16} />
                </div>
                <small class="muted">{t(ACTIONS[b.action].hint)}</small>
              </div>
              <div class="kb-key">
                <KeyRecorder
                  combo={b.combo}
                  autoStart={fresh() === b.id}
                  onChange={(c) => (setFresh(null), patch(b.id, { combo: c }))}
                />
                <Show when={conflict(b)}>
                  {(o) => (
                    <small class="warn">{t('Also used by {action}', { action: t(ACTIONS[o().action].label) })}</small>
                  )}
                </Show>
              </div>
              <button
                class="icon-btn danger"
                aria-label={t('Remove keybind')}
                data-tip={t('Remove')}
                onClick={() => write(binds().filter((x) => x.id !== b.id))}
              >
                <I.Trash size={17} />
              </button>
            </div>
          )}
        </For>
        <button class="btn add-kb" onClick={add}>
          <I.Plus size={16} /> {t('Add a keybind')}
        </button>
      </div>

      <Show when={binds().some((b) => b.action === 'ptt')}>
        <Section title={t('Push to talk')}>
          <div class="set-card">
            <label class="field">
              <span>{t('Release delay — {ms} ms', { ms: prefs.pttReleaseDelay })}</span>
              <Slider
                min={0}
                max={1000}
                step={20}
                value={prefs.pttReleaseDelay}
                onInput={(v) => setPrefs({ pttReleaseDelay: v })}
              />
              <small class="muted">
                {t("Keeps your mic open briefly after you let go, so your last word isn't cut off.")}
              </small>
            </label>
          </div>
        </Section>
      </Show>
    </>
  );
}

// ---------- Notifications ----------

const SOUND_KINDS: [SoundKind, string, string, () => void][] = [
  ['messages', msg('Messages'), msg('DMs, mentions, and messages in servers set to All Messages.'), sounds.message],
  ['voice', msg('Voice channel'), msg('Joining, leaving, and cameras turning on or off.'), sounds.join],
  [
    'calls',
    msg('Calls'),
    msg('The ringtone when a friend calls you, and the ringing while you wait for them to pick up.'),
    () => void setTimeout(sounds.ringIncoming(), 5400),
  ],
  ['mute', msg('Mute and deafen'), msg('When you mute, unmute, deafen or undeafen.'), sounds.mute],
  ['ptt', msg('Push to talk'), msg('A click when push to talk opens and closes.'), sounds.pttOn],
  [
    'stream',
    msg('Streams'),
    msg('Going live, ending a stream, and people starting or stopping watching yours.'),
    sounds.streamStart,
  ],
];

/** Push notifications for this phone or browser (lib/push.ts), web only. */
function PushSection() {
  const toggle = async (on: boolean) => {
    try {
      if (!on) return await disablePush();
      if (!(await enablePush()) && pushState() === 'blocked')
        toast(t('Notifications are blocked for this site in your browser settings.'), 6000);
    } catch {
      toast(t("Couldn't turn notifications on. Try again in a moment."), 5000);
    }
  };
  const test = async () => {
    try {
      toast(
        t('A test arrives in {n} seconds: close Linkord or lock the phone to see it like a real notification.', {
          n: TEST_DELAY,
        }),
        8000,
      );
      const r = await testPush();
      if (r.result === 'not-arrived')
        toast(
          t(
            "The test didn't reach this device. On Android, check that the browser may run in the background (battery settings) and has notifications allowed.",
          ),
          9000,
        );
      else if (r.result === 'not-shown')
        toast(t("The test arrived but couldn't be shown: {error}", { error: r.error ?? '' }), 9000);
      else
        toast(
          t(
            "The test arrived and was shown. Don't see it? Android may be hiding this browser's notifications: allow them in Android's settings for the browser and for Linkord.",
          ),
          9000,
        );
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 5000);
    }
  };
  return (
    <Section
      title={t('Notifications on this device')}
      description={t(
        "For your phone or this browser: DMs, mentions and calls arrive even when Linkord is closed. They aren't sent while you're using Linkord on another device.",
      )}
    >
      <div class="set-card">
        <Switch>
          <Match when={pushState() === 'unsupported'}>
            <p class="muted set-note">{t("This browser can't get notifications while Linkord is closed.")}</p>
          </Match>
          <Match when={pushState() === 'install'}>
            <p class="muted set-note">
              {t(
                'On iPhone and iPad, add Linkord to your Home Screen first (Share, then Add to Home Screen), then turn this on from there.',
              )}
            </p>
          </Match>
          <Match when={pushState() === 'blocked'}>
            <p class="muted set-note">
              {t('Notifications are blocked for this site. Allow them in your browser settings, then come back here.')}
            </p>
          </Match>
          <Match when={true}>
            <SwitchRow
              label={t('Push notifications')}
              hint={t('Only on this device. Every phone or browser you use turns them on by itself.')}
              checked={pushState() === 'on'}
              disabled={pushState() === 'working'}
              onChange={(v) => void toggle(v)}
              extra={
                <Show when={pushState() === 'on'}>
                  <button
                    class="btn small-btn"
                    onClick={(e) => {
                      e.preventDefault();
                      void test();
                    }}
                  >
                    {t('Send a test')}
                  </button>
                </Show>
              }
            />
          </Match>
        </Switch>
      </div>
    </Section>
  );
}

function NotificationsPage() {
  return (
    <>
      <Section
        title={t('Desktop notifications')}
        description={t(
          "Pop-ups for DMs, mentions, replies and server messages (servers notify for all messages unless you change it) while Linkord isn't focused.",
        )}
      >
        <div class="set-card">
          <SwitchRow
            label={t('Enable desktop notifications')}
            checked={prefs.desktopNotifications}
            onChange={(v) => setPrefs({ desktopNotifications: v })}
            extra={
              <button
                class="btn small-btn"
                onClick={(e) => {
                  e.preventDefault();
                  void notify('Linkord', t('Notifications are working.'));
                }}
              >
                {t('Send a test')}
              </button>
            }
          />
        </div>
      </Section>
      <Show when={!isTauri}>
        <PushSection />
      </Show>
      <Section title={t('Sounds')}>
        <div class="set-card">
          <SwitchRow
            label={t('Play sounds')}
            hint={t('Master switch for every sound below.')}
            checked={prefs.sounds}
            onChange={(v) => setPrefs({ sounds: v })}
          />
          <For each={SOUND_KINDS}>
            {([kind, label, hint, play]) => (
              <SwitchRow
                label={t(label)}
                hint={t(hint)}
                disabled={!prefs.sounds}
                checked={prefs.sounds && prefs.soundKinds[kind]}
                onChange={(v) => setPrefs({ soundKinds: { ...prefs.soundKinds, [kind]: v } })}
                extra={
                  <button
                    class="icon-btn"
                    aria-label={t('Play {sound} sound', { sound: t(label) })}
                    data-tip={t('Preview')}
                    disabled={!prefs.sounds || !prefs.soundKinds[kind]}
                    onClick={(e) => {
                      e.preventDefault();
                      play();
                    }}
                  >
                    <I.Play size={15} />
                  </button>
                }
              />
            )}
          </For>
        </div>
      </Section>
      <Section title={t('Updates')}>
        <div class="set-card">
          <SwitchRow
            label={t('Show a banner after each update')}
            hint={t('"Linkord was updated", with a link to the patch notes.')}
            checked={prefs.updateBanner}
            onChange={(v) => setPrefs({ updateBanner: v })}
          />
        </div>
      </Section>
      <p class="muted small">
        {t(
          'Right-click a server or channel to choose what notifies you: All Messages, Only @mentions or Nothing, or to mute it. Muted places still notify you when someone @mentions you directly. Do Not Disturb silences everything.',
        )}
      </p>
    </>
  );
}

// ---------- Appearance ----------

/** Linkord itself in miniature, in one theme's colours whichever theme is on: server strip, channels, chat, people. */
function ThemeMock(p: { mode: 'dark' | 'light' | 'christmas'; half?: boolean }) {
  return (
    <span class={`tm tm-${p.mode}`} classList={{ 'tm-half': p.half }}>
      <span class="tm-side">
        <span class="tm-rail">
          <i class="on" />
          <i />
          <i />
        </span>
        <span class="tm-panel tm-nav">
          <i class="on" />
          <i />
          <i />
          <b />
        </span>
      </span>
      <span class="tm-panel tm-chat">
        <em />
        <span class="tm-msg">
          <u />
          <i />
        </span>
        <span class="tm-msg">
          <u class="gold" />
          <i class="long" />
        </span>
        <span class="tm-box" />
      </span>
      <span class="tm-panel tm-people">
        <u />
        <u class="gold" />
        <u />
      </span>
    </span>
  );
}

function AppearancePage() {
  const options = (): [typeof prefs.theme, string, string, (p: { size?: number }) => JSX.Element][] => [
    [
      'system',
      t('System default'),
      systemTheme() === 'light'
        ? t('Follows your system, currently light.')
        : t('Follows your system, currently dark.'),
      I.Appearance,
    ],
    ['light', t('Light'), '', I.Sun],
    ['dark', t('Dark'), '', I.Moon],
    ['christmas', t('Christmas'), t('Evergreen and gold, with snow, string lights and its own sounds.'), I.Snowflake],
  ];
  return (
    <Section title={t('Theme')} description={t('How Linkord looks on this device.')}>
      <div class="theme-cards">
        <For each={options()}>
          {([id, name, sub, Icon]) => (
            <label class="theme-card" classList={{ on: prefs.theme === id }}>
              <input type="radio" name="theme" checked={prefs.theme === id} onChange={() => setPrefs({ theme: id })} />
              <span class="theme-preview" aria-hidden="true">
                <ThemeMock mode={id === 'system' ? 'dark' : id} />
                <Show when={id === 'system'}>
                  <ThemeMock mode="light" half />
                </Show>
              </span>
              <span class="theme-card-text">
                <strong>
                  <Icon size={15} /> {name}
                  <Show when={prefs.theme === id}>
                    <I.Check size={15} class="theme-card-check" />
                  </Show>
                </strong>
                <Show when={sub}>
                  <small>{sub}</small>
                </Show>
              </span>
            </label>
          )}
        </For>
      </div>
      <Show when={prefs.theme === 'christmas'}>
        <div class="set-card xmas-options">
          <SwitchRow
            label={t('Falling snow')}
            hint={t(
              'Rests while Linkord is in the background or showing a call, so it never takes anything from a game.',
            )}
            checked={prefs.christmasSnow}
            onChange={(v) => setPrefs({ christmasSnow: v })}
          />
          <SwitchRow
            label={t('Santa hats')}
            hint={t("On everyone's picture, only on your screen.")}
            checked={prefs.christmasHats}
            onChange={(v) => setPrefs({ christmasHats: v })}
          />
          <SwitchRow
            label={t('Santa flyover')}
            hint={
              t('He crosses the window every so often. Click him!') +
              (prefs.santaCaught ? ` ${plural(prefs.santaCaught, 'Caught {n} time.', 'Caught {n} times.')}` : '')
            }
            checked={prefs.christmasSanta}
            onChange={(v) => setPrefs({ christmasSanta: v })}
            extra={
              <button
                class="btn small-btn"
                onClick={(e) => {
                  e.preventDefault();
                  flySanta();
                }}
              >
                {t('Send Santa now')}
              </button>
            }
          />
          <SwitchRow
            label={t('Holiday countdown')}
            hint={t('Days until Christmas and New Year in channel headers, with fireworks at midnight.')}
            checked={prefs.christmasCountdown}
            onChange={(v) => setPrefs({ christmasCountdown: v })}
            extra={
              <button
                class="btn small-btn"
                onClick={(e) => {
                  e.preventDefault();
                  celebrate(nextHoliday());
                }}
              >
                {t('Preview fireworks')}
              </button>
            }
          />
          <SwitchRow
            label={t('Background music')}
            hint={t("Christmas carols. Pauses during calls, videos and while you're using another window.")}
            checked={prefs.christmasMusic}
            onChange={(v) => setPrefs({ christmasMusic: v })}
            extra={
              <Show when={musicTitle()}>
                <button
                  class="btn small-btn"
                  onClick={(e) => {
                    e.preventDefault();
                    nextSong();
                  }}
                >
                  {t('Next song')}
                </button>
              </Show>
            }
          />
          <Show when={prefs.christmasMusic}>
            <label class="field xmas-music-volume">
              <span>{t('Music volume')}</span>
              <Slider
                min={0}
                max={100}
                value={Math.round(prefs.christmasMusicVolume * 100)}
                onInput={(v) => setPrefs({ christmasMusicVolume: v / 100 })}
              />
            </label>
          </Show>
          <SwitchRow
            label={t('Christmas sounds')}
            hint={t("Discord's Winter sounds for calls, joining, leaving, mute and deafen.")}
            checked={prefs.christmasSounds}
            onChange={(v) => setPrefs({ christmasSounds: v })}
            extra={
              <button
                class="icon-btn"
                aria-label={t('Play {sound} sound', { sound: t('Christmas sounds') })}
                data-tip={t('Preview')}
                disabled={!prefs.christmasSounds || !prefs.sounds || !prefs.soundKinds.calls}
                onClick={(e) => {
                  e.preventDefault();
                  setTimeout(sounds.ringIncoming(), 5400);
                }}
              >
                <I.Play size={15} />
              </button>
            }
          />
        </div>
      </Show>
    </Section>
  );
}

// ---------- Language ----------

function LanguagePage() {
  const options = (): [LangPref, string, string][] => [
    [
      'system',
      t('System default'),
      t(
        isTauri
          ? 'Follows your system language, currently {language}.'
          : 'Follows your browser language, currently {language}.',
        {
          language: LANGUAGES.find((l) => l.id === systemLang())!.name,
        },
      ),
    ],
    ...LANGUAGES.map((l): [LangPref, string, string] => [l.id, l.name, t(l.english)]),
  ];
  return (
    <>
      <Section title={t('Choose a language')} description={t('The language Linkord uses on this device.')}>
        <div class="set-card">
          <For each={options()}>
            {([id, name, sub]) => (
              <label class="set-row lang-row">
                <input
                  type="radio"
                  name="language"
                  checked={prefs.language === id}
                  onChange={() => setPrefs({ language: id })}
                />
                <span class="set-row-text">
                  <strong>{name}</strong>
                  <Show when={sub !== name}>
                    <small>{sub}</small>
                  </Show>
                </span>
              </label>
            )}
          </For>
        </div>
      </Section>
      <Section
        title={t('Spellcheck')}
        description={t('Underlines misspelled words in the message box; right-click one for suggestions.')}
      >
        <div class="set-card">
          <SwitchRow
            label={t('Check spelling while I type')}
            checked={prefs.spellcheck}
            onChange={(v) => setPrefs({ spellcheck: v })}
          />
          <label class="field">
            <span>{t('Spellcheck language')}</span>
            <select
              value={prefs.spellLanguage}
              disabled={!prefs.spellcheck}
              onChange={(e) => setPrefs({ spellLanguage: e.currentTarget.value as typeof prefs.spellLanguage })}
            >
              <option value="auto">
                {t('Same as the app ({language})', { language: SPELL_LANGUAGES[spellLanguage()].name })}
              </option>
              <For each={Object.entries(SPELL_LANGUAGES)}>{([id, d]) => <option value={id}>{d.name}</option>}</For>
            </select>
          </label>
          <Show when={prefs.spellWords.length}>
            <div class="set-row static">
              <span class="set-row-text">
                <strong>{t('Your dictionary')}</strong>
                <small>{prefs.spellWords.slice(-12).join(', ')}</small>
              </span>
              <button class="btn small-btn" onClick={clearDictionary}>
                {t('Clear')}
              </button>
            </div>
          </Show>
        </div>
      </Section>
    </>
  );
}

// ---------- Desktop app ----------

function AppPage() {
  const [autostart, { mutate }] = createResource(autostartEnabled);
  const [checking, setChecking] = createSignal(false);
  return (
    <>
      <Section title={t('Startup & window')}>
        <div class="set-card">
          <SwitchRow
            label={t('Minimize to tray on close')}
            hint={t(
              'Closing the window keeps Linkord running in the tray, so you stay in voice and keybinds keep working.',
            )}
            checked={prefs.closeToTray}
            onChange={(v) => setPrefs({ closeToTray: v })}
          />
          <SwitchRow
            label={t('Open Linkord when your computer starts')}
            hint={prefs.startMinimized ? t('Starts quietly in the tray.') : t('Opens the Linkord window.')}
            checked={!!autostart()}
            onChange={(v) => void attempt(async () => (await setAutostart(v), mutate(v)))}
          />
          <Show when={autostart()}>
            <SwitchRow
              label={t('Start minimized')}
              hint={t('Stay in the tray when your computer starts instead of opening the window.')}
              checked={prefs.startMinimized}
              onChange={(v) => setPrefs({ startMinimized: v })}
            />
          </Show>
        </div>
      </Section>
      <Show when={nativeKeybinds}>
        <Section title={t('Game overlay')}>
          <div class="set-card">
            <SwitchRow
              label={t('Show the overlay in games')}
              hint={t(
                "During a call, shows who's there and who's talking over games in borderless mode. Nothing is added to the game itself, and it stays out of your streams.",
              )}
              checked={prefs.overlay}
              onChange={(v) => setPrefs({ overlay: v })}
            />
            <Show when={prefs.overlay}>
              <SwitchRow
                label={t('Only show who is talking')}
                hint={t('Leaves the screen clear when nobody is talking.')}
                checked={prefs.overlayOnlySpeaking}
                onChange={(v) => setPrefs({ overlayOnlySpeaking: v })}
              />
              <label class="field device-field">
                <span>{t('Position')}</span>
                <div class="select-wrap">
                  <select
                    value={prefs.overlayCorner}
                    onChange={(e) => setPrefs({ overlayCorner: e.currentTarget.value as typeof prefs.overlayCorner })}
                  >
                    <option value="top-left">{t('Top left')}</option>
                    <option value="top-right">{t('Top right')}</option>
                    <option value="bottom-left">{t('Bottom left')}</option>
                    <option value="bottom-right">{t('Bottom right')}</option>
                  </select>
                  <I.Chevron size={16} />
                </div>
              </label>
              <p class="muted small">
                {t("It can't appear over a game in exclusive fullscreen: set the game to borderless.")}
              </p>
            </Show>
          </div>
        </Section>
      </Show>
      <Section title={t('Updates')}>
        <div class="set-card update-card">
          <div class="grow">
            <strong>Linkord {__APP_VERSION__}</strong>{' '}
            <button class="settings-link" onClick={() => (setUi('modal', null), openPage('changelog'))}>
              {t("See what's new")}
            </button>
            <p class="muted small">
              {update()
                ? t('Version {version} is ready to install.', { version: update()!.version })
                : t('Updates are checked automatically every 30 minutes.')}
            </p>
          </div>
          <Show
            when={update()}
            fallback={
              <button
                class="btn"
                disabled={checking()}
                onClick={async () => {
                  setChecking(true);
                  const found = await checkForUpdates();
                  setChecking(false);
                  if (!found) toast(t("You're on the latest version"));
                }}
              >
                {checking() ? t('Checking…') : t('Check for updates')}
              </button>
            }
          >
            <button class="btn primary" disabled={updating()} onClick={() => void update()!.install()}>
              {updating() ? t('Updating…') : t('Update & restart')}
            </button>
          </Show>
        </div>
      </Section>
    </>
  );
}
