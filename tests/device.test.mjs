// What Settings -> Sessions calls a device (app/src/lib/device.ts).
//   node --test device.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeDevice } from '../app/src/lib/device.ts';

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const EDGE = `${CHROME} Edg/131.0.0.0`;

test('browsers that also claim to be other browsers', () => {
  assert.equal(describeDevice('web', CHROME).browser, 'Chrome');
  assert.equal(describeDevice('web', EDGE).browser, 'Edge');
  assert.equal(describeDevice('web', CHROME.replace('Chrome/', 'HeadlessChrome/')).browser, 'Chrome');
  assert.equal(describeDevice('web', `${CHROME} OPR/115.0.0.0`).browser, 'Opera');
  assert.equal(describeDevice('web', 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0').browser, 'Firefox');
  assert.equal(
    describeDevice('web', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15').browser,
    'Safari',
  );
});

test('systems that also claim to be other systems', () => {
  const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1';
  assert.deepEqual(describeDevice('web', android), { app: false, browser: 'Chrome', os: 'Android', mobile: true });
  assert.deepEqual(describeDevice('web', iphone), { app: false, browser: 'Chrome', os: 'iPhone', mobile: true });
  assert.equal(describeDevice('web', CHROME).mobile, false);
});

test('the desktop app is the app, not the Edge it runs on', () => {
  assert.deepEqual(describeDevice('desktop', EDGE), { app: true, browser: null, os: 'Windows', mobile: false });
});

test('the Android app is an app on a phone', () => {
  const ua = 'Linkord/0.1.0 (Android 16; Pixel 8)';
  assert.deepEqual(describeDevice('android', ua), { app: true, browser: null, os: 'Android', mobile: true });
});

test('a login that never connected says nothing', () => {
  assert.deepEqual(describeDevice(null, null), { app: false, browser: null, os: null, mobile: false });
});
