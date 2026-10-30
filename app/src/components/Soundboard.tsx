// The soundboard picker (from the call controls) and the server settings page for a server's own sounds.
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { api, serverUrl } from '../lib/api';
import { prefs } from '../lib/prefs';
import { t } from '../lib/i18n';
import { can, P } from '../lib/perms';
import { railEntries } from './Rail';
import { loadDefaultSounds, loadGuildSounds, sounds, type Sound } from '../lib/soundboard';
import { state } from '../lib/store';
import { attempt, toast } from '../lib/ui';
import { previewSound, sendSound, voiceUi } from '../lib/voice';
import { GuildIcon } from './Avatar';
import * as I from './Icons';

/** One sound: click plays it in the call; the speaker previews it just for you. */
function SoundButton(p: { sound: Sound; disabled?: boolean }) {
  return (
    <div class="sound" classList={{ disabled: p.disabled }}>
      <button class="sound-play" disabled={p.disabled} onClick={() => sendSound(p.sound)} title={p.sound.name}>
        <span class="sound-emoji">{p.sound.emoji || '🔊'}</span>
        <span class="sound-name">{p.sound.name}</span>
      </button>
      <button
        class="sound-preview"
        aria-label={t('Preview {name}', { name: p.sound.name })}
        data-tip={t('Preview')}
        onClick={() => void previewSound(p.sound).catch(() => toast(t("Couldn't play that sound")))}
      >
        <I.Speaker size={14} />
      </button>
    </div>
  );
}

/** Popover with every sound you can play: the call's server first, your other servers, then the defaults. */
export function SoundboardPicker(p: { onClose: () => void; style?: Record<string, string> }) {
  let el!: HTMLDivElement;
  const [q, setQ] = createSignal('');
  const callGuild = () => (voiceUi.channelId ? state.channels[voiceUi.channelId]?.guild_id : undefined) ?? undefined;
  const guildIds = () => {
    const all = railEntries().flatMap((f) => f.guild_ids);
    const first = callGuild();
    return first ? [first, ...all.filter((id) => id !== first)] : all;
  };
  createEffect(() => {
    loadDefaultSounds();
    guildIds().forEach((id) => loadGuildSounds(id));
  });
  const match = (s: Sound) => !q() || s.name.toLowerCase().includes(q().toLowerCase());
  const sections = createMemo(() => [
    ...guildIds()
      .map((id) => ({ id, title: state.guilds[id]?.name ?? '', list: (sounds.guilds[id] ?? []).filter(match) }))
      .filter((x) => x.list.length),
    { id: 'default', title: t('Default sounds'), list: (sounds.defaults ?? []).filter(match) },
  ]);
  const onDoc = (e: MouseEvent) =>
    !el.contains(e.target as Node) && !(e.target as HTMLElement).closest('.soundboard-toggle') && p.onClose();
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && p.onClose();
  onMount(() => {
    setTimeout(() => document.addEventListener('mousedown', onDoc));
    document.addEventListener('keydown', onKey);
  });
  onCleanup(() => {
    document.removeEventListener('mousedown', onDoc);
    document.removeEventListener('keydown', onKey);
  });
  const inCall = () => !!voiceUi.channelId && !voiceUi.connecting;
  return (
    <div class="soundboard" ref={el} style={p.style}>
      <div class="soundboard-head">
        <strong>{t('Soundboard')}</strong>
        <input placeholder={t('Search sounds')} value={q()} onInput={(e) => setQ(e.currentTarget.value)} autofocus />
      </div>
      <Show when={!inCall()}>
        <p class="soundboard-hint">
          {t('Join a voice channel to play sounds for everyone. The speaker plays one just for you.')}
        </p>
      </Show>
      <div class="soundboard-body">
        <For each={sections()}>
          {(sec) => (
            <section>
              <h4>
                <Show when={sec.id !== 'default'} fallback={<I.Music size={14} />}>
                  <GuildIcon name={sec.title} icon={state.guilds[sec.id]?.icon} size={16} />
                </Show>
                {sec.title}
              </h4>
              <div class="sound-grid">
                <For each={sec.list}>{(s) => <SoundButton sound={s} disabled={!inCall()} />}</For>
              </div>
            </section>
          )}
        </For>
        <Show when={sounds.defaults && !sections().some((s) => s.list.length)}>
          <p class="empty-hint">{t('No sounds found.')}</p>
        </Show>
      </div>
    </div>
  );
}

/** A toggle button plus its picker, for the call controls and the voice panel. */
export function SoundboardButton(p: { class: string; label?: boolean; size?: number; above?: boolean }) {
  const [open, setOpen] = createSignal(false);
  const [style, setStyle] = createSignal<Record<string, string>>({});
  let btn!: HTMLButtonElement;
  const toggle = () => {
    if (open()) return setOpen(false);
    const r = btn.getBoundingClientRect();
    const w = Math.min(380, innerWidth - 16);
    const left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    setStyle({ left: `${left}px`, bottom: `${innerHeight - r.top + 8}px`, width: `${w}px` });
    setOpen(true);
  };
  return (
    <>
      <button
        ref={btn}
        class={`${p.class} soundboard-toggle`}
        classList={{ on: open() }}
        data-tip={p.label ? undefined : t('Soundboard')}
        aria-label={t('Soundboard')}
        onClick={toggle}
      >
        <I.Music size={p.size ?? 20} />
        <Show when={p.label}> {t('Sounds')}</Show>
      </button>
      <Show when={open()}>
        <SoundboardPicker onClose={() => setOpen(false)} style={style()} />
      </Show>
    </>
  );
}

// ---------- server settings ----------

const MAX_SECONDS = 5.2;
const MAX_SOURCE = 8 * 1024 * 1024;

let decodeCtx: AudioContext | null = null;

/** Peaks for drawing a waveform: the loudest sample in each of `bars` slices (0..1). */
function peaks(buf: AudioBuffer, bars: number): number[] {
  const data = buf.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / bars));
  const out: number[] = [];
  for (let i = 0; i < bars; i++) {
    let max = 0;
    for (let j = i * step; j < Math.min(data.length, (i + 1) * step); j++) max = Math.max(max, Math.abs(data[j]));
    out.push(max);
  }
  const top = Math.max(0.01, ...out);
  return out.map((v) => v / top);
}

interface Draft {
  name: string;
  emoji: string;
  /** 0..1 */
  volume: number;
  start: number;
  end: number;
}

/**
 * Trim and volume for a sound, before uploading it or later: the waveform of the whole file with the part that
 * plays between two handles (at most 5.2 s), a volume slider and a preview of exactly what will play.
 */
function SoundEditor(p: {
  /** The file being added, or the URL of an uploaded sound's original. */
  source: File | string;
  initial: Draft;
  saveLabel: string;
  onSave: (d: Draft) => Promise<unknown>;
  onCancel: () => void;
}) {
  const [buf, setBuf] = createSignal<AudioBuffer | null>(null);
  const [failed, setFailed] = createSignal(false);
  const [draft, setDraft] = createSignal<Draft>(p.initial);
  const [busy, setBusy] = createSignal(false);
  const [playhead, setPlayhead] = createSignal<number | null>(null);
  const set = (patch: Partial<Draft>) => setDraft({ ...draft(), ...patch });
  onMount(async () => {
    try {
      const bytes =
        typeof p.source === 'string'
          ? await (await fetch(serverUrl() + p.source)).arrayBuffer()
          : await p.source.arrayBuffer();
      decodeCtx ??= new AudioContext();
      const b = await decodeCtx.decodeAudioData(bytes);
      setBuf(b);
      // A new file: start at the beginning, as much as fits.
      if (draft().end <= draft().start) set({ end: Math.min(b.duration, draft().start + MAX_SECONDS) });
      else set({ end: Math.min(b.duration, draft().end) });
    } catch {
      setFailed(true);
    }
  });
  const length = () => buf()?.duration ?? 1;
  const bars = createMemo(() => (buf() ? peaks(buf()!, 120) : []));

  let wave!: HTMLDivElement;
  /** Drags a handle (or the whole selection) along the waveform. */
  const drag = (e: PointerEvent, what: 'start' | 'end' | 'both') => {
    e.preventDefault();
    e.stopPropagation();
    const r = wave.getBoundingClientRect();
    const d0 = draft();
    const x0 = e.clientX;
    const move = (ev: PointerEvent) => {
      const at = Math.min(length(), Math.max(0, ((ev.clientX - r.left) / r.width) * length()));
      if (what === 'start') set({ start: Math.min(Math.max(at, d0.end - MAX_SECONDS), d0.end - 0.1) });
      else if (what === 'end') set({ end: Math.max(d0.start + 0.1, Math.min(at, d0.start + MAX_SECONDS)) });
      else {
        const span = d0.end - d0.start;
        const shift = ((ev.clientX - x0) / r.width) * length();
        const start = Math.min(length() - span, Math.max(0, d0.start + shift));
        set({ start, end: start + span });
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  /** A click outside the selection moves it there. */
  const jump = (e: MouseEvent) => {
    const r = wave.getBoundingClientRect();
    const at = ((e.clientX - r.left) / r.width) * length();
    const span = Math.min(MAX_SECONDS, draft().end - draft().start);
    const start = Math.min(Math.max(0, length() - span), Math.max(0, at - span / 2));
    set({ start, end: start + span });
  };

  let playing: AudioBufferSourceNode | null = null;
  let raf = 0;
  const stop = () => {
    playing?.stop();
    playing = null;
    cancelAnimationFrame(raf);
    setPlayhead(null);
  };
  const preview = () => {
    if (!buf() || !decodeCtx) return;
    stop();
    const src = decodeCtx.createBufferSource();
    const g = decodeCtx.createGain();
    g.gain.value = draft().volume * prefs.soundboardVolume;
    src.buffer = buf();
    src.connect(g).connect(decodeCtx.destination);
    const d = draft();
    void decodeCtx.resume();
    const t0 = decodeCtx.currentTime;
    src.start(0, d.start, d.end - d.start);
    src.onended = () => playing === src && stop();
    playing = src;
    const tick = () => {
      setPlayhead(d.start + (decodeCtx!.currentTime - t0));
      raf = requestAnimationFrame(tick);
    };
    tick();
  };
  onCleanup(stop);
  const pct = (sec: number) => `${(sec / length()) * 100}%`;
  const fmt = (sec: number) => `${sec.toFixed(2)}s`;

  return (
    <div class="sound-editor">
      <Show when={!failed()} fallback={<p class="error">{t("Couldn't read that sound")}</p>}>
        <div class="sound-wave" ref={wave} onClick={jump}>
          <div class="sound-bars">
            <For each={bars()}>{(v) => <i style={{ height: `${Math.max(4, v * 100)}%` }} />}</For>
          </div>
          <Show when={buf()}>
            <div
              class="sound-sel"
              style={{ left: pct(draft().start), width: pct(draft().end - draft().start) }}
              onPointerDown={(e) => drag(e, 'both')}
              onClick={(e) => e.stopPropagation()}
            >
              <span class="sound-handle start" onPointerDown={(e) => drag(e, 'start')} />
              <span class="sound-handle end" onPointerDown={(e) => drag(e, 'end')} />
            </div>
            <Show when={playhead() !== null}>
              <span class="sound-playhead" style={{ left: pct(playhead()!) }} />
            </Show>
          </Show>
        </div>
        <div class="sound-times">
          <span>{fmt(draft().start)}</span>
          <span class="muted">{t('{n} selected (up to 5.2s)', { n: fmt(draft().end - draft().start) })}</span>
          <span>{fmt(draft().end)}</span>
        </div>
        <div class="sound-editor-row">
          <button class="btn small-btn" disabled={!buf()} onClick={() => (playing ? stop() : preview())}>
            <I.Play size={14} /> {t('Preview')}
          </button>
          <label class="field grow">
            <span>{t('Volume {n}%', { n: Math.round(draft().volume * 100) })}</span>
            <input
              type="range"
              min="5"
              max="100"
              value={Math.round(draft().volume * 100)}
              onInput={(e) => set({ volume: +e.currentTarget.value / 100 })}
            />
          </label>
        </div>
        <div class="sound-editor-row">
          <label class="field grow">
            <span>{t('Name')}</span>
            <input value={draft().name} maxLength={32} onInput={(e) => set({ name: e.currentTarget.value })} />
          </label>
          <label class="field emoji-field">
            <span>{t('Emoji')}</span>
            <input
              value={draft().emoji}
              maxLength={8}
              placeholder="🔊"
              onInput={(e) => set({ emoji: e.currentTarget.value })}
            />
          </label>
        </div>
        <div class="sound-editor-actions">
          <button class="link-btn" onClick={p.onCancel}>
            {t('Cancel')}
          </button>
          <button
            class="btn primary small-btn"
            disabled={busy() || !buf() || draft().name.trim().length < 2}
            onClick={async () => {
              stop();
              setBusy(true);
              await p.onSave(draft());
              setBusy(false);
            }}
          >
            {p.saveLabel}
          </button>
        </div>
      </Show>
    </div>
  );
}

export function SoundboardSettings(p: { guildId: string }) {
  createEffect(() => loadGuildSounds(p.guildId));
  const list = () => sounds.guilds[p.guildId] ?? [];
  const manage = () => can(p.guildId, P.MANAGE_EMOJIS);
  const [file, setFile] = createSignal<File | null>(null);
  const [editing, setEditing] = createSignal<string | null>(null);
  let input!: HTMLInputElement;
  const pick = (f?: File) => {
    if (!f) return;
    if (f.size > MAX_SOURCE) return toast(t('Pick a file up to 8 MB; you choose the part that plays next'));
    setEditing(null);
    setFile(f);
  };
  const upload = async (f: File, d: Draft) => {
    const fd = new FormData();
    fd.append(
      'payload_json',
      JSON.stringify({ name: d.name, emoji: d.emoji, volume: d.volume, trim_start: d.start, trim_end: d.end }),
    );
    fd.append('file', f, f.name);
    await attempt(async () => {
      await api('POST', `/guilds/${p.guildId}/soundboard`, fd);
      setFile(null);
      input.value = '';
    }, t('Sound added'));
  };
  const save = (s: Sound, d: Draft) =>
    attempt(async () => {
      const trimmed = Math.abs(d.start - s.trim_start) > 0.005 || Math.abs(d.end - (s.trim_end ?? 0)) > 0.005;
      await api('PATCH', `/guilds/${p.guildId}/soundboard/${s.id}`, {
        name: d.name,
        emoji: d.emoji,
        volume: d.volume,
        ...(trimmed ? { trim_start: d.start, trim_end: d.end } : {}),
      });
      setEditing(null);
    }, t('Sound saved'));
  return (
    <div class="stack">
      <p class="muted small">
        {t('Sounds anyone in a call can play for everyone. Pick any audio file and choose up to 5 seconds of it.')}
      </p>
      <Show when={manage()}>
        <Show
          when={file()}
          keyed
          fallback={
            <label class="btn small-btn sound-pick">
              <I.Plus size={14} /> {t('Choose a sound')}
              <input
                ref={input}
                type="file"
                accept="audio/*,.mp3,.ogg,.wav,.webm,.m4a"
                hidden
                onChange={(e) => pick(e.currentTarget.files?.[0])}
              />
            </label>
          }
        >
          {(f) => (
            <SoundEditor
              source={f}
              initial={{ name: f.name.replace(/\.[^.]+$/, '').slice(0, 32), emoji: '', volume: 1, start: 0, end: 0 }}
              saveLabel={t('Upload')}
              onSave={(d) => upload(f, d)}
              onCancel={() => setFile(null)}
            />
          )}
        </Show>
      </Show>
      <div class="sound-rows">
        <For each={list()} fallback={<p class="empty-hint">{t('No sounds yet.')}</p>}>
          {(s) => (
            <>
              <div class="sound-row">
                <span class="sound-emoji">{s.emoji || '🔊'}</span>
                <strong class="grow">{s.name}</strong>
                <span class="muted small">{Math.round(s.volume * 100)}%</span>
                <button
                  class="icon-btn"
                  aria-label={t('Preview')}
                  data-tip={t('Preview')}
                  onClick={() => void previewSound(s)}
                >
                  <I.Speaker size={16} />
                </button>
                <Show when={manage()}>
                  <button
                    class="icon-btn"
                    aria-label={t('Edit')}
                    data-tip={t('Edit')}
                    onClick={() => (setFile(null), setEditing(editing() === s.id ? null : s.id))}
                  >
                    <I.Edit size={16} />
                  </button>
                  <button
                    class="icon-btn danger"
                    aria-label={t('Delete')}
                    data-tip={t('Delete')}
                    onClick={() => void attempt(() => api('DELETE', `/guilds/${p.guildId}/soundboard/${s.id}`))}
                  >
                    <I.Trash size={16} />
                  </button>
                </Show>
              </div>
              <Show when={editing() === s.id}>
                <SoundEditor
                  source={s.source ?? s.url}
                  initial={{
                    name: s.name,
                    emoji: s.emoji ?? '',
                    volume: s.volume,
                    start: s.source ? s.trim_start : 0,
                    end: s.source ? (s.trim_end ?? 0) : 0,
                  }}
                  saveLabel={t('Save')}
                  onSave={(d) => save(s, d)}
                  onCancel={() => setEditing(null)}
                />
              </Show>
            </>
          )}
        </For>
      </div>
    </div>
  );
}
