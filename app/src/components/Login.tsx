import { createResource, createSignal, Show } from 'solid-js';
import { api, checkServer, defaultServer, serverUrl, setServerUrl, setToken } from '../lib/api';
import { t } from '../lib/i18n';
import { isTauri, openExternal } from '../lib/platform';
import { Emblem } from './Icons';

function randomNonce() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export function Login(p: { onLogin: () => void }) {
  const [server, setServer] = createSignal(serverUrl());
  const [error, setError] = createSignal<string | null>(null);
  const [waiting, setWaiting] = createSignal(false);
  const [devName, setDevName] = createSignal('');
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

  const done = (token: string) => {
    setToken(token);
    p.onLogin();
  };

  async function discordLogin() {
    setError(null);
    if (!isTauri) {
      location.href = `${serverUrl()}/api/auth/discord/start`;
      return;
    }
    // Desktop: sign in through the system browser, then pick the session up by polling.
    const nonce = randomNonce();
    await openExternal(`${serverUrl()}/api/auth/discord/start?nonce=${nonce}`);
    setWaiting(true);
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline && waiting()) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const { token } = await api<{ token: string | null }>('GET', `/auth/poll?nonce=${nonce}`);
        if (token) return done(token);
      } catch {}
    }
    setWaiting(false);
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
      <div class="login-glow" />
      <div class="login-card">
        <Emblem size={64} />
        <h1>Linkord</h1>
        <p class="muted">{t('Gather your party.')}</p>

        <Show when={isTauri}>
          <label class="field">
            <span>{t('Server')}</span>
            <input
              value={server()}
              placeholder="https://linkord.example.com"
              onChange={(e) => {
                useServer(e.currentTarget.value);
                e.currentTarget.value = serverUrl();
              }}
            />
          </label>
        </Show>

        <Show
          when={config()}
          fallback={
            <Show when={!check.loading} fallback={<div class="spinner" />}>
              <div class="server-problem">
                <p class="small">{check() && !check()!.ok ? (check() as { reason: string }).reason : t('Enter your server address.')}</p>
                <div class="row">
                  <button class="btn" onClick={() => refetch()}>
                    {t('Retry')}
                  </button>
                  <Show when={isTauri && defaultServer() && server() !== defaultServer()}>
                    <button class="btn ghost" onClick={() => useServer(defaultServer())}>
                      {t('Use {host}', { host: new URL(defaultServer()).host })}
                    </button>
                  </Show>
                </div>
              </div>
            </Show>
          }
        >
          <Show when={config()!.discord} fallback={<p class="muted small">{t('Discord login is not configured on this server yet.')}</p>}>
            <Show
              when={!waiting()}
              fallback={
                <div class="waiting">
                  <div class="spinner" />
                  <p>{t('Finish signing in in your browser…')}</p>
                  <button class="btn ghost" onClick={() => setWaiting(false)}>{t('Cancel')}</button>
                </div>
              }
            >
              <button class="btn discord" onClick={discordLogin}>
                {t('Continue with Discord')}
              </button>
            </Show>
          </Show>
          <Show when={config()!.dev_login}>
            <form class="dev-login" onSubmit={devLogin}>
              <div class="divider"><span>{t('dev login')}</span></div>
              <input value={devName()} onInput={(e) => setDevName(e.currentTarget.value)} placeholder={t('username (e.g. link.hero)')} />
              <button class="btn" type="submit" disabled={!devName().trim()}>{t('Enter')}</button>
            </form>
          </Show>
        </Show>
        <Show when={error()}>
          <p class="error">{error()}</p>
        </Show>
      </div>
    </div>
  );
}
