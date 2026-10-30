import { createEffect, createSignal, Match, onMount, Show, Switch } from 'solid-js';
import { getToken, setToken } from './lib/api';
import { connectGateway } from './lib/gateway';
import { lang, t } from './lib/i18n';
import { isTauri } from './lib/platform';
import { initDesktop, update, updating } from './lib/desktop';
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
import { WatchHost } from './components/Watch';
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
import { Button } from './components/ui/button';

const INVITE_KEY = 'linkord.pendingInvite';

function captureUrlState() {
  // Web Discord login returns with the session token in the fragment.
  const m = location.hash.match(/token=([\w-]+)/);
  if (m) setToken(m[1]);
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
  });

  return (
    <div class="app-root" classList={{ desktop: isTauri }}>
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
  return (
    <div class="layout" classList={{ 'mobile-main': ui.mobilePane === 'main' }} ref={initSwipes}>
      <div class="nav-pane" classList={{ 'with-banner': state.view !== '@me' && !!state.guilds[state.view]?.banner }}>
        <GuildBanner />
        <Rail />
        <Sidebar />
        <Dock />
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
      </main>
      <Show when={channel() && marginTab(channel()!)}>{(tab) => <Margin channel={channel()!} tab={tab()} />}</Show>
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
      <WatchHost />
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
    return c && (!c.guild_id || can(c.guild_id, P.CONNECT)) ? c : undefined;
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
