// A slider: a native range input (keyboard, screen readers and touch for free) drawn as a gold fill up to the
// value on a quiet track, with a round handle. `mark` adds a tick, e.g. at 100% on a 0-200% volume.
import { cn } from '../../lib/cn';

export function Slider(p: {
  value: number;
  onInput: (value: number) => void;
  /** After the drag ends (the input's change event). */
  onChange?: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** What it sets, for screen readers (when no visible label wraps it). */
  label?: string;
  disabled?: boolean;
  mark?: number;
  class?: string;
}) {
  const min = () => p.min ?? 0;
  const max = () => p.max ?? 100;
  /** 0-1 along the track (the CSS keeps the fill and the tick under the handle's centre). */
  const at = (v: number) => Math.max(0, Math.min(1, (v - min()) / (max() - min() || 1)));
  return (
    <input
      type="range"
      class={cn('slider', p.mark !== undefined && 'marked', p.class)}
      min={min()}
      max={max()}
      step={p.step ?? 1}
      value={p.value}
      disabled={p.disabled}
      aria-label={p.label}
      style={{ '--p': at(p.value), '--mark': p.mark !== undefined ? at(p.mark) : undefined }}
      onInput={(e) => p.onInput(+e.currentTarget.value)}
      onChange={(e) => p.onChange?.(+e.currentTarget.value)}
    />
  );
}
