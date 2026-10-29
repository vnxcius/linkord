// User settings: a full-window screen (like Discord's) with a sidebar of pages. Server settings stay
// a dialog in SettingsModals.tsx.
import {
  createEffect,
  createResource,
  createSignal,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack,
  type JSX,
} from 'solid-js';
import { api, media } from '../lib/api';
import { logout } from '../lib/actions';
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
import { openPage } from '../lib/route';
import { prefs, setPrefs, type SoundKind } from '../lib/prefs';
import { sounds } from '../lib/sounds';
import { state } from '../lib/store';
import { attempt, isMobile, setUi, toast } from '../lib/ui';
import { cameraConstraints, restartMic, setOutputDevice, syncVad, voiceUi } from '../lib/voice';
import { GameIcon, SpotifyIcon } from './Activity';
import { Avatar } from './Avatar';
import { ColorPicker } from './ColorPicker';
import * as I from './Icons';
import { formatSize } from './MessageItem';
import { accentCss } from './Profile';

type Page =
  | 'account'
  | 'profile'
  | 'connections'
  | 'voice'
  | 'keybinds'
  | 'games'
  | 'notifications'
  | 'language'
  | 'app';

interface AccountStats {
  created_at: string;
  voice_seconds: number;
  messages: number;
  attachments: number;
  reactions: number;
  servers: number;
  friends: number;
  upload_bytes: number;
  upload_quota: number;
}

interface Connection {
  type: 'discord' | 'spotify';
  id: string;
  username: string | null;
  linked_at: string;
  show_on_profile?: boolean;
  show_activity?: boolean;
  revoked?: boolean;
}

const NAV: { group: string; pages: [Page, string, (p: { size?: number }) => JSX.Element][] }[] = [
  {
    group: msg('User settings'),
    pages: [
      ['account', msg('My Account'), I.Account],
      ['profile', msg('Profile'), I.EditProfile],
      ['connections', msg('Connections'), I.Link],
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
      ['language', msg('Language'), I.Language],
      ...(isTauri
        ? [['app', msg('Desktop App'), I.AppIcon] as [Page, string, (p: { size?: number }) => JSX.Element]]
        : []),
    ],
  },
];

const TITLES: Record<Page, string> = {
  account: msg('My Account'),
  profile: msg('Profile'),
  connections: msg('Connections'),
  voice: msg('Voice & Video'),
  keybinds: msg('Keybinds'),
  games: msg('Registered Games'),
  notifications: msg('Notifications'),
  language: msg('Language'),
  app: msg('Desktop App'),
};

export function Settings(p: { tab?: string }) {
  const legacy: Record<string, Page> = {
    connections: 'connections',
    profile: 'profile',
    voice: 'voice',
    keybinds: 'keybinds',
    notifications: 'notifications',
    language: 'language',
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
          <div class="settings-version">
            Linkord {__APP_VERSION__} · {isTauri ? (nativeKeybinds ? 'Windows' : t('Desktop')) : 'Web'} ·{' '}
            <button class="settings-link" onClick={() => (close(), openPage('changelog'))}>
              {t('Patch notes')}
            </button>
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
            <Match when={page() === 'language'}>
              <LanguagePage />
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
            <dd>{me().username}</dd>
          </div>
        </dl>
      </div>

      <StatsSection />

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

/** "3 h 12 min", "45 min". */
function formatVoiceTime(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? t('{h} h {m} min', { h: h.toLocaleString(dateLocale()), m }) : t('{m} min', { m });
}

function StatsSection() {
  const [stats] = createResource(() => api<AccountStats>('GET', '/users/@me/stats').catch(() => null));
  const num = (n: number) => n.toLocaleString(dateLocale());
  const id = () => state.me!.id;
  return (
    <Section title={t('Stats')}>
      <div class="stat-grid">
        <div class="stat">
          <span class="stat-label">{t('Member since')}</span>
          <strong>
            {stats()
              ? new Date(stats()!.created_at).toLocaleDateString(dateLocale(), {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })
              : '…'}
          </strong>
        </div>
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
          <span class="stat-label">{t('Time in voice')}</span>
          <strong>{stats() ? formatVoiceTime(stats()!.voice_seconds) : '…'}</strong>
        </div>
        <div class="stat">
          <span class="stat-label">{t('Messages sent')}</span>
          <strong>{stats() ? num(stats()!.messages) : '…'}</strong>
        </div>
        <div class="stat">
          <span class="stat-label">{t('Reactions added')}</span>
          <strong>{stats() ? num(stats()!.reactions) : '…'}</strong>
        </div>
        <div class="stat">
          <span class="stat-label">{t('Files shared')}</span>
          <strong>{stats() ? num(stats()!.attachments) : '…'}</strong>
        </div>
        <div class="stat">
          <span class="stat-label">{t('Servers')}</span>
          <strong>{stats() ? num(stats()!.servers) : '…'}</strong>
        </div>
        <div class="stat">
          <span class="stat-label">{t('Friends')}</span>
          <strong>{stats() ? num(stats()!.friends) : '…'}</strong>
        </div>
        <div class="stat">
          <span class="stat-label">{t('Upload space')}</span>
          <strong>
            {stats()
              ? t('{used} of {total}', {
                  used: formatSize(stats()!.upload_bytes),
                  total: formatSize(stats()!.upload_quota),
                })
              : '…'}
          </strong>
          <Show when={stats()}>
            {(s) => (
              <div class="stat-bar">
                <i style={{ width: `${Math.min(100, (s().upload_bytes / s().upload_quota) * 100)}%` }} />
              </div>
            )}
          </Show>
        </div>
      </div>
      <p class="muted small">{t("Time in voice is counted from Linkord 0.1.14 on. Deleted messages don't count.")}</p>
    </Section>
  );
}

// ---------- Profile ----------

const IMAGE_TYPES = 'image/png,image/jpeg,image/gif,image/webp';

function ProfilePage() {
  const me = () => state.users[state.me!.id] ?? state.me!;
  const saved = () => ({
    name: me().display_name ?? '',
    bio: me().bio,
    accent: accentCss(me().accent_color) ?? '#2b2d31',
  });
  const [name, setName] = createSignal(saved().name);
  const [bio, setBio] = createSignal(saved().bio);
  const [accent, setAccent] = createSignal(saved().accent);
  const [uploading, setUploading] = createSignal<'avatar' | 'banner' | null>(null);
  const [saving, setSaving] = createSignal(false);
  const dirty = () => name() !== saved().name || bio() !== saved().bio || accent() !== saved().accent;
  const reset = () => {
    setName(saved().name);
    setBio(saved().bio);
    setAccent(saved().accent);
  };
  const upload = async (which: 'avatar' | 'banner', file?: File) => {
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    setUploading(which);
    await attempt(
      () => api('POST', `/users/@me/${which}`, fd),
      t(which === 'avatar' ? 'Avatar updated' : 'Banner updated'),
    );
    setUploading(null);
  };
  const removeImage = (which: 'avatar' | 'banner') =>
    attempt(() => api('DELETE', `/users/@me/${which}`), t(which === 'avatar' ? 'Avatar removed' : 'Banner removed'));
  const save = async () => {
    setSaving(true);
    await attempt(
      () =>
        api('PATCH', '/users/@me', { display_name: name(), bio: bio(), accent_color: parseInt(accent().slice(1), 16) }),
      t('Profile saved'),
    );
    setSaving(false);
  };
  const preview = () => ({ ...me(), display_name: name() || null, bio: bio() });

  return (
    <div class="profile-editor">
      <div class="profile-fields">
        <label class="field">
          <span>{t('Display name')}</span>
          <input
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            placeholder={me().username}
            maxLength={32}
          />
          <small class="muted">{t('What people see in chat. Leave empty to show your username.')}</small>
        </label>
        <label class="field">
          <span>
            {t('About me')} <em class="counter">{bio().length}/190</em>
          </span>
          <textarea
            value={bio()}
            onInput={(e) => setBio(e.currentTarget.value)}
            maxLength={190}
            rows={4}
            placeholder={t('Say a little about yourself')}
          />
        </label>
        <div class="field">
          <span>{t('Banner colour')}</span>
          <ColorPicker value={accent()} onChange={setAccent} label={t('Banner colour')} />
          <small class="muted">{t('Shown behind your profile when you have no banner image.')}</small>
        </div>
      </div>

      <div class="profile-side">
        <div class="field-label">{t('Preview')}</div>
        <div class="profile-preview editable">
          <label
            class="edit-banner"
            style={{ 'background-color': accent() }}
            classList={{ busy: uploading() === 'banner' }}
          >
            <Show when={media(me().banner)}>{(src) => <img src={src()} alt="" />}</Show>
            <span class="edit-overlay">
              <I.AddImage size={20} /> {me().banner ? t('Change banner') : t('Add banner')}
            </span>
            <input
              type="file"
              accept={IMAGE_TYPES}
              hidden
              onChange={(e) => void upload('banner', e.currentTarget.files?.[0])}
            />
          </label>
          <label class="edit-avatar profile-avatar" classList={{ busy: uploading() === 'avatar' }}>
            <Avatar user={me()} size={84} />
            <span class="edit-overlay round">
              <I.Photo size={20} />
              <small>{t('Change')}</small>
            </span>
            <input
              type="file"
              accept={IMAGE_TYPES}
              hidden
              onChange={(e) => void upload('avatar', e.currentTarget.files?.[0])}
            />
          </label>
          <div class="profile-body">
            <h3>{preview().display_name || me().username}</h3>
            <div class="profile-username">{me().username}</div>
            <Show when={preview().bio}>
              <p class="bio">{preview().bio}</p>
            </Show>
          </div>
        </div>
        <p class="muted small">{t('Click your banner or picture to change it. PNG, JPG, GIF or WebP.')}</p>
        <div class="row small">
          <Show when={me().avatar}>
            <button class="link-btn" onClick={() => void removeImage('avatar')}>
              {t('Remove picture')}
            </button>
          </Show>
          <Show when={me().banner}>
            <button class="link-btn" onClick={() => void removeImage('banner')}>
              {t('Remove banner')}
            </button>
          </Show>
        </div>
      </div>

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

// ---------- Voice & Video ----------

/** Live input level: from the voice pipeline when connected, otherwise a local mic test. */
function useMicLevel() {
  const [level, setLevel] = createSignal(0);
  const [monitoring, setMonitoring] = createSignal(false);
  let monitorGain: GainNode | null = null;
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  let raf = 0;
  const stop = () => {
    cancelAnimationFrame(raf);
    stream?.getTracks().forEach((t) => t.stop());
    void ctx?.close();
    stream = null;
    ctx = null;
    monitorGain = null;
  };
  createEffect(() => {
    if (voiceUi.channelId) setMonitoring(false);
  });
  createEffect(() => {
    const on = monitoring();
    if (monitorGain) monitorGain.gain.value = on ? 1 : 0;
  });
  createEffect(() => {
    const device = prefs.inputDevice;
    const out = prefs.outputDevice;
    const ns = prefs.noiseMode === 'standard';
    const ec = prefs.echoCancellation;
    stop();
    if (voiceUi.channelId) return;
    navigator.mediaDevices
      .getUserMedia({
        audio: {
          deviceId: device !== 'default' ? { exact: device } : undefined,
          noiseSuppression: ns,
          echoCancellation: ec,
          autoGainControl: true,
        },
      })
      .then((s) => {
        stream = s;
        const c = new AudioContext() as AudioContext & { setSinkId?: (id: string) => Promise<void> };
        ctx = c;
        void c.setSinkId?.(out === 'default' ? '' : out).catch(() => {});
        const an = c.createAnalyser();
        an.fftSize = 1024;
        const src = c.createMediaStreamSource(s);
        src.connect(an);
        // Mic test: play the mic back on the chosen speakers (muted until the test is switched on).
        monitorGain = c.createGain();
        monitorGain.gain.value = untrack(monitoring) ? 1 : 0;
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
  onCleanup(stop);
  return { level: () => (voiceUi.channelId ? voiceUi.level : level()), monitoring, setMonitoring };
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
        <select value={p.value} onChange={(e) => p.onChange(e.currentTarget.value)}>
          <option value="default">{t('System default')}</option>
          <For each={p.devices}>{(d) => <option value={d.deviceId}>{d.label || p.fallback}</option>}</For>
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
  const startPreview = () =>
    navigator.mediaDevices
      .getUserMedia({ video: cameraConstraints() })
      .then(setPreview, () => toast(t('Could not open that camera')));
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
              disabled={!!voiceUi.channelId}
              title={voiceUi.channelId ? t('Leave voice to test your microphone') : undefined}
              onClick={() => setMonitoring(!monitoring())}
            >
              <I.Mic size={16} /> {monitoring() ? t('Stop test') : t('Test microphone')}
            </button>
            <button class="btn" onClick={() => void testOutput(prefs.outputDevice)}>
              <I.Speaker size={16} /> {t('Test speakers')}
            </button>
          </div>
          <small class="muted">
            {voiceUi.channelId ? t('Your live mic level in voice.') : t('Talk to see your mic level.')}
          </small>
          <Show when={monitoring()}>
            <small class="muted">{t('You are hearing your own mic. Use headphones to avoid feedback.')}</small>
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
              <input
                type="range"
                class="range"
                min="0"
                max="1000"
                step="20"
                value={prefs.pttReleaseDelay}
                onInput={(e) => setPrefs({ pttReleaseDelay: +e.currentTarget.value })}
              />
              <small class="muted">
                {t("Keeps your mic open briefly after you let go, so your last word isn't cut off.")}
              </small>
            </label>
          </div>
        </Show>
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
              <input
                type="range"
                class="range"
                min="0"
                max="1000"
                step="20"
                value={prefs.pttReleaseDelay}
                onInput={(e) => setPrefs({ pttReleaseDelay: +e.currentTarget.value })}
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
  ['messages', msg('Messages'), msg('New messages in DMs and mentions.'), sounds.message],
  ['voice', msg('Voice channel'), msg('Joining, leaving, and cameras turning on or off.'), sounds.join],
  ['mute', msg('Mute and deafen'), msg('When you mute, unmute, deafen or undeafen.'), sounds.mute],
  ['ptt', msg('Push to talk'), msg('A click when push to talk opens and closes.'), sounds.pttOn],
  [
    'stream',
    msg('Streams'),
    msg('Going live, ending a stream, and people starting or stopping watching yours.'),
    sounds.streamStart,
  ],
];

function NotificationsPage() {
  return (
    <>
      <Section
        title={t('Desktop notifications')}
        description={t("Pop-ups for DMs, mentions and replies while Linkord isn't focused.")}
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
      <p class="muted small">
        {t(
          'To silence a server or channel, right-click it and choose Mute. Muted places still notify you when someone @mentions you directly. Do Not Disturb silences everything.',
        )}
      </p>
    </>
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
