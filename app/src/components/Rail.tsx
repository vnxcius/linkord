// Server list, tiles across the top of the channel list: at most two rows, the rest behind a "+N" tile that opens a
// searchable panel (owner, 2026-11-14: a sideways-scrolling row was too hard to browse). Drag a server left or right to
// reorder, onto another server to make a folder, or onto a folder to add it. Folders open in place; the order syncs across devices
// (settings.guild_folders), which folders are open is per device.
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { markRead, patchSettings, selectView } from '../lib/actions';
import { t } from '../lib/i18n';
import { openPage } from '../lib/route';
import { isTauri } from '../lib/platform';
import { guildAlert, guildMentions, guildUnread, state } from '../lib/store';
import type { GuildFolder } from '../lib/types';
import { attempt, isMobile, openMenu, setUi, type MenuEntry } from '../lib/ui';
import { guildMenu } from './Sidebar';
import { GuildIcon } from './Avatar';
import { Download, Folder, Mark, Plus } from './Icons';
import { accentCss } from './Profile';

/** The server list as stored, cleaned up: unknown servers dropped, servers not listed yet appended. */
export function railEntries(): GuildFolder[] {
  const known = new Set(state.guildOrder);
  const seen = new Set<string>();
  const out: GuildFolder[] = [];
  for (const f of state.settings.guild_folders ?? []) {
    const ids = f.guild_ids.filter((id) => known.has(id) && !seen.has(id));
    ids.forEach((id) => seen.add(id));
    if (!ids.length) continue;
    if (f.id) out.push({ ...f, guild_ids: ids });
    else ids.forEach((id) => out.push({ guild_ids: [id] }));
  }
  for (const id of state.guildOrder) if (!seen.has(id)) out.push({ guild_ids: [id] });
  return out;
}

const saveEntries = (entries: GuildFolder[]) => attempt(() => patchSettings({ guild_folders: entries }));

const OPEN_KEY = 'pottira.openFolders';
const [openFolders, setOpenFolders] = createSignal<string[]>(
  (() => {
    try {
      return JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]');
    } catch {
      return [];
    }
  })(),
);
function toggleFolder(id: string) {
  const next = openFolders().includes(id) ? openFolders().filter((x) => x !== id) : [...openFolders(), id];
  setOpenFolders(next);
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify(next));
  } catch {}
}

const folderName = (f: GuildFolder) =>
  f.name ||
  f.guild_ids
    .map((id) => state.guilds[id]?.name)
    .filter(Boolean)
    .slice(0, 3)
    .join(', ');

export function updateFolder(id: string, patch: Partial<GuildFolder>) {
  return saveEntries(railEntries().map((f) => (f.id === id ? { ...f, ...patch } : f)));
}

function folderMenu(f: GuildFolder): MenuEntry[] {
  const channels = (gid: string) =>
    Object.values(state.channels)
      .filter((c) => c.guild_id === gid)
      .map((c) => c.id);
  return [
    { label: t('Mark Folder As Read'), run: () => markRead(f.guild_ids.flatMap(channels)) },
    {
      label: t('Folder Settings'),
      icon: () => <Folder size={16} />,
      run: () => setUi('modal', { type: 'folder-settings', folderId: f.id! }),
    },
    'separator',
    {
      label: t('Ungroup Folder'),
      run: () =>
        saveEntries(
          railEntries().flatMap((x) => (x.id === f.id ? x.guild_ids.map((id) => ({ guild_ids: [id] })) : [x])),
        ),
    },
  ];
}

// ---------- drag and drop ----------

type Mark = { key: string; zone: 'before' | 'after' | 'into' };
const [dragKey, setDragKey] = createSignal<string | null>(null);
const [mark, setMark] = createSignal<Mark | null>(null);
/** Drag keys: "g:<guild id>" for servers, "f:<folder id>" for folders. */
const isFolderKey = (k: string) => k.startsWith('f:');

function drop(from: string, to: Mark) {
  if (from === to.key) return;
  let entries = railEntries().map((f) => ({ ...f, guild_ids: [...f.guild_ids] }));
  const fid = from.slice(2);
  let moving: GuildFolder;
  if (isFolderKey(from)) {
    moving = entries.find((f) => f.id === fid)!;
    entries = entries.filter((f) => f !== moving);
  } else {
    moving = { guild_ids: [fid] };
    for (const f of entries) f.guild_ids = f.guild_ids.filter((id) => id !== fid);
    entries = entries.filter((f) => f.guild_ids.length);
  }
  const targetId = to.key.slice(2);
  if (isFolderKey(to.key)) {
    const i = entries.findIndex((f) => f.id === targetId);
    if (i < 0) return;
    if (to.zone === 'into') entries[i].guild_ids.push(...moving.guild_ids);
    else entries.splice(i + (to.zone === 'after' ? 1 : 0), 0, moving);
  } else {
    const i = entries.findIndex((f) => f.guild_ids.includes(targetId));
    if (i < 0) return;
    const holder = entries[i];
    if (holder.id) {
      // A server inside a folder: place it next to that one, in the folder.
      const j = holder.guild_ids.indexOf(targetId);
      holder.guild_ids.splice(j + (to.zone === 'before' ? 0 : 1), 0, ...moving.guild_ids);
    } else if (to.zone === 'into') {
      entries[i] = { id: `${Date.now()}`, guild_ids: [targetId, ...moving.guild_ids] };
    } else entries.splice(i + (to.zone === 'after' ? 1 : 0), 0, moving);
  }
  void saveEntries(entries);
}

/** Drag props for a rail element. `combine`: dropping a server in its middle makes/joins a folder. */
function dnd(key: string, combine: boolean) {
  return {
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.stopPropagation();
      setDragKey(key);
      e.dataTransfer!.effectAllowed = 'move';
      e.dataTransfer!.setData('text/plain', key);
    },
    onDragOver: (e: DragEvent) => {
      const from = dragKey();
      if (!from || from === key) return;
      e.preventDefault();
      e.stopPropagation();
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const into = combine && !isFolderKey(from) && x > 0.25 && x < 0.75;
      setMark({ key, zone: into ? 'into' : x < 0.5 ? 'before' : 'after' });
    },
    onDragLeave: () => mark()?.key === key && setMark(null),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const from = dragKey();
      const m = mark();
      setDragKey(null);
      setMark(null);
      if (from && m) drop(from, m);
    },
    onDragEnd: () => {
      setDragKey(null);
      setMark(null);
    },
  };
}
const markClass = (key: string) => ({
  dragging: dragKey() === key,
  'drop-before': mark()?.key === key && mark()!.zone === 'before',
  'drop-after': mark()?.key === key && mark()!.zone === 'after',
  'drop-into': mark()?.key === key && mark()!.zone === 'into',
});

// ---------- rail ----------

/** Tile sizes, to lay the strip out before rendering it: a tile is 38 px, tiles are 6 px apart, an open folder holds its
 * own tile and its servers' plus 4 px of padding on each side. Keep in step with .rail-btn / .rail-servers / .rail-folder. */
const TILE = 38;
const GAP = 6;
const entryWidth = (f: GuildFolder) =>
  f.id && openFolders().includes(f.id) ? 8 + (f.guild_ids.length + 1) * TILE + f.guild_ids.length * GAP : TILE;

/** How many entries fit in two rows of `width` px: all of them, or as many as leave room for the "+N" tile. */
function fitTwoRows(widths: number[], width: number): number {
  const fits = (n: number, more: boolean) => {
    let row = 1;
    let x = 0;
    const put = (w: number) => {
      if (x === 0) x = w;
      else if (x + GAP + w <= width) x += GAP + w;
      else {
        row += 1;
        x = w;
      }
      return row <= 2;
    };
    for (let i = 0; i < n; i++) if (!put(widths[i])) return false;
    return more ? put(TILE) : true;
  };
  if (fits(widths.length, false)) return widths.length;
  let n = 0;
  while (n < widths.length && fits(n + 1, true)) n++;
  return n;
}

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

export function Rail() {
  const dmMentions = () => state.dmOrder.reduce((n, id) => n + (state.mentions[id] ?? 0), 0);
  let servers!: HTMLDivElement;
  const [width, setWidth] = createSignal(0);
  onMount(() => {
    const ro = new ResizeObserver(() => setWidth(servers.clientWidth));
    ro.observe(servers);
    onCleanup(() => ro.disconnect());
  });

  /** What the two rows show and what waits behind "+N". The server you're in never hides: it takes the last place. */
  const split = createMemo(() => {
    const entries = railEntries();
    const n = width() ? fitTwoRows(entries.map(entryWidth), width()) : entries.length;
    if (n >= entries.length) return { shown: entries, hidden: [] as GuildFolder[] };
    const shown = entries.slice(0, n);
    const hidden = entries.slice(n);
    const i = hidden.findIndex((f) => f.guild_ids.includes(state.view));
    if (i >= 0 && shown.length) {
      const [current] = hidden.splice(i, 1);
      hidden.unshift(shown.pop()!);
      shown.push(current);
    }
    return { shown, hidden };
  });
  const hiddenIds = () => split().hidden.flatMap((f) => f.guild_ids);

  const [panel, setPanel] = createSignal(false);
  const [query, setQuery] = createSignal('');
  const close = () => {
    setPanel(false);
    setQuery('');
  };
  const go = (id: string) => {
    close();
    selectView(id);
  };
  createEffect(() => {
    if (!panel()) return;
    const down = (e: PointerEvent) => !(e.target as Element).closest?.('.rail-more-panel, .more-btn') && close();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key, true);
    onCleanup(() => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key, true);
    });
  });
  // Nothing left behind "+N" (a wider window, a server left): the panel closes.
  createEffect(() => !hiddenIds().length && close());

  /** The panel's list: the hidden servers, or while searching, every server whose name matches. */
  const listed = () => {
    const q = fold(query().trim());
    const rows = (list: GuildFolder[]) =>
      list.flatMap((f) => f.guild_ids.map((id) => ({ id, folder: f.id ? folderName(f) : '' })));
    if (!q) return rows(split().hidden);
    return rows(railEntries()).filter((x) => fold(state.guilds[x.id]?.name ?? '').includes(q));
  };

  return (
    <nav class="rail">
      <RailItem
        home
        active={state.view === '@me'}
        label={t('Direct Messages')}
        badge={dmMentions()}
        onClick={() => selectView('@me')}
      >
        <Mark size={22} />
      </RailItem>
      <div class="rail-sep" />
      <div class="rail-servers" ref={servers}>
        <For each={split().shown}>{(f) => (f.id ? <FolderItem folder={f} /> : <GuildItem id={f.guild_ids[0]} />)}</For>
        <Show when={hiddenIds().length}>
          <RailItem
            more
            active={panel()}
            label={t('More servers')}
            badge={hiddenIds().reduce((n, id) => n + guildMentions(id), 0)}
            alert={hiddenIds().some(guildAlert)}
            unread={hiddenIds().some(guildUnread)}
            onClick={() => (panel() ? close() : setPanel(true))}
          >
            <span class="rail-more-count">+{hiddenIds().length}</span>
          </RailItem>
        </Show>
      </div>
      <RailItem label={t('Add a server')} add onClick={() => setUi('modal', { type: 'add-server' })}>
        <Plus size={22} />
      </RailItem>
      <Show when={!isTauri && !isMobile()}>
        <RailItem label={t('Download the app')} add onClick={() => openPage('download')}>
          <Download size={20} />
        </RailItem>
      </Show>
      <Show when={panel()}>
        <div class="rail-more-panel" role="dialog" aria-label={t('More servers')}>
          <input
            class="rail-more-search"
            placeholder={t('Search servers')}
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              const first = listed()[0];
              if (first) go(first.id);
            }}
            ref={(el) => queueMicrotask(() => el.focus())}
          />
          <div class="rail-more-list">
            <For each={listed()} fallback={<p class="rail-more-empty">{t('No servers match.')}</p>}>
              {(x) => (
                <Show when={state.guilds[x.id]}>
                  {(g) => (
                    <button
                      class="rail-more-item"
                      classList={{ active: state.view === x.id, unread: guildUnread(x.id) }}
                      onClick={() => go(x.id)}
                      onContextMenu={(e) => openMenu(e, guildMenu(x.id))}
                    >
                      <GuildIcon name={g().name} icon={g().icon} size={28} />
                      <span class="rmi-text">
                        <span class="rmi-name">{g().name}</span>
                        <Show when={x.folder}>
                          <small>{x.folder}</small>
                        </Show>
                      </span>
                      <Show
                        when={guildMentions(x.id)}
                        fallback={
                          <Show when={guildAlert(x.id)}>
                            <span class="badge rail-alert" aria-label={t('New messages')}>
                              <i />
                            </span>
                          </Show>
                        }
                      >
                        {(n) => <span class="badge">{n() > 99 ? '99+' : n()}</span>}
                      </Show>
                    </button>
                  )}
                </Show>
              )}
            </For>
          </div>
        </div>
      </Show>
    </nav>
  );
}

function GuildItem(p: { id: string; inFolder?: boolean }) {
  const g = () => state.guilds[p.id];
  const key = `g:${p.id}`;
  return (
    <Show when={g()}>
      <RailItem
        active={state.view === p.id}
        unread={guildUnread(p.id)}
        badge={guildMentions(p.id)}
        alert={guildAlert(p.id)}
        label={g()!.name}
        muted={state.settings.muted_guilds?.includes(p.id)}
        onClick={() => selectView(p.id)}
        onContextMenu={(e) => openMenu(e, guildMenu(p.id))}
        drag={dnd(key, !p.inFolder)}
        marks={markClass(key)}
      >
        <GuildIcon name={g()!.name} icon={g()!.icon} />
      </RailItem>
    </Show>
  );
}

function FolderItem(p: { folder: GuildFolder }) {
  const key = `f:${p.folder.id}`;
  const open = () => openFolders().includes(p.folder.id!);
  const color = () => accentCss(p.folder.color) ?? 'var(--brand)';
  const mentions = () => p.folder.guild_ids.reduce((n, id) => n + guildMentions(id), 0);
  const unread = () => p.folder.guild_ids.some(guildUnread);
  const alert = () => p.folder.guild_ids.some(guildAlert);
  const active = () => p.folder.guild_ids.includes(state.view);
  return (
    <div class="rail-folder" classList={{ open: open() }} style={{ '--folder': color() }}>
      <RailItem
        active={!open() && active()}
        unread={!open() && unread()}
        badge={open() ? 0 : mentions()}
        alert={!open() && alert()}
        label={folderName(p.folder)}
        onClick={() => toggleFolder(p.folder.id!)}
        onContextMenu={(e) => openMenu(e, folderMenu(p.folder))}
        drag={dnd(key, true)}
        marks={markClass(key)}
        folder
      >
        <Show
          when={!open()}
          fallback={<Folder size={22} style={{ color: color(), fill: color(), 'fill-opacity': 0.35 }} />}
        >
          <div class="folder-grid">
            <For each={p.folder.guild_ids.slice(0, 4)}>
              {(id) => <GuildIcon name={state.guilds[id]?.name ?? ''} icon={state.guilds[id]?.icon} />}
            </For>
          </div>
        </Show>
      </RailItem>
      <Show when={open()}>
        <For each={p.folder.guild_ids}>{(id) => <GuildItem id={id} inFolder />}</For>
      </Show>
    </div>
  );
}

function RailItem(p: {
  active?: boolean;
  unread?: boolean;
  muted?: boolean;
  badge?: number;
  /** Unread messages that notify, without a mention: a red badge with a dot instead of a number. */
  alert?: boolean;
  label: string;
  add?: boolean;
  folder?: boolean;
  home?: boolean;
  more?: boolean;
  onClick: () => void;
  onContextMenu?: (e: MouseEvent) => void;
  drag?: ReturnType<typeof dnd>;
  marks?: Record<string, boolean>;
  children: any;
}) {
  return (
    <div
      class="rail-item"
      classList={{ active: p.active, unread: p.unread, muted: p.muted, ...p.marks }}
      data-tip={p.label}
      data-tip-side="below"
      {...p.drag}
    >
      <span class="rail-pill" />
      <button
        class="rail-btn"
        classList={{ add: p.add, 'folder-btn': p.folder, 'home-btn': p.home, 'more-btn': p.more }}
        onClick={p.onClick}
        onContextMenu={p.onContextMenu}
        aria-label={p.label}
      >
        {p.children}
      </button>
      <Show
        when={p.badge}
        fallback={
          <Show when={p.alert}>
            <span class="badge rail-badge rail-alert" aria-label={t('New messages')}>
              <i />
            </span>
          </Show>
        }
      >
        <span class="badge rail-badge">{p.badge! > 99 ? '99+' : p.badge}</span>
      </Show>
    </div>
  );
}
