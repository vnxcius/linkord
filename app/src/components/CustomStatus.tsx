// "Set a custom status", like Discord's: an emoji and up to 128 characters, cleared after a while or never.
// Shown in place of the activity line (member list, DMs, friends), under your name and on profiles.
import { createSignal, For, Show } from 'solid-js';
import { api } from '../lib/api';
import { dateLocale, msg, t } from '../lib/i18n';
import { nameOf, setState, state } from '../lib/store';
import type { Activity, StatusEmoji } from '../lib/types';
import { attempt, setUi } from '../lib/ui';
import { StatusEmojiView } from './Activity';
import { EmojiPicker, type Picked } from './EmojiPicker';
import * as I from './Icons';
import { Button } from './ui/button';
import { Dialog, useSubmit } from './Modals';

const MAX = 128;

type ClearAfter = 'today' | '4h' | '1h' | '30m' | 'never' | 'keep';

const CLEAR_AFTER: { id: Exclude<ClearAfter, 'keep'>; label: string }[] = [
  { id: 'today', label: msg('Today') },
  { id: '4h', label: msg('4 hours') },
  { id: '1h', label: msg('1 hour') },
  { id: '30m', label: msg('30 minutes') },
  { id: 'never', label: msg("Don't clear") },
];

function expiryFor(choice: ClearAfter, current?: number): number | null {
  const now = Date.now();
  switch (choice) {
    case 'today': {
      const midnight = new Date();
      midnight.setHours(24, 0, 0, 0);
      return midnight.getTime();
    }
    case '4h':
      return now + 4 * 3600_000;
    case '1h':
      return now + 3600_000;
    case '30m':
      return now + 30 * 60_000;
    case 'keep':
      return current ?? null;
    default:
      return null;
  }
}

/** A picked emoji as a status emoji: server emoji come as `name:id`. */
function statusEmoji(p: Picked): StatusEmoji {
  const m = /^(.+):(\d+)$/.exec(p.reaction);
  return m ? { id: m[2], name: m[1], animated: p.text.startsWith('<a:') } : { name: p.text };
}

export async function saveCustomStatus(body: { text: string | null; emoji: StatusEmoji | null; expires_at: number | null }) {
  const saved = await api<Activity | null>('PUT', '/activities/custom', body);
  setState('customStatus', saved);
}

export async function clearCustomStatus() {
  await api('DELETE', '/activities/custom');
  setState('customStatus', null);
}

export function CustomStatusModal() {
  const current = state.customStatus;
  const [text, setText] = createSignal(current?.state ?? '');
  const [emoji, setEmoji] = createSignal<StatusEmoji | null>(current?.emoji ?? null);
  const [clearAfter, setClearAfter] = createSignal<ClearAfter>(current ? (current.expires_at ? 'keep' : 'never') : 'today');
  const [picking, setPicking] = createSignal(false);
  const { busy, error, run } = useSubmit();
  let input!: HTMLInputElement;

  const empty = () => !text().trim() && !emoji();
  const until = (at: number) => {
    const d = new Date(at);
    const sameDay = d.toDateString() === new Date().toDateString();
    return d.toLocaleString(dateLocale(), sameDay ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  };
  const save = () =>
    run(async () => {
      if (empty()) {
        if (current) await clearCustomStatus();
      } else {
        await saveCustomStatus({ text: text().trim() || null, emoji: emoji(), expires_at: expiryFor(clearAfter(), current?.expires_at) });
      }
      setUi('modal', null);
    });

  return (
    <Dialog
      title={t('Set a custom status')}
      footer={
        <>
          <Button variant="ghost" onClick={() => setUi('modal', null)}>
            {t('Cancel')}
          </Button>
          <Button disabled={busy()} onClick={save}>
            {t('Save')}
          </Button>
        </>
      }
    >
      <div class="custom-status-modal">
        <div class="custom-status-preview">
          <span class="custom-status-preview-bubble">
            <Show when={!empty()} fallback={<span class="muted">{t("What's on your mind?")}</span>}>
              <Show when={emoji()}>{(e) => <StatusEmojiView emoji={e()} size={18} />}</Show>
              <span>{text().trim()}</span>
            </Show>
          </span>
        </div>
        <label class="field">
          <span>{t("What's cookin', {name}?", { name: nameOf(state.me!.id) })}</span>
          <div class="status-input">
            <button class="status-emoji-btn" type="button" aria-label={t('Choose an emoji')} data-tip={t('Choose an emoji')} onClick={() => setPicking((v) => !v)}>
              <Show when={emoji()} fallback={<I.Smile size={20} />}>
                {(e) => <StatusEmojiView emoji={e()} size={20} />}
              </Show>
            </button>
            <input
              ref={input}
              value={text()}
              maxLength={MAX}
              placeholder={t('Support has arrived!')}
              onInput={(e) => setText(e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Enter' && save()}
              autofocus
            />
            <Show when={!empty()}>
              <button
                class="status-clear-btn"
                type="button"
                aria-label={t('Clear')}
                onClick={() => {
                  setText('');
                  setEmoji(null);
                  input.focus();
                }}
              >
                <I.Close size={14} />
              </button>
            </Show>
            <Show when={picking()}>
              <EmojiPicker
                class="status-picker"
                onClose={() => setPicking(false)}
                onPick={(picked) => {
                  setEmoji(statusEmoji(picked));
                  setPicking(false);
                  input.focus();
                }}
              />
            </Show>
          </div>
        </label>
        <label class="field">
          <span>{t('Clear after')}</span>
          <select value={clearAfter()} onChange={(e) => setClearAfter(e.currentTarget.value as ClearAfter)}>
            <Show when={current?.expires_at}>{(at) => <option value="keep">{t('Until {time}', { time: until(at()) })}</option>}</Show>
            <For each={CLEAR_AFTER}>{(o) => <option value={o.id}>{t(o.label)}</option>}</For>
          </select>
        </label>
        <Show when={error()}>
          <p class="error">{error()}</p>
        </Show>
      </div>
    </Dialog>
  );
}

/** Opens the dialog (from the status menu). */
export const openCustomStatus = () => setUi('modal', { type: 'custom-status' });
export const clearCustomStatusNow = () => attempt(clearCustomStatus);
