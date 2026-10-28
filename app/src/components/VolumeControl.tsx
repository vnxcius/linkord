import * as I from './Icons';

/**
 * Mute button with a slider that slides out on hover. Shared by the chat video player, streams and the
 * mini player. `max` above 1 allows boosting (streams go to 200%).
 */
export function VolumeControl(p: { value: number; max?: number; muted?: boolean; tip: string; onChange: (v: number) => void; onToggleMute: () => void }) {
  let bar!: HTMLDivElement;
  const max = () => p.max ?? 1;
  const shown = () => (p.muted ? 0 : p.value);
  const drag = (e: PointerEvent) => {
    if (e.type === 'pointerdown') bar.setPointerCapture(e.pointerId);
    if (!(e.buttons & 1)) return;
    const r = bar.getBoundingClientRect();
    p.onChange(Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * max() * 100) / 100);
  };
  const icon = () => (shown() === 0 ? <I.VolumeMute size={18} /> : shown() < max() / 2 ? <I.VolumeLow size={18} /> : <I.VolumeHigh size={18} />);
  return (
    <div class="vp-volume" onClick={(e) => e.stopPropagation()}>
      <button class="vp-btn" data-tip={p.tip} onClick={() => p.onToggleMute()}>
        {icon()}
      </button>
      <div class="vp-volume-bar" ref={bar} title={`${Math.round(shown() * 100)}%`} onPointerDown={drag} onPointerMove={drag}>
        <div class="vp-track">
          <div class="vp-progress" style={{ width: `${(shown() / max()) * 100}%` }} />
        </div>
      </div>
    </div>
  );
}
