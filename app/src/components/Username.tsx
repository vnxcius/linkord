// Changing your username (Settings → Account), and picking one right after signing up when your Discord
// username was already taken on Pottira (the server gave you a stand-in like "name_1234": needs_username).
import { createSignal, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { api } from '../lib/api';
import { t } from '../lib/i18n';
import { setState, state } from '../lib/store';
import { toast } from '../lib/ui';
import { Emblem } from './Icons';

/** Discord's rules (the server checks the same): 2-32 of a-z, 0-9, _ and ., no two dots in a row. */
export function usernameProblem(name: string): string | null {
  if (name.length < 2 || name.length > 32) return t('Usernames are 2 to 32 characters.');
  if (!/^[a-z0-9_.]+$/.test(name)) return t('Use only lowercase letters, numbers, _ and .');
  if (name.includes('..')) return t('No two dots in a row.');
  return null;
}

async function saveUsername(name: string) {
  await api('PATCH', '/users/@me', { username: name });
  // USER_UPDATE brings the new name; the "pick one" flag is only ours.
  setState('me', 'needs_username', false);
}

/** One input + Save, used by both. */
function UsernameForm(p: { initial: string; onDone: () => void; onCancel?: () => void; submit: string }) {
  const [value, setValue] = createSignal(p.initial);
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    const name = value().trim();
    const problem = usernameProblem(name);
    if (problem) return setError(problem);
    setBusy(true);
    setError('');
    try {
      await saveUsername(name);
      p.onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="username-form" onSubmit={(e) => void submit(e)}>
      <div class="username-input">
        <span>@</span>
        <input
          value={value()}
          onInput={(e) => {
            // Typed capitals and spaces become what usernames allow.
            const v = e.currentTarget.value.toLowerCase().replace(/\s/g, '_');
            if (v !== e.currentTarget.value) e.currentTarget.value = v;
            setValue(v);
            setError('');
          }}
          maxLength={32}
          autocomplete="off"
          spellcheck={false}
          aria-label={t('Username')}
          autofocus
        />
      </div>
      <Show when={error()}>
        <p class="error" role="alert">
          {error()}
        </p>
      </Show>
      <div class="username-actions">
        <Show when={p.onCancel}>
          <button type="button" class="link-btn" onClick={p.onCancel}>
            {t('Cancel')}
          </button>
        </Show>
        <button class="btn primary" disabled={busy() || !value().trim()}>
          {busy() ? t('Saving…') : p.submit}
        </button>
      </div>
    </form>
  );
}

/** The username row in Settings → Account: shows it, Edit opens the form in place. */
export function UsernameEditor() {
  const [editing, setEditing] = createSignal(false);
  const name = () => state.users[state.me!.id]?.username ?? state.me!.username;
  return (
    <Show
      when={editing()}
      fallback={
        <span class="username-row">
          {name()}
          <button class="link-btn" onClick={() => setEditing(true)}>
            {t('Edit')}
          </button>
        </span>
      }
    >
      <UsernameForm
        initial={name()}
        submit={t('Save')}
        onCancel={() => setEditing(false)}
        onDone={() => {
          setEditing(false);
          toast(t('Username changed'));
        }}
      />
    </Show>
  );
}

/** Right after signing up with a taken username: pick another before using the app. */
export function PickUsername() {
  return (
    <Portal>
      <div class="modal-backdrop pick-username">
        <div class="modal" role="dialog" aria-label={t('Pick a username')}>
          <div class="pick-username-emblem">
            <Emblem size={40} />
          </div>
          <h2>{t('Pick a username')}</h2>
          <p class="muted">
            {t(
              'Someone on Pottira already has your Discord username, so your account got a stand-in. Pick the name people will find you by; you can change it later in Settings.',
            )}
          </p>
          <UsernameForm initial={state.me!.username} submit={t('Continue')} onDone={() => {}} />
        </div>
      </div>
    </Portal>
  );
}
