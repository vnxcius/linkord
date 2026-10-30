// The message box shows mentions and custom emoji the way people read them ("@MrSansBR", ":dude:"), while
// messages carry Discord's markup ("<@109360124031664128>", "<:dude:108656542873550848>"). A Tokens map
// remembers what each readable form stands for, so sending (or saving an edit) turns them back.
import { nameOf, state } from './store';

/** Readable text -> markup, for what was inserted (or loaded) into one message box. */
export type Tokens = Map<string, string>;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Message markup -> what the box shows, remembering each mention and emoji in `tokens`. */
export function toDisplay(content: string, guildId: string | null | undefined, tokens: Tokens): string {
  return content.replace(/<(@!?|@&|a?:(\w+):)(\d+)>/g, (raw, kind: string, emoji: string | undefined, id: string) => {
    let shown: string;
    if (emoji) shown = `:${emoji}:`;
    else if (kind === '@&') shown = `@${(guildId && state.roles[guildId]?.[id]?.name) || 'role'}`;
    else shown = `@${nameOf(id, guildId)}`;
    // Two different people with the same name keep their markup, so neither is mistaken for the other.
    if (tokens.has(shown) && tokens.get(shown) !== raw) return raw;
    tokens.set(shown, raw);
    return shown;
  });
}

/** What the box shows -> message markup. A typed ":name:" becomes a server emoji of that name, if there is one. */
export function toRaw(text: string, guildId: string | null | undefined, tokens: Tokens): string {
  const shown = [...tokens.keys()].sort((a, b) => b.length - a.length);
  let out = text;
  if (shown.length) {
    const re = new RegExp(`(${shown.map(escape).join('|')})(?![\\w.])`, 'g');
    out = out.replace(re, (s) => tokens.get(s) ?? s);
  }
  // Inside code spans and blocks, ":name:" stays as typed.
  return out.replace(/(```[\s\S]*?```|`[^`\n]*`)|(?<![<\w]):(\w{2,32}):(?!\d)/g, (all, code, name) => {
    if (code) return code;
    const list = [...(guildId ? (state.emojis[guildId] ?? []) : []), ...Object.values(state.emojis).flat()];
    const e = list.find((x) => x.name === name);
    return e ? `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>` : all;
  });
}
