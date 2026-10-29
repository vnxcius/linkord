// Voice-chat removal from Windows 10 system-audio streams (app/src/lib/echo-canceller.ts).
//   node --test echo.test.mjs   (Node 23.6+ runs the TypeScript module directly)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EchoCanceller, HOLD_CHUNKS } from '../app/src/lib/echo-canceller.ts';

const RATE = 48000;
const FRAME = 960;

function rng(seed) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}

/** Speech-like: low-passed noise in 200-500 ms bursts with pauses. */
function voice(seconds, seed) {
  const r = rng(seed);
  const out = new Float32Array(RATE * seconds);
  let lp = 0;
  let on = true;
  let left = 0;
  for (let i = 0; i < out.length; i++) {
    if (left-- <= 0) {
      on = !on;
      left = Math.floor((0.2 + Math.abs(r()) * 0.3) * RATE);
    }
    lp += 0.25 * (r() - lp);
    out[i] = on ? lp * 0.8 : 0;
  }
  return out;
}

function power(a, from, to) {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return s / (to - from);
}

/**
 * `lead`: how many samples of reference the worker has beyond the echo in the loopback chunk it is handed
 * (the old harness gave delay + 2 chunks; a Windows 10 PC measured about 0, sometimes less). `jitter`: random
 * +-chunks on that. `delay2`: the output latency changes to this at `switchAt` seconds.
 */
function run({ delay, gain, seconds = 8, music = 0.2, smear = false, lead = delay + FRAME * 2, jitter = 0, delay2 = delay, switchAt = 6 }) {
  const ref = voice(seconds + 2, 7);
  const n = RATE * seconds;
  const start = RATE; // capture starts 1 s after playback did
  const r = rng(99);
  const other = new Float32Array(n);
  const echo = new Float32Array(n);
  const loop = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    other[i] = music * (Math.sin((2 * Math.PI * 220 * i) / RATE) + 0.5 * Math.sin((2 * Math.PI * 330 * i) / RATE)) + 0.002 * r();
    const at = i + start - (i < switchAt * RATE ? delay : delay2);
    // smear: a fractional delay / resampling-like low-pass, as when Windows converts 48 kHz to a 44.1 kHz device.
    echo[i] = gain * (smear ? 0.25 * ref[at - 1] + 0.5 * ref[at] + 0.25 * ref[at + 1] : ref[at]);
    loop[i * 2] = loop[i * 2 + 1] = other[i] + echo[i];
  }
  const ec = new EchoCanceller(2);
  const out = new Float32Array(n);
  const jr = rng(5);
  const hold = HOLD_CHUNKS * FRAME;
  let refPushed = 0;
  for (let i = 0; i < n; i += FRAME) {
    const needRef = i + FRAME + start - delay + lead + Math.round(jr() * jitter) * FRAME;
    while (refPushed < needRef) {
      const c = new Float32Array(FRAME * 2);
      for (let k = 0; k < FRAME; k++) c[k * 2] = c[k * 2 + 1] = ref[refPushed + k];
      ec.pushReference(c);
      refPushed += FRAME;
    }
    // The output is the chunk from HOLD_CHUNKS calls ago.
    const res = ec.process(loop.subarray(i * 2, (i + FRAME) * 2));
    if (i >= hold) for (let k = 0; k < FRAME; k++) out[i - hold + k] = res[k * 2];
  }
  const residual = out.map((v, i) => v - other[i]);
  const end = n - hold;
  const tail = end - RATE * 3; // judge the last 3 s, after convergence
  return {
    ec,
    erleDb: 10 * Math.log10(power(echo, tail, end) / power(residual, tail, end)),
    musicKeptDb: 10 * Math.log10(power(other, tail, end) / power(residual, tail, end)),
  };
}

test('finds the delay and removes the voice chat', () => {
  const { ec, erleDb, musicKeptDb } = run({ delay: 5000, gain: 0.6 });
  // Measured from the arrival anchor, so it includes the simulated two-chunk pipeline lag and the hold.
  assert.ok(Math.abs(ec.delay - (5000 + FRAME * 2 + HOLD_CHUNKS * FRAME)) <= 2, `delay ${ec.delay}`);
  // Diagnostics readout: locked on a steady delay, never realigned.
  assert.ok(ec.locked && ec.alignTries > 0 && ec.realigns === 0, `locked ${ec.locked}, tries ${ec.alignTries}, realigns ${ec.realigns}`);
  assert.ok(erleDb > 25, `voice chat only reduced by ${erleDb.toFixed(1)} dB`);
  assert.ok(musicKeptDb > 20, `residual too close to the music: ${musicKeptDb.toFixed(1)} dB`);
});

test('handles short and long output latencies and different volumes', () => {
  for (const [delay, gain] of [[600, 1], [14000, 0.3]]) {
    const { erleDb } = run({ delay, gain });
    assert.ok(erleDb > 25, `delay ${delay}, gain ${gain}: only ${erleDb.toFixed(1)} dB`);
  }
});

test('copes with resampling-like smearing in the output path', () => {
  const { erleDb } = run({ delay: 3000, gain: 0.5, smear: true });
  assert.ok(erleDb > 20, `only ${erleDb.toFixed(1)} dB`);
});

test('a weak match on a re-check never replaces a working lock (Windows 10: realigned 38x, 0 dB)', () => {
  for (const seconds of [12, 30]) {
    const { ec, erleDb } = run({ delay: 1500, gain: 0.6, seconds });
    assert.ok(erleDb > 25, `${seconds} s: only ${erleDb.toFixed(1)} dB`);
    assert.equal(ec.realigns, 0);
  }
});

test('works when our playback reference arrives as late as the loopback, or later', () => {
  for (const [lead, jitter] of [[0, 0], [0, 1], [-FRAME, 0], [-FRAME, 1]]) {
    const { erleDb } = run({ delay: 1500, gain: 0.6, seconds: 12, lead, jitter });
    assert.ok(erleDb > 25, `lead ${lead}, jitter ${jitter}: only ${erleDb.toFixed(1)} dB`);
  }
});

test('follows a real change in output latency', () => {
  const { ec, erleDb } = run({ delay: 1500, gain: 0.6, seconds: 12, delay2: 4320 });
  assert.ok(erleDb > 25, `only ${erleDb.toFixed(1)} dB`);
  assert.ok(ec.realigns >= 1);
});

test('reports suppression numbers', () => {
  for (const cfg of [{ delay: 5000, gain: 0.6 }, { delay: 600, gain: 1 }, { delay: 14000, gain: 0.3 }, { delay: 3000, gain: 0.5, smear: true }]) {
    const { erleDb, musicKeptDb } = run(cfg);
    console.log(`  ${JSON.stringify(cfg)} -> voice chat -${erleDb.toFixed(1)} dB, music-to-residue ${musicKeptDb.toFixed(1)} dB`);
  }
});

test('leaves audio untouched when the voice chat is silent', () => {
  const ec = new EchoCanceller(2);
  const chunk = new Float32Array(FRAME * 2).map((_, i) => Math.sin(i / 10) * 0.3);
  for (let k = 0; k < 100; k++) ec.pushReference(new Float32Array(FRAME * 2));
  let out = ec.process(chunk);
  for (let k = 0; k < HOLD_CHUNKS; k++) out = ec.process(new Float32Array(FRAME * 2));
  assert.deepEqual(Array.from(out), Array.from(chunk));
  assert.equal(ec.locked, false);
});

/** Voiced speech: pitch pulses (100-220 Hz, drifting) through three formant resonators, in 0.3-1.2 s phrases. */
function voiced(seconds, seed) {
  const r = rng(seed);
  const out = new Float32Array(RATE * seconds);
  const formants = [700, 1200, 2600].map((f) => ({ c: 2 * 0.97 * Math.cos((2 * Math.PI * f) / RATE), y1: 0, y2: 0 }));
  let phase = 0;
  let f0 = 120;
  let on = false;
  let left = 0;
  let peak = 0;
  for (let i = 0; i < out.length; i++) {
    if (left-- <= 0) {
      on = !on;
      left = Math.floor((on ? 0.3 + Math.abs(r()) * 0.9 : 0.15 + Math.abs(r()) * 0.4) * RATE);
      f0 = 100 + Math.abs(r()) * 120;
    }
    f0 += 0.0005 * r() * f0;
    phase += f0 / RATE;
    let x = 0;
    if (phase >= 1) {
      phase -= 1;
      x = 1;
    }
    x += 0.05 * r();
    let y = 0;
    for (const s of formants) {
      const v = x + s.c * s.y1 - 0.97 * 0.97 * s.y2;
      s.y2 = s.y1;
      s.y1 = v;
      y += v;
    }
    out[i] = on && i > RATE ? y : 0; // a second of silence first
    peak = Math.max(peak, Math.abs(out[i]));
  }
  return out.map((v) => (v * 0.5) / peak);
}

/** Broadband game-like sound: rumble, mid-band noise, hiss and a tone. */
function gameAudio(n, level, seed) {
  const r = rng(seed);
  const out = new Float32Array(n);
  let b0 = 0;
  let b1 = 0;
  for (let i = 0; i < n; i++) {
    const w = r();
    b0 = 0.997 * b0 + 0.03 * w;
    b1 = 0.96 * b1 + 0.3 * w;
    out[i] = level * (b0 + 0.5 * b1 + 0.2 * w + 0.3 * Math.sin((2 * Math.PI * 440 * i) / RATE));
  }
  return out;
}

/**
 * Streams voiced speech + game audio; returns when the canceller locked (s), every delay it locked onto and how
 * much of the voice chat it removed over the last 4 s.
 */
function runGame({ seed, gain, game, seconds = 12, delay = 2000 }) {
  const ref = voiced(seconds + 2, seed);
  const n = RATE * seconds;
  const start = RATE;
  const other = gameAudio(n, game, seed + 1);
  const echo = new Float32Array(n);
  const loop = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const at = i + start - delay;
    echo[i] = gain * (0.25 * ref[at - 1] + 0.5 * ref[at] + 0.25 * ref[at + 1]);
    loop[i * 2] = loop[i * 2 + 1] = other[i] + echo[i];
  }
  const out = new Float32Array(n);
  const hold = HOLD_CHUNKS * FRAME;
  const ec = new EchoCanceller(2);
  const jr = rng(seed + 2);
  let refPushed = 0;
  let lockedAt = null;
  const delays = new Set();
  for (let i = 0; i < n; i += FRAME) {
    const needRef = i + FRAME + start + Math.round(jr()) * FRAME;
    while (refPushed < needRef) {
      const c = new Float32Array(FRAME * 2);
      for (let k = 0; k < FRAME; k++) c[k * 2] = c[k * 2 + 1] = ref[refPushed + k];
      ec.pushReference(c);
      refPushed += FRAME;
    }
    const res = ec.process(loop.subarray(i * 2, (i + FRAME) * 2));
    if (i >= hold) for (let k = 0; k < FRAME; k++) out[i - hold + k] = res[k * 2];
    if (ec.locked) {
      lockedAt ??= (i + FRAME) / RATE;
      delays.add(ec.delay);
    }
  }
  const end = n - hold;
  const residual = out.map((v, i) => v - other[i]);
  const removedDb = 10 * Math.log10(power(echo, end - RATE * 4, end) / power(residual, end - RATE * 4, end));
  // The voice chat starts 1 s into the reference, which the loopback hears `delay` later, 1 s before capture starts.
  return { lockedAt, delays: [...delays], speechAt: delay / RATE, removedDb };
}

test('with game audio in the capture, locks onto the right delay within about a second of the voice chat', () => {
  // Windows 10: listeners heard themselves for 5-15 s at the start of a stream. Chance peaks from the game
  // locked onto a wrong delay, and a re-check needed 3 s (or never replaced it when the voice chat was quiet).
  for (let seed = 1; seed <= 6; seed++) {
    const { lockedAt, delays, speechAt, removedDb } = runGame({ seed, gain: 0.3, game: 0.1 });
    assert.ok(lockedAt !== null && lockedAt - speechAt < 1.5, `seed ${seed}: locked at ${lockedAt} s`);
    assert.equal(delays.length, 1, `seed ${seed}: locked onto ${delays.join(', ')}`);
    assert.ok(removedDb > 20, `seed ${seed}: voice chat only reduced by ${removedDb.toFixed(1)} dB`);
  }
});

test('finds a quiet voice chat under a loud game', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const { lockedAt, delays, speechAt, removedDb } = runGame({ seed, gain: 0.1, game: 0.2 });
    assert.ok(lockedAt !== null && lockedAt - speechAt < 3, `seed ${seed}: locked at ${lockedAt} s`);
    assert.equal(delays.length, 1, `seed ${seed}: locked onto ${delays.join(', ')}`);
    // The game is much louder than the voice chat here, which limits how exactly the filter can be fitted
    // (8-17 dB removed; what's left sits ~25 dB under the game). The old code locked wrong and removed 0 dB.
    assert.ok(removedDb > 6, `seed ${seed}: voice chat only reduced by ${removedDb.toFixed(1)} dB`);
  }
});
