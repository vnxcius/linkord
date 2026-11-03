// The Christmas theme's toys: the tree at the foot of the right sidebar and the snowman in the full profile. Everything
// reacts to clicks. Reactions are one-shot Web Animations, so nothing runs until you click; the only thing that loops is
// the tree's lights, and those rest with the string lights.
import { For, Show } from 'solid-js';
import { musicTitle, nextSong } from '../lib/christmas-music';
import { confetti } from '../lib/confetti';
import { t } from '../lib/i18n';
import * as I from './Icons';
import { prefs } from '../lib/prefs';

const SNOW = '#f1f6f3';
const GOLD = '#f2cd6b';
const MAX_PARTICLES = 60;
const CLICKS_TO_OPEN = 5;

const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Plays a reaction, replacing the one running on that element so fast clicks feel snappy. */
function move(el: Element, frames: Keyframe[], ms: number, origin = '50% 100%') {
  if (calm()) return;
  const style = (el as SVGElement).style;
  style.transformBox = 'fill-box';
  style.transformOrigin = origin;
  el.getAnimations().forEach((a) => a.cancel());
  el.animate(frames, { duration: ms, easing: 'cubic-bezier(0.3, 0.7, 0.4, 1)' });
}

const wobble = (el: Element, degrees: number, ms = 620) =>
  move(
    el,
    [0, -1, 0.7, -0.4, 0.15, 0].map((k) => ({ transform: `rotate(${k * degrees}deg)` })),
    ms,
  );

const hop = (el: Element, height: number) =>
  move(
    el,
    [
      { transform: 'translateY(0) scale(1, 1)' },
      { transform: 'translateY(0) scale(1.14, 0.82)', offset: 0.14 },
      { transform: `translateY(${-height}px) scale(0.92, 1.1) rotate(-4deg)`, offset: 0.45 },
      { transform: 'translateY(0) scale(1.12, 0.86)', offset: 0.76 },
      { transform: 'translateY(0) scale(1, 1)' },
    ],
    560,
  );

/** Small dots flying from a point: sparkles when they go up and out, snow when they fall. */
function particles(
  layer: SVGGElement,
  count: number,
  from: () => [number, number],
  to: () => [number, number],
  colors: string[],
  ms: number,
) {
  if (calm()) return;
  for (let i = 0; i < count && layer.childElementCount < MAX_PARTICLES; i++) {
    const [x, y] = from();
    const [dx, dy] = to();
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', String(x));
    dot.setAttribute('cy', String(y));
    dot.setAttribute('r', String(1 + Math.random() * 1.6));
    dot.setAttribute('fill', colors[i % colors.length]);
    layer.append(dot);
    dot
      .animate(
        [
          { transform: 'translate(0, 0)', opacity: 1 },
          { transform: `translate(${dx}px, ${dy}px)`, opacity: 0 },
        ],
        { duration: ms * (0.7 + Math.random() * 0.6), easing: 'ease-out' },
      )
      .finished.finally(() => dot.remove());
  }
}

const sparkle = (layer: SVGGElement, x: number, y: number, count: number, colors = [GOLD, '#fff4cf', '#ffffff']) =>
  particles(
    layer,
    count,
    () => [x, y],
    () => {
      const a = Math.random() * Math.PI * 2;
      const r = 14 + Math.random() * 22;
      return [Math.cos(a) * r, Math.sin(a) * r - 6];
    },
    colors,
    650,
  );

const ORNAMENTS: [number, number, number, string][] = [
  [78, 102, 5, '#d8343f'],
  [140, 102, 5, '#e3b341'],
  [66, 146, 5.5, '#e3b341'],
  [110, 152, 5.5, '#d8343f'],
  [154, 146, 5.5, '#4f8fe0'],
  [100, 60, 4, '#4f8fe0'],
  [122, 60, 4, '#d8343f'],
];

export function ChristmasTree() {
  let body!: SVGGElement;
  let fx!: SVGGElement;

  /** A gift hops, and bursts open with confetti once in a while. */
  const gift = () => {
    let clicks = 0;
    return (e: MouseEvent, x: number, y: number, height: number) => {
      const el = e.currentTarget as Element;
      if (++clicks >= CLICKS_TO_OPEN) {
        clicks = 0;
        hop(el, height * 2.2);
        sparkle(fx, x, y, 22);
        confetti(1);
      } else {
        hop(el, height);
        sparkle(fx, x, y, 5);
      }
    };
  };
  const big = gift();
  const medium = gift();
  const small = gift();

  const shake = () => {
    wobble(body, 2.4);
    particles(
      fx,
      18,
      () => [46 + Math.random() * 128, 40 + Math.random() * 110],
      () => [(Math.random() - 0.5) * 12, 28 + Math.random() * 34],
      [SNOW],
      1000,
    );
  };

  return (
    <Show when={prefs.theme === 'christmas'}>
      <Show when={musicTitle()}>
        {(title) => (
          <div class="xmas-now-playing">
            <I.Music size={14} />
            <span class="xmas-now-playing-title" title={title()}>
              {title()}
            </span>
            <button class="icon-btn tiny" aria-label={t('Next song')} data-tip={t('Next song')} onClick={nextSong}>
              <I.NextTrack size={15} />
            </button>
          </div>
        )}
      </Show>
      <div class="xmas-tree" aria-hidden="true">
        <svg viewBox="0 0 220 200" width="220" height="200">
          <ellipse cx="110" cy="187" rx="104" ry="12" fill="#e9f1ec" />
          <rect x="99" y="156" width="22" height="28" rx="2" fill="#5b3b24" />
          <rect x="110" y="156" width="11" height="28" rx="2" fill="#472d1a" />

          <g ref={body} class="xmas-poke" onClick={shake}>
            <path d="M110 84 186 162Q148 150 110 162 72 150 34 162Z" fill="#1f7a4d" />
            <path d="M110 84 186 162Q148 150 110 162Z" fill="#17613c" />
            <path d="M110 46 168 116Q139 105 110 116 81 105 52 116Z" fill="#268a59" />
            <path d="M110 46 168 116Q139 105 110 116Z" fill="#1c6f46" />
            <path d="M110 20 148 72Q129 63 110 72 91 63 72 72Z" fill="#2e9c66" />
            <path d="M110 20 148 72Q129 63 110 72Z" fill="#227c50" />

            <path d="M110 20 122 37Q116 33 110 38 104 33 98 37Z" fill={SNOW} />
            <path d="M72 72 82 58Q85 63 88 65 79 66 72 72Z" fill={SNOW} />
            <path d="M52 116 64 101Q68 106 72 108 61 109 52 116Z" fill={SNOW} />
            <path d="M34 162 48 145Q53 151 58 153 45 154 34 162Z" fill={SNOW} />
            <path d="M148 72 138 58Q135 63 132 65 141 66 148 72Z" fill="#dce8e1" />
            <path d="M168 116 156 101Q152 106 148 108 159 109 168 116Z" fill="#dce8e1" />
            <path d="M186 162 172 145Q167 151 162 153 175 154 186 162Z" fill="#dce8e1" />

            <g fill="none" stroke="#e3b341" stroke-width="1.6" stroke-linecap="round">
              <path d="M88 52Q112 64 133 51" />
              <path d="M70 94Q110 112 151 92" />
              <path d="M54 138Q110 160 167 136" />
            </g>

            <For each={ORNAMENTS}>
              {([cx, cy, r, fill]) => (
                <g
                  class="xmas-poke"
                  onClick={(e) => {
                    e.stopPropagation();
                    move(
                      e.currentTarget,
                      [0, 26, -20, 13, -7, 3, 0].map((k) => ({ transform: `rotate(${k}deg)` })),
                      900,
                      '50% -120%',
                    );
                    sparkle(fx, cx, cy, 4, [fill, '#ffffff']);
                  }}
                >
                  {/* A little more than the ball, so a small target is easy to hit. */}
                  <circle cx={cx} cy={cy} r={r + 3} fill="transparent" />
                  <circle cx={cx} cy={cy} r={r} fill={fill} />
                  <circle cx={cx - r * 0.3} cy={cy - r * 0.3} r={r * 0.28} fill="#fff" opacity=".7" />
                </g>
              )}
            </For>

            <g class="xmas-tree-lights">
              <circle cx="108" cy="44" r="2.4" fill="#ffe08a" />
              <circle cx="96" cy="84" r="2.4" fill="#ffe08a" />
              <circle cx="126" cy="128" r="2.4" fill="#ffe08a" />
              <circle cx="84" cy="128" r="2.4" fill="#ffe08a" />
              <circle cx="136" cy="156" r="2.4" fill="#ffe08a" />
              <circle cx="120" cy="88" r="2.4" fill="#ffe08a" />
            </g>
            <g class="xmas-tree-lights b">
              <circle cx="94" cy="72" r="2.4" fill="#fff4cf" />
              <circle cx="126" cy="76" r="2.4" fill="#fff4cf" />
              <circle cx="108" cy="124" r="2.4" fill="#fff4cf" />
              <circle cx="146" cy="124" r="2.4" fill="#fff4cf" />
              <circle cx="88" cy="156" r="2.4" fill="#fff4cf" />
              <circle cx="60" cy="124" r="2.4" fill="#fff4cf" />
            </g>

            <path
              class="xmas-poke"
              d="M110 3 113.6 12.2 123.3 12.8 115.8 19 118.2 28.5 110 23.2 101.8 28.5 104.2 19 96.7 12.8 106.4 12.2Z"
              fill={GOLD}
              stroke="#e3b341"
              stroke-linejoin="round"
              onClick={(e) => {
                e.stopPropagation();
                move(
                  e.currentTarget,
                  [
                    { transform: 'rotate(0) scale(1)' },
                    { transform: 'rotate(200deg) scale(1.5)', offset: 0.5 },
                    { transform: 'rotate(360deg) scale(1)' },
                  ],
                  800,
                  '50% 50%',
                );
                sparkle(fx, 110, 15, 14);
              }}
            />
          </g>

          <g class="xmas-poke" onClick={(e) => big(e, 53, 170, 20)}>
            <rect x="38" y="164" width="30" height="24" rx="2" fill="#c8313f" />
            <rect x="49.5" y="164" width="7" height="24" fill={GOLD} />
            <rect x="38" y="172" width="30" height="6" fill={GOLD} />
            <path d="M53 164C47 155 41 158 45 163ZM53 164C59 155 65 158 61 163Z" fill={GOLD} />
          </g>
          <g class="xmas-poke" onClick={(e) => medium(e, 164, 172, 18)}>
            <rect x="150" y="168" width="28" height="20" rx="2" fill="#e3b341" />
            <rect x="161" y="168" width="6" height="20" fill="#c8313f" />
            <path d="M164 168C159 160 153 163 157 167ZM164 168C169 160 175 163 171 167Z" fill="#c8313f" />
          </g>
          <g class="xmas-poke" onClick={(e) => small(e, 186, 178, 26)}>
            <rect x="178" y="175" width="17" height="13" rx="1.5" fill="#4f8fe0" />
            <rect x="185" y="175" width="4" height="13" fill={SNOW} />
          </g>

          <g ref={fx} class="xmas-fx" />
        </svg>
      </div>
    </Show>
  );
}

/** Lives in the corner of the full profile. Click him to make him wobble, click his hat or his arm for more. */
export function Snowman() {
  let body!: SVGGElement;
  let fx!: SVGGElement;
  return (
    <Show when={prefs.theme === 'christmas'}>
      <div class="xmas-snowman" aria-hidden="true">
        <svg viewBox="0 0 120 130" width="120" height="130">
          <ellipse cx="60" cy="122" rx="52" ry="7" fill="#e9f1ec" />
          <g
            ref={body}
            class="xmas-poke"
            onClick={() => {
              wobble(body, 7, 760);
              particles(
                fx,
                12,
                () => [34 + Math.random() * 52, 62 + Math.random() * 52],
                () => [(Math.random() - 0.5) * 34, 12 + Math.random() * 18],
                [SNOW],
                700,
              );
            }}
          >
            <g
              class="xmas-poke"
              onClick={(e) => {
                e.stopPropagation();
                move(
                  e.currentTarget,
                  [0, -34, 10, -34, 10, -22, 0].map((k) => ({ transform: `rotate(${k}deg)` })),
                  1000,
                  '100% 80%',
                );
              }}
            >
              <path
                d="M34 68 14 52M22 58 12 60M22 58 18 46"
                fill="none"
                stroke="#5b3b24"
                stroke-width="2.6"
                stroke-linecap="round"
              />
              <path d="M34 68 14 52" fill="none" stroke="transparent" stroke-width="12" stroke-linecap="round" />
            </g>
            <path
              d="M86 68 106 56M98 61 108 64M98 61 103 50"
              fill="none"
              stroke="#5b3b24"
              stroke-width="2.6"
              stroke-linecap="round"
            />

            <circle cx="60" cy="96" r="27" fill="#f1f6f3" />
            <path d="M60 69a27 27 0 0 1 0 54 34 34 0 0 0 0-54Z" fill="#d5e2db" />
            <circle cx="60" cy="60" r="19" fill="#f1f6f3" />
            <path d="M60 41a19 19 0 0 1 0 38 24 24 0 0 0 0-38Z" fill="#d5e2db" />
            <circle cx="60" cy="32" r="15" fill="#f1f6f3" />
            <path d="M60 17a15 15 0 0 1 0 30 19 19 0 0 0 0-30Z" fill="#d5e2db" />

            <circle cx="60" cy="60" r="2.2" fill="#23302a" />
            <circle cx="60" cy="70" r="2.2" fill="#23302a" />
            <circle cx="60" cy="88" r="2.6" fill="#23302a" />
            <circle cx="60" cy="100" r="2.6" fill="#23302a" />

            <path d="M44 45Q60 53 76 45L76 51Q60 59 44 51Z" fill="#c8313f" />
            <path d="M66 50 74 49 76 68 67 69Z" fill="#a81c2b" />

            <circle cx="54.5" cy="29" r="2" fill="#23302a" />
            <circle cx="65.5" cy="29" r="2" fill="#23302a" />
            <path d="M60 32 74 35 60 37Z" fill="#ef8a2c" />
            <g fill="#23302a">
              <circle cx="52.5" cy="38" r="1.1" />
              <circle cx="56" cy="40.5" r="1.1" />
              <circle cx="60" cy="41.4" r="1.1" />
              <circle cx="64" cy="40.5" r="1.1" />
              <circle cx="67.5" cy="38" r="1.1" />
            </g>

            <g
              class="xmas-poke"
              onClick={(e) => {
                e.stopPropagation();
                move(
                  e.currentTarget,
                  [
                    { transform: 'translateY(0) rotate(0)' },
                    { transform: 'translateY(-26px) rotate(-200deg)', offset: 0.5 },
                    { transform: 'translateY(0) rotate(-360deg)' },
                  ],
                  760,
                  '50% 50%',
                );
                sparkle(fx, 60, 8, 8);
              }}
            >
              <rect x="44" y="18" width="32" height="4.5" rx="2" fill="#23302a" />
              <rect x="49" y="1" width="22" height="19" rx="2" fill="#23302a" />
              <rect x="49" y="13" width="22" height="4.5" fill="#c8313f" />
            </g>
          </g>
          <g ref={fx} class="xmas-fx" />
        </svg>
      </div>
    </Show>
  );
}
