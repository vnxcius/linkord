#!/usr/bin/env node
// Builds src/lib/emoji-list.json (the emoji picker and `:name` autocomplete) from emojibase-data.
// Only emoji up to Unicode/Emoji 15.0, since the bundled Twemoji font (twemoji-colr-font 15.0.x) has no newer ones;
// raise MAX_VERSION together with that package. Run from app/: node scripts/build-emoji-data.mjs
//
// Output: [[group, [[emoji, "name name2", "search tags", skins?], ...]], ...]
// skins: omitted = no skin tones; 1 = the tone goes right after the first character; otherwise the 5 variants.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_VERSION = 15.0;
const read = (f) => JSON.parse(readFileSync(join(APP, 'node_modules/emojibase-data/en', f), 'utf8'));

const data = read('data.json');
// Shortcode sets, most familiar first (GitHub and Slack/iamcal names are what Discord mostly uses).
const sets = ['shortcodes/github.json', 'shortcodes/iamcal.json', 'shortcodes/emojibase.json'].map(read);

// Picker sections (emojibase groups; 2 = skin tone/hair components, left out). Names are translated in the UI.
const GROUPS = [
  [0, 'Smileys'],
  [1, 'People'],
  [3, 'Nature'],
  [4, 'Food'],
  [6, 'Activities'],
  [5, 'Travel'],
  [7, 'Objects'],
  [8, 'Symbols'],
  [9, 'Flags'],
];
// Names Linkord's picker had before this list was generated, kept so they still autocomplete.
const OLD_NAMES = {
  '🙂': ['slight_smile'], '🥰': ['smiling_face_with_hearts'], '😝': ['squint_tongue'], '🤑': ['money_mouth'],
  '🙄': ['eye_roll'], '🤒': ['sick'], '🤕': ['hurt'], '🤯': ['mind_blown'], '🧐': ['monocle'], '🙁': ['slight_frown'],
  '🥹': ['holding_back_tears'], '😥': ['sad_relieved'], '🤬': ['cursing'], '☠': ['skull_crossbones'], '🤏': ['pinching'],
  '✌': ['peace'], '🤟': ['love_you'], '🤙': ['call_me'], '🖐': ['hand_splayed'], '🤲': ['palms_up'], '✍': ['writing'],
  '🫠': ['melting'], '💫': ['dizzy_star'], '🧿': ['nazar'], '🗺': ['map'], '🌲': ['evergreen'], '🌳': ['tree'],
  '🌾': ['rice'], '🎊': ['confetti'], '🥩': ['steak'], '🍫': ['chocolate'], '🧃': ['juice'], '🥂': ['champagne'],
  '🍷': ['wine'],
};
const TONES = ['🏻', '🏼', '🏽', '🏾', '🏿'];

/** The fully-qualified form: emojibase adds FE0F even where Unicode doesn't (👍️), which would make a picked 👍 a
 *  different reaction from a typed one. FE0F only belongs after characters that are text-style by default (❤️). */
const chars = (e) => (e.emoji ?? e).replace(/(\p{Emoji_Presentation})\uFE0F/gu, '$1');
const stripVs = (s) => s.replace(/\uFE0F/g, '');
/** Default tone placement: the modifier right after the first character, replacing its FE0F. */
function placeTone(emoji, tone) {
  const [first, ...rest] = [...emoji];
  if (rest[0] === '\uFE0F') rest.shift();
  return first + tone + rest.join('');
}

function names(e) {
  const out = [...(OLD_NAMES[stripVs(chars(e))] ?? [])];
  for (const set of sets) for (const n of [set[e.hexcode]].flat()) if (n && !out.includes(n.toLowerCase())) out.push(n.toLowerCase());
  if (!out.length) out.push(e.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  // Word names first (:thumbsup:, not :+1:); the first one is what the picker shows.
  return out.sort((a, b) => /^[a-z]/.test(b) - /^[a-z]/.test(a));
}

const groups = GROUPS.map(([id, name]) => {
  const list = data
    .filter((e) => e.group === id && e.version <= MAX_VERSION)
    .sort((a, b) => a.order - b.order)
    .map((e) => {
      const entry = [chars(e), names(e).join(' '), [...new Set(e.tags ?? [])].join(' ')];
      const skins = (e.skins ?? []).filter((s) => typeof s.tone === 'number').sort((a, b) => a.tone - b.tone);
      if (skins.length === 5) {
        const variants = skins.map((s) => chars(s));
        entry.push(variants.every((v, i) => v === placeTone(chars(e), TONES[i])) ? 1 : variants);
      }
      return entry;
    });
  return [name, list];
});

const out = join(APP, 'src/lib/emoji-list.json');
writeFileSync(out, JSON.stringify(groups) + '\n');
const total = groups.reduce((n, [, l]) => n + l.length, 0);
console.log(`src/lib/emoji-list.json: ${total} emoji in ${groups.length} groups`);
