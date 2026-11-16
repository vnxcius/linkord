// Presence marks (owner, 2026-11-16): triangles from the app icon, corners rounded, in a 100-unit box (the mark's
// size; they reach a little past it sideways so they weigh as much as a square would). Each status keeps its colour
// and has its own shape, so it reads without colour too:
//   online = a solid triangle; idle = the Triforce (the middle missing); dnd = upside down, like a yield sign;
//   offline / invisible = an empty outline.
// Android draws the same shapes (android/.../components/Components.kt PresenceMark): keep the numbers in step.

/** Corner radius as a share of the mark (the "63%" the owner picked on the comparison page). */
export const ROUND = 0.2;
const S = 100;
const W = S * (1.14 + ROUND * 0.5);
const H = W * 0.866;
const CX = S / 2;
const TOP = S / 2 - H / 2 + S * 0.04;
const BOT = S / 2 + H / 2 + S * 0.04;
const LEFT = CX - W / 2;
const RIGHT = CX + W / 2;
/** Width of the offline outline. */
export const OUTLINE = S * 0.2;

type Pt = [number, number];
const f = (n: number) => Math.round(n * 100) / 100;

/** A triangle (points clockwise) with each corner an arc of radius `r`. */
function roundTri(pts: Pt[], r: number): string {
  if (r <= 0.01) return `M${pts.map((p) => p.map(f).join(',')).join('L')}Z`;
  const t = r * Math.sqrt(3); // where the arc meets each side of a 60° corner
  const along = (a: Pt, b: Pt, d: number): Pt => {
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return [a[0] + ((b[0] - a[0]) / l) * d, a[1] + ((b[1] - a[1]) / l) * d];
  };
  let d = '';
  pts.forEach((p, i) => {
    const a = along(p, pts[(i + 2) % 3], t);
    const b = along(p, pts[(i + 1) % 3], t);
    d += `${i ? 'L' : 'M'}${f(a[0])},${f(a[1])}A${f(r)},${f(r)} 0 0 1 ${f(b[0])},${f(b[1])}`;
  });
  return d + 'Z';
}

const R = S * ROUND;
const UP: Pt[] = [
  [CX, TOP],
  [RIGHT, BOT],
  [LEFT, BOT],
];
const DOWN: Pt[] = [
  [LEFT, TOP],
  [RIGHT, TOP],
  [CX, TOP + H],
];
const HOLE: Pt[] = [
  [(LEFT + CX) / 2, (TOP + BOT) / 2],
  [(RIGHT + CX) / 2, (TOP + BOT) / 2],
  [CX, BOT],
];
// The offline outline runs inside the triangle: the shape shrunk toward its centroid by the line's width.
const G = (TOP + 2 * BOT) / 3;
const K = 1 - (OUTLINE * 1.9) / H;
const INNER = UP.map(([x, y]) => [CX + (x - CX) * K, G + (y - G) * K] as Pt);

export const MARKS = {
  up: roundTri(UP, R),
  down: roundTri(DOWN, R),
  /** Online's triangle with the Triforce's middle cut out (fill-rule evenodd). */
  triforce: `${roundTri(UP, R)}${roundTri(HOLE, R * 0.45)}`,
  inner: roundTri(INNER, Math.max(0, R * K - OUTLINE / 2)),
};

export type Presence = 'online' | 'idle' | 'dnd' | 'offline';

/** The outer shape of a status's mark (what the ring is drawn around). */
export const outline = (s: Presence) => (s === 'dnd' ? MARKS.down : MARKS.up);
