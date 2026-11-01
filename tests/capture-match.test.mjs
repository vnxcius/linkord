// Pairing a capture card's video device with its audio input (app/src/lib/capture-match.ts).
//   node --test capture-match.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchCaptureAudio } from '../app/src/lib/capture-match.ts';

const device = (deviceId, groupId, label) => ({ deviceId, groupId, label });
// As a real UGREEN 25854 reports them in Chromium on Windows.
const card = device('v1', 'g-card', 'UGREEN 25854 (2b89:5854)');
const inputs = [
  device('a1', 'g-card', 'Digital Audio Interface (UGREEN 25854) (2b89:5854)'),
  device('a2', 'g-nvidia', 'Microfone (NVIDIA Broadcast)'),
  device('a3', 'g-mic', 'Microphone (fifine Microphone) (3142:a010)'),
];

test('finds the card by group id', () => {
  assert.equal(matchCaptureAudio(card, inputs)?.deviceId, 'a1');
});

test('falls back to the USB id when group ids differ', () => {
  const other = device('v2', 'g-other', 'UGREEN 25854 (2B89:5854)');
  assert.equal(matchCaptureAudio(other, inputs)?.deviceId, 'a1');
});

test('a device with no sound of its own gets none, never somebody\'s mic', () => {
  assert.equal(matchCaptureAudio(device('v3', 'g-obs', 'OBS Virtual Camera'), inputs), null);
  assert.equal(matchCaptureAudio(device('v4', '', 'Webcam (1111:2222)'), inputs), null);
});

test('an empty group id matches nothing', () => {
  const blank = [device('a4', '', 'Microphone')];
  assert.equal(matchCaptureAudio(device('v5', '', 'Camera'), blank), null);
});
