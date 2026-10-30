import { createEffect, createMemo, createSignal, For, Index, on, onCleanup, Show } from 'solid-js';
import { prefs } from '../lib/prefs';
import { loadedVersion, misspelled, spellLanguage } from '../lib/spellcheck';
import { resetTyping, runCommand, sendMessage, sendTyping } from '../lib/actions';
import { emojiUrl } from '../lib/api';
import { COMMANDS, parseCommand } from '../lib/commands';
import { searchEmoji } from '../lib/emoji-data';
import { toRaw, type Tokens } from '../lib/mentions';
import { t } from '../lib/i18n';
import { can, P } from '../lib/perms';
import { dmName, nameColor, nameOf, state } from '../lib/store';
import type { Channel } from '../lib/types';
import { isPrivate, Kind } from '../lib/types';
import { setUi, toast, ui } from '../lib/ui';
import { Avatar } from './Avatar';
import { customPick, EmojiPicker } from './EmojiPicker';
import * as I from './Icons';
import { createVoiceRecording, RecordingBar } from './VoiceNote';

/** One autocomplete row: a member, role, @everyone, emoji, or slash command. */
interface Suggestion {
  key: string;
  insert: string;
  /** What the box shows instead of `insert` (mentions and custom emoji); turned back when sending. */
  shown?: string;
  label: string;
  hint?: string;
  icon: () => any;
}

const MAX_FILE = 25 * 1024 * 1024;

export function Composer(p: { channel: Channel }) {
  const [text, setText] = createSignal('');
  const [files, setFiles] = createSignal<File[]>([]);
  const [picker, setPicker] = createSignal<'emoji' | null>(null);
  const [mentionIdx, setMentionIdx] = createSignal(0);
  /** A slash command waiting for the bot (yt-dlp can take a few seconds to find a video). */
  const [thinking, setThinking] = createSignal(false);
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
    if (isPrivate(p.channel.kind))
      return t('Message {name}', { name: `${p.channel.kind === Kind.Dm ? '@' : ''}${dmName(p.channel)}` });
    return t('Message {name}', { name: p.channel.kind === Kind.Thread ? p.channel.name : `#${p.channel.name}` });
  };

  const memberIds = (): string[] => {
    if (isPrivate(p.channel.kind)) return (p.channel.recipients ?? []).map((u) => u.id);
    return Object.keys(state.members[gid()!] ?? {});
  };

  // Active autocomplete: "@name" for mentions, ":name" (2+ chars) for emoji, right before the caret, or "/name"
  // at the start of a message in a server channel for slash commands.
  const [caret, setCaret] = createSignal(0);
  const trigger = createMemo(() => {
    const before = text().slice(0, caret());
    const cmd = gid() && before.match(/^\/(\w{0,32})$/);
    if (cmd) return { kind: '/', q: cmd[1].toLowerCase() };
    const m = before.match(/(?:^|\s)([@:])([\w.]{0,32})$/);
    if (!m || (m[1] === ':' && m[2].length < 2)) return null;
    return { kind: m[1], q: m[2].toLowerCase() };
  });
  const matches = createMemo((): Suggestion[] => {
    const tr = trigger();
    if (!tr) return [];
    if (tr.kind === '/') {
      return COMMANDS.filter((c) => c.name.startsWith(tr.q)).map((c) => ({
        key: c.name,
        insert: `/${c.name}`,
        label: !c.option ? `/${c.name}` : c.optional ? `/${c.name} [${t(c.option)}]` : `/${c.name} <${t(c.option)}>`,
        hint: t(c.description),
        icon: () => <span class="ac-command">/</span>,
      }));
    }
    if (tr.kind === ':') {
      const custom = Object.values(state.emojis)
        .flat()
        .filter((e) => e.name.toLowerCase().includes(tr.q))
        .slice(0, 5)
        .map((e) => ({
          key: e.id,
          insert: customPick(e).text,
          shown: `:${e.name}:`,
          label: `:${e.name}:`,
          icon: () => <img class="emoji custom" src={emojiUrl(e.id, e.animated)} alt="" />,
        }));
      const unicode = searchEmoji(tr.q, 10 - custom.length).map((e) => ({
        key: e.char,
        insert: e.char,
        label: `:${e.names[0]}:`,
        icon: () => <span class="ac-emoji">{e.char}</span>,
      }));
      return [...custom, ...unicode];
    }
    const users: Suggestion[] = memberIds()
      .filter(
        (id) =>
          state.users[id] &&
          (state.users[id].username.includes(tr.q) || nameOf(id, gid()).toLowerCase().includes(tr.q)),
      )
      .slice(0, 8)
      .map((id) => ({
        key: id,
        insert: `<@${id}>`,
        shown: `@${nameOf(id, gid())}`,
        label: nameOf(id, gid()),
        hint: state.users[id].username,
        icon: () => <Avatar user={state.users[id]} size={24} />,
      }));
    if (!gid()) return users;
    const everyone = can(gid(), P.MENTION_EVERYONE);
    const roles: Suggestion[] = Object.values(state.roles[gid()!] ?? {})
      .filter((r) => r.id !== gid() && (r.mentionable || everyone) && r.name.toLowerCase().includes(tr.q))
      .slice(0, 4)
      .map((r) => ({
        key: r.id,
        insert: `<@&${r.id}>`,
        shown: `@${r.name}`,
        label: `@${r.name}`,
        hint: t('Role'),
        icon: () => (
          <span
            class="ac-role"
            style={{ background: r.color ? `#${r.color.toString(16).padStart(6, '0')}` : undefined }}
          />
        ),
      }));
    const special: Suggestion[] = everyone
      ? ['everyone', 'here']
          .filter((w) => w.startsWith(tr.q))
          .map((w) => ({
            key: w,
            insert: `@${w}`,
            label: `@${w}`,
            hint: w === 'here' ? t('Notify everyone online') : t('Notify everyone'),
            icon: () => <I.At size={20} />,
          }))
      : [];
    return [...users, ...roles, ...special];
  });

  /** Mentions and custom emoji in the box, readable form -> markup (see lib/mentions.ts). */
  const tokens: Tokens = new Map();
  const insertSuggestion = (sug: Suggestion) => {
    if (sug.shown) tokens.set(sug.shown, sug.insert);
    const before = text()
      .slice(0, caret())
      .replace(/^\/\w*$|[@:][\w.]*$/, `${sug.shown ?? sug.insert} `);
    const after = text().slice(caret());
    setText(before + after);
    input.value = before + after;
    input.setSelectionRange(before.length, before.length);
    setCaret(before.length);
    input.focus();
    autosize();
  };

  // Spellcheck: the text split into runs, misspelled ones marked (checked a moment after typing stops).
  let layer!: HTMLDivElement;
  const [bad, setBad] = createSignal<{ start: number; end: number }[]>([]);
  let spellTimer: number | undefined;
  let spellGen = 0;
  createEffect(() => {
    const value = text();
    loadedVersion();
    void prefs.spellcheck;
    void spellLanguage();
    void prefs.spellWords.length;
    clearTimeout(spellTimer);
    const gen = ++spellGen;
    spellTimer = window.setTimeout(async () => {
      const wrong = await misspelled(value);
      if (gen === spellGen) setBad(wrong);
    }, 350);
  });
  onCleanup(() => clearTimeout(spellTimer));
  const spellRuns = createMemo(() => {
    const v = text();
    const runs: { text: string; bad: boolean }[] = [];
    let at = 0;
    for (const w of bad()) {
      if (w.end > v.length || w.start < at) continue;
      if (w.start > at) runs.push({ text: v.slice(at, w.start), bad: false });
      runs.push({ text: v.slice(w.start, w.end), bad: true });
      at = w.end;
    }
    if (at < v.length) runs.push({ text: v.slice(at), bad: false });
    return runs;
  });

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
  createEffect(
    on(
      () => ui.composerFocus,
      () => !input.disabled && input.focus(),
      { defer: true },
    ),
  );

  // Entering a channel or DM puts the cursor in the message box (not on phones, where it would pop the keyboard up).
  createEffect(
    on(
      () => p.channel.id,
      () => {
        if (window.matchMedia('(max-width: 760px)').matches) return;
        queueMicrotask(() => input && !input.disabled && input.focus());
      },
    ),
  );

  const submit = () => {
    const content = toRaw(text(), gid(), tokens).trim();
    if (!content && !files().length) return;
    const cmd = gid() && !files().length ? parseCommand(content) : null;
    if (cmd) {
      if (thinking()) return;
      setThinking(true);
      void runCommand(p.channel.id, cmd.command.name, cmd.query).finally(() => setThinking(false));
    } else void sendMessage(p.channel.id, content, ui.replyTo[p.channel.id], files());
    setText('');
    setFiles([]);
    setUi('replyTo', p.channel.id, undefined);
    resetTyping();
    input.value = '';
    autosize();
  };

  const voice = createVoiceRecording((clip) => {
    void sendMessage(p.channel.id, '', ui.replyTo[p.channel.id], [clip.file], {
      duration_secs: clip.duration,
      waveform: clip.waveform,
    });
    setUi('replyTo', p.channel.id, undefined);
  });
  const canRecord = typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  // Like WhatsApp: the mic sits where the send button goes until there's something to send.
  const hasDraft = () => !!text().trim() || files().length > 0;

  const editLast = () => {
    const mine = state.messages[p.channel.id]?.list.filter(
      (m) => m.author.id === state.me?.id && !m.pending && !m.attachments[0]?.waveform,
    );
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
        // A complete command that needs nothing more ("/stop", "/repeat") runs right away.
        const typed = parseCommand(text().trim());
        if (e.key === 'Enter' && typed && (!typed.command.option || typed.command.optional)) submit();
        else insertSuggestion(matches()[Math.min(mentionIdx(), matches().length - 1)]);
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
          <div class="autocomplete-title">
            {trigger()?.kind === ':' ? t('Emoji') : trigger()?.kind === '/' ? t('Commands') : t('Members')}
          </div>
          <For each={matches()}>
            {(sug, i) => (
              <button
                classList={{ active: i() === Math.min(mentionIdx(), matches().length - 1) }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertSuggestion(sug);
                }}
              >
                {sug.icon()}
                <span
                  style={{
                    color:
                      sug.insert.startsWith('<@') && !sug.insert.startsWith('<@&')
                        ? nameColor(gid(), sug.key)
                        : undefined,
                  }}
                >
                  {sug.label}
                </span>
                <Show when={sug.hint}>
                  <span class="muted small">{sug.hint}</span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={thinking()}>
        <div class="reply-bar thinking">
          <span>{t('Kass is thinking…')}</span>
        </div>
      </Show>
      <Show when={replyTo()}>
        {(m) => (
          <div class="reply-bar">
            <span>
              {t('Replying to')} <strong>{nameOf(m().author.id, gid())}</strong>
            </span>
            <button
              class="icon-btn tiny"
              aria-label={t('Cancel reply')}
              onClick={() => setUi('replyTo', p.channel.id, undefined)}
            >
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
                <button
                  class="icon-btn tiny"
                  aria-label={t('Remove')}
                  onClick={() => setFiles((l) => l.filter((_, j) => j !== i))}
                >
                  <I.Close size={14} />
                </button>
              </div>
            )}
          </Index>
        </div>
      </Show>
      <div
        class="composer"
        classList={{
          attached: !!replyTo() || thinking() || files().length > 0,
          disabled: !canSend(),
          recording: !!voice.rec(),
        }}
      >
        <Show when={voice.rec()}>
          <RecordingBar v={voice} />
        </Show>
        <button
          class="icon-btn"
          aria-label={t('Upload a file')}
          data-tip={t('Upload a file')}
          disabled={!canSend() || !canAttach()}
          onClick={() => fileInput.click()}
        >
          <I.Plus size={20} />
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.currentTarget.files) addFiles(e.currentTarget.files);
            e.currentTarget.value = '';
          }}
        />
        <div class="composer-input">
          {/* Misspelled words, underlined behind the (transparent) text box, kept in step with its scrolling. */}
          <div class="spell-layer" ref={layer} aria-hidden="true">
            <For each={spellRuns()}>{(r) => (r.bad ? <mark>{r.text}</mark> : r.text)}</For>
            {'\u200b'}
          </div>
          <textarea
            ref={input}
            rows={1}
            spellcheck={false}
            data-spell="composer"
            disabled={!canSend()}
            placeholder={placeholder()}
            value={text()}
            onScroll={(e) => (layer.scrollTop = e.currentTarget.scrollTop)}
            onInput={(e) => {
              setText(e.currentTarget.value);
              setCaret(e.currentTarget.selectionStart);
              setMentionIdx(0);
              autosize();
              // Slash commands aren't messages, so nobody sees "typing" for them.
              const v = e.currentTarget.value;
              if (v.trim() && !(gid() && v.startsWith('/'))) sendTyping(p.channel.id);
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
        </div>
        <div class="composer-emoji">
          <button
            class="icon-btn"
            aria-label={t('Emoji')}
            data-tip={t('Emoji')}
            disabled={!canSend()}
            onClick={() => setPicker(picker() === 'emoji' ? null : 'emoji')}
          >
            <I.Smile size={22} />
          </button>
          <Show when={picker() === 'emoji'}>
            <EmojiPicker
              class="composer-picker"
              guildId={gid()}
              onClose={() => setPicker(null)}
              onPick={(picked) => {
                const custom = picked.text.match(/^<a?:(\w+):\d+>$/);
                if (custom) tokens.set(`:${custom[1]}:`, picked.text);
                const emoji = custom ? `:${custom[1]}:` : picked.text;
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
          <button
            class="composer-send"
            aria-label={t('Send')}
            data-tip={t('Send')}
            disabled={!canSend()}
            onClick={submit}
          >
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
