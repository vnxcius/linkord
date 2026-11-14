// REC's studio (its button sits beside Settings in the dock). Its own part of the app, not a Settings page (owner,
// 2026-11-13: easier to browse and to configure): a top bar (Library / Shared / Settings, what's recording, the folder),
// then
// - Library: filters on the left (kind, game, starred, space used), a search and sort bar, everything recorded grouped
//   by day. VOD cards scrub through their thumbnails on hover. Opening one shows the viewer: the player (RecPlayer.tsx:
//   overview + zoomed filmstrip lanes, moments, a clip editor on both) beside a panel with its details, actions and
//   moments list.
// - Shared: your clips on the server (web too), playable the same way.
// - Settings: one page of cards with an index (quality presets, audio sources and devices, clips, hotkeys, storage,
//   League, privacy). The web app only has Privacy.
// Recording only happens in the Windows app. Recordings are read straight off disk through Tauri's asset protocol
// (scoped to the REC folder by the shell).

import { convertFileSrc } from '@tauri-apps/api/core';
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  type JSX,
} from 'solid-js';
import { api, media, serverUrl } from '../lib/api';
import { shareFile } from '../lib/clip-share';
import { currentGame } from '../lib/games';
import { dateLocale, plural, t } from '../lib/i18n';
import { ACTIONS, REC_ACTIONS, type Combo, type KeyAction } from '../lib/keys';
import { msg } from '../lib/msg';
import { captureCapabilities } from '../lib/native-capture';
import { prefs, setPrefs, type LeagueClipPrefs, type RecPrefs } from '../lib/prefs';
import {
  displayPicker,
  lastSaved,
  listDisplays,
  recAvailable,
  recCall,
  recDesktop,
  recStatus,
  recToggle,
  setDisplayPicker,
  setRecPrefs,
} from '../lib/rec';
import { state } from '../lib/store';
import type { SharedClip } from '../lib/types';
import { openMenu, setUi, toast, type MenuEntry } from '../lib/ui';
import { voiceUi } from '../lib/voice';
import type { VodPart } from '../lib/vod-player';
import * as I from './Icons';
import { formatSize } from './MessageItem';
import { RecIntro, RecSetup } from './RecIntro';
import { clock, markText, RecPlayer, type Mark, type PlayerControl } from './RecPlayer';
import { KeyRecorder, useDevices } from './Settings';
import { Slider } from './ui/slider';

export { clock };

// ---------- data (src-tauri/src/rec/model.rs) ----------

interface Meta {
  game: string;
  title: string;
  started: number;
  duration_ms: number;
  width: number;
  height: number;
  stems: string[];
  bookmarks: number[];
  events: Mark[];
  starred: boolean;
}

interface ItemMeta {
  game: string;
  title: string;
  created: number;
  duration_ms: number;
  source: string;
  starred: boolean;
  shared: string | null;
}

interface Library {
  folder: string;
  vods: { dir: string; meta: Meta; size: number; thumb: string | null; recording: boolean }[];
  clips: { path: string; meta: ItemMeta; size: number }[];
  screenshots: { path: string; meta: ItemMeta; size: number }[];
  vod_bytes: number;
  clip_bytes: number;
  free_bytes: number | null;
}

interface VodIndex {
  meta: Meta;
  parts: VodPart[];
  thumbs: [number, string][];
}

type Kind = 'vod' | 'clip' | 'shot';

/** One thing in the library, whatever it is. */
interface Item {
  kind: Kind;
  /** The VOD's folder or the file. */
  path: string;
  title: string;
  game: string;
  at: number;
  duration: number;
  size: number;
  starred: boolean;
  shared: string | null;
  thumb: string | null;
  recording: boolean;
  /** Clips: the VOD folder they came from. */
  source: string;
  moments: number;
}

const items = (lib: Library | null | undefined): Item[] =>
  lib
    ? [
        ...lib.vods.map((v) => ({
          kind: 'vod' as const,
          path: v.dir,
          title: v.meta.title,
          game: v.meta.game,
          at: v.meta.started,
          duration: v.meta.duration_ms,
          size: v.size,
          starred: v.meta.starred,
          shared: null,
          thumb: v.thumb,
          recording: v.recording,
          source: '',
          moments: v.meta.bookmarks.length + v.meta.events.length,
        })),
        ...lib.clips.map((c) => ({
          kind: 'clip' as const,
          path: c.path,
          title: c.meta.title,
          game: c.meta.game,
          at: c.meta.created,
          duration: c.meta.duration_ms,
          size: c.size,
          starred: c.meta.starred,
          shared: c.meta.shared,
          thumb: null,
          recording: false,
          source: c.meta.source,
          moments: 0,
        })),
        ...lib.screenshots.map((s) => ({
          kind: 'shot' as const,
          path: s.path,
          title: s.meta.title,
          game: s.meta.game,
          at: s.meta.created,
          duration: 0,
          size: s.size,
          starred: s.meta.starred,
          shared: null,
          thumb: s.path,
          recording: false,
          source: '',
          moments: 0,
        })),
      ]
    : [];

const src = (path: string) => convertFileSrc(path);
const nameOf = (i: { title: string; game: string }) => i.title || i.game || t('Recording');
const when = (ms: number) => new Date(ms).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' });
const fullDate = (ms: number) =>
  new Date(ms).toLocaleString(dateLocale(), {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

/** "Today", "Yesterday", else the date. */
function dayOf(ms: number) {
  const d = new Date(ms);
  const today = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(today) - start(d)) / 86_400_000);
  if (days === 0) return t('Today');
  if (days === 1) return t('Yesterday');
  return d.toLocaleDateString(dateLocale(), {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  });
}

const KIND_NAMES: Record<Kind, string> = { vod: msg('VOD'), clip: msg('Clip'), shot: msg('Screenshot') };
const KIND_ICONS: Record<Kind, (p: { size?: number }) => JSX.Element> = {
  vod: I.Film,
  clip: I.Scissors,
  shot: I.Photo,
};

// ---------- the studio ----------

type View = 'library' | 'shared' | 'settings';
type Filter = 'all' | Kind;
type Open = { kind: Kind; path: string } | { kind: 'shared'; clip: SharedClip } | null;

/** Old tab names (the overlay and older code open REC on one). */
const SECTION_OF: Record<string, string> = {
  recording: 'recording',
  audio: 'audio',
  hotkeys: 'hotkeys',
  storage: 'storage',
  league: 'league',
  privacy: 'privacy',
};

export function RecPage(p: { tab?: string }) {
  // Opt-in (owner, 2026-11-14): the Windows app shows the introduction (and the first time, the setup) until REC is on.
  // "Run the setup again" (owner, same day): the introduction and the setup as the first time, while REC stays on;
  // Not now goes back to the studio.
  const locked = () => recAvailable && (!prefs.rec.enabled || replaying());
  const [setup, setSetup] = createSignal(false);
  onCleanup(() => setReplaying(false));
  const turnOn = () => {
    setRecPrefs({ enabled: true, setupDone: true });
    setSetup(false);
    setReplaying(false);
  };
  return (
    <Show
      when={!locked()}
      fallback={
        <div class="rs" role="dialog" aria-label="REC">
          <header class="rs-top">
            <div class="rs-brand">
              <I.Rec size={20} />
              <span>REC</span>
            </div>
            <span class="grow" />
            <button class="rs-close" onClick={() => setUi('modal', null)} aria-label={t('Close REC')}>
              <I.Close size={18} />
              <span>ESC</span>
            </button>
          </header>
          <Show
            when={setup()}
            fallback={
              <RecIntro
                onAccept={() => (prefs.rec.setupDone && !replaying() ? turnOn() : setSetup(true))}
                onLater={() => (replaying() ? setReplaying(false) : setUi('modal', null))}
              />
            }
          >
            <RecSetup onDone={turnOn} onBack={() => setSetup(false)} />
          </Show>
          <EscCloses />
        </div>
      }
    >
      <Studio tab={p.tab} />
    </Show>
  );
}

/** Showing the introduction and setup again from the settings, with REC on. */
const [replaying, setReplaying] = createSignal(false);

/** Esc closes the locked REC page (the studio has its own, which also closes a viewer first). */
function EscCloses() {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !e.defaultPrevented) setUi('modal', null);
  };
  onMount(() => window.addEventListener('keydown', onKey));
  onCleanup(() => window.removeEventListener('keydown', onKey));
  return null;
}

function Studio(p: { tab?: string }) {
  const desktop = recAvailable;
  const initial = (): View => {
    if (p.tab === 'shared' || !desktop) return p.tab && SECTION_OF[p.tab] ? 'settings' : 'shared';
    return p.tab && SECTION_OF[p.tab] ? 'settings' : 'library';
  };
  const [view, setView] = createSignal<View>(initial());
  const [filter, setFilter] = createSignal<Filter>(
    p.tab === 'clips' ? 'clip' : p.tab === 'screenshots' ? 'shot' : p.tab === 'vods' ? 'vod' : 'all',
  );
  const [section, setSection] = createSignal(p.tab ? (SECTION_OF[p.tab] ?? '') : '');
  const [open, setOpen] = createSignal<Open>(null);
  const [library, { refetch }] = createResource(
    () => desktop,
    (on) => (on ? recCall<Library>('rec_library') : Promise.resolve(null)),
  );
  // New things saved, a recording starting or ending: the library is the folder, read it again.
  createEffect(on([lastSaved, () => recStatus().recording], () => void refetch(), { defer: true }));
  const close = () => setUi('modal', null);
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented || document.fullscreenElement) return;
    if (open()) setOpen(null);
    else close();
  };
  onMount(() => window.addEventListener('keydown', onKey));
  onCleanup(() => window.removeEventListener('keydown', onKey));
  const go = (v: View, sectionId = '') => {
    setView(v);
    setOpen(null);
    setSection(sectionId);
  };

  return (
    <div class="rs" role="dialog" aria-label="REC">
      <header class="rs-top">
        <div class="rs-brand">
          <I.Rec size={20} />
          <span>REC</span>
        </div>
        <nav class="rs-tabs" aria-label="REC">
          <Show when={desktop}>
            <button classList={{ active: view() === 'library' }} onClick={() => go('library')}>
              <I.Grid size={17} /> {t('Library')}
            </button>
          </Show>
          <button classList={{ active: view() === 'shared' }} onClick={() => go('shared')}>
            <I.CloudUp size={17} /> {t('Shared')}
          </button>
          <button classList={{ active: view() === 'settings' }} onClick={() => go('settings')}>
            <I.Sliders size={17} /> {t('Settings')}
          </button>
        </nav>
        <span class="grow" />
        <Show when={desktop}>
          <RecState />
          <button
            class="rs-icon"
            aria-label={t('Open the REC folder')}
            data-tip={t('Open the REC folder')}
            onClick={() => void recCall('rec_reveal', { path: null })}
          >
            <I.FolderOpen size={18} />
          </button>
        </Show>
        <button class="rs-close" onClick={close} aria-label={t('Close REC')}>
          <I.Close size={18} />
          <span>ESC</span>
        </button>
      </header>

      <Switch>
        <Match when={open()}>
          {(o) => (
            <Viewer open={o()} library={library()} onClose={() => setOpen(null)} onOpen={setOpen} refetch={refetch} />
          )}
        </Match>
        <Match when={view() === 'library'}>
          <LibraryView
            library={library()}
            loading={library.loading}
            filter={filter()}
            setFilter={setFilter}
            onOpen={(i) => setOpen({ kind: i.kind, path: i.path })}
            onStorage={() => go('settings', 'storage')}
            refetch={refetch}
          />
        </Match>
        <Match when={view() === 'shared'}>
          <SharedView onOpen={(clip) => setOpen({ kind: 'shared', clip })} />
        </Match>
        <Match when={view() === 'settings'}>
          <SettingsView library={library()} section={section()} />
        </Match>
      </Switch>
    </div>
  );
}

/** Recording or not: the only place besides the overlay that says so. */
function RecState() {
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(timer));
  const s = recStatus;
  return (
    <div class="rs-state" classList={{ on: s().recording }}>
      <span class="rs-dot" aria-hidden="true" />
      <span class="rs-state-text">
        <Show
          when={s().recording}
          fallback={
            <>
              <strong>{t('Not recording')}</strong>
              <small>
                {s().error ?? (prefs.rec.auto ? t('Starts with your next game') : t('Recording games is off'))}
              </small>
            </>
          }
        >
          <strong>
            {t('Recording')} · {clock(now() - (s().since ?? now()))}
          </strong>
          <small>{s().paused ? t('{game} (window covered)', { game: s().game ?? '' }) : s().game}</small>
        </Show>
      </span>
      <button class="rs-state-btn" onClick={() => void recToggle()}>
        {s().recording ? t('Stop') : t('Record now')}
      </button>
      <Show when={displayPicker()}>
        <DisplayPicker />
      </Show>
    </div>
  );
}

/** Which display a desktop recording records (REC records games by itself, the desktop only when you ask). */
function DisplayPicker() {
  const [displays] = createResource(() => listDisplays().catch(() => []));
  const last = () => prefs.rec.display?.id;
  let el!: HTMLDivElement;
  const close = () => setDisplayPicker(false);
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  const onDown = (e: PointerEvent) => !el.contains(e.target as Node) && close();
  onMount(() => {
    window.addEventListener('keydown', onKey, true);
    // The click that opened it is still on its way: listen from the next one.
    setTimeout(() => window.addEventListener('pointerdown', onDown, true));
  });
  onCleanup(() => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('pointerdown', onDown, true);
  });
  return (
    <div class="rs-displays" ref={el} role="dialog" aria-label={t('Record a display')}>
      <header>
        <strong>{t('Record a display')}</strong>
        <small>{t('No game is running, so pick which screen to record.')}</small>
      </header>
      <Show when={!displays.loading} fallback={<small class="muted">{t('Looking for displays…')}</small>}>
        <Show when={displays()?.length} fallback={<small class="muted">{t('No displays found.')}</small>}>
          <div class="rs-display-list">
            <For each={displays()}>
              {(d, i) => (
                <button classList={{ last: d.id === last() }} onClick={() => void recDesktop(d)}>
                  <span class="rs-display-shot">
                    <Show when={d.thumbnail} fallback={<I.Screen size={26} />}>
                      <img src={d.thumbnail!} alt="" />
                    </Show>
                  </span>
                  <span class="rs-display-name">
                    <strong>{d.name || t('Display {n}', { n: i() + 1 })}</strong>
                    <small>
                      {d.width} × {d.height}
                    </small>
                  </span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  );
}

// ---------- library ----------

type Sort = 'new' | 'old' | 'long' | 'big';

function LibraryView(p: {
  library: Library | null | undefined;
  loading: boolean;
  filter: Filter;
  setFilter: (f: Filter) => void;
  onOpen: (i: Item) => void;
  onStorage: () => void;
  refetch: () => void;
}) {
  const [game, setGame] = createSignal<string | null>(null);
  const [starred, setStarred] = createSignal(false);
  const [query, setQuery] = createSignal('');
  const [sort, setSort] = createSignal<Sort>('new');
  const all = createMemo(() => items(p.library));
  const count = (k: Filter) => (k === 'all' ? all().length : all().filter((i) => i.kind === k).length);
  const games = createMemo(() => {
    const m = new Map<string, number>();
    for (const i of all()) if (i.game) m.set(i.game, (m.get(i.game) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  });
  const shown = createMemo(() => {
    const q = query().trim().toLowerCase();
    const list = all().filter(
      (i) =>
        (p.filter === 'all' || i.kind === p.filter) &&
        (!game() || i.game === game()) &&
        (!starred() || i.starred) &&
        (!q || `${i.title} ${i.game}`.toLowerCase().includes(q)),
    );
    const by: Record<Sort, (a: Item, b: Item) => number> = {
      new: (a, b) => b.at - a.at,
      old: (a, b) => a.at - b.at,
      long: (a, b) => b.duration - a.duration,
      big: (a, b) => b.size - a.size,
    };
    return list.sort(by[sort()]);
  });
  /** Grouped by day when sorted by date; one group otherwise. */
  const groups = createMemo(() => {
    if (sort() !== 'new' && sort() !== 'old') return [{ day: '', items: shown() }];
    const out: { day: string; items: Item[] }[] = [];
    for (const i of shown()) {
      const day = dayOf(i.at);
      if (out.at(-1)?.day === day) out.at(-1)!.items.push(i);
      else out.push({ day, items: [i] });
    }
    return out;
  });
  // ---------- selection ----------
  // Click a card's box (or Ctrl+click a card) to select; Shift+click selects the range from the last one; Ctrl+A selects
  // everything shown; Esc clears. While something is selected a click on a card selects it instead of opening it.
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
  const [selectMode, setSelectMode] = createSignal(false);
  const selecting = () => selectMode() || selected().size > 0;
  const chosen = createMemo(() => all().filter((i) => selected().has(i.path)));
  let anchor: string | null = null;
  const clear = () => (setSelected(new Set<string>()), setSelectMode(false), (anchor = null));
  const toggle = (i: Item, e: MouseEvent) => {
    const next = new Set(selected());
    const list = shown();
    const from = anchor ? list.findIndex((x) => x.path === anchor) : -1;
    if (e.shiftKey && from >= 0) {
      const to = list.findIndex((x) => x.path === i.path);
      for (const x of list.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(x.path);
    } else if (next.has(i.path)) next.delete(i.path);
    else next.add(i.path);
    anchor = i.path;
    setSelected(next);
  };
  const click = (i: Item, e: MouseEvent) => {
    if (selecting() || e.ctrlKey || e.metaKey || e.shiftKey) toggle(i, e);
    else p.onOpen(i);
  };
  /** Right-click on a card: its quick actions. */
  const menu = (i: Item, e: MouseEvent) => {
    const vod = i.source ? all().find((x) => x.kind === 'vod' && x.path === i.source) : undefined;
    openMenu(
      e,
      itemMenu(i, {
        open: () => p.onOpen(i),
        openVod: vod && (() => p.onOpen(vod)),
        select: () => (setSelectMode(true), selected().has(i.path) || toggle(i, e)),
        refetch: p.refetch,
      }),
    );
  };
  // Things that disappear (deleted, filtered away by a refetch) leave the selection.
  createEffect(
    on(all, (list) => {
      const paths = new Set(list.map((i) => i.path));
      if ([...selected()].some((x) => !paths.has(x))) setSelected(new Set([...selected()].filter((x) => paths.has(x))));
    }),
  );
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, textarea, select')) return;
    if (e.key === 'Escape' && selecting()) {
      e.preventDefault();
      clear();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      setSelected(new Set(shown().map((i) => i.path)));
    }
  };
  // Capture: runs before the studio's own Escape (which would close REC).
  onMount(() => window.addEventListener('keydown', onKey, true));
  onCleanup(() => window.removeEventListener('keydown', onKey, true));

  const gb = 1024 ** 3;
  const FILTERS: [Filter, string, (p: { size?: number }) => JSX.Element][] = [
    ['all', msg('Everything'), I.Grid],
    ['vod', msg('VODs'), I.Film],
    ['clip', msg('Clips'), I.Scissors],
    ['shot', msg('Screenshots'), I.Photo],
  ];

  return (
    <div class="rs-library" classList={{ selecting: selecting() }}>
      <aside class="rs-filters">
        <div class="rs-filter-group">
          <span class="rs-label">{t('Show')}</span>
          <For each={FILTERS}>
            {([id, label, Icon]) => (
              <button class="rs-filter" classList={{ active: p.filter === id }} onClick={() => p.setFilter(id)}>
                <Icon size={17} />
                <span class="grow">{t(label)}</span>
                <span class="rs-count">{count(id)}</span>
              </button>
            )}
          </For>
          <button class="rs-filter" classList={{ active: starred() }} onClick={() => setStarred(!starred())}>
            <I.Star size={17} />
            <span class="grow">{t('Starred only')}</span>
            <span class="rs-count">{all().filter((i) => i.starred).length}</span>
          </button>
        </div>
        <Show when={games().length}>
          <div class="rs-filter-group">
            <span class="rs-label">{t('Games')}</span>
            <button class="rs-filter" classList={{ active: !game() }} onClick={() => setGame(null)}>
              <I.Gamepad size={17} />
              <span class="grow">{t('All games')}</span>
            </button>
            <For each={games()}>
              {([name, n]) => (
                <button
                  class="rs-filter"
                  classList={{ active: game() === name }}
                  onClick={() => setGame(game() === name ? null : name)}
                >
                  <span class="rs-game-dot">{name.slice(0, 1).toUpperCase()}</span>
                  <span class="grow rs-ellipsis">{name}</span>
                  <span class="rs-count">{n}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
        <Show when={p.library}>
          {(lib) => (
            <button class="rs-space" onClick={p.onStorage}>
              <span class="rs-label">{t('Space used')}</span>
              <Meter label={t('VODs')} used={lib().vod_bytes} cap={prefs.rec.vodCapGb * gb} />
              <Meter label={t('Clips and screenshots')} used={lib().clip_bytes} cap={prefs.rec.clipCapGb * gb} />
              <Show when={lib().free_bytes != null}>
                <small class="muted">{t('{size} free on this drive', { size: formatSize(lib().free_bytes!) })}</small>
              </Show>
            </button>
          )}
        </Show>
      </aside>

      <main class="rs-main">
        <div class="rs-toolbar">
          <label class="rs-search">
            <I.Search size={16} />
            <input
              type="search"
              placeholder={t('Search recordings')}
              aria-label={t('Search recordings')}
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
          </label>
          <span class="grow muted small">{plural(shown().length, '{n} item', '{n} items')}</span>
          <button
            class="rs-select-btn"
            classList={{ active: selecting() }}
            onClick={() => (selecting() ? clear() : setSelectMode(true))}
          >
            <I.Check size={16} /> {selecting() ? t('Done') : t('Select')}
          </button>
          <label class="rs-sort">
            <span class="muted small">{t('Sort')}</span>
            <select value={sort()} onChange={(e) => setSort(e.currentTarget.value as Sort)}>
              <option value="new">{t('Newest first')}</option>
              <option value="old">{t('Oldest first')}</option>
              <option value="long">{t('Longest first')}</option>
              <option value="big">{t('Largest first')}</option>
            </select>
          </label>
        </div>

        <Show
          when={shown().length}
          fallback={
            <Show when={!p.loading}>
              <div class="rs-empty">
                <I.Rec size={30} />
                <strong>{all().length ? t('Nothing matches') : t('Nothing recorded yet')}</strong>
                <p class="muted small">
                  {all().length
                    ? t('Try another filter or search.')
                    : t('Play a game: REC records it from start to end. Press your clip hotkey for the best moments.')}
                </p>
              </div>
            </Show>
          }
        >
          <For each={groups()}>
            {(g) => (
              <section class="rs-day">
                <Show when={g.day}>
                  <h2>
                    {g.day} <span class="rs-count">{g.items.length}</span>
                  </h2>
                </Show>
                <div class="rs-grid">
                  <For each={g.items}>
                    {(i) => (
                      <Card
                        item={i}
                        selected={selected().has(i.path)}
                        onClick={(e) => click(i, e)}
                        onToggle={(e) => toggle(i, e)}
                        onMenu={(e) => menu(i, e)}
                        refetch={p.refetch}
                      />
                    )}
                  </For>
                </div>
              </section>
            )}
          </For>
        </Show>
        <Show when={selecting()}>
          <SelectionBar
            items={chosen()}
            total={shown().length}
            onAll={() => setSelected(new Set(shown().map((i) => i.path)))}
            onClear={clear}
            refetch={p.refetch}
          />
        </Show>
      </main>
    </div>
  );
}

/** What can be done to everything selected at once. */
function SelectionBar(p: {
  items: Item[];
  total: number;
  onAll: () => void;
  onClear: () => void;
  refetch: () => void;
}) {
  const [confirm, setConfirm] = createSignal(false);
  const [busy, setBusy] = createSignal<string | null>(null);
  const size = () => p.items.reduce((n, i) => n + i.size, 0);
  const deletable = () => p.items.filter((i) => !i.recording);
  const clips = () => p.items.filter((i) => i.kind === 'clip');
  const unshared = () => clips().filter((i) => !i.shared);
  const links = () => clips().filter((i) => i.shared);
  const allStarred = () => p.items.length > 0 && p.items.every((i) => i.starred);
  /** One change per item, one after another; the library is read again at the end. */
  const each = async (label: string, list: Item[], run: (i: Item) => Promise<unknown>) => {
    const failed: string[] = [];
    for (const [n, i] of list.entries()) {
      setBusy(`${label} ${n + 1}/${list.length}`);
      await run(i).catch((e) => failed.push(`${nameOf(i)}: ${e instanceof Error ? e.message : e}`));
    }
    setBusy(null);
    p.refetch();
    if (failed.length) toast(failed.join('\n'));
    return failed.length;
  };
  const star = () =>
    void each(t('Saving…'), p.items, (i) => recCall('rec_update', { path: i.path, starred: !allStarred() }));
  const remove = async () => {
    if (!confirm()) return void (setConfirm(true), setTimeout(() => setConfirm(false), 3000));
    setConfirm(false);
    const list = deletable();
    const failed = await each(t('Deleting…'), list, (i) => recCall('rec_delete', { path: i.path }));
    if (!failed) toast(plural(list.length, '{n} item deleted', '{n} items deleted'));
    p.onClear();
  };
  const share = async () => {
    const slugs: string[] = links().map((i) => i.shared!);
    await each(t('Uploading…'), unshared(), async (i) => {
      const meta = { title: i.title, game: i.game, kind: 'clip' as const };
      const clip = await shareFile(i.path, meta, () => {});
      await recCall('rec_update', { path: i.path, shared: clip.slug });
      slugs.push(clip.slug);
    });
    if (slugs.length) await copyLinks(slugs);
  };
  return (
    <div class="rs-selbar" role="toolbar" aria-label={t('Selection')}>
      <span class="rs-selbar-count">
        <strong>{plural(p.items.length, '{n} selected', '{n} selected')}</strong>
        <small class="muted">{formatSize(size())}</small>
      </span>
      <Show when={p.items.length < p.total}>
        <button class="rs-sel-action" onClick={p.onAll}>
          {t('Select all')}
        </button>
      </Show>
      <span class="rs-sep" />
      <Show when={busy()} fallback={<></>}>
        <span class="muted small">{busy()}</span>
      </Show>
      <button class="rs-sel-action" disabled={!p.items.length || !!busy()} onClick={star}>
        <I.Star size={16} /> {allStarred() ? t('Unstar') : t('Star')}
      </button>
      <Show when={clips().length}>
        <button class="rs-sel-action" disabled={!!busy()} onClick={() => void share()}>
          <I.CloudUp size={16} />{' '}
          {unshared().length
            ? plural(clips().length, 'Share {n} clip', 'Share {n} clips')
            : plural(clips().length, 'Copy {n} link', 'Copy {n} links')}
        </button>
      </Show>
      <button
        class="rs-sel-action danger"
        classList={{ confirm: confirm() }}
        disabled={!deletable().length || !!busy()}
        onClick={() => void remove()}
      >
        <I.Trash size={16} />{' '}
        {confirm() ? t('Click again to delete') : plural(deletable().length, 'Delete {n}', 'Delete {n}')}
      </button>
      <button
        class="rs-icon"
        aria-label={t('Clear selection')}
        data-tip={t('Clear selection (Esc)')}
        onClick={p.onClear}
      >
        <I.Close size={16} />
      </button>
    </div>
  );
}

function Meter(p: { label: string; used: number; cap: number }) {
  const share = () => Math.min(1, p.used / Math.max(1, p.cap));
  return (
    <div class="rs-meter">
      <div class="rs-meter-text">
        <span>{p.label}</span>
        <span class="muted">
          {formatSize(p.used)} / {formatSize(p.cap)}
        </span>
      </div>
      <div class="rs-meter-bar">
        <span style={{ width: `${share() * 100}%` }} classList={{ full: share() >= 0.95 }} />
      </div>
    </div>
  );
}

/** A VOD's thumbnails, read once (hover scrubbing on its card). */
const vodThumbs = new Map<string, Promise<[number, string][]>>();
const thumbsOf = (dir: string) => {
  if (!vodThumbs.has(dir))
    vodThumbs.set(
      dir,
      recCall<VodIndex>('rec_vod', { dir })
        .then((i) => i.thumbs.map(([ms, path]) => [ms, src(path)] as [number, string]))
        .catch(() => []),
    );
  return vodThumbs.get(dir)!;
};

function Card(p: {
  item: Item;
  selected: boolean;
  onClick: (e: MouseEvent) => void;
  onToggle: (e: MouseEvent) => void;
  onMenu: (e: MouseEvent) => void;
  refetch: () => void;
}) {
  const i = () => p.item;
  const Icon = KIND_ICONS[p.item.kind];
  const [scrub, setScrub] = createSignal<string | null>(null);
  const [frac, setFrac] = createSignal<number | null>(null);
  const onMove = (e: MouseEvent) => {
    if (i().kind !== 'vod') return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    setFrac(f);
    void thumbsOf(i().path).then((list) => {
      if (!list.length || frac() === null) return;
      setScrub(list[Math.min(list.length - 1, Math.floor(f * list.length))][1]);
    });
  };
  const star = (e: MouseEvent) => {
    e.stopPropagation();
    void recCall('rec_update', { path: i().path, starred: !i().starred })
      .then(p.refetch)
      .catch((err) => toast(String(err)));
  };
  return (
    <div
      class="rs-card"
      classList={{ selected: p.selected }}
      role="button"
      tabIndex={0}
      aria-pressed={p.selected}
      onClick={(e) => p.onClick(e)}
      onContextMenu={(e) => p.onMenu(e)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') p.onClick(e as unknown as MouseEvent);
        if (e.key === ' ') (e.preventDefault(), p.onToggle(e as unknown as MouseEvent));
      }}
    >
      <div class="rs-thumb" onMouseMove={onMove} onMouseLeave={() => (setFrac(null), setScrub(null))}>
        <Switch fallback={<Icon size={28} />}>
          <Match when={scrub()}>{(s) => <img src={s()} alt="" draggable={false} />}</Match>
          <Match when={i().kind === 'clip'}>
            <ClipFrame path={i().path} />
          </Match>
          <Match when={i().thumb}>{(th) => <img src={src(th())} alt="" loading="lazy" draggable={false} />}</Match>
        </Switch>
        <span class="rs-kind">
          <Icon size={13} /> {t(KIND_NAMES[i().kind])}
        </span>
        <Show when={i().recording}>
          <span class="rs-live">
            <span class="rs-dot" /> {t('Recording')}
          </span>
        </Show>
        <Show when={i().duration && !i().recording}>
          <span class="rs-length">{clock(i().duration)}</span>
        </Show>
        <Show when={frac() !== null}>
          <span class="rs-scrub" style={{ left: `${frac()! * 100}%` }} />
        </Show>
        <button
          class="rs-check"
          role="checkbox"
          aria-checked={p.selected}
          aria-label={t('Select')}
          onClick={(e) => (e.stopPropagation(), p.onToggle(e))}
        >
          <I.Check size={15} />
        </button>
        <button
          class="rs-star"
          classList={{ on: i().starred }}
          aria-label={i().starred ? t('Unstar') : t('Star')}
          data-tip={i().starred ? t('Starred: never deleted to make room') : t('Star: never deleted to make room')}
          onClick={star}
        >
          <I.Star size={16} />
        </button>
      </div>
      <div class="rs-card-text">
        <strong>{nameOf(i())}</strong>
        <small>
          <Show when={i().title && i().game}>{i().game} · </Show>
          {when(i().at)} · {formatSize(i().size)}
          <Show when={i().shared}>
            {' '}
            · <I.Link size={12} />
          </Show>
          <Show when={i().moments}> · {plural(i().moments, '{n} moment', '{n} moments')}</Show>
        </small>
      </div>
    </div>
  );
}

/** A library item's right-click menu: what its viewer offers, without opening it. */
function itemMenu(
  i: Item,
  o: { open: () => void; openVod?: () => void; select: () => void; refetch: () => void },
): MenuEntry[] {
  const fail = (e: unknown) => toast(String(e instanceof Error ? e.message : e));
  const update = (patch: Record<string, unknown>) =>
    recCall('rec_update', { path: i.path, ...patch })
      .then(o.refetch)
      .catch(fail);
  const share = async () => {
    toast(t('Uploading…'), 60_000);
    try {
      const clip = await shareFile(i.path, { title: i.title, game: i.game, kind: 'clip' }, () => {});
      await recCall('rec_update', { path: i.path, shared: clip.slug });
      o.refetch();
      await copyLink(clip.slug);
    } catch (e) {
      fail(e);
    }
  };
  const remove = (at: { x: number; y: number }) =>
    setUi('menu', {
      ...at,
      items: [
        { label: t('Delete "{name}"?', { name: nameOf(i) }), disabled: true },
        {
          label: t('Delete'),
          icon: () => <I.Trash size={16} />,
          danger: true,
          run: () => recCall('rec_delete', { path: i.path }).then(o.refetch).catch(fail),
        },
        { label: t('Cancel'), run: () => {} },
      ],
    });
  const channel = voiceUi.channelId;
  return [
    {
      label: i.kind === 'vod' ? t('Open in the player') : t('Open'),
      icon: () => <I.Play size={16} />,
      run: o.open,
    },
    ...(o.openVod ? [{ label: t('Open the VOD it came from'), icon: () => <I.Film size={16} />, run: o.openVod }] : []),
    'separator',
    ...(i.kind === 'clip'
      ? i.shared
        ? [
            {
              label: t('Copy link'),
              icon: () => <I.Link size={16} />,
              run: () => void copyLink(i.shared!),
            },
            ...(channel
              ? [
                  {
                    label: t('Watch together in the call'),
                    icon: () => <I.Play size={16} />,
                    run: () =>
                      void import('../lib/watch').then((w) => w.startWatch(channel, linkOf(i.shared!))).catch(fail),
                  },
                ]
              : []),
          ]
        : [{ label: t('Share'), icon: () => <I.CloudUp size={16} />, run: () => void share() }]
      : []),
    ...(i.kind === 'shot'
      ? [{ label: t('Copy Image'), icon: () => <I.Copy size={16} />, run: () => void copyPicture(i.path) }]
      : []),
    {
      label: i.starred ? t('Unstar') : t('Star'),
      icon: () => <I.Star size={16} />,
      run: () => void update({ starred: !i.starred }),
    },
    { label: t('Select'), icon: () => <I.Check size={16} />, run: o.select },
    'separator',
    {
      label: t('Show in folder'),
      icon: () => <I.FolderOpen size={16} />,
      run: () => void recCall('rec_reveal', { path: i.path }),
    },
    {
      label: t('Copy path'),
      run: () => navigator.clipboard.writeText(i.path).then(() => toast(t('Path copied'))),
    },
    ...(i.recording
      ? []
      : ([
          'separator',
          { label: t('Delete'), icon: () => <I.Trash size={16} />, danger: true, run: remove },
        ] as MenuEntry[])),
  ];
}

/** A screenshot to the clipboard (as PNG: what the clipboard takes, even when the file is a JPEG). */
async function copyPicture(path: string) {
  try {
    const blob = await (await fetch(src(path))).blob();
    const png =
      blob.type === 'image/png'
        ? blob
        : await createImageBitmap(blob).then((bitmap) => {
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
            return canvas.convertToBlob({ type: 'image/png' });
          });
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    toast(t('Image copied'));
  } catch {
    toast(t("Couldn't copy this image"));
  }
}

/** A clip's frame, only loaded while its card is on screen (lazy media rule). */
function ClipFrame(p: { path: string }) {
  const [visible, setVisible] = createSignal(false);
  let el!: HTMLSpanElement;
  onMount(() => {
    const io = new IntersectionObserver(([e]) => e.isIntersecting && (setVisible(true), io.disconnect()));
    io.observe(el);
    onCleanup(() => io.disconnect());
  });
  return (
    <span class="rs-frame" ref={el}>
      <Show when={visible()} fallback={<I.Scissors size={26} />}>
        <video src={`${src(p.path)}#t=0.5`} preload="metadata" muted />
      </Show>
    </span>
  );
}

// ---------- viewer ----------

function Viewer(p: {
  open: NonNullable<Open>;
  library: Library | null | undefined;
  onClose: () => void;
  onOpen: (o: Open) => void;
  refetch: () => void;
}) {
  return (
    <div class="rs-viewer">
      <Switch>
        <Match when={p.open.kind === 'vod' && (p.open as { path: string }).path}>
          {(dir) => (
            <VodViewer dir={dir()} library={p.library} onClose={p.onClose} onOpen={p.onOpen} refetch={p.refetch} />
          )}
        </Match>
        <Match when={p.open.kind === 'clip' && (p.open as { path: string }).path}>
          {(path) => (
            <ClipViewer path={path()} library={p.library} onClose={p.onClose} onOpen={p.onOpen} refetch={p.refetch} />
          )}
        </Match>
        <Match when={p.open.kind === 'shot' && (p.open as { path: string }).path}>
          {(path) => <ShotViewer path={path()} library={p.library} onClose={p.onClose} refetch={p.refetch} />}
        </Match>
        <Match when={p.open.kind === 'shared' && (p.open as { clip: SharedClip }).clip}>
          {(clip) => <SharedViewer clip={clip()} onClose={p.onClose} />}
        </Match>
      </Switch>
    </div>
  );
}

function ViewerHead(p: { back: string; onClose: () => void; children?: JSX.Element }) {
  return (
    <div class="rs-viewer-head">
      <button class="rs-back" onClick={p.onClose}>
        <I.Back size={16} /> {p.back}
      </button>
      {p.children}
    </div>
  );
}

/** The editable name at the top of a viewer's panel. */
function TitleField(p: { path: string; title: string; placeholder: string; refetch: () => void }) {
  const save = (value: string) => {
    if (value.trim() === p.title) return;
    void recCall('rec_update', { path: p.path, title: value.trim() })
      .then(p.refetch)
      .catch((e) => toast(String(e)));
  };
  return (
    <input
      class="rs-title"
      value={p.title}
      placeholder={p.placeholder}
      aria-label={t('Name')}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          e.preventDefault();
          e.currentTarget.value = p.title;
          e.currentTarget.blur();
        }
      }}
      onBlur={(e) => save(e.currentTarget.value)}
    />
  );
}

function Facts(p: { rows: [string, JSX.Element][] }) {
  return (
    <dl class="rs-facts">
      <For each={p.rows}>
        {([k, v]) => (
          <div>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        )}
      </For>
    </dl>
  );
}

/** Star, show in folder, delete: every local item has them. */
function LocalActions(p: {
  path: string;
  starred: boolean;
  recording?: boolean;
  refetch: () => void;
  onDeleted: () => void;
}) {
  const [confirm, setConfirm] = createSignal(false);
  return (
    <div class="rs-actions">
      <button
        class="rs-action"
        classList={{ on: p.starred }}
        onClick={() =>
          void recCall('rec_update', { path: p.path, starred: !p.starred })
            .then(p.refetch)
            .catch((e) => toast(String(e)))
        }
      >
        <I.Star size={16} /> {p.starred ? t('Starred') : t('Star')}
      </button>
      <button class="rs-action" onClick={() => void recCall('rec_reveal', { path: p.path })}>
        <I.FolderOpen size={16} /> {t('Show in folder')}
      </button>
      <Show when={!p.recording}>
        <button
          class="rs-action danger"
          classList={{ confirm: confirm() }}
          onClick={() => {
            if (!confirm()) return void (setConfirm(true), setTimeout(() => setConfirm(false), 3000));
            void recCall('rec_delete', { path: p.path })
              .then(() => (p.onDeleted(), p.refetch()))
              .catch((e) => toast(String(e)));
          }}
        >
          <I.Trash size={16} /> {confirm() ? t('Click again to delete') : t('Delete')}
        </button>
      </Show>
    </div>
  );
}

const MARK_FILTERS: [string, string][] = [
  ['all', msg('All')],
  ['yours', msg('Yours')],
  ['game', msg('Game')],
];
const YOURS = new Set(['bookmark', 'clip', 'screenshot']);

function VodViewer(p: {
  dir: string;
  library: Library | null | undefined;
  onClose: () => void;
  onOpen: (o: Open) => void;
  refetch: () => void;
}) {
  const [index] = createResource(
    () => p.dir,
    (dir) => recCall<VodIndex>('rec_vod', { dir }),
  );
  const entry = () => p.library?.vods.find((v) => v.dir === p.dir);
  const [cut, setCut] = createSignal<[number, number] | null>(null);
  const [cutTitle, setCutTitle] = createSignal('');
  const [saving, setSaving] = createSignal(false);
  const [markFilter, setMarkFilter] = createSignal('all');
  const [player, setPlayer] = createSignal<PlayerControl | null>(null);
  const duration = () => index()?.meta.duration_ms || (index()?.parts.at(-1)?.segments.at(-1)?.end_ms ?? 0);
  const marks = createMemo<Mark[]>(() => {
    const m = index()?.meta;
    if (!m) return [];
    return [...m.bookmarks.map((ms) => ({ ms, kind: 'bookmark', label: '' })), ...m.events].sort((a, b) => a.ms - b.ms);
  });
  const listed = () =>
    marks().filter(
      (m) => markFilter() === 'all' || (markFilter() === 'yours' ? YOURS.has(m.kind) : !YOURS.has(m.kind)),
    );
  const startCut = (around?: number) => {
    const now = around ?? player()?.time() ?? 0;
    setCut([Math.max(0, now - prefs.rec.clipSeconds * 500), Math.min(duration(), now + prefs.rec.clipSeconds * 500)]);
  };
  const nudge = (which: 0 | 1, by: number) => {
    const c = cut();
    if (!c) return;
    setCut(
      which === 0
        ? [Math.max(0, Math.min(c[0] + by, c[1] - 1000)), c[1]]
        : [c[0], Math.min(duration(), Math.max(c[1] + by, c[0] + 1000))],
    );
  };
  const saveCut = async () => {
    const c = cut();
    if (!c) return;
    setSaving(true);
    try {
      await recCall('rec_export', {
        vod: p.dir,
        fromMs: Math.round(c[0]),
        toMs: Math.round(c[1]),
        title: cutTitle().trim(),
      });
      setCut(null);
      setCutTitle('');
      toast(t('Clip saved'));
      p.refetch();
    } catch (e) {
      toast(String(e));
    } finally {
      setSaving(false);
    }
  };
  const IconOf = (kind: string) =>
    kind === 'bookmark' ? I.Bookmark : kind === 'clip' ? I.Scissors : kind === 'screenshot' ? I.Photo : I.Sparkles;

  return (
    <>
      <ViewerHead back={t('Library')} onClose={p.onClose} />
      <div class="rs-viewer-body">
        <div class="rs-stage">
          <Show when={index()} fallback={<div class="rs-loading" />}>
            {(i) => (
              <RecPlayer
                source={{ parts: i().parts }}
                duration={duration()}
                thumbs={i().thumbs.map(([ms, path]) => [ms, src(path)] as [number, string])}
                marks={marks()}
                cut={cut()}
                onCut={setCut}
                autoplay
                control={setPlayer}
              />
            )}
          </Show>
          <p class="rs-keys muted small">
            {t(
              'Space play · J / L 10 s · , / . frame · [ / ] moments · + / − zoom · Ctrl + wheel zoom · I / O clip start and end',
            )}
          </p>
        </div>
        <aside class="rs-panel">
          <Show when={index()}>
            {(i) => (
              <>
                <TitleField path={p.dir} title={i().meta.title} placeholder={i().meta.game} refetch={p.refetch} />
                <Facts
                  rows={[
                    [t('Game'), i().meta.game],
                    [t('Recorded'), fullDate(i().meta.started)],
                    [t('Length'), clock(duration())],
                    ...(i().meta.width
                      ? [[t('Picture'), `${i().meta.width}×${i().meta.height}`] as [string, string]]
                      : []),
                    ...(entry() ? [[t('Size'), formatSize(entry()!.size)] as [string, string]] : []),
                  ]}
                />
                <Show
                  when={cut()}
                  fallback={
                    <button class="btn primary rs-wide" onClick={() => startCut()}>
                      <I.Scissors size={16} /> {t('Make a clip here')}
                    </button>
                  }
                >
                  {(c) => (
                    <div class="rs-cut">
                      <span class="rs-label">{t('New clip')}</span>
                      <div class="rs-cut-times">
                        <CutTime
                          label={t('Clip start')}
                          ms={c()[0]}
                          onNudge={(by) => nudge(0, by)}
                          onJump={() => player()?.seek(c()[0])}
                        />
                        <CutTime
                          label={t('Clip end')}
                          ms={c()[1]}
                          onNudge={(by) => nudge(1, by)}
                          onJump={() => player()?.seek(c()[1])}
                        />
                      </div>
                      <small class="muted">
                        {t('Length {time}', { time: clock(c()[1] - c()[0]) })} ·{' '}
                        {t('drag the gold handles, or press I and O at the playhead')}
                      </small>
                      <input
                        class="rs-input"
                        placeholder={t('Clip name (optional)')}
                        value={cutTitle()}
                        onInput={(e) => setCutTitle(e.currentTarget.value)}
                      />
                      <div class="rs-row">
                        <button class="btn" onClick={() => setCut(null)}>
                          {t('Cancel')}
                        </button>
                        <button class="btn primary grow" disabled={saving()} onClick={() => void saveCut()}>
                          {saving() ? t('Saving…') : t('Save clip')}
                        </button>
                      </div>
                    </div>
                  )}
                </Show>
                <LocalActions
                  path={p.dir}
                  starred={i().meta.starred}
                  recording={entry()?.recording}
                  refetch={p.refetch}
                  onDeleted={p.onClose}
                />
                <div class="rs-moments">
                  <div class="rs-moments-head">
                    <span class="rs-label">{t('Moments')}</span>
                    <div class="rs-chips">
                      <For each={MARK_FILTERS}>
                        {([id, label]) => (
                          <button classList={{ active: markFilter() === id }} onClick={() => setMarkFilter(id)}>
                            {t(label)}
                          </button>
                        )}
                      </For>
                    </div>
                  </div>
                  <Show
                    when={listed().length}
                    fallback={<p class="muted small">{t('Bookmarks, clips and game moments show up here.')}</p>}
                  >
                    <ol class="rs-moment-list">
                      <For each={listed()}>
                        {(m) => {
                          const Icon = IconOf(m.kind);
                          return (
                            <li>
                              <button
                                class={`rs-moment ${m.kind}`}
                                onClick={() => player()?.seek(Math.max(0, m.ms - 3000))}
                              >
                                <Icon size={15} />
                                <span class="grow rs-ellipsis">{markText(m)}</span>
                                <span class="rs-moment-time">{clock(m.ms)}</span>
                              </button>
                              <button
                                class="rs-moment-cut"
                                aria-label={t('Make a clip here')}
                                data-tip={t('Make a clip here')}
                                onClick={() => (player()?.seek(Math.max(0, m.ms - 3000)), startCut(m.ms))}
                              >
                                <I.Scissors size={14} />
                              </button>
                            </li>
                          );
                        }}
                      </For>
                    </ol>
                  </Show>
                </div>
                <ClipsFrom dir={p.dir} library={p.library} onOpen={p.onOpen} />
              </>
            )}
          </Show>
        </aside>
      </div>
    </>
  );
}

function CutTime(p: { label: string; ms: number; onNudge: (by: number) => void; onJump: () => void }) {
  return (
    <div class="rs-cut-time">
      <small class="muted">{p.label}</small>
      <div class="rs-row">
        <button class="rs-nudge" aria-label={t('1 second earlier')} onClick={() => p.onNudge(-1000)}>
          −1s
        </button>
        <button class="rs-cut-clock" onClick={p.onJump} data-tip={t('Go there')}>
          {clock(p.ms)}
        </button>
        <button class="rs-nudge" aria-label={t('1 second later')} onClick={() => p.onNudge(1000)}>
          +1s
        </button>
      </div>
    </div>
  );
}

/** The clips already made from this VOD. */
function ClipsFrom(p: { dir: string; library: Library | null | undefined; onOpen: (o: Open) => void }) {
  const name = () => p.dir.split(/[\\/]/).pop() ?? '';
  const list = () => p.library?.clips.filter((c) => c.meta.source === name()) ?? [];
  return (
    <Show when={list().length}>
      <div class="rs-from">
        <span class="rs-label">{t('Clips from this VOD')}</span>
        <For each={list()}>
          {(c) => (
            <button class="rs-from-item" onClick={() => p.onOpen({ kind: 'clip', path: c.path })}>
              <I.Scissors size={15} />
              <span class="grow rs-ellipsis">{nameOf(c.meta)}</span>
              <span class="muted">{clock(c.meta.duration_ms)}</span>
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}

const linkOf = (slug: string) => `${serverUrl()}/clip/${slug}`;

async function copyLink(slug: string) {
  await navigator.clipboard.writeText(linkOf(slug)).catch(() => {});
  toast(t('Link copied: anyone with it can watch'));
}

/** Several links, one per line. */
async function copyLinks(slugs: string[]) {
  if (slugs.length === 1) return copyLink(slugs[0]);
  await navigator.clipboard.writeText(slugs.map(linkOf).join('\n')).catch(() => {});
  toast(plural(slugs.length, '{n} link copied', '{n} links copied'));
}

/** Uploads a clip so anyone with the link can watch it; once shared, copies the link again. */
function ShareButton(p: { path: string; meta: ItemMeta; refetch: () => void }) {
  const [progress, setProgress] = createSignal<number | null>(null);
  const share = async () => {
    setProgress(0);
    try {
      const clip = await shareFile(p.path, { title: p.meta.title, game: p.meta.game, kind: 'clip' }, setProgress);
      // Shared clips are never deleted to make room on this PC.
      await recCall('rec_update', { path: p.path, shared: clip.slug });
      p.refetch();
      await copyLink(clip.slug);
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e));
    } finally {
      setProgress(null);
    }
  };
  return (
    <Show
      when={!p.meta.shared}
      fallback={
        <button class="btn rs-wide" onClick={() => void copyLink(p.meta.shared!)}>
          <I.Link size={16} /> {t('Copy link')}
        </button>
      }
    >
      <button class="btn primary rs-wide" disabled={progress() !== null} onClick={() => void share()}>
        <I.CloudUp size={16} />{' '}
        {progress() === null ? t('Share') : t('Uploading… {n}%', { n: Math.round(progress()! * 100) })}
      </button>
    </Show>
  );
}

function ClipViewer(p: {
  path: string;
  library: Library | null | undefined;
  onClose: () => void;
  onOpen: (o: Open) => void;
  refetch: () => void;
}) {
  const clip = () => p.library?.clips.find((c) => c.path === p.path);
  const vod = () => {
    const source = clip()?.meta.source;
    return source ? p.library?.vods.find((v) => v.dir.split(/[\\/]/).pop() === source) : undefined;
  };
  return (
    <>
      <ViewerHead back={t('Library')} onClose={p.onClose} />
      <div class="rs-viewer-body">
        <div class="rs-stage">
          <RecPlayer source={{ url: src(p.path) }} duration={clip()?.meta.duration_ms ?? 0} autoplay />
        </div>
        <aside class="rs-panel">
          <Show when={clip()}>
            {(c) => (
              <>
                <TitleField path={c().path} title={c().meta.title} placeholder={c().meta.game} refetch={p.refetch} />
                <Facts
                  rows={[
                    [t('Game'), c().meta.game],
                    [t('Saved'), fullDate(c().meta.created)],
                    [t('Length'), clock(c().meta.duration_ms)],
                    [t('Size'), formatSize(c().size)],
                  ]}
                />
                <ShareButton path={c().path} meta={c().meta} refetch={p.refetch} />
                <Show when={c().meta.shared}>
                  <small class="muted">
                    {t('Shared: anyone with the link can watch it. It stays on this PC whatever the limits.')}
                  </small>
                </Show>
                <LocalActions path={c().path} starred={c().meta.starred} refetch={p.refetch} onDeleted={p.onClose} />
                <Show when={vod()}>
                  {(v) => (
                    <button class="rs-from-item" onClick={() => p.onOpen({ kind: 'vod', path: v().dir })}>
                      <I.Film size={15} />
                      <span class="grow rs-ellipsis">{t('Open the VOD it came from')}</span>
                      <span class="muted">{clock(v().meta.duration_ms)}</span>
                    </button>
                  )}
                </Show>
              </>
            )}
          </Show>
        </aside>
      </div>
    </>
  );
}

function ShotViewer(p: {
  path: string;
  library: Library | null | undefined;
  onClose: () => void;
  refetch: () => void;
}) {
  const shot = () => p.library?.screenshots.find((s) => s.path === p.path);
  const copy = async () => {
    try {
      const blob = await (await fetch(src(p.path))).blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
      toast(t('Copied'));
    } catch {
      toast(t("Couldn't copy it"));
    }
  };
  return (
    <>
      <ViewerHead back={t('Library')} onClose={p.onClose} />
      <div class="rs-viewer-body">
        <div class="rs-stage rs-shot">
          <img src={src(p.path)} alt="" />
        </div>
        <aside class="rs-panel">
          <Show when={shot()}>
            {(s) => (
              <>
                <TitleField path={s().path} title={s().meta.title} placeholder={s().meta.game} refetch={p.refetch} />
                <Facts
                  rows={[
                    [t('Game'), s().meta.game],
                    [t('Saved'), fullDate(s().meta.created)],
                    [t('Size'), formatSize(s().size)],
                  ]}
                />
                <button class="btn rs-wide" onClick={() => void copy()}>
                  <I.Copy size={16} /> {t('Copy picture')}
                </button>
                <LocalActions path={s().path} starred={s().meta.starred} refetch={p.refetch} onDeleted={p.onClose} />
              </>
            )}
          </Show>
        </aside>
      </div>
    </>
  );
}

// ---------- shared ----------

function SharedView(p: { onOpen: (c: SharedClip) => void }) {
  const [data, { refetch }] = createResource(() =>
    api<{ clips: SharedClip[]; used: number; quota: number }>('GET', '/users/@me/clips').catch(() => null),
  );
  const clips = () => data()?.clips ?? [];
  // ---------- selection (as in the library) ----------
  // A card's box or Ctrl+click selects, Shift+click selects the range, Ctrl+A everything, Esc clears; while selecting,
  // a click selects instead of opening.
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
  const [selectMode, setSelectMode] = createSignal(false);
  const selecting = () => selectMode() || selected().size > 0;
  const chosen = createMemo(() => clips().filter((c) => selected().has(c.id)));
  let anchor: string | null = null;
  const clear = () => (setSelected(new Set<string>()), setSelectMode(false), (anchor = null));
  const toggle = (c: SharedClip, e: MouseEvent) => {
    const next = new Set(selected());
    const list = clips();
    const from = anchor ? list.findIndex((x) => x.id === anchor) : -1;
    if (e.shiftKey && from >= 0) {
      const to = list.findIndex((x) => x.id === c.id);
      for (const x of list.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(x.id);
    } else if (next.has(c.id)) next.delete(c.id);
    else next.add(c.id);
    anchor = c.id;
    setSelected(next);
  };
  const click = (c: SharedClip, e: MouseEvent) => {
    if (selecting() || e.ctrlKey || e.metaKey || e.shiftKey) toggle(c, e);
    else p.onOpen(c);
  };
  // Clips no longer shared leave the selection.
  createEffect(
    on(clips, (list) => {
      const ids = new Set(list.map((c) => c.id));
      if ([...selected()].some((x) => !ids.has(x))) setSelected(new Set([...selected()].filter((x) => ids.has(x))));
    }),
  );
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, textarea, select')) return;
    if (e.key === 'Escape' && selecting()) {
      e.preventDefault();
      clear();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && clips().length) {
      e.preventDefault();
      setSelected(new Set(clips().map((c) => c.id)));
    }
  };
  // Capture: runs before the studio's own Escape (which would close REC).
  onMount(() => window.addEventListener('keydown', onKey, true));
  onCleanup(() => window.removeEventListener('keydown', onKey, true));
  const menu = (c: SharedClip, e: MouseEvent) =>
    openMenu(
      e,
      sharedMenu(c, {
        open: () => p.onOpen(c),
        select: () => (setSelectMode(true), selected().has(c.id) || toggle(c, e)),
        refetch,
      }),
    );
  return (
    <div class="rs-page" classList={{ selecting: selecting() }}>
      <Show when={!recAvailable}>
        <div class="rs-intro">
          <I.Rec size={22} />
          <div>
            <strong>{t('REC records your games in the Windows app')}</strong>
            <p class="muted small">
              {t('Every game you play, saved as a VOD you can browse, clip and share. Get the desktop app to use it.')}
            </p>
          </div>
        </div>
      </Show>
      <div class="rs-page-head">
        <div>
          <h1>{t('Shared clips')}</h1>
          <p class="muted small">{t('Anyone with a link can watch, no account needed.')}</p>
        </div>
        <div class="rs-page-tools">
          <Show when={clips().length}>
            <button
              class="rs-select-btn"
              classList={{ active: selecting() }}
              onClick={() => (selecting() ? clear() : setSelectMode(true))}
            >
              <I.Check size={16} /> {selecting() ? t('Done') : t('Select')}
            </button>
          </Show>
        </div>
      </div>
      <Show when={data()}>{(d) => <SharedSpace used={d().used} quota={d().quota} />}</Show>
      <Show
        when={data()?.clips.length}
        fallback={
          <Show when={!data.loading}>
            <div class="rs-empty">
              <I.CloudUp size={30} />
              <strong>{t('Nothing shared yet')}</strong>
              <p class="muted small">
                {t('Open a clip and press Share: anyone with its link can watch it, no account needed.')}
              </p>
            </div>
          </Show>
        }
      >
        <div class="rs-grid">
          <For each={data()!.clips}>
            {(c) => (
              <div
                class="rs-card"
                classList={{ selected: selected().has(c.id) }}
                role="button"
                tabIndex={0}
                aria-pressed={selected().has(c.id)}
                onClick={(e) => click(c, e)}
                onContextMenu={(e) => menu(c, e)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') click(c, e as unknown as MouseEvent);
                  if (e.key === ' ') {
                    e.preventDefault();
                    toggle(c, e as unknown as MouseEvent);
                  }
                }}
              >
                <div class="rs-thumb">
                  <img src={media(c.thumbnail)} alt="" loading="lazy" />
                  <span class="rs-length">{clock(c.duration_ms)}</span>
                  <Show when={!c.on_profile}>
                    <span class="rs-kind">
                      <I.EyeOff size={13} /> {t('Not on your profile')}
                    </span>
                  </Show>
                  <button
                    class="rs-check"
                    role="checkbox"
                    aria-checked={selected().has(c.id)}
                    aria-label={t('Select')}
                    onClick={(e) => (e.stopPropagation(), toggle(c, e))}
                  >
                    <I.Check size={15} />
                  </button>
                </div>
                <div class="rs-card-text">
                  <strong>{c.title || c.game || t('Clip')}</strong>
                  <small>
                    {dayOf(Date.parse(c.created_at))} · {plural(c.views, '{n} view', '{n} views')}
                  </small>
                </div>
              </div>
            )}
          </For>
        </div>
        <Show when={selecting()}>
          <SharedSelectionBar
            clips={chosen()}
            total={clips().length}
            onAll={() => setSelected(new Set(clips().map((c) => c.id)))}
            onClear={clear}
            refetch={refetch}
          />
        </Show>
      </Show>
    </div>
  );
}

/** The server space your shared clips use: one full-width bar under the heading, in line with the grid below it. */
function SharedSpace(p: { used: number; quota: number }) {
  const share = () => Math.min(1, p.used / Math.max(1, p.quota));
  const full = () => share() >= 0.9;
  return (
    <div class="rs-quota" classList={{ full: full() }}>
      <div class="rs-quota-text">
        <span>
          <strong>{formatSize(p.used)}</strong> {t('of {quota} used', { quota: formatSize(p.quota) })}
        </span>
        <span class="rs-quota-left">
          {full()
            ? t('Almost full: stop sharing some clips to make room.')
            : t('{free} left', { free: formatSize(Math.max(0, p.quota - p.used)) })}
        </span>
      </div>
      <div
        class="rs-quota-bar"
        role="meter"
        aria-label={t('Space for shared clips')}
        aria-valuemin={0}
        aria-valuemax={p.quota}
        aria-valuenow={p.used}
      >
        <span style={{ width: `${Math.max(share() * 100, p.used ? 1 : 0)}%` }} />
      </div>
    </div>
  );
}

const sharedName = (c: SharedClip) => c.title || c.game || t('Clip');
const apiError = (e: unknown) => String((e as { message?: string })?.message ?? e);

/** A shared clip's right-click menu: what its viewer offers, without opening it. */
function sharedMenu(c: SharedClip, o: { open: () => void; select: () => void; refetch: () => void }): MenuEntry[] {
  const update = (patch: Record<string, unknown>) =>
    api('PATCH', `/clips/${c.id}`, patch).then(o.refetch, (e) => toast(apiError(e)));
  const stop = (at: { x: number; y: number }) =>
    setUi('menu', {
      ...at,
      items: [
        { label: t('Stop sharing "{name}"?', { name: sharedName(c) }), disabled: true },
        {
          label: t('Stop sharing'),
          icon: () => <I.Trash size={16} />,
          danger: true,
          run: () => api('DELETE', `/clips/${c.id}`).then(o.refetch, (e) => toast(apiError(e))),
        },
        { label: t('Cancel'), run: () => {} },
      ],
    });
  const channel = voiceUi.channelId;
  return [
    { label: t('Open'), icon: () => <I.Play size={16} />, run: o.open },
    { label: t('Copy link'), icon: () => <I.Link size={16} />, run: () => void copyLink(c.slug) },
    {
      label: t('Open the public page'),
      icon: () => <I.External size={16} />,
      run: () => void import('../lib/platform').then((m) => m.openExternal(linkOf(c.slug))),
    },
    ...(channel
      ? [
          {
            label: t('Watch together in the call'),
            icon: () => <I.Play size={16} />,
            run: () =>
              void import('../lib/watch')
                .then((w) => w.startWatch(channel, linkOf(c.slug)))
                .catch((e) => toast(apiError(e))),
          },
        ]
      : []),
    'separator',
    {
      label: c.on_profile ? t('Hide from your profile') : t('Show on your profile'),
      icon: () => <I.Account size={16} />,
      run: () => void update({ on_profile: !c.on_profile }),
    },
    { label: t('Select'), icon: () => <I.Check size={16} />, run: o.select },
    'separator',
    { label: t('Stop sharing'), icon: () => <I.Trash size={16} />, danger: true, run: stop },
  ];
}

/** What can be done to every selected shared clip at once. */
function SharedSelectionBar(p: {
  clips: SharedClip[];
  total: number;
  onAll: () => void;
  onClear: () => void;
  refetch: () => void;
}) {
  const [confirm, setConfirm] = createSignal(false);
  const [busy, setBusy] = createSignal<string | null>(null);
  const size = () => p.clips.reduce((n, c) => n + c.size, 0);
  const allOnProfile = () => p.clips.length > 0 && p.clips.every((c) => c.on_profile);
  /** One request per clip, one after another; the list is read again at the end. */
  const each = async (label: string, run: (c: SharedClip) => Promise<unknown>) => {
    const failed: string[] = [];
    for (const [n, c] of p.clips.entries()) {
      setBusy(`${label} ${n + 1}/${p.clips.length}`);
      await run(c).catch((e) => failed.push(`${sharedName(c)}: ${apiError(e)}`));
    }
    setBusy(null);
    p.refetch();
    if (failed.length) toast(failed.join('\n'));
    return failed.length;
  };
  const profile = () => {
    const on = !allOnProfile();
    void each(t('Saving…'), (c) => api('PATCH', `/clips/${c.id}`, { on_profile: on }));
  };
  const stop = async () => {
    if (!confirm()) return void (setConfirm(true), setTimeout(() => setConfirm(false), 3000));
    setConfirm(false);
    const n = p.clips.length;
    const failed = await each(t('Stopping…'), (c) => api('DELETE', `/clips/${c.id}`));
    if (!failed) toast(plural(n, 'Stopped sharing {n} clip', 'Stopped sharing {n} clips'));
    p.onClear();
  };
  return (
    <div class="rs-selbar" role="toolbar" aria-label={t('Selection')}>
      <span class="rs-selbar-count">
        <strong>{plural(p.clips.length, '{n} selected', '{n} selected')}</strong>
        <small class="muted">{formatSize(size())}</small>
      </span>
      <Show when={p.clips.length < p.total}>
        <button class="rs-sel-action" onClick={p.onAll}>
          {t('Select all')}
        </button>
      </Show>
      <span class="rs-sep" />
      <Show when={busy()}>
        <span class="muted small">{busy()}</span>
      </Show>
      <button
        class="rs-sel-action"
        disabled={!p.clips.length || !!busy()}
        onClick={() => void copyLinks(p.clips.map((c) => c.slug))}
      >
        <I.Link size={16} /> {plural(p.clips.length, 'Copy {n} link', 'Copy {n} links')}
      </button>
      <button class="rs-sel-action" disabled={!p.clips.length || !!busy()} onClick={profile}>
        <I.Account size={16} /> {allOnProfile() ? t('Hide from your profile') : t('Show on your profile')}
      </button>
      <button
        class="rs-sel-action danger"
        classList={{ confirm: confirm() }}
        disabled={!p.clips.length || !!busy()}
        onClick={() => void stop()}
      >
        <I.Trash size={16} />{' '}
        {confirm() ? t('Click again to stop sharing') : plural(p.clips.length, 'Stop sharing {n}', 'Stop sharing {n}')}
      </button>
      <button
        class="rs-icon"
        aria-label={t('Clear selection')}
        data-tip={t('Clear selection (Esc)')}
        onClick={p.onClear}
      >
        <I.Close size={16} />
      </button>
    </div>
  );
}

function SharedViewer(p: { clip: SharedClip; onClose: () => void }) {
  const [clip, setClip] = createSignal(p.clip);
  const [confirm, setConfirm] = createSignal(false);
  const update = (patch: Record<string, unknown>) =>
    void api<SharedClip>('PATCH', `/clips/${clip().id}`, patch).then(
      (c) => setClip({ ...clip(), ...c }),
      (e) => toast(String(e.message ?? e)),
    );
  const remove = () => {
    if (!confirm()) return void (setConfirm(true), setTimeout(() => setConfirm(false), 3000));
    void api('DELETE', `/clips/${clip().id}`).then(p.onClose, (e) => toast(String(e.message ?? e)));
  };
  return (
    <>
      <ViewerHead back={t('Shared')} onClose={p.onClose} />
      <div class="rs-viewer-body">
        <div class="rs-stage">
          <RecPlayer source={{ url: media(clip().video)! }} duration={clip().duration_ms} autoplay />
        </div>
        <aside class="rs-panel">
          <input
            class="rs-title"
            value={clip().title}
            placeholder={clip().game || t('Clip')}
            aria-label={t('Name')}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            onBlur={(e) =>
              e.currentTarget.value.trim() !== clip().title && update({ title: e.currentTarget.value.trim() })
            }
          />
          <Facts
            rows={[
              [t('Game'), clip().game],
              [t('Shared on'), fullDate(Date.parse(clip().created_at))],
              [t('Length'), clock(clip().duration_ms)],
              [t('Views'), String(clip().views)],
              [t('Size'), formatSize(clip().size)],
            ]}
          />
          <button class="btn primary rs-wide" onClick={() => void copyLink(clip().slug)}>
            <I.Link size={16} /> {t('Copy link')}
          </button>
          <div class="rs-actions">
            <button
              class="rs-action"
              classList={{ on: clip().on_profile }}
              onClick={() => update({ on_profile: !clip().on_profile })}
            >
              <I.Account size={16} /> {clip().on_profile ? t('On your profile') : t('Not on your profile')}
            </button>
            <button class="rs-action danger" classList={{ confirm: confirm() }} onClick={remove}>
              <I.Trash size={16} /> {confirm() ? t('Click again to delete') : t('Stop sharing')}
            </button>
          </div>
        </aside>
      </div>
    </>
  );
}

// ---------- settings ----------

const SECTIONS: [string, string, (p: { size?: number }) => JSX.Element][] = [
  ['recording', msg('Recording'), I.Rec],
  ['quality', msg('Quality'), I.Film],
  ['audio', msg('Audio'), I.Mic],
  ['clips', msg('Clips'), I.Scissors],
  ['hotkeys', msg('Hotkeys'), I.Keyboard],
  ['storage', msg('Storage'), I.Folder],
  ['league', msg('League of Legends'), I.Trophy],
  ['privacy', msg('Privacy'), I.Lock],
];

function SettingsView(p: { library: Library | null | undefined; section: string }) {
  const sections = recAvailable ? SECTIONS : SECTIONS.filter(([id]) => id === 'privacy');
  const [active, setActive] = createSignal(sections[0][0]);
  let scroller!: HTMLDivElement;
  // Clicked in the index: that one stays marked until the scroll it started ends (the last sections can't scroll up
  // to the top, so reading the position would mark another one).
  let pinned = false;
  let unpin: ReturnType<typeof setTimeout> | undefined;
  const jump = (id: string, behavior: ScrollBehavior = 'smooth') => {
    const el = scroller.querySelector(`#rs-${id}`);
    if (!el) return;
    setActive(id);
    pinned = true;
    clearTimeout(unpin);
    unpin = setTimeout(() => (pinned = false), 1200);
    el.scrollIntoView({ behavior, block: 'start' });
  };
  /** The section marked = the last one whose top passed a line near the top; scrolled to the end = the last one. */
  const spy = () => {
    if (pinned) return;
    const all = [...scroller.querySelectorAll<HTMLElement>('.rs-section')];
    if (!all.length) return;
    const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
    const line = scroller.getBoundingClientRect().top + Math.min(160, scroller.clientHeight * 0.25);
    const current = atEnd ? all.at(-1)! : (all.filter((s) => s.getBoundingClientRect().top <= line).at(-1) ?? all[0]);
    setActive(current.id.slice('rs-'.length));
  };
  const scrollEnded = () => {
    clearTimeout(unpin);
    pinned = false;
  };
  // Scrolling by hand takes over from a click.
  const takeOver = () => (pinned = false);
  onMount(() => {
    if (p.section) queueMicrotask(() => jump(p.section, 'auto'));
    scroller.addEventListener('scroll', spy, { passive: true });
    scroller.addEventListener('scrollend', scrollEnded);
    scroller.addEventListener('wheel', takeOver, { passive: true });
    scroller.addEventListener('touchstart', takeOver, { passive: true });
  });
  onCleanup(() => {
    clearTimeout(unpin);
    scroller.removeEventListener('scroll', spy);
    scroller.removeEventListener('scrollend', scrollEnded);
    scroller.removeEventListener('wheel', takeOver);
    scroller.removeEventListener('touchstart', takeOver);
  });
  return (
    <div class="rs-settings">
      <nav class="rs-index" aria-label={t('Settings')}>
        <For each={sections}>
          {([id, label, Icon]) => (
            <button classList={{ active: active() === id }} onClick={() => jump(id)}>
              <Icon size={17} /> {t(label)}
            </button>
          )}
        </For>
      </nav>
      <div class="rs-settings-scroll" ref={scroller}>
        <Show when={recAvailable}>
          <RecordingSettings />
          <QualitySettings />
          <AudioSettings />
          <ClipSettings />
          <HotkeySettings />
          <StorageSettings library={p.library} />
          <LeagueSettings />
        </Show>
        <PrivacySettings />
      </div>
    </div>
  );
}

function Block(p: { id: string; title: string; description?: string; children: JSX.Element }) {
  return (
    <section class="rs-section" id={`rs-${p.id}`}>
      <header>
        <h2>{p.title}</h2>
        <Show when={p.description}>
          <p class="muted small">{p.description}</p>
        </Show>
      </header>
      {p.children}
    </section>
  );
}

/** A switch with its words, REC style. */
export function Toggle(p: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label class="rs-toggle" classList={{ disabled: p.disabled }}>
      <span class="rs-toggle-text">
        <strong>{p.label}</strong>
        <Show when={p.hint}>
          <small>{p.hint}</small>
        </Show>
      </span>
      <input
        type="checkbox"
        class="switch"
        checked={p.checked}
        disabled={p.disabled}
        onChange={(e) => p.onChange(e.currentTarget.checked)}
      />
    </label>
  );
}

function RecordingSettings() {
  const r = () => prefs.rec;
  const game = currentGame;
  const toggleIgnored = (key: string, on: boolean) =>
    setRecPrefs({ ignoredGames: on ? [...r().ignoredGames, key] : r().ignoredGames.filter((k) => k !== key) });
  return (
    <Block id="recording" title={t('Recording')}>
      <div class="rs-box rs-off">
        <span class="rs-toggle-text">
          <strong>{t('REC is on')}</strong>
          <small>
            {t(
              'Turning it off stops recording and hides your library until you turn it on again. Your recordings stay in their folder.',
            )}
          </small>
        </span>
        <button class="btn ghost" onClick={() => setReplaying(true)}>
          {t('Run the setup again')}
        </button>
        <button class="btn danger-ghost" onClick={() => setRecPrefs({ enabled: false })}>
          {t('Turn off REC')}
        </button>
      </div>
      <div class="rs-cards two">
        <div class="rs-box">
          <Toggle
            label={t('Record every game you play')}
            hint={t(
              'Starts when Pottira sees a game and stops when it closes. Nothing shows on your screen while it records.',
            )}
            checked={r().auto}
            onChange={(v) => setRecPrefs({ auto: v })}
          />
          <Show when={game()}>
            {(g) => (
              <Toggle
                label={t("Don't record {game}", { game: g().name })}
                checked={r().ignoredGames.includes(g().key)}
                onChange={(v) => toggleIgnored(g().key, v)}
              />
            )}
          </Show>
        </div>
        <div class="rs-box">
          <strong class="rs-box-title">{t('Games never recorded')}</strong>
          <Show
            when={r().ignoredGames.length}
            fallback={<small class="muted">{t('None. Open a game and come back here to leave it out.')}</small>}
          >
            <div class="rs-tags">
              <For each={r().ignoredGames}>
                {(key) => (
                  <span class="rs-tag">
                    {key}
                    <button aria-label={t('Record it again')} onClick={() => toggleIgnored(key, false)}>
                      <I.Close size={12} />
                    </button>
                  </span>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </Block>
  );
}

/** Presets: resolution, frame rate, bitrate. */
export const PRESETS: { id: string; name: string; height: number; fps: number; kbps: number }[] = [
  { id: 'light', name: msg('Lightweight'), height: 720, fps: 30, kbps: 4000 },
  { id: 'balanced', name: msg('Balanced'), height: 1080, fps: 60, kbps: 12000 },
  { id: 'high', name: msg('High'), height: 1440, fps: 60, kbps: 20000 },
  { id: 'max', name: msg('Best'), height: 0, fps: 60, kbps: 35000 },
];
export const gbPerHour = (kbps: number) => ((kbps * 1000 + 448_000) * 3600) / 8 / 1024 ** 3;
export const fmt1 = (n: number) => n.toLocaleString(dateLocale(), { maximumFractionDigits: 1 });

function QualitySettings() {
  const r = () => prefs.rec;
  const current = () =>
    PRESETS.find((x) => x.height === r().maxHeight && x.fps === r().fps && x.kbps === r().bitrateKbps)?.id;
  const [custom, setCustom] = createSignal(!current());
  const heightName = (h: number) => (h ? `${h}p` : t('Native'));
  return (
    <Block
      id="quality"
      title={t('Quality')}
      description={t('Higher takes more space. Recording uses your graphics card, not your processor.')}
    >
      <div class="rs-presets">
        <For each={PRESETS}>
          {(x) => (
            <button
              class="rs-preset"
              classList={{ active: current() === x.id && !custom() }}
              onClick={() => (setCustom(false), setRecPrefs({ maxHeight: x.height, fps: x.fps, bitrateKbps: x.kbps }))}
            >
              <strong>{t(x.name)}</strong>
              <span>
                {heightName(x.height)} · {x.fps} fps
              </span>
              <small>{t('about {gb} GB an hour', { gb: fmt1(gbPerHour(x.kbps)) })}</small>
            </button>
          )}
        </For>
        <button class="rs-preset" classList={{ active: custom() || !current() }} onClick={() => setCustom(true)}>
          <strong>{t('Custom')}</strong>
          <span>
            {heightName(r().maxHeight)} · {r().fps} fps
          </span>
          <small>{t('about {gb} GB an hour', { gb: fmt1(gbPerHour(r().bitrateKbps)) })}</small>
        </button>
      </div>
      <Show when={custom() || !current()}>
        <div class="rs-box rs-custom">
          <div class="rs-field">
            <span>{t('Resolution')}</span>
            <div class="rs-seg">
              <For each={[720, 1080, 1440, 0]}>
                {(h) => (
                  <button classList={{ active: r().maxHeight === h }} onClick={() => setRecPrefs({ maxHeight: h })}>
                    {heightName(h)}
                  </button>
                )}
              </For>
            </div>
          </div>
          <div class="rs-field">
            <span>{t('Frame rate')}</span>
            <div class="rs-seg">
              <For each={[30, 60]}>
                {(f) => (
                  <button classList={{ active: r().fps === f }} onClick={() => setRecPrefs({ fps: f })}>
                    {f} fps
                  </button>
                )}
              </For>
            </div>
          </div>
          <div class="rs-field">
            <span>
              {t('Bitrate — {n} Mbit/s', { n: fmt1(r().bitrateKbps / 1000) })} ·{' '}
              {t('about {gb} GB an hour', { gb: fmt1(gbPerHour(r().bitrateKbps)) })}
            </span>
            <Slider
              min={2000}
              max={50000}
              step={1000}
              value={r().bitrateKbps}
              onInput={(v) => setRecPrefs({ bitrateKbps: v })}
            />
          </div>
        </div>
      </Show>
      <div class="rs-box">
        <Toggle label={t('Record the cursor')} checked={r().cursor} onChange={(v) => setRecPrefs({ cursor: v })} />
      </div>
    </Block>
  );
}

/** A device dropdown: `none` is the first option ('' value). */
function DevicePick(p: {
  label: string;
  hint?: string;
  icon: JSX.Element;
  value: string;
  none: string;
  devices: MediaDeviceInfo[];
  disabled?: boolean;
  onChange: (id: string) => void;
}) {
  return (
    <label class="rs-device" classList={{ disabled: p.disabled }}>
      <span class="rs-device-icon">{p.icon}</span>
      <span class="rs-device-text">
        <strong>{p.label}</strong>
        <Show when={p.hint}>
          <small>{p.hint}</small>
        </Show>
      </span>
      <select disabled={p.disabled} onChange={(e) => p.onChange(e.currentTarget.value)}>
        <option value="" selected={!p.value}>
          {p.none}
        </option>
        <For each={p.devices}>
          {(d) => (
            <option value={d.deviceId} selected={d.deviceId === p.value}>
              {d.label || t('Unnamed device')}
            </option>
          )}
        </For>
        <Show when={p.value && !p.devices.some((d) => d.deviceId === p.value)}>
          <option value={p.value} selected>
            {t('Unavailable device')}
          </option>
        </Show>
      </select>
    </label>
  );
}

function AudioSettings() {
  const r = () => prefs.rec;
  const { inputs, outputs } = useDevices();
  // Windows 10 can't capture one app's sound (process loopback is Windows 11).
  const [caps] = createResource(() => captureCapabilities().catch(() => ({ per_app_audio: true })));
  const win10 = () => caps() && !caps()!.per_app_audio;
  return (
    <Block
      id="audio"
      title={t('Audio')}
      description={t('Each source is its own track too, so a clip can be fixed later.')}
    >
      <div class="rs-cards two">
        <div class="rs-box">
          <strong class="rs-box-title">{t('What goes into recordings')}</strong>
          <Toggle
            label={t("The game's sound")}
            checked={r().gameAudio}
            onChange={(v) => setRecPrefs({ gameAudio: v })}
          />
          <Toggle
            label={t('Your microphone')}
            hint={t('Even outside calls.')}
            checked={r().mic === 'voice'}
            onChange={(v) => setRecPrefs({ mic: v ? 'voice' : 'off' })}
          />
          <Toggle
            label={t('Voice chat')}
            hint={t("Everyone you hear in your call, except people who don't want to be recorded.")}
            checked={r().voices}
            onChange={(v) => setRecPrefs({ voices: v })}
          />
          <Show when={win10()}>
            <small class="muted">
              {t("On Windows 10 the game's sound is everything your PC plays, voice chat included.")}
            </small>
          </Show>
        </div>
        <div class="rs-box">
          <strong class="rs-box-title">{t('Devices')}</strong>
          <DevicePick
            label={t('Microphone')}
            icon={<I.Mic size={18} />}
            value={r().micDevice}
            none={t('Same as voice chat')}
            devices={inputs()}
            disabled={r().mic === 'off'}
            onChange={(id) => setRecPrefs({ micDevice: id })}
          />
          <DevicePick
            label={t('Sound recorded from')}
            hint={
              win10()
                ? t("The output whose sound is recorded as the game's.")
                : t("Games are recorded on their own; this is for when that isn't possible.")
            }
            icon={<I.Speaker size={18} />}
            value={r().outputDevice}
            none={t('Windows default')}
            devices={outputs()}
            onChange={(id) => setRecPrefs({ outputDevice: id })}
          />
          <DevicePick
            label={t('Play recordings on')}
            icon={<I.Headphones size={18} />}
            value={r().playbackDevice}
            none={t("Pottira's output device")}
            devices={outputs()}
            onChange={(id) => setRecPrefs({ playbackDevice: id })}
          />
        </div>
      </div>
    </Block>
  );
}

function ClipSettings() {
  const r = () => prefs.rec;
  return (
    <Block id="clips" title={t('Clips')}>
      <div class="rs-cards two">
        <div class="rs-box">
          <strong class="rs-box-title">{t('Clip length')}</strong>
          <small class="muted">{t('The clip hotkey saves the last {n} seconds.', { n: r().clipSeconds })}</small>
          <div class="rs-seg one-line">
            <For each={[15, 30, 45, 60, 90, 120, 150, 180]}>
              {(s) => (
                <button classList={{ active: r().clipSeconds === s }} onClick={() => setRecPrefs({ clipSeconds: s })}>
                  {s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`}
                </button>
              )}
            </For>
          </div>
        </div>
        <div class="rs-box">
          <Toggle
            label={t('Sound when something is saved')}
            hint={t('A short chime for clips, screenshots and bookmarks: the only sign while you play.')}
            checked={r().sounds}
            onChange={(v) => setRecPrefs({ sounds: v })}
          />
        </div>
      </div>
    </Block>
  );
}

function HotkeySettings() {
  const bindOf = (action: KeyAction) => prefs.keybinds.find((b) => b.action === action);
  const set = (action: KeyAction, combo: Combo | null) => {
    const rest = prefs.keybinds.filter((b) => b.action !== action);
    setPrefs({ keybinds: [...rest, { id: bindOf(action)?.id ?? `rec-${action}`, action, combo }] });
  };
  const conflict = (action: KeyAction) => {
    const c = bindOf(action)?.combo;
    return c && prefs.keybinds.find((b) => b.action !== action && b.combo?.vk === c.vk && b.combo?.mods === c.mods);
  };
  return (
    <Block
      id="hotkeys"
      title={t('Hotkeys')}
      description={t('They work in games, even with Pottira minimized. The game still gets the key too.')}
    >
      <div class="rs-cards three">
        <For each={REC_ACTIONS}>
          {(action) => (
            <div class="rs-box rs-hotkey">
              <strong>{t(ACTIONS[action].label)}</strong>
              <small class="muted">{t(ACTIONS[action].hint)}</small>
              <div class="rs-row">
                <KeyRecorder combo={bindOf(action)?.combo ?? null} onChange={(c) => set(action, c)} />
                <button
                  class="rs-icon"
                  aria-label={t('Remove keybind')}
                  data-tip={t('Remove')}
                  disabled={!bindOf(action)?.combo}
                  onClick={() => set(action, null)}
                >
                  <I.Trash size={16} />
                </button>
              </div>
              <Show when={conflict(action)}>
                {(o) => (
                  <small class="warn">{t('Also used by {action}', { action: t(ACTIONS[o().action].label) })}</small>
                )}
              </Show>
            </div>
          )}
        </For>
      </div>
    </Block>
  );
}

function StorageSettings(p: { library: Library | null | undefined }) {
  const r = () => prefs.rec;
  const gb = 1024 ** 3;
  const [folder, setFolder] = createSignal(prefs.rec.folder);
  const apply = (patch: Partial<RecPrefs>) => setRecPrefs(patch);
  return (
    <Block
      id="storage"
      title={t('Storage')}
      description={t(
        'Past a limit the oldest go first. Starred and shared ones are never deleted, nor the recording in progress.',
      )}
    >
      <div class="rs-cards two">
        <div class="rs-box">
          <strong class="rs-box-title">{t('Space used')}</strong>
          <Meter label={t('VODs')} used={p.library?.vod_bytes ?? 0} cap={r().vodCapGb * gb} />
          <Meter label={t('Clips and screenshots')} used={p.library?.clip_bytes ?? 0} cap={r().clipCapGb * gb} />
          <Show when={p.library?.free_bytes != null}>
            <small class="muted">{t('{size} free on this drive', { size: formatSize(p.library!.free_bytes!) })}</small>
          </Show>
        </div>
        <div class="rs-box">
          <strong class="rs-box-title">{t('Limits')}</strong>
          <div class="rs-field">
            <span>{t('VODs — up to {n} GB', { n: r().vodCapGb })}</span>
            <Slider min={10} max={1000} step={10} value={r().vodCapGb} onInput={(v) => apply({ vodCapGb: v })} />
          </div>
          <div class="rs-field">
            <span>{t('Clips and screenshots — up to {n} GB', { n: r().clipCapGb })}</span>
            <Slider min={1} max={500} step={1} value={r().clipCapGb} onInput={(v) => apply({ clipCapGb: v })} />
          </div>
          <div class="rs-field">
            <span>{t('Stop recording below {n} GB free', { n: r().minFreeGb })}</span>
            <Slider min={1} max={100} step={1} value={r().minFreeGb} onInput={(v) => apply({ minFreeGb: v })} />
          </div>
        </div>
      </div>
      <div class="rs-box">
        <strong class="rs-box-title">{t('Folder')}</strong>
        <div class="rs-row">
          <input
            class="rs-input grow"
            value={folder()}
            placeholder={p.library?.folder ?? ''}
            aria-label={t('Where REC saves (empty = Videos\\Pottira)')}
            onInput={(e) => setFolder(e.currentTarget.value)}
            onChange={() => apply({ folder: folder().trim() })}
          />
          <button class="btn" onClick={() => void recCall('rec_reveal', { path: null })}>
            <I.FolderOpen size={16} /> {t('Open')}
          </button>
        </div>
        <small class="muted">
          {t('Where REC saves (empty = Videos\\Pottira)')} · {t('Recordings already saved stay where they are.')}
        </small>
      </div>
    </Block>
  );
}

/** League of Legends: your moments as ticks on the VOD (always) and, if you want, clips saved by themselves. */
function LeagueSettings() {
  const l = () => prefs.rec.league;
  const set = (patch: Partial<LeagueClipPrefs>) => setRecPrefs({ league: { ...prefs.rec.league, ...patch } });
  const kinds: [Exclude<keyof LeagueClipPrefs, 'auto'>, string, string?][] = [
    ['multikill', msg('Multikills'), msg('Double kill and up. A pentakill also earns the Pentakill badge.')],
    ['ace', msg('Aces')],
    ['steal', msg('Stolen objectives'), msg('Dragon, Baron Nashor, Rift Herald and others.')],
    ['kill', msg('Every kill')],
    ['death', msg('Every death')],
  ];
  return (
    <Block
      id="league"
      title={t('League of Legends')}
      description={t(
        "Your kills, deaths, multikills and objectives are marked on the recording's timeline either way. Pottira reads them from League's own match data on your PC.",
      )}
    >
      <div class="rs-cards two">
        <div class="rs-box">
          <Toggle
            label={t('Save clips of my plays by themselves')}
            hint={t(
              'Each one ends 5 seconds after the moment and starts the clip length before it. Moments close together make one clip.',
            )}
            checked={l().auto}
            onChange={(v) => set({ auto: v })}
          />
        </div>
        <div class="rs-box">
          <For each={kinds}>
            {([key, label, hint]) => (
              <Toggle
                label={t(label)}
                hint={hint && t(hint)}
                checked={l()[key]}
                disabled={!l().auto}
                onChange={(v) => set({ [key]: v })}
              />
            )}
          </For>
        </div>
      </div>
    </Block>
  );
}

function PrivacySettings() {
  return (
    <Block id="privacy" title={t('Privacy')}>
      <div class="rs-box">
        <VoiceConsent />
      </div>
    </Block>
  );
}

/** Your voice in other people's recordings (a server setting: it applies whether your own REC is on or not). */
export function VoiceConsent() {
  const out = () => !!state.me?.rec_opt_out;
  const set = (record: boolean) =>
    void api('PATCH', '/users/@me', { rec_opt_out: !record }).catch(() => toast(t("Couldn't save that. Try again.")));
  return (
    <Toggle
      label={t('Let others record my voice')}
      hint={t(
        "When this is off, everyone's Pottira leaves your voice out of their recordings from now on. What was already recorded stays.",
      )}
      checked={!out()}
      onChange={set}
    />
  );
}
