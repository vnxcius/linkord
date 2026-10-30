// Small building blocks for the profile page: a circled "i" that reveals an explanation on hover/focus (so
// the page needs no help paragraphs), and a row with Upload / Remove buttons for one profile image.
import { Show, type JSX } from 'solid-js';
import { t } from '../lib/i18n';
import * as I from './Icons';

export function InfoTip(p: { text: string; align?: 'start' | 'end' }) {
  return (
    <span class="info-tip" classList={{ end: p.align === 'end' }}>
      <button type="button" class="info-tip-btn" aria-label={p.text}>
        <I.Info size={15} />
      </button>
      <span class="info-tip-pop" role="tooltip">
        {p.text}
      </span>
    </span>
  );
}

export function ImageSlot(p: {
  label: string;
  info?: string;
  has: boolean;
  accept: string;
  onPick: (input: HTMLInputElement) => void;
  onRemove: () => void;
  children?: JSX.Element;
}) {
  return (
    <div class="image-slot">
      <div class="image-slot-row">
        <span class="image-slot-label">
          {p.label}
          <Show when={p.info}>{(text) => <InfoTip text={text()} />}</Show>
        </span>
        <label class="slot-btn upload">
          <I.AddImage size={16} />
          {p.has ? t('Change') : t('Upload')}
          <input type="file" accept={p.accept} hidden onChange={(e) => p.onPick(e.currentTarget)} />
        </label>
        <button
          type="button"
          class="slot-btn remove"
          disabled={!p.has}
          title={t('Remove')}
          aria-label={t('Remove')}
          onClick={p.onRemove}
        >
          <I.Trash size={16} />
        </button>
      </div>
      {p.children}
    </div>
  );
}
