// The soundboard picker (from the call controls) and the server settings page for a server's own sounds.
import { Slider } from './ui/slider';
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { onOutsideMouseDown } from '../lib/outside-click';
import { Portal } from 'solid-js/web';
import { api, serverUrl } from '../lib/api';
import { prefs } from '../lib/prefs';
import { t } from '../lib/i18n';
import { can, P } from '../lib/perms';
import { railEntries } from './Rail';
import {
  favoriteSounds,
  isFavoriteSound,
  loadDefaultSounds,
  loadGuildSounds,
  sounds,
  toggleFavoriteSound,
  type Sound,
} from '../lib/soundboard';
import { state } from '../lib/store';
import { attempt, toast } from '../lib/ui';
import { previewSound, sendSound, voiceUi } from '../lib/voice';
import { GuildIcon } from './Avatar';
import { EmojiPicker } from './EmojiPicker';
import * as I from './Icons';

/** One sound: click plays it in the call; the speaker previews it just for you, the star keeps it in Favorites. */
function SoundButton(p: { sound: Sound; disabled?: boolean }) {
  const fav = () => isFavoriteSound(p.sound.id);
  return (
    <div class="sound" classList={{ disabled: p.disabled, favorite: fav() }}>
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
      <button
        class="sound-fav"
        classList={{ on: fav() }}
        aria-pressed={fav()}
        aria-label={t(fav() ? 'Remove {name} from favorites' : 'Add {name} to favorites', { name: p.sound.name })}
        data-tip={t(fav() ? 'Remove from favorites' : 'Add to favorites')}
        onClick={() => toggleFavoriteSound(p.sound.id)}
      >
        <I.Star size={14} />
      </button>
    </div>
  );
}

/** Popover with every sound you can play: your favorites, the call's server, your other servers, then the defaults. */
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
  // Favorites in the order they were starred; sounds that no longer exist (deleted, server left) just drop out.
  const favorites = createMemo(() => {
    const byId = new Map<string, Sound>();
    for (const s of sounds.defaults ?? []) byId.set(s.id, s);
    for (const id of guildIds()) for (const s of sounds.guilds[id] ?? []) byId.set(s.id, s);
    return favoriteSounds()
      .map((id) => byId.get(id))
      .filter((s): s is Sound => !!s);
  });
  const sections = createMemo(() => [
    ...[{ id: 'favorites', title: t('Favorites'), list: favorites().filter(match) }].filter((x) => x.list.length),
    ...guildIds()
      .map((id) => ({ id, title: state.guilds[id]?.name ?? '', list: (sounds.guilds[id] ?? []).filter(match) }))
      .filter((x) => x.list.length),
    { id: 'default', title: t('Default sounds'), list: (sounds.defaults ?? []).filter(match) },
  ]);
  const onDoc = (e: MouseEvent) =>
    !el.contains(e.target as Node) && !(e.target as HTMLElement).closest('.soundboard-toggle') && p.onClose();
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && p.onClose();
  onOutsideMouseDown(onDoc);
  onMount(() => {
    document.addEventListener('keydown', onKey);
  });
  onCleanup(() => {
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
                <Show
                  when={sec.id !== 'default' && sec.id !== 'favorites'}
                  fallback={sec.id === 'favorites' ? <I.Star size={14} /> : <I.Music size={14} />}
                >
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
      {/* On <body>: inside the call controls it would share their stacking context, under the watch-together player. */}
      <Show when={open()}>
        <Portal>
          <SoundboardPicker onClose={() => setOpen(false)} style={style()} />
        </Portal>
      </Show>
    </>
  );
}

// ---------- server settings ----------

const SOUND_SECONDS = 5.2;
/** Per server, like the server's limit (soundboard.rs MAX_PER_GUILD). */
const MAX_SOUNDS = 100;
const MAX_SOURCE = 8 * 1024 * 1024;

let decodeCtx: AudioContext | null = null;

/** Holding a handle still this long zooms the waveform in around it (fine tuning). */
const HOLD_MS = 350;
/** How much of the sound the zoomed waveform shows, in seconds: about 3 ms per pixel. */
const FINE_SECONDS = 1.5;

/** Peaks for drawing a waveform: the loudest sample in each of `bars` slices (0..1), from `from` to `to` seconds. */
function peaks(buf: AudioBuffer, bars: number, from = 0, to = buf.duration): number[] {
  const data = buf.getChannelData(0);
  const first = Math.max(0, Math.floor(from * buf.sampleRate));
  const last = Math.min(data.length, Math.ceil(to * buf.sampleRate));
  const step = Math.max(1, (last - first) / bars);
  const out: number[] = [];
  for (let i = 0; i < bars; i++) {
    let max = 0;
    const a = Math.floor(first + i * step);
    const b = Math.min(last, Math.floor(first + (i + 1) * step));
    for (let j = a; j < b; j++) max = Math.max(max, Math.abs(data[j]));
    out.push(max);
  }
  const top = Math.max(0.01, ...out);
  return out.map((v) => v / top);
}

export interface Draft {
  name: string;
  emoji: string;
  /** 0..1 */
  volume: number;
  start: number;
  end: number;
}

/**
 * Trim and volume for a sound, before uploading it or later: the waveform of the whole file with the part that
 * plays between two handles (at most 5.2 s), a volume slider and a preview of exactly what will play. Profile songs
 * (Settings -> Profile) use it too, with a longer limit, a title instead of a name and no emoji.
 */
export function SoundEditor(p: {
  /** The file being added, or the URL of an uploaded sound's original. */
  source: File | string;
  initial: Draft;
  saveLabel: string;
  onSave: (d: Draft) => Promise<unknown>;
  onCancel: () => void;
  /** Longest part that plays, in seconds (default: a soundboard sound's 5.2 s). */
  maxSeconds?: number;
  /** Profile songs: "Title" (may be empty), no emoji. */
  song?: boolean;
}) {
  const MAX_SECONDS = p.maxSeconds ?? SOUND_SECONDS;
  const [buf, setBuf] = createSignal<AudioBuffer | null>(null);
  const [failed, setFailed] = createSignal(false);
  const [draft, setDraft] = createSignal<Draft>(p.initial);
  const [busy, setBusy] = createSignal(false);
  const [playhead, setPlayhead] = createSignal<number | null>(null);
  const [picker, setPicker] = createSignal<{ x: number; y: number } | null>(null);
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
  /** The part of the sound the waveform shows: all of it, or a short window while fine tuning. */
  const [view, setView] = createSignal<{ from: number; to: number } | null>(null);
  const from = () => view()?.from ?? 0;
  const viewSpan = () => (view() ? view()!.to - view()!.from : length());
  const [fineWhat, setFineWhat] = createSignal<'start' | 'end' | 'both' | null>(null);
  const bars = createMemo(() => (buf() ? peaks(buf()!, view() ? 160 : 120, from(), from() + viewSpan()) : []));

  /** A new start/end/position, kept inside the sound and the length limit. */
  const place = (what: 'start' | 'end' | 'both', at: number, d0: Draft) => {
    if (what === 'start') set({ start: Math.max(0, Math.min(Math.max(at, d0.end - MAX_SECONDS), d0.end - 0.1)) });
    else if (what === 'end')
      set({ end: Math.min(length(), Math.max(d0.start + 0.1, Math.min(at, d0.start + MAX_SECONDS))) });
    else {
      const width = d0.end - d0.start;
      const start = Math.min(length() - width, Math.max(0, at));
      set({ start, end: start + width });
    }
  };

  let wave!: HTMLDivElement;
  /**
   * Drags a handle (or the whole selection) along the waveform. Holding still for a moment zooms in around it
   * (FINE_SECONDS across the waveform), so it can be placed to the millisecond even in a long file; letting go
   * zooms back out.
   */
  const drag = (e: PointerEvent, what: 'start' | 'end' | 'both') => {
    e.preventDefault();
    e.stopPropagation();
    const r = wave.getBoundingClientRect();
    // Where the drag is measured from: the pointer, the time it points at and the seconds per pixel. Zooming in
    // starts a new reference, so the handle doesn't jump.
    let ref = { x: e.clientX, d: draft(), perPx: length() / r.width };
    const timeOf = (d: Draft) => (what === 'end' ? d.end : d.start);
    let still = e.clientX;
    let timer = 0;
    const zoom = () => {
      const width = Math.min(FINE_SECONDS, length());
      if (width >= length() * 0.8) return; // a short sound is fine as it is
      const at = timeOf(draft());
      // The handle goes to the middle, with room on both sides; the drag is relative, so nothing jumps.
      const start = Math.min(length() - width, Math.max(0, at - width / 2));
      setView({ from: start, to: start + width });
      setFineWhat(what);
      ref = { x: still, d: draft(), perPx: width / r.width };
    };
    const arm = () => {
      clearTimeout(timer);
      if (!view()) timer = window.setTimeout(zoom, HOLD_MS);
    };
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - still) > 3) {
        still = ev.clientX;
        arm();
      }
      const at = timeOf(ref.d) + (ev.clientX - ref.x) * ref.perPx;
      place(what, at, ref.d);
      if (view()) follow();
    };
    /** While zoomed, the window slides along when the handle nears its edge. */
    const follow = () => {
      const v = view();
      if (!v) return;
      const at = timeOf(draft());
      const width = v.to - v.from;
      const edge = width * 0.08;
      let start = v.from;
      if (at < v.from + edge) start = at - edge;
      else if (at > v.to - edge) start = at + edge - width;
      start = Math.min(length() - width, Math.max(0, start));
      if (start !== v.from) setView({ from: start, to: start + width });
    };
    const up = () => {
      clearTimeout(timer);
      setView(null);
      setFineWhat(null);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    arm();
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  /** Arrow keys on a handle: 10 ms, or 100 ms with Shift. */
  const nudge = (e: KeyboardEvent, what: 'start' | 'end') => {
    const dir =
      e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : 0;
    if (!dir) return;
    e.preventDefault();
    const d = draft();
    place(what, (what === 'start' ? d.start : d.end) + dir * (e.shiftKey ? 0.1 : 0.01), d);
  };
  /** A click outside the selection moves it there. */
  const jump = (e: MouseEvent) => {
    const r = wave.getBoundingClientRect();
    const at = from() + ((e.clientX - r.left) / r.width) * viewSpan();
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
  /** Where a time is on the waveform as it's shown now (whole sound or zoomed window). */
  const pct = (sec: number) => `${((sec - from()) / viewSpan()) * 100}%`;
  const inView = (sec: number) => sec >= from() - 1e-6 && sec <= from() + viewSpan() + 1e-6;
  const fmt = (sec: number) => `${sec.toFixed(3)}s`;
  /** The selection as drawn: cut to the zoomed window. */
  const selFrom = () => Math.max(draft().start, from());
  const selTo = () => Math.min(draft().end, from() + viewSpan());

  return (
    <div class="sound-editor">
      <Show when={!failed()} fallback={<p class="error">{t("Couldn't read that sound")}</p>}>
        <div class="sound-wave" classList={{ fine: !!view() }} ref={wave} onClick={jump}>
          <div class="sound-bars">
            <For each={bars()}>{(v) => <i style={{ height: `${Math.max(4, v * 100)}%` }} />}</For>
          </div>
          <Show when={buf()}>
            <div
              class="sound-sel"
              style={{ left: pct(selFrom()), width: `${(Math.max(0, selTo() - selFrom()) / viewSpan()) * 100}%` }}
              onPointerDown={(e) => drag(e, 'both')}
              onClick={(e) => e.stopPropagation()}
            >
              <Show when={inView(draft().start)}>
                <span
                  class="sound-handle start"
                  tabindex="0"
                  role="slider"
                  aria-label={t('Clip start')}
                  aria-valuetext={fmt(draft().start)}
                  onPointerDown={(e) => drag(e, 'start')}
                  onKeyDown={(e) => nudge(e, 'start')}
                />
              </Show>
              <Show when={inView(draft().end)}>
                <span
                  class="sound-handle end"
                  tabindex="0"
                  role="slider"
                  aria-label={t('Clip end')}
                  aria-valuetext={fmt(draft().end)}
                  onPointerDown={(e) => drag(e, 'end')}
                  onKeyDown={(e) => nudge(e, 'end')}
                />
              </Show>
            </div>
            <Show when={fineWhat()}>
              {(w) => (
                <span class="sound-fine-label" style={{ left: pct(w() === 'end' ? draft().end : draft().start) }}>
                  {fmt(w() === 'end' ? draft().end : draft().start)}
                </span>
              )}
            </Show>
            <Show when={playhead() !== null && inView(playhead()!)}>
              <span class="sound-playhead" style={{ left: pct(playhead()!) }} />
            </Show>
          </Show>
        </div>
        <div class="sound-times">
          <span>{fmt(draft().start)}</span>
          <span class="muted">
            {p.song
              ? t('{n} selected (up to {max}s)', { n: fmt(draft().end - draft().start), max: MAX_SECONDS })
              : t('{n} selected (up to 5.2s)', { n: fmt(draft().end - draft().start) })}
          </span>
          <span>{fmt(draft().end)}</span>
        </div>
        <p class="sound-hint muted">
          {t('Hold a handle still to zoom in and place it to the millisecond. Arrow keys move a handle by 10 ms.')}
        </p>
        <div class="sound-editor-row">
          <button class="btn small-btn" disabled={!buf()} onClick={() => (playing ? stop() : preview())}>
            <I.Play size={14} /> {t('Preview')}
          </button>
          <label class="field grow">
            <span>{t('Volume {n}%', { n: Math.round(draft().volume * 100) })}</span>
            <Slider
              min={5}
              max={100}
              value={Math.round(draft().volume * 100)}
              onInput={(v) => set({ volume: v / 100 })}
            />
          </label>
        </div>
        <div class="sound-editor-row">
          <label class="field grow">
            <span>{p.song ? t('Title (optional)') : t('Name')}</span>
            <input
              value={draft().name}
              maxLength={p.song ? 80 : 32}
              placeholder={p.song ? t('Artist — Song') : undefined}
              onInput={(e) => set({ name: e.currentTarget.value })}
            />
          </label>
          <Show when={!p.song}>
            <div class="field emoji-field">
              <span>{t('Emoji')}</span>
              <div class="emoji-pick">
                <button
                  type="button"
                  class="emoji-pick-btn"
                  classList={{ empty: !draft().emoji }}
                  aria-label={t('Pick an emoji')}
                  data-tip={t('Pick an emoji')}
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    const below = r.bottom + 6 + 368 < innerHeight;
                    setPicker({
                      x: Math.max(8, Math.min(r.left, innerWidth - 348)),
                      y: below ? r.bottom + 6 : Math.max(8, r.top - 366),
                    });
                  }}
                >
                  {draft().emoji || '🔊'}
                </button>
                <Show when={draft().emoji}>
                  <button
                    type="button"
                    class="emoji-pick-clear"
                    aria-label={t('Remove emoji')}
                    onClick={() => set({ emoji: '' })}
                  >
                    <I.Close size={12} />
                  </button>
                </Show>
              </div>
            </div>
          </Show>
        </div>
        <Show when={picker()}>
          {(at) => (
            <Portal>
              {/* Only the app's emoji: a sound's emoji is shown as text, server emoji wouldn't draw. */}
              <EmojiPicker
                unicodeOnly
                class="message-picker sound-emoji-picker"
                style={{ left: `${at().x}px`, top: `${at().y}px` }}
                onClose={() => setPicker(null)}
                onPick={(picked) => {
                  set({ emoji: picked.text });
                  setPicker(null);
                }}
              />
            </Portal>
          )}
        </Show>
        <div class="sound-editor-actions">
          <button class="link-btn" onClick={p.onCancel}>
            {t('Cancel')}
          </button>
          <button
            class="btn primary small-btn"
            disabled={busy() || !buf() || (!p.song && draft().name.trim().length < 2)}
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
        {t('Sounds anyone in a call can play for everyone. Pick any audio file and choose up to 5 seconds of it.')}{' '}
        {t('{n} of {max} sounds.', { n: list().length, max: MAX_SOUNDS })}
      </p>
      <Show when={manage()}>
        <Show
          when={file()}
          keyed
          fallback={
            <label class="btn small-btn sound-pick" classList={{ disabled: list().length >= MAX_SOUNDS }}>
              <I.Plus size={14} /> {t('Choose a sound')}
              <input
                ref={input}
                type="file"
                accept="audio/*,.mp3,.ogg,.wav,.webm,.m4a"
                hidden
                disabled={list().length >= MAX_SOUNDS}
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
