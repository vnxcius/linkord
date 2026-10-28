import { createEffect, createMemo, createSignal, For, Index, on, Show } from 'solid-js';
import { resetTyping, sendMessage, sendTyping } from '../lib/actions';
import { emojiUrl } from '../lib/api';
import { searchEmoji } from '../lib/emoji-data';
import { t } from '../lib/i18n';
import { can, P } from '../lib/perms';
import { dmName, nameColor, nameOf, state } from '../lib/store';
import type { Channel } from '../lib/types';
import { isPrivate, Kind } from '../lib/types';
import { setUi, toast, ui } from '../lib/ui';
import { Avatar } from './Avatar';
import { customPick, EmojiPicker } from './EmojiPicker';
import { GifPicker } from './GifPicker';
import * as I from './Icons';
import { createVoiceRecording, RecordingBar } from './VoiceNote';

/** One autocomplete row: a member, role, @everyone, or emoji. */
interface Suggestion {
  key: string;
  insert: string;
  label: string;
  hint?: string;
  icon: () => any;
}

const MAX_FILE = 25 * 1024 * 1024;

export function Composer(p: { channel: Channel }) {
  const [text, setText] = createSignal('');
  const [files, setFiles] = createSignal<File[]>([]);
  const [picker, setPicker] = createSignal<'emoji' | 'gif' | null>(null);
  const [mentionIdx, setMentionIdx] = createSignal(0);
  let input!: HTMLTextAreaElement;
  let fileInput!: HTMLInputElement;

  const replyTo = () => {
    const id = ui.replyTo[p.channel.id];
    return id ? state.messages[p.channel.id]?.list.find((m) => m.id === id) : undefined;
  };

  const gid = () => p.channel.guild_id ?? null;
  const canSend = () => can(gid(), P.SEND_MESSAGES);
  const canAttach = () => can(gid(), P.ATTACH_FILES);
  const placeholder = () => {
    if (!canSend()) return t('You do not have permission to send messages in this channel');
    if (isPrivate(p.channel.kind)) return t('Message {name}', { name: `${p.channel.kind === Kind.Dm ? '@' : ''}${dmName(p.channel)}` });
    return t('Message {name}', { name: p.channel.kind === Kind.Thread ? p.channel.name : `#${p.channel.name}` });
  };

  const memberIds = (): string[] => {
    if (isPrivate(p.channel.kind)) return (p.channel.recipients ?? []).map((u) => u.id);
    return Object.keys(state.members[gid()!] ?? {});
  };

  // Active autocomplete: "@name" for mentions or ":name" (2+ chars) for emoji, right before the caret.
  const [caret, setCaret] = createSignal(0);
  const trigger = createMemo(() => {
    const before = text().slice(0, caret());
    const m = before.match(/(?:^|\s)([@:])([\w.]{0,32})$/);
    if (!m || (m[1] === ':' && m[2].length < 2)) return null;
    return { kind: m[1], q: m[2].toLowerCase() };
  });
  const matches = createMemo((): Suggestion[] => {
    const tr = trigger();
    if (!tr) return [];
    if (tr.kind === ':') {
      const custom = Object.values(state.emojis)
        .flat()
        .filter((e) => e.name.toLowerCase().includes(tr.q))
        .slice(0, 5)
        .map((e) => ({ key: e.id, insert: customPick(e).text, label: `:${e.name}:`, icon: () => <img class="emoji custom" src={emojiUrl(e.id, e.animated)} alt="" /> }));
      const unicode = searchEmoji(tr.q, 10 - custom.length).map((e) => ({ key: e.char, insert: e.char, label: `:${e.names[0]}:`, icon: () => <span class="ac-emoji">{e.char}</span> }));
      return [...custom, ...unicode];
    }
    const users: Suggestion[] = memberIds()
      .filter((id) => state.users[id] && (state.users[id].username.includes(tr.q) || nameOf(id, gid()).toLowerCase().includes(tr.q)))
      .slice(0, 8)
      .map((id) => ({ key: id, insert: `<@${id}>`, label: nameOf(id, gid()), hint: state.users[id].username, icon: () => <Avatar user={state.users[id]} size={24} /> }));
    if (!gid()) return users;
    const everyone = can(gid(), P.MENTION_EVERYONE);
    const roles: Suggestion[] = Object.values(state.roles[gid()!] ?? {})
      .filter((r) => r.id !== gid() && (r.mentionable || everyone) && r.name.toLowerCase().includes(tr.q))
      .slice(0, 4)
      .map((r) => ({ key: r.id, insert: `<@&${r.id}>`, label: `@${r.name}`, hint: t('Role'), icon: () => <span class="ac-role" style={{ background: r.color ? `#${r.color.toString(16).padStart(6, '0')}` : undefined }} /> }));
    const special: Suggestion[] = everyone
      ? ['everyone', 'here'].filter((w) => w.startsWith(tr.q)).map((w) => ({ key: w, insert: `@${w}`, label: `@${w}`, hint: w === 'here' ? t('Notify everyone online') : t('Notify everyone'), icon: () => <I.At size={20} /> }))
      : [];
    return [...users, ...roles, ...special];
  });

  const insertSuggestion = (sug: Suggestion) => {
    const before = text().slice(0, caret()).replace(/[@:][\w.]*$/, `${sug.insert} `);
    const after = text().slice(caret());
    setText(before + after);
    input.value = before + after;
    input.setSelectionRange(before.length, before.length);
    setCaret(before.length);
    input.focus();
    autosize();
  };

  const autosize = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 320)}px`;
  };

  const addFiles = (list: FileList | File[]) => {
    const ok = [...list].filter((f) => {
      if (f.size > MAX_FILE) toast(t('{name} is larger than 25 MB', { name: f.name }));
      return f.size <= MAX_FILE;
    });
    setFiles((cur) => [...cur, ...ok].slice(0, 10));
    input.focus();
  };

  // Replying, finishing an edit or leaving bulk select hands the keyboard back to the composer.
  createEffect(on(() => ui.composerFocus, () => !input.disabled && input.focus(), { defer: true }));

  const submit = () => {
    const content = text().trim();
    if (!content && !files().length) return;
    void sendMessage(p.channel.id, content, ui.replyTo[p.channel.id], files());
    setText('');
    setFiles([]);
    setUi('replyTo', p.channel.id, undefined);
    resetTyping();
    input.value = '';
    autosize();
  };

  const voice = createVoiceRecording((clip) => {
    void sendMessage(p.channel.id, '', ui.replyTo[p.channel.id], [clip.file], { duration_secs: clip.duration, waveform: clip.waveform });
    setUi('replyTo', p.channel.id, undefined);
  });
  const canRecord = typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  // Like WhatsApp: the mic sits where the send button goes until there's something to send.
  const hasDraft = () => !!text().trim() || files().length > 0;

  const editLast = () => {
    const mine = state.messages[p.channel.id]?.list.filter((m) => m.author.id === state.me?.id && !m.pending && !m.attachments[0]?.waveform);
    const last = mine?.[mine.length - 1];
    if (last) setUi('editing', last.id);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (matches().length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = matches().length;
        setMentionIdx((i) => (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertSuggestion(matches()[Math.min(mentionIdx(), matches().length - 1)]);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === 'ArrowUp' && !text()) {
      e.preventDefault();
      editLast();
    } else if (e.key === 'Escape' && ui.replyTo[p.channel.id]) {
      setUi('replyTo', p.channel.id, undefined);
    }
  };

  return (
    <div
      class="composer-wrap"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files);
      }}
    >
      <Show when={matches().length}>
        <div class="autocomplete">
          <div class="autocomplete-title">{trigger()?.kind === ':' ? t('Emoji') : t('Members')}</div>
          <For each={matches()}>
            {(sug, i) => (
              <button classList={{ active: i() === Math.min(mentionIdx(), matches().length - 1) }} onMouseDown={(e) => { e.preventDefault(); insertSuggestion(sug); }}>
                {sug.icon()}
                <span style={{ color: sug.insert.startsWith('<@') && !sug.insert.startsWith('<@&') ? nameColor(gid(), sug.key) : undefined }}>{sug.label}</span>
                <Show when={sug.hint}>
                  <span class="muted small">{sug.hint}</span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={replyTo()}>
        {(m) => (
          <div class="reply-bar">
            <span>
              {t('Replying to')} <strong>{nameOf(m().author.id, gid())}</strong>
            </span>
            <button class="icon-btn tiny" aria-label={t('Cancel reply')} onClick={() => setUi('replyTo', p.channel.id, undefined)}>
              <I.Close size={14} />
            </button>
          </div>
        )}
      </Show>
      <Show when={files().length}>
        <div class="upload-tray">
          <Index each={files()}>
            {(f, i) => (
              <div class="upload-chip">
                <Show when={f().type.startsWith('image/')} fallback={<I.Paperclip size={28} />}>
                  <img src={URL.createObjectURL(f())} alt="" />
                </Show>
                <span class="file-name">{f().name}</span>
                <button class="icon-btn tiny" aria-label={t('Remove')} onClick={() => setFiles((l) => l.filter((_, j) => j !== i))}>
                  <I.Close size={14} />
                </button>
              </div>
            )}
          </Index>
        </div>
      </Show>
      <div class="composer" classList={{ attached: !!replyTo() || files().length > 0, disabled: !canSend(), recording: !!voice.rec() }}>
        <Show when={voice.rec()}>
          <RecordingBar v={voice} />
        </Show>
        <button class="icon-btn" aria-label={t('Upload a file')} data-tip={t('Upload a file')} disabled={!canSend() || !canAttach()} onClick={() => fileInput.click()}>
          <I.Plus size={20} />
        </button>
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => { if (e.currentTarget.files) addFiles(e.currentTarget.files); e.currentTarget.value = ''; }} />
        <textarea
          ref={input}
          rows={1}
          disabled={!canSend()}
          placeholder={placeholder()}
          value={text()}
          onInput={(e) => {
            setText(e.currentTarget.value);
            setCaret(e.currentTarget.selectionStart);
            setMentionIdx(0);
            autosize();
            if (e.currentTarget.value.trim()) sendTyping(p.channel.id);
          }}
          onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
          onClick={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            const pasted = e.clipboardData?.files;
            if (pasted?.length) {
              e.preventDefault();
              addFiles(pasted);
            }
          }}
        />
        <div class="composer-emoji">
          <button class="icon-btn" aria-label="GIFs" data-tip="GIFs" disabled={!canSend()} onClick={() => setPicker(picker() === 'gif' ? null : 'gif')}>
            <I.Gif size={22} />
          </button>
          <button class="icon-btn" aria-label={t('Emoji')} data-tip={t('Emoji')} disabled={!canSend()} onClick={() => setPicker(picker() === 'emoji' ? null : 'emoji')}>
            <I.Smile size={22} />
          </button>
          <Show when={picker() === 'gif'}>
            <GifPicker
              onClose={() => setPicker(null)}
              onPick={(url) => {
                setPicker(null);
                void sendMessage(p.channel.id, url, ui.replyTo[p.channel.id]);
                setUi('replyTo', p.channel.id, undefined);
              }}
            />
          </Show>
          <Show when={picker() === 'emoji'}>
            <EmojiPicker
              class="composer-picker"
              guildId={gid()}
              onClose={() => setPicker(null)}
              onPick={(picked) => {
                const emoji = picked.text;
                const pos = input.selectionStart ?? text().length;
                const next = text().slice(0, pos) + emoji + text().slice(pos);
                setText(next);
                input.value = next;
                input.focus();
                input.setSelectionRange(pos + emoji.length, pos + emoji.length);
              }}
            />
          </Show>
        </div>
        <Show when={hasDraft()}>
          <button class="composer-send" aria-label={t('Send')} data-tip={t('Send')} disabled={!canSend()} onClick={submit}>
            <I.Send size={20} />
          </button>
        </Show>
        <Show when={!hasDraft() && canRecord && canSend() && canAttach() && !(voice.rec() && voice.locked())}>
          <button
            class="composer-mic"
            classList={{ holding: !!voice.rec() }}
            aria-label={t('Record a voice message')}
            data-tip={voice.rec() ? undefined : t('Record a voice message')}
            style={voice.rec() ? { transform: `translate(${voice.drag().x}px, ${voice.drag().y}px)` } : undefined}
            {...voice.micProps}
          >
            <I.Mic size={20} />
          </button>
        </Show>
      </div>
    </div>
  );
}
