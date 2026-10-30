// The WebView's own right-click menu (Back, Reload, Inspect...) never shows: everything the app doesn't handle
// itself gets Linkord's menu for text fields and selected text, or nothing.
import { t } from './i18n';
import { setUi, toast, type MenuEntry } from './ui';
import { prefs, setPrefs } from './prefs';
import {
  addToDictionary,
  misspelled,
  SPELL_LANGUAGES,
  spellLanguage,
  suggestions,
  wordsIn,
  type SpellLanguage,
} from './spellcheck';

function editable(el: EventTarget | null): HTMLInputElement | HTMLTextAreaElement | HTMLElement | null {
  if (!(el instanceof HTMLElement)) return null;
  const field = el.closest('input, textarea, [contenteditable="true"]') as HTMLElement | null;
  if (field instanceof HTMLInputElement && !/^(text|search|url|email|number|password|tel)$/.test(field.type))
    return null;
  return field;
}

async function paste(field: HTMLElement) {
  field.focus();
  try {
    document.execCommand('insertText', false, await navigator.clipboard.readText());
  } catch {
    toast(t('Use Ctrl+V to paste'));
  }
}

/** Replaces the text between `start` and `end` in a text box, as if typed (undo works, the app sees the input). */
function replaceRange(field: HTMLTextAreaElement | HTMLInputElement, start: number, end: number, text: string) {
  field.focus();
  field.setSelectionRange(start, end);
  document.execCommand('insertText', false, text);
}

/** The message box: suggestions for a misspelled word under the cursor, then the spellcheck options. */
async function spellItems(field: HTMLTextAreaElement): Promise<MenuEntry[]> {
  const items: MenuEntry[] = [];
  const at = field.selectionStart ?? 0;
  const word = prefs.spellcheck
    ? wordsIn(field.value).find((w) => at >= w.start && at <= w.end && field.selectionStart === field.selectionEnd)
    : undefined;
  if (word && (await misspelled(field.value)).some((w) => w.start === word.start)) {
    const list = await suggestions(word.word);
    if (!list.length) items.push({ label: t('No suggestions'), disabled: true });
    for (const s of list) items.push({ label: s, run: () => replaceRange(field, word.start, word.end, s) });
    items.push({ label: t('Add to Dictionary'), run: () => addToDictionary(word.word) }, 'separator');
  }
  return items;
}

function spellOptions(): MenuEntry[] {
  return [
    {
      label: t('Spellcheck'),
      checked: prefs.spellcheck,
      run: () => setPrefs({ spellcheck: !prefs.spellcheck }),
    },
    ...(prefs.spellcheck
      ? (Object.keys(SPELL_LANGUAGES) as SpellLanguage[]).map((l) => ({
          label: SPELL_LANGUAGES[l].name,
          checked: spellLanguage() === l,
          run: () => setPrefs({ spellLanguage: l }),
        }))
      : []),
  ];
}

export function installContextMenu() {
  document.addEventListener('contextmenu', async (e) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    const field = editable(e.target);
    const selected = window.getSelection()?.toString() ?? '';
    const items: MenuEntry[] = [];
    const composer = field instanceof HTMLTextAreaElement && field.dataset.spell ? field : null;
    if (composer) items.push(...(await spellItems(composer)));
    if (field) {
      const input = field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? field : null;
      const hasSel = input ? input.selectionStart !== input.selectionEnd : !!selected;
      const readOnly = !!input && (input.readOnly || input.disabled);
      if (!readOnly)
        items.push({
          label: t('Cut'),
          disabled: !hasSel,
          run: () => (field.focus(), document.execCommand('cut')),
        });
      items.push({ label: t('Copy'), disabled: !hasSel, run: () => (field.focus(), document.execCommand('copy')) });
      if (!readOnly) items.push({ label: t('Paste'), run: () => void paste(field) });
      items.push('separator', {
        label: t('Select All'),
        run: () => (field.focus(), input ? input.select() : document.execCommand('selectAll')),
      });
      if (composer) items.push('separator', ...spellOptions());
    } else if (selected.trim()) {
      items.push({ label: t('Copy'), run: () => void navigator.clipboard.writeText(selected) });
    }
    if (items.length) setUi('menu', { x: e.clientX, y: e.clientY, items });
  });
}
