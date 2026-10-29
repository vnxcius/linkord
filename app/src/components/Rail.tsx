// Server list, like Discord's: drag a server up or down to reorder, onto another server to make a
// folder, or onto a folder to add it. Folders open in place; the order syncs across devices
// (settings.guild_folders), which folders are open is per device.
import { createSignal, For, Show } from 'solid-js';
import { markRead, patchSettings, selectView } from '../lib/actions';
import { t } from '../lib/i18n';
import { openPage } from '../lib/route';
import { isTauri } from '../lib/platform';
import { guildMentions, guildUnread, state } from '../lib/store';
import type { GuildFolder } from '../lib/types';
import { attempt, isMobile, openMenu, setUi, type MenuEntry } from '../lib/ui';
import { guildMenu } from './Sidebar';
import { GuildIcon } from './Avatar';
import { Download, Emblem, Folder, Plus } from './Icons';
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

const OPEN_KEY = 'linkord.openFolders';
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
      const y = (e.clientY - r.top) / r.height;
      const into = combine && !isFolderKey(from) && y > 0.25 && y < 0.75;
      setMark({ key, zone: into ? 'into' : y < 0.5 ? 'before' : 'after' });
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

export function Rail() {
  const dmMentions = () => state.dmOrder.reduce((n, id) => n + (state.mentions[id] ?? 0), 0);
  return (
    <nav class="rail">
      <RailItem
        home
        active={state.view === '@me'}
        label={t('Direct Messages')}
        badge={dmMentions()}
        onClick={() => selectView('@me')}
      >
        <Emblem size={24} />
      </RailItem>
      <div class="rail-sep" />
      <For each={railEntries()}>{(f) => (f.id ? <FolderItem folder={f} /> : <GuildItem id={f.guild_ids[0]} />)}</For>
      <RailItem label={t('Add a server')} add onClick={() => setUi('modal', { type: 'add-server' })}>
        <Plus size={22} />
      </RailItem>
      <Show when={!isTauri && !isMobile()}>
        <RailItem label={t('Download the app')} add onClick={() => openPage('download')}>
          <Download size={20} />
        </RailItem>
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
  const color = () => accentCss(p.folder.color) ?? 'var(--glow)';
  const mentions = () => p.folder.guild_ids.reduce((n, id) => n + guildMentions(id), 0);
  const unread = () => p.folder.guild_ids.some(guildUnread);
  const active = () => p.folder.guild_ids.includes(state.view);
  return (
    <div class="rail-folder" classList={{ open: open() }} style={{ '--folder': color() }}>
      <RailItem
        active={!open() && active()}
        unread={!open() && unread()}
        badge={open() ? 0 : mentions()}
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
  label: string;
  add?: boolean;
  folder?: boolean;
  home?: boolean;
  onClick: () => void;
  onContextMenu?: (e: MouseEvent) => void;
  drag?: ReturnType<typeof dnd>;
  marks?: Record<string, boolean>;
  children: any;
}) {
  return (
    <div class="rail-item" classList={{ active: p.active, unread: p.unread, muted: p.muted, ...p.marks }} {...p.drag}>
      <span class="rail-pill" />
      <button
        class="rail-btn"
        classList={{ add: p.add, 'folder-btn': p.folder, 'home-btn': p.home }}
        onClick={p.onClick}
        onContextMenu={p.onContextMenu}
        aria-label={p.label}
        data-tip={p.label}
      >
        {p.children}
      </button>
      <Show when={p.badge}>
        <span class="badge rail-badge">{p.badge! > 99 ? '99+' : p.badge}</span>
      </Show>
    </div>
  );
}
