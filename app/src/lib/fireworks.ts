// Fireworks and a greeting when a holiday arrives: a full-window canvas above everything (it ignores the mouse) that removes
// itself when the show ends. With reduced motion, just the greeting.
const SHOW_MS = 14_000;
const COLORS = ['#f2cd6b', '#e3b341', '#ff5a5f', '#4cd07f', '#6aa9ff', '#ffffff', '#ff9ad5'];
const GRAVITY = 90;
const SPARKS = 70;

interface Rocket {
  x: number;
  y: number;
  vy: number;
  stopAt: number;
  color: string;
}
interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

function greeting(text: string, sub: string | undefined, ms: number) {
  const el = document.createElement('div');
  el.className = 'holiday-greeting';
  el.setAttribute('role', 'status');
  const title = document.createElement('strong');
  title.textContent = text;
  el.append(title);
  if (sub) {
    const year = document.createElement('span');
    year.textContent = sub;
    el.append(year);
  }
  document.body.append(el);
  el.animate(
    [
      { opacity: 0, transform: 'translate(-50%, -46%)' },
      { opacity: 1, transform: 'translate(-50%, -50%)', offset: 0.08 },
      { opacity: 1, transform: 'translate(-50%, -50%)', offset: 0.85 },
      { opacity: 0, transform: 'translate(-50%, -54%)' },
    ],
    { duration: ms },
  ).finished.finally(() => el.remove());
}

let running = false;

export function fireworks(text: string, sub?: string) {
  if (running) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return greeting(text, sub, 5000);
  running = true;
  greeting(text, sub, SHOW_MS - 2000);

  const canvas = document.createElement('canvas');
  canvas.className = 'fireworks';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.append(canvas);
  const g = canvas.getContext('2d')!;
  const size = () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  };
  size();
  window.addEventListener('resize', size);

  const rockets: Rocket[] = [];
  const sparks: Spark[] = [];
  const start = performance.now();
  let last = start;
  let nextLaunch = start;

  const frame = (t: number) => {
    const dt = Math.min(t - last, 50) / 1000;
    last = t;
    const w = canvas.width;
    const h = canvas.height;
    if (t < start + SHOW_MS - 2500 && t >= nextLaunch) {
      nextLaunch = t + rand(220, 620);
      rockets.push({
        x: rand(w * 0.1, w * 0.9),
        y: h,
        vy: -rand(h * 0.7, h * 0.95),
        stopAt: rand(h * 0.12, h * 0.5),
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
      });
    }
    // Fading what's there instead of clearing it is what draws the trails.
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = 'rgba(0, 0, 0, 0.22)';
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'lighter';

    for (let i = rockets.length - 1; i >= 0; i--) {
      const r = rockets[i];
      r.y += r.vy * dt;
      g.fillStyle = r.color;
      g.fillRect(r.x - 1, r.y, 2, 6);
      if (r.y <= r.stopAt) {
        rockets.splice(i, 1);
        for (let s = 0; s < SPARKS; s++) {
          const a = Math.random() * Math.PI * 2;
          const speed = rand(40, 240);
          sparks.push({
            x: r.x,
            y: r.y,
            vx: Math.cos(a) * speed,
            vy: Math.sin(a) * speed,
            life: rand(0.8, 1.6),
            color: r.color,
          });
        }
      }
    }
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.life -= dt;
      if (s.life <= 0) {
        sparks.splice(i, 1);
        continue;
      }
      s.vy += GRAVITY * dt;
      s.vx *= 0.985;
      s.vy *= 0.985;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      g.globalAlpha = Math.min(1, s.life * 1.4);
      g.fillStyle = s.color;
      g.fillRect(s.x, s.y, 2, 2);
    }
    g.globalAlpha = 1;

    if (t < start + SHOW_MS) requestAnimationFrame(frame);
    else {
      window.removeEventListener('resize', size);
      canvas.remove();
      running = false;
    }
  };
  requestAnimationFrame(frame);
}
