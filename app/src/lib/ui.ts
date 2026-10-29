import type { JSX } from 'solid-js';
import { createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import type { Message } from './types';

export type Modal =
  | { type: 'add-server' }
  | { type: 'invite'; guildId: string }
  | { type: 'create-channel'; guildId: string; kind: 0 | 2 | 4; parentId?: string }
  | { type: 'channel-settings'; channelId: string }
  | { type: 'server-settings'; guildId: string; tab?: string }
  | { type: 'settings'; tab?: string }
  | { type: 'join-invite'; code: string }
  | { type: 'create-group' }
  | { type: 'user-profile'; userId: string; guildId?: string }
  | { type: 'folder-settings'; folderId: string }
  | { type: 'go-live'; update?: boolean; switchSource?: boolean }
  | { type: 'nickname'; guildId: string; userId: string }
  | { type: 'custom-status' }
  | { type: 'forward'; message: Message }
  | { type: 'confirm'; title: string; body: string; action: string; run: () => Promise<unknown> };

export interface MenuItem {
  label: string;
  icon?: () => JSX.Element;
  danger?: boolean;
  checked?: boolean;
  disabled?: boolean;
  run?: () => unknown;
  /** Custom content instead of a button (e.g. a volume slider). */
  render?: () => JSX.Element;
}

export type MenuEntry = MenuItem | 'separator';

export const [ui, setUi] = createStore({
  modal: null as Modal | null,
  /** A user card at x/y, or with its bottom edge at `bottom` (opened from below, like your own panel). */
  profile: null as { userId: string; x: number; y: number; bottom?: number; guildId?: string } | null,
  menu: null as { x: number; y: number; items: MenuEntry[] } | null,
  lightbox: null as string | null,
  replyTo: {} as Record<string, string | undefined>,
  editing: null as string | null,
  /** Voice channel whose status is being edited in the header. */
  editVoiceStatus: null as string | null,
  showMembers: true,
  panel: null as 'search' | 'pins' | null,
  search: {
    query: '',
    channelId: '' as string | undefined,
    results: null as null | { total: number; messages: any[] },
    loading: false,
  },
  toast: null as string | null,
  /** Bumped to ask the composer to take focus (reply, end of edit, file picked...). */
  composerFocus: 0,
  /** Bumped when you send a message, so the list jumps to the bottom. */
  sent: { channelId: '', n: 0 },
  /** Messages picked for bulk delete. */
  selection: null as { channelId: string; ids: string[]; anchor?: string } | null,
  /** Phones show one pane at a time: the server/channel lists, or the open chat. */
  mobilePane: 'nav' as 'nav' | 'main',
  /** Below 1100px the member list has no room beside the chat and slides in over it instead. */
  membersDrawer: false,
});

const phone = matchMedia('(max-width: 760px)');
const [isMobile, setIsMobile] = createSignal(phone.matches);
phone.addEventListener('change', (e) => setIsMobile(e.matches));
export { isMobile };

const narrowQuery = matchMedia('(max-width: 1100px)');
const [isNarrow, setIsNarrow] = createSignal(narrowQuery.matches);
narrowQuery.addEventListener('change', (e) => setIsNarrow(e.matches));
export { isNarrow };

export const focusComposer = () => setUi('composerFocus', (n) => n + 1);

/** Starts replying to a message and puts the cursor in the composer. */
export function replyTo(channelId: string, messageId: string) {
  setUi('replyTo', channelId, messageId);
  focusComposer();
}

let toastTimer: number | undefined;

export function toast(msg: string, ms = 3500) {
  setUi('toast', msg);
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => setUi('toast', null), ms);
}

export function openProfile(userId: string, e: MouseEvent, guildId?: string) {
  e.stopPropagation();
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  setUi('profile', { userId, x: r.right + 10, y: r.top, guildId });
}

/** Right-click menus. Call from onContextMenu. */
export function openMenu(e: MouseEvent, items: MenuEntry[]) {
  e.preventDefault();
  e.stopPropagation();
  setUi('menu', { x: e.clientX, y: e.clientY, items });
}

/** Wraps an API action: shows the server's error as a toast instead of failing silently. */
export function attempt(fn: () => Promise<unknown>, success?: string) {
  return fn().then(
    () => success && toast(success),
    (e) => toast(e instanceof Error ? e.message : String(e)),
  );
}
