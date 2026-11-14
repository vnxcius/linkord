// Keybinds: a key plus modifiers, mapped to an action. Keys are stored as Windows virtual-key codes
// (0x04-0x06 = middle/side mouse buttons) so the desktop app's native hook can match them.
import { msg } from './msg';

export const MOD = { ctrl: 1, shift: 2, alt: 4, meta: 8 } as const;

export interface Combo {
  vk: number;
  /** Required modifiers (MOD bits). */
  mods: number;
  /** Name of the key itself, e.g. "M", "Num *", "Mouse 4". */
  label: string;
}

export type KeyAction =
  | 'ptt'
  | 'ptm'
  | 'toggle-mute'
  | 'toggle-deafen'
  | 'toggle-stream'
  | 'stream-game'
  | 'toggle-camera'
  | 'toggle-overlay'
  | 'disconnect'
  | 'rec-clip'
  | 'rec-screenshot'
  | 'rec-bookmark'
  | 'rec-toggle'
  | 'rec-overlay';

export interface Keybind {
  id: string;
  action: KeyAction;
  combo: Combo | null;
}

/** `rec`: a REC hotkey, set on the REC page instead of Settings -> Keybinds. */
export const ACTIONS: Record<KeyAction, { label: string; hint: string; hold: boolean; rec?: true }> = {
  ptt: { label: msg('Push to Talk'), hint: msg('Hold to talk. Switches your input mode to Push to Talk.'), hold: true },
  ptm: { label: msg('Push to Mute'), hint: msg('Hold to mute yourself for a moment.'), hold: true },
  'toggle-mute': { label: msg('Toggle Mute'), hint: msg('Mute or unmute your microphone.'), hold: false },
  'toggle-deafen': { label: msg('Toggle Deafen'), hint: msg('Stop hearing voice chat (also mutes you).'), hold: false },
  'toggle-stream': {
    label: msg('Go Live / Stop Streaming'),
    hint: msg('Opens the Go Live picker, or ends your stream.'),
    hold: false,
  },
  'stream-game': {
    label: msg('Stream Your Game'),
    hint: msg('Goes live with the game you are playing right away, or ends your stream.'),
    hold: false,
  },
  'toggle-camera': { label: msg('Toggle Camera'), hint: msg('Turn your camera on or off in voice.'), hold: false },
  'toggle-overlay': {
    label: msg('Toggle Game Overlay'),
    hint: msg('Show or hide the overlay over your game (Windows app).'),
    hold: false,
  },
  disconnect: { label: msg('Disconnect from Voice'), hint: msg('Leave the voice channel you are in.'), hold: false },
  'rec-clip': {
    label: msg('Save a Clip'),
    hint: msg('Saves the last moments of your game as a clip.'),
    hold: false,
    rec: true,
  },
  'rec-screenshot': {
    label: msg('Take a Screenshot'),
    hint: msg('Saves a picture of your game.'),
    hold: false,
    rec: true,
  },
  'rec-bookmark': {
    label: msg('Bookmark'),
    hint: msg('Marks this moment in the recording, to find it later.'),
    hold: false,
    rec: true,
  },
  'rec-toggle': {
    label: msg('Start / Stop Recording'),
    hint: msg('Stops or starts recording your game. With no game open, records the display you pick.'),
    hold: false,
    rec: true,
  },
  'rec-overlay': {
    label: msg('Open REC Overlay'),
    hint: msg('Opens REC over your game. Only works while a game is open.'),
    hold: false,
    rec: true,
  },
};

/** The REC actions, in the order the REC page lists them. */
export const REC_ACTIONS: KeyAction[] = ['rec-overlay', 'rec-clip', 'rec-screenshot', 'rec-bookmark', 'rec-toggle'];

export const DEFAULT_KEYBINDS: Keybind[] = [
  { id: 'default-mute', action: 'toggle-mute', combo: { vk: 0x4d, mods: MOD.ctrl | MOD.shift, label: 'M' } },
  { id: 'default-deafen', action: 'toggle-deafen', combo: { vk: 0x44, mods: MOD.ctrl | MOD.shift, label: 'D' } },
];

const NAMED: Record<string, [number, string]> = {
  Space: [0x20, msg('Space')],
  Backquote: [0xc0, '`'],
  Tab: [0x09, 'Tab'],
  CapsLock: [0x14, 'Caps Lock'],
  ShiftLeft: [0xa0, msg('Left Shift')],
  ShiftRight: [0xa1, msg('Right Shift')],
  ControlLeft: [0xa2, msg('Left Ctrl')],
  ControlRight: [0xa3, msg('Right Ctrl')],
  AltLeft: [0xa4, msg('Left Alt')],
  AltRight: [0xa5, msg('Right Alt')],
  MetaLeft: [0x5b, msg('Left Win')],
  MetaRight: [0x5c, msg('Right Win')],
  ContextMenu: [0x5d, 'Menu'],
  Enter: [0x0d, 'Enter'],
  NumpadEnter: [0x0d, 'Enter'],
  Backspace: [0x08, msg('Backspace')],
  Escape: [0x1b, 'Esc'],
  Backslash: [0xdc, '\\'],
  IntlBackslash: [0xe2, '\\'],
  BracketLeft: [0xdb, '['],
  BracketRight: [0xdd, ']'],
  Semicolon: [0xba, ';'],
  Quote: [0xde, "'"],
  Comma: [0xbc, ','],
  Period: [0xbe, '.'],
  Slash: [0xbf, '/'],
  Minus: [0xbd, '-'],
  Equal: [0xbb, '='],
  Insert: [0x2d, msg('Insert')],
  Delete: [0x2e, msg('Delete')],
  Home: [0x24, msg('Home')],
  End: [0x23, msg('End')],
  PageUp: [0x21, msg('Page Up')],
  PageDown: [0x22, msg('Page Down')],
  ArrowLeft: [0x25, '←'],
  ArrowUp: [0x26, '↑'],
  ArrowRight: [0x27, '→'],
  ArrowDown: [0x28, '↓'],
  NumpadMultiply: [0x6a, 'Num *'],
  NumpadAdd: [0x6b, 'Num +'],
  NumpadSubtract: [0x6d, 'Num -'],
  NumpadDecimal: [0x6e, 'Num .'],
  NumpadDivide: [0x6f, 'Num /'],
  NumLock: [0x90, 'Num Lock'],
  ScrollLock: [0x91, 'Scroll Lock'],
  Pause: [0x13, msg('Pause')],
  PrintScreen: [0x2c, msg('Print Screen')],
  AudioVolumeMute: [0xad, msg('Volume Mute')],
  AudioVolumeDown: [0xae, msg('Volume Down')],
  AudioVolumeUp: [0xaf, msg('Volume Up')],
  MediaTrackNext: [0xb0, msg('Next Track')],
  MediaTrackPrevious: [0xb1, msg('Previous Track')],
  MediaStop: [0xb2, msg('Media Stop')],
  MediaPlayPause: [0xb3, msg('Play/Pause')],
};

export function keyFromEvent(e: KeyboardEvent): { vk: number; label: string } | null {
  const c = e.code;
  if (/^Key[A-Z]$/.test(c)) return { vk: c.charCodeAt(3), label: c.slice(3) };
  if (/^Digit\d$/.test(c)) return { vk: 0x30 + +c[5], label: c[5] };
  if (/^Numpad\d$/.test(c)) return { vk: 0x60 + +c[6], label: `Num ${c[6]}` };
  const f = c.match(/^F(\d{1,2})$/);
  if (f && +f[1] <= 24) return { vk: 0x6f + +f[1], label: c };
  const named = NAMED[c];
  return named ? { vk: named[0], label: named[1] } : null;
}

/** Middle and side mouse buttons are popular push-to-talk binds. */
export function keyFromMouse(e: MouseEvent): { vk: number; label: string } | null {
  if (e.button === 1) return { vk: 0x04, label: 'Mouse 3' };
  if (e.button === 3) return { vk: 0x05, label: 'Mouse 4' };
  if (e.button === 4) return { vk: 0x06, label: 'Mouse 5' };
  return null;
}

/** The modifier a key is (left/right variants included), or 0. Mirrors keybinds.rs. */
export function modifierOf(vk: number): number {
  if (vk === 0xa0 || vk === 0xa1) return MOD.shift;
  if (vk === 0xa2 || vk === 0xa3) return MOD.ctrl;
  if (vk === 0xa4 || vk === 0xa5) return MOD.alt;
  if (vk === 0x5b || vk === 0x5c) return MOD.meta;
  return 0;
}

/** Modifiers held during an event, not counting the key itself. */
export function modsFromEvent(e: KeyboardEvent | MouseEvent, vk = 0): number {
  const m =
    (e.ctrlKey ? MOD.ctrl : 0) | (e.shiftKey ? MOD.shift : 0) | (e.altKey ? MOD.alt : 0) | (e.metaKey ? MOD.meta : 0);
  return m & ~modifierOf(vk);
}

export function modsLabel(mods: number): string[] {
  return [
    mods & MOD.ctrl && 'Ctrl',
    mods & MOD.shift && 'Shift',
    mods & MOD.alt && 'Alt',
    mods & MOD.meta && 'Win',
  ].filter(Boolean) as string[];
}

export function comboParts(c: Combo): string[] {
  return [...modsLabel(c.mods), c.label];
}

/** `tr` translates key names and "Not set" (keys.ts can't import i18n: prefs.ts imports this file). */
export const comboLabel = (c: Combo | null | undefined, tr = (s: string) => s) =>
  c ? comboParts(c).map(tr).join(' + ') : tr(msg('Not set'));

export const sameCombo = (a: Combo | null, b: Combo | null) => !!a && !!b && a.vk === b.vk && a.mods === b.mods;
