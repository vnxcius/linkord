import { createResource, createSignal, For, Show } from 'solid-js';
import { api, checkServer, defaultServer, LOGIN_PENDING_KEY, serverUrl, setServerUrl, setToken } from '../lib/api';
import { t } from '../lib/i18n';
import { isTauri, openExternal } from '../lib/platform';
import * as I from './Icons';
import { Emblem } from './Icons';

function randomNonce() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 of `text` in URL-safe base64, the challenge the server checks the sign-in's secret against. */
async function challengeOf(text: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function Login(p: { onLogin: () => void }) {
  const [server, setServer] = createSignal(serverUrl());
  const [error, setError] = createSignal<string | null>(null);
  const [waiting, setWaiting] = createSignal(false);
  const [devName, setDevName] = createSignal('');
  const [editServer, setEditServer] = createSignal(false);
  const [check, { refetch }] = createResource(server, (s) => checkServer(s));
  const config = () => {
    const c = check();
    return c?.ok ? c : null;
  };
  const useServer = (value: string) => {
    setServerUrl(value);
    setServer(serverUrl());
    refetch();
  };
  const status = () => (check.loading ? 'checking' : config() ? 'online' : 'offline');

  const done = (token: string) => {
    setToken(token);
    p.onLogin();
  };

  async function discordLogin() {
    setError(null);
    if (!isTauri) {
      sessionStorage.setItem(LOGIN_PENDING_KEY, '1');
      location.href = `${serverUrl()}/api/auth/discord/start`;
      return;
    }
    // Desktop: sign in through the system browser, which comes back to a listener on this computer. Only this app
    // gets the code, and only with this secret does it become a session.
    const verifier = randomNonce();
    const state = randomNonce();
    const challenge = await challengeOf(verifier);
    const { invoke } = await import('@tauri-apps/api/core');
    const { listen } = await import('@tauri-apps/api/event');
    const unlisten = await listen<string>('login-code', async ({ payload: code }) => {
      unlisten();
      try {
        const { token } = await api<{ token: string }>('POST', '/auth/exchange', { code, verifier });
        done(token);
      } catch (err) {
        setError((err as Error).message);
      }
      setWaiting(false);
    });
    try {
      const port = await invoke<number>('login_listen', { state });
      setWaiting(true);
      const params = `port=${port}&state=${state}&challenge=${challenge}`;
      await openExternal(`${serverUrl()}/api/auth/discord/start?${params}`);
    } catch (err) {
      unlisten();
      setWaiting(false);
      setError((err as Error).message ?? String(err));
    }
  }

  async function devLogin(e: Event) {
    e.preventDefault();
    setError(null);
    try {
      const { token } = await api<{ token: string }>('POST', '/auth/dev', { username: devName().trim().toLowerCase() });
      done(token);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div class="login">
      <section class="login-panel">
        <header class="login-brand">
          <Emblem size={30} />
          <span>Linkord</span>
        </header>

        <div class="login-card">
          <h1>{t('Gather your party.')}</h1>
          <p class="login-lead">
            {t('Sign in with your Discord account to hop into voice, chat and streams with your friends.')}
          </p>

          <Show
            when={config()}
            fallback={
              <Show when={!check.loading} fallback={<div class="spinner" />}>
                <div class="server-problem">
                  <p class="small">
                    {check() && !check()!.ok ? (check() as { reason: string }).reason : t('Enter your server address.')}
                  </p>
                  <div class="row">
                    <button class="btn" onClick={() => refetch()}>
                      {t('Retry')}
                    </button>
                    <Show when={isTauri && defaultServer() && server() !== defaultServer()}>
                      <button class="btn ghost" onClick={() => useServer(defaultServer())}>
                        {t('Use {host}', { host: hostOf(defaultServer()) })}
                      </button>
                    </Show>
                  </div>
                </div>
              </Show>
            }
          >
            <Show
              when={config()!.discord}
              fallback={<p class="muted small">{t('Discord login is not configured on this server yet.')}</p>}
            >
              <Show
                when={!waiting()}
                fallback={
                  <div class="waiting">
                    <div class="spinner" />
                    <p>{t('Finish signing in in your browser…')}</p>
                    <button class="btn ghost" onClick={() => setWaiting(false)}>
                      {t('Cancel')}
                    </button>
                  </div>
                }
              >
                <button class="btn discord" onClick={discordLogin}>
                  <DiscordMark />
                  {t('Continue with Discord')}
                </button>
                <p class="login-note">
                  <I.Lock size={14} />
                  {isTauri
                    ? t('Opens in your browser. Linkord never sees your Discord password.')
                    : t('Linkord never sees your Discord password.')}
                </p>
              </Show>
            </Show>
            <Show when={config()!.dev_login}>
              <form class="dev-login" onSubmit={devLogin}>
                <div class="divider">
                  <span>{t('dev login')}</span>
                </div>
                <input
                  value={devName()}
                  onInput={(e) => setDevName(e.currentTarget.value)}
                  placeholder={t('username (e.g. link.hero)')}
                />
                <button class="btn" type="submit" disabled={!devName().trim()}>
                  {t('Enter')}
                </button>
              </form>
            </Show>
          </Show>
          <Show when={error()}>
            <p class="error">{error()}</p>
          </Show>
        </div>

        <footer class="login-foot">
          <Show
            when={isTauri && (editServer() || !config())}
            fallback={
              <div class="login-server">
                <span class={`login-dot ${status()}`} />
                <span class="login-server-text">
                  {status() === 'checking'
                    ? t('Checking {host}…', { host: hostOf(server()) })
                    : status() === 'online'
                      ? t('Connected to {host}', { host: hostOf(server()) })
                      : t("Can't reach {host}", { host: hostOf(server()) })}
                </span>
                <Show when={isTauri}>
                  <button class="login-link" onClick={() => setEditServer(true)}>
                    {t('Change')}
                  </button>
                </Show>
              </div>
            }
          >
            <label class="field">
              <span>{t('Server')}</span>
              <input
                value={server()}
                placeholder="https://linkord.example.com"
                onChange={(e) => {
                  useServer(e.currentTarget.value);
                  e.currentTarget.value = serverUrl();
                  setEditServer(false);
                }}
              />
            </label>
          </Show>
        </footer>
      </section>

      <section class="login-showcase" aria-hidden="true">
        <div class="showcase-inner">
          <p class="showcase-kicker">{t('Your own Discord-style hangout')}</p>
          <h2>{t('Voice, video and streams for your group, on your own server.')}</h2>
          <AppPreview />
          <div class="showcase-features">
            <Feature
              icon={<I.Headphones size={20} />}
              title={t('Crystal-clear voice')}
              text={t('Noise suppression built in, nothing to set up.')}
            />
            <Feature
              icon={<I.Screen size={20} />}
              title={t('Share your screen')}
              text={t('Stream a game or a window with its audio.')}
            />
            <Feature
              icon={<I.Thread size={20} />}
              title={t('Servers, threads and DMs')}
              text={t('Everything you expect, without the noise.')}
            />
          </div>
        </div>
      </section>
    </div>
  );
}

function Feature(p: { icon: any; title: string; text: string }) {
  return (
    <div class="showcase-feature">
      <span class="showcase-feature-icon">{p.icon}</span>
      <div>
        <strong>{p.title}</strong>
        <p>{p.text}</p>
      </div>
    </div>
  );
}

/** Discord's logo mark for the sign-in button. */
function DiscordMark() {
  return (
    <svg width="22" height="17" viewBox="0 0 127.14 96.36" fill="currentColor" aria-hidden="true">
      <path d="M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.83 97.68 97.68 0 0 0-29.11 0A72.37 72.37 0 0 0 45.64 0a105.89 105.89 0 0 0-26.25 8.09C2.79 32.65-1.71 56.6.54 80.21a105.73 105.73 0 0 0 32.17 16.15 77.7 77.7 0 0 0 6.89-11.11 68.42 68.42 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2a75.57 75.57 0 0 0 64.32 0c.87.71 1.76 1.39 2.66 2a68.68 68.68 0 0 1-10.87 5.19 77 77 0 0 0 6.89 11.1 105.25 105.25 0 0 0 32.19-16.14c2.64-27.38-4.51-51.11-18.9-72.15ZM42.45 65.69C36.18 65.69 31 60 31 53s5-12.74 11.43-12.74S54 46 53.89 53s-5.05 12.69-11.44 12.69Zm42.24 0C78.41 65.69 73.25 60 73.25 53s5-12.74 11.44-12.74S96.23 46 96.12 53s-5.04 12.69-11.43 12.69Z" />
    </svg>
  );
}

/** A flat, static sketch of the app (rail, channels with a voice call, chat) for the sign-in screen. */
export function AppPreview() {
  const voice = [
    { name: 'link', tone: 1, speak: 'a' },
    { name: 'zelda', tone: 2, speak: 'b', live: true },
    { name: 'midna', tone: 3 },
  ];
  const messages = [
    { name: 'zelda', tone: 2, lines: [78, 46] },
    { name: 'link', tone: 1, lines: [58] },
    { name: 'midna', tone: 3, lines: [84, 52] },
  ];
  return (
    <div class="preview">
      <div class="preview-rail">
        <span class="preview-server preview-home">
          <Emblem size={16} />
        </span>
        <span class="preview-sep" />
        <span class="preview-server active">H</span>
        <span class="preview-server">K</span>
        <span class="preview-server">G</span>
        <span class="preview-server add">
          <I.Plus size={14} />
        </span>
      </div>
      <div class="preview-sidebar">
        <div class="preview-title">Hyrule</div>
        <div class="preview-channel">
          <I.Hash size={14} /> {t('general')}
        </div>
        <div class="preview-channel active">
          <I.Hash size={14} /> {t('clips')}
        </div>
        <div class="preview-channel">
          <I.Speaker size={14} /> {t('Lounge')}
        </div>
        <For each={voice}>
          {(u) => (
            <div class="preview-voice">
              <span class={`preview-avatar tone-${u.tone}`} classList={{ [`speak-${u.speak}`]: !!u.speak }}>
                {u.name[0].toUpperCase()}
              </span>
              <span>{u.name}</span>
              <Show when={u.live}>
                <span class="preview-live">{t('LIVE')}</span>
              </Show>
            </div>
          )}
        </For>
        <div class="preview-connected">
          <span class="login-dot online" />
          <span>{t('Voice online')}</span>
        </div>
      </div>
      <div class="preview-chat">
        <div class="preview-chat-head">
          <I.Hash size={15} /> {t('clips')}
        </div>
        <div class="preview-messages">
          <For each={messages}>
            {(m) => (
              <div class="preview-message">
                <span class={`preview-avatar big tone-${m.tone}`}>{m.name[0].toUpperCase()}</span>
                <div class="preview-lines">
                  <span class="preview-name">{m.name}</span>
                  <For each={m.lines}>{(w) => <span class="preview-line" style={{ width: `${w}%` }} />}</For>
                </div>
              </div>
            )}
          </For>
          <div class="preview-embed">
            <span class="preview-play">
              <I.Play size={16} />
            </span>
          </div>
        </div>
        <div class="preview-composer">
          <I.Plus size={14} />
          <span class="preview-line" style={{ width: '40%' }} />
        </div>
      </div>
    </div>
  );
}
