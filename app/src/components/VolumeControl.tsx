import * as I from './Icons';

/**
 * Mute button with a slider that slides out on hover. Shared by the chat video player, streams and the
 * mini player. `max` above 1 allows boosting (streams go to 200%).
 */
export function VolumeControl(p: {
  value: number;
  max?: number;
  muted?: boolean;
  tip: string;
  onChange: (v: number) => void;
  onToggleMute: () => void;
}) {
  let bar!: HTMLDivElement;
  const max = () => p.max ?? 1;
  const shown = () => (p.muted ? 0 : p.value);
  const drag = (e: PointerEvent) => {
    if (e.type === 'pointerdown') bar.setPointerCapture(e.pointerId);
    if (!(e.buttons & 1)) return;
    const r = bar.getBoundingClientRect();
    p.onChange(Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * max() * 100) / 100);
  };
  const icon = () =>
    shown() === 0 ? (
      <I.VolumeMute size={18} />
    ) : shown() < max() / 2 ? (
      <I.VolumeLow size={18} />
    ) : (
      <I.VolumeHigh size={18} />
    );
  return (
    <div class="vp-volume" onClick={(e) => e.stopPropagation()}>
      <button class="vp-btn" data-tip={p.tip} onClick={() => p.onToggleMute()}>
        {icon()}
      </button>
      <div
        class="vp-volume-bar"
        ref={bar}
        title={`${Math.round(shown() * 100)}%`}
        onPointerDown={drag}
        onPointerMove={drag}
      >
        <div class="vp-track">
          <div class="vp-progress" style={{ width: `${(shown() / max()) * 100}%` }} />
        </div>
      </div>
    </div>
  );
}

/**
 * Someone's volume in the right-click menu: any whole percentage from 0 to 200%, dragged (1% steps; arrow keys 1%,
 * Page Up/Down 10%) or typed into the number, with 100% marked and one click away.
 */
export function UserVolumeSlider(p: { label: string; value: number; onChange: (v: number) => void }) {
  const pct = () => Math.round(p.value * 100);
  const set = (n: number) => p.onChange(Math.min(200, Math.max(0, Math.round(n))) / 100);
  let field!: HTMLInputElement;
  return (
    <div class="uv">
      <div class="uv-head">
        <span class="uv-label">{p.label}</span>
        <label class="uv-value">
          <input
            ref={field}
            inputmode="numeric"
            maxlength="3"
            aria-label={p.label}
            value={pct()}
            onFocus={(e) => e.currentTarget.select()}
            onInput={(e) => {
              const digits = e.currentTarget.value.replace(/\D/g, '');
              if (digits !== e.currentTarget.value) e.currentTarget.value = digits;
              if (digits) set(+digits);
            }}
            onBlur={(e) => (e.currentTarget.value = String(pct()))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') field.blur();
              else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault();
                set(pct() + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1));
                field.value = String(pct());
              }
            }}
          />
          <span>%</span>
        </label>
      </div>
      <input
        class="uv-range"
        type="range"
        min="0"
        max="200"
        step="1"
        aria-label={p.label}
        value={pct()}
        style={{ '--fill': `${pct() / 2}%` }}
        onInput={(e) => set(+e.currentTarget.value)}
      />
      <div class="uv-scale">
        <span>0%</span>
        <button classList={{ on: pct() === 100 }} onClick={() => set(100)}>
          100%
        </button>
        <span>200%</span>
      </div>
    </div>
  );
}
