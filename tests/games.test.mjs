// Game detection: running executable paths -> Discord's detectable list (app/src/lib/game-match.ts).
//   node --test games.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildIndex, gameIconUrl, matchPath } from '../app/src/lib/game-match.ts';

const LIST = [
  ['1', 'Counter-Strike 2', 'abc', ['win64/cs2.exe']],
  ['2', 'VALORANT', '', ['win64/valorant-win64-shipping.exe']],
  ['3', 'Minecraft', 'def', ['>javaw.exe', 'content/minecraft.exe']],
  ['4', 'Some Game', 'x', ['game.exe']],
];
const index = buildIndex(LIST);
const name = (path) => matchPath(index, path)?.[1];

test('matches executable paths by their ending, case-insensitively, with either slash', () => {
  assert.equal(name('C:\\Program Files (x86)\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\bin\\win64\\cs2.exe'), 'Counter-Strike 2');
  assert.equal(name('D:/Riot Games/VALORANT/live/ShooterGame/Binaries/Win64/VALORANT-Win64-Shipping.exe'), 'VALORANT');
  assert.equal(name('C:\\Games\\Some Game\\GAME.EXE'), 'Some Game');
});

test('needs the whole path part, not just the file name', () => {
  // cs2.exe outside a win64 folder is something else.
  assert.equal(name('C:\\Tools\\cs2.exe'), undefined);
  // "xwin64/cs2.exe" must not count as "win64/cs2.exe".
  assert.equal(name('C:\\x\\xwin64\\cs2.exe'), undefined);
  assert.equal(name('C:\\Windows\\explorer.exe'), undefined);
});

test('">" entries match the file name exactly', () => {
  assert.equal(name('C:\\Program Files\\Java\\bin\\javaw.exe'), 'Minecraft');
  assert.equal(name('C:\\Games\\content\\minecraft.exe'), 'Minecraft');
});

test('just a file name (elevated processes) still matches entries without a folder', () => {
  assert.equal(name('game.exe'), 'Some Game');
  assert.equal(name('cs2.exe'), undefined);
});

test('icon URLs use the CDN, none without an icon hash', () => {
  assert.equal(gameIconUrl(LIST[0]), 'https://cdn.discordapp.com/app-icons/1/abc.png?size=128');
  assert.equal(gameIconUrl(LIST[1]), undefined);
});
