import { createEffect, createSignal, Match, onMount, Show, Switch } from 'solid-js';
import { getToken, setToken } from './lib/api';
import { connectGateway } from './lib/gateway';
import { lang, t } from './lib/i18n';
import { isTauri } from './lib/platform';
import { initDesktop, launchUpdate, update, updating } from './lib/desktop';
import { can, P } from './lib/perms';
import { currentChannel, state } from './lib/store';
import { Kind } from './lib/types';
import { isMobile, isNarrow, setUi, ui } from './lib/ui';
import { initSwipes } from './lib/swipe';
import { joinVoice, voiceUi } from './lib/voice';
import { dismissResume, initVoiceResume, rejoinAfterReload, resumable } from './lib/voice-resume';
import { initRoute } from './lib/route';
import { ChatHeader, ChatView, Margin, marginTab, MobileBack } from './components/Chat';
import { Friends } from './components/Friends';
import { ContextMenu, Lightbox } from './components/Overlays';
import { MiniPlayer } from './components/MiniPlayer';
import { QuickSwitcher } from './components/QuickSwitcher';
import { Calls } from './components/Call';
import { LeaguePrompts } from './components/League';
import { BadgeEarnedHost, BadgeHoverHost } from './components/Badges';
import { ChristmasDecor, HolidayCountdown, SnowPile } from './components/Christmas';
import { WatchHost, watchTheater } from './components/Watch';
import { StreamPreviewHost } from './components/StreamPreview';
import { prefs } from './lib/prefs';
import { installShortcuts } from './lib/shortcuts';
import { Close, Emblem, Rejoin } from './components/Icons';
import { Login } from './components/Login';
import { Members } from './components/Members';
import { DownloadBanner, PageHost, UpdatedBanner } from './components/Pages';
import { ModalHost, parseInvite } from './components/Modals';
import { ProfilePopout } from './components/Profile';
import { Rail } from './components/Rail';
import { Dock, GuildBanner, Sidebar } from './components/Sidebar';
import { TitleBar } from './components/TitleBar';
import { DiscordStage } from './components/Discord';
import { PickUsername } from './components/Username';
import { SidebarResize, sidebarWidth } from './components/SidebarResize';
import { Onboarding } from './components/Onboarding';
import { initPush } from './lib/push';
import { Button } from './components/ui/button';
import { INVITE_KEY, LOGIN_PENDING_KEY } from './lib/api';

function captureUrlState() {
  // Web Discord login returns with the session token in the fragment. Only a login started in this tab counts: a
  // link with someone else's token must not swap the session behind the user's back.
  const m = location.hash.match(/token=([\w-]+)/);
  if (m && sessionStorage.getItem(LOGIN_PENDING_KEY)) setToken(m[1]);
  sessionStorage.removeItem(LOGIN_PENDING_KEY);
  const code = parseInvite(location.pathname);
  if (code) sessionStorage.setItem(INVITE_KEY, code);
  if (m || code) history.replaceState(null, '', '/');
}

export default function App() {
  captureUrlState();
  const [authed, setAuthed] = createSignal(!!getToken());
  createEffect(() => (document.documentElement.lang = lang()));

  const start = () => {
    setAuthed(true);
    connectGateway();
  };
  onMount(() => {
    if (authed()) connectGateway();
    void initDesktop();
    void initVoiceResume();
    void initPush();
  });

  return (
    <div class="app-root" classList={{ desktop: isTauri }}>
      <Show when={prefs.theme === 'christmas'}>
        <ChristmasDecor />
      </Show>
      <Show when={isTauri || !isMobile()}>
        <TitleBar />
      </Show>
      <Show when={authed()} fallback={<Login onLogin={start} />}>
        <Show when={state.ready} fallback={<Splash />}>
          <DownloadBanner />
          <Main />
        </Show>
      </Show>
      <PageHost />
      <Show when={isTauri}>
        <DiscordStage />
      </Show>
      <Show when={launchUpdate()}>{(u) => <LaunchUpdate version={u().version} progress={u().progress} />}</Show>
    </div>
  );
}

/** The update found at launch installing itself; the app restarts when it's done. */
function LaunchUpdate(p: { version: string; progress: number }) {
  return (
    <div class="splash launch-update" role="status">
      <div class="splash-emblem">
        <Emblem size={72} />
      </div>
      <p class="muted">{t('Updating to Linkord {version}…', { version: p.version })}</p>
      <div class="stat-bar launch-update-bar">
        <i style={{ width: `${Math.round(p.progress * 100)}%` }} />
      </div>
    </div>
  );
}

function Splash() {
  return (
    <div class="splash">
      <div class="splash-emblem">
        <Emblem size={72} />
      </div>
      <p class="muted">{state.connection === 'reconnecting' ? t('Reconnecting…') : t('Opening the gate…')}</p>
    </div>
  );
}

function Main() {
  onMount(() => {
    initRoute();
    installShortcuts();
    void rejoinAfterReload();
    const code = sessionStorage.getItem(INVITE_KEY);
    if (code) {
      sessionStorage.removeItem(INVITE_KEY);
      setUi('modal', { type: 'join-invite', code });
    }
  });
  const channel = currentChannel;
  // The channel list steps aside for a call (sidebar button in a voice channel's header) or theater mode.
  const navHidden = () => {
    const c = channel();
    if (!c || isMobile()) return false;
    return (c.kind === Kind.Voice && prefs.voiceNavCollapsed) || watchTheater(c.id);
  };
  return (
    <div
      class="layout"
      classList={{ 'mobile-main': ui.mobilePane === 'main', 'nav-hidden': navHidden() }}
      style={{ '--nav-w': sidebarWidth(prefs.navWidth), '--margin-w': sidebarWidth(prefs.marginWidth) }}
      ref={initSwipes}
    >
      <div class="nav-pane" classList={{ 'with-banner': state.view !== '@me' && !!state.guilds[state.view]?.banner }}>
        <Rail />
        <div class="nav-panel">
          <GuildBanner />
          <Sidebar />
          <Dock />
        </div>
      </div>
      <main class="main">
        <ReconnectBanner />
        <UpdateBanner />
        <UpdatedBanner />
        <Show
          when={channel()}
          fallback={
            <Show when={state.view === '@me'} fallback={<Home />}>
              <Friends />
            </Show>
          }
        >
          {(c) => (
            <>
              <ChatHeader channel={c()} />
              <HolidayCountdown />
              <div class="main-body">
                <ChatView channel={c()} />
                <Show when={isNarrow() && !ui.panel && c().guild_id && c().kind === Kind.Text && ui.membersDrawer}>
                  <div class="drawer-backdrop" onClick={() => setUi('membersDrawer', false)} />
                  <Members guildId={c().guild_id!} drawer />
                </Show>
              </div>
            </>
          )}
        </Show>
        <SnowPile />
      </main>
      <Show when={!navHidden()}>
        <SidebarResize side="nav" />
      </Show>
      <Show when={channel() && marginTab(channel()!)}>
        {(tab) => (
          <>
            <SidebarResize side="margin" />
            <Margin channel={channel()!} tab={tab()} />
          </>
        )}
      </Show>
      <ModalHost />
      <Show when={ui.profile}>
        <ProfilePopout />
      </Show>
      <MiniPlayer />
      <Show when={ui.menu}>
        <ContextMenu />
      </Show>
      <Show when={ui.lightbox}>
        <Lightbox />
      </Show>
      <Show when={ui.quickSwitcher}>
        <QuickSwitcher />
      </Show>
      <Calls />
      <LeaguePrompts />
      <BadgeEarnedHost />
      <BadgeHoverHost />
      <WatchHost />
      <StreamPreviewHost />
      <Show when={state.me?.needs_username}>
        <PickUsername />
      </Show>
      <Onboarding />
      <Show when={ui.toast}>
        <div class="toast">{ui.toast}</div>
      </Show>
      <Show when={state.connection === 'reconnecting' && !isTauri}>
        <div class="conn-banner">{t('Connection lost — reconnecting…')}</div>
      </Show>
    </div>
  );
}

/** Shown when a signed update has been downloaded-ready on the server, like Discord's green download icon. */
function UpdateBanner() {
  return (
    <Show when={update()}>
      <div class="update-banner">
        <span>{t('Linkord {version} is available.', { version: update()!.version })}</span>
        <Button size="sm" disabled={updating()} onClick={() => void update()!.install()}>
          {updating() ? t('Updating…') : t('Update & restart')}
        </Button>
      </div>
    </Show>
  );
}

/** After a crash or update restart that cut a voice call short: one click to get back in. */
function ReconnectBanner() {
  const channel = () => {
    const id = resumable();
    const c = id && !voiceUi.channelId ? state.channels[id] : undefined;
    return c && (!c.guild_id || can(c.guild_id, P.CONNECT, c.id)) ? c : undefined;
  };
  return (
    <Show when={channel()}>
      {(c) => (
        <div class="update-banner reconnect-banner">
          <span>
            {t('Linkord closed while you were in')} <strong>{c().name}</strong>
            {c().guild_id && state.guilds[c().guild_id!] ? ` (${state.guilds[c().guild_id!].name})` : ''}.
          </span>
          <Button
            size="sm"
            onClick={() => {
              const id = c().id;
              dismissResume();
              void joinVoice(id);
            }}
          >
            <Rejoin size={15} /> {t('Reconnect')}
          </Button>
          <button class="icon-btn" aria-label={t('Dismiss')} onClick={dismissResume}>
            <Close size={16} />
          </button>
        </div>
      )}
    </Show>
  );
}

function Home() {
  return (
    <div class="home">
      <MobileBack />
      <Switch>
        <Match when={state.view === '@me'}>
          <div class="home-art">
            <Emblem size={96} />
          </div>
          <h1>{t('Welcome back, traveler')}</h1>
          <p class="muted">
            {t(
              'Pick a conversation, or open a server from the left. Invite your party with a link from the server menu.',
            )}
          </p>
        </Match>
        <Match when={true}>
          <h1>{t('No channels here yet')}</h1>
          <p class="muted">{t('Create one from the server menu.')}</p>
        </Match>
      </Switch>
    </div>
  );
}
