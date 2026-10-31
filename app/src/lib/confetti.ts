// Confetti for the 1.0 dialog: two cannons, one on each side of the window, firing up and inward. A full-window
// canvas above everything (it ignores the mouse) that removes itself when the last piece has fallen.

const COLORS = ['#e3b341', '#f2cd6b', '#e3b341', '#fff4d6', '#ececee', '#3ba55d', '#5b8def', '#e0574f', '#b07ad8'];

interface Piece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  shape: 'rect' | 'strip' | 'triangle';
  /** Spin around the vertical axis (the flutter) and in the plane. */
  flip: number;
  flipSpeed: number;
  angle: number;
  spin: number;
  /** Side-to-side sway as it falls. */
  sway: number;
  swaySpeed: number;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** Fires `bursts` volleys from both sides. Skipped when the system asks for reduced motion. */
export function confetti(bursts = 3) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.appendChild(canvas);
  const g = canvas.getContext('2d')!;
  let w = 0;
  let h = 0;
  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  window.addEventListener('resize', resize);

  const pieces: Piece[] = [];
  const fire = (side: 'left' | 'right', count: number) => {
    const dir = side === 'left' ? 1 : -1;
    for (let i = 0; i < count; i++) {
      // Aimed up and toward the middle, 25-70 degrees above the horizon.
      const angle = rand(25, 70) * (Math.PI / 180);
      const speed = rand(9, 20) * Math.max(0.75, Math.min(1.3, h / 800));
      const r = Math.random();
      pieces.push({
        x: side === 'left' ? rand(-10, 10) : w + rand(-10, 10),
        y: h * rand(0.62, 0.82),
        vx: Math.cos(angle) * speed * dir,
        vy: -Math.sin(angle) * speed,
        size: rand(6, 11),
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        shape: r < 0.55 ? 'rect' : r < 0.85 ? 'strip' : 'triangle',
        flip: rand(0, Math.PI * 2),
        flipSpeed: rand(0.08, 0.22),
        angle: rand(0, Math.PI * 2),
        spin: rand(-0.12, 0.12),
        sway: rand(0, Math.PI * 2),
        swaySpeed: rand(0.03, 0.08),
      });
    }
  };
  const timers: number[] = [];
  for (let b = 0; b < bursts; b++) {
    timers.push(
      window.setTimeout(() => {
        const n = b === 0 ? 90 : 55;
        fire('left', n);
        fire('right', n);
      }, b * 380),
    );
  }

  let last = performance.now();
  let frame = 0;
  const tick = (now: number) => {
    // Steps of a 60 fps frame, so it falls at the same speed on any refresh rate.
    const k = Math.min(3, (now - last) / 16.67);
    last = now;
    g.clearRect(0, 0, w, h);
    for (let i = pieces.length - 1; i >= 0; i--) {
      const p = pieces[i];
      p.vx *= Math.pow(0.985, k);
      p.vy = p.vy * Math.pow(0.985, k) + 0.32 * k;
      p.sway += p.swaySpeed * k;
      p.x += (p.vx + Math.sin(p.sway) * 0.9) * k;
      p.y += p.vy * k;
      p.flip += p.flipSpeed * k;
      p.angle += p.spin * k;
      if (p.y > h + 40) {
        pieces.splice(i, 1);
        continue;
      }
      g.save();
      g.translate(p.x, p.y);
      g.rotate(p.angle);
      // The flutter: the piece turns edge-on and back, darker while its back faces us.
      const face = Math.cos(p.flip);
      g.scale(1, face);
      g.fillStyle = p.color;
      g.globalAlpha = face < 0 ? 0.78 : 1;
      if (p.shape === 'rect') g.fillRect(-p.size / 2, -p.size / 3, p.size, (p.size * 2) / 3);
      else if (p.shape === 'strip') g.fillRect(-p.size / 5, -p.size * 0.75, (p.size * 2) / 5, p.size * 1.5);
      else {
        // A small gold-ish triangle, a nod to the emblem.
        g.beginPath();
        g.moveTo(0, -p.size * 0.6);
        g.lineTo(p.size * 0.55, p.size * 0.4);
        g.lineTo(-p.size * 0.55, p.size * 0.4);
        g.closePath();
        g.fill();
      }
      g.restore();
    }
    if (pieces.length || now - started < bursts * 380 + 100) frame = requestAnimationFrame(tick);
    else stop();
  };
  const started = performance.now();
  frame = requestAnimationFrame(tick);
  const stop = () => {
    cancelAnimationFrame(frame);
    timers.forEach(clearTimeout);
    window.removeEventListener('resize', resize);
    canvas.remove();
  };
  return stop;
}
