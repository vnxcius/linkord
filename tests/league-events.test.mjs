// REC + League: which match events are yours and what they make (app/src/lib/league-events.ts).
//   node --test league-events.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clipSpan, momentOf, samePlayer } from '../app/src/lib/league-events.ts';

const ME = 'Vini#BR1';
const ev = (EventName, extra = {}) => ({ EventID: 1, EventName, EventTime: 100, ...extra });

test('players match by Riot ID or by its name alone, in any case', () => {
  assert.ok(samePlayer('Vini#BR1', ME));
  assert.ok(samePlayer('vini', ME));
  assert.ok(samePlayer('Vini', 'vini'));
  assert.ok(!samePlayer('Vinicius', ME));
  assert.ok(!samePlayer(undefined, ME));
  assert.ok(!samePlayer('Vini', ''));
});

test("kills, deaths, multikills, aces and objectives are yours or nothing", () => {
  assert.deepEqual(momentOf(ev('ChampionKill', { KillerName: 'Vini', VictimName: 'Foe' }), ME), { kind: 'kill', other: 'Foe', auto: 'kill', rank: 1 });
  assert.deepEqual(momentOf(ev('ChampionKill', { KillerName: 'Foe', VictimName: 'Vini#BR1' }), ME), { kind: 'death', other: 'Foe', auto: 'death', rank: 0 });
  assert.equal(momentOf(ev('ChampionKill', { KillerName: 'A', VictimName: 'B' }), ME), null);
  assert.equal(momentOf(ev('Multikill', { KillerName: 'Vini', KillStreak: 5 }), ME).streak, 5);
  assert.ok(momentOf(ev('Multikill', { KillerName: 'Vini', KillStreak: 5 }), ME).rank > momentOf(ev('Multikill', { KillerName: 'Vini', KillStreak: 2 }), ME).rank);
  assert.equal(momentOf(ev('Multikill', { KillerName: 'Other', KillStreak: 5 }), ME), null);
  assert.equal(momentOf(ev('Ace', { Acer: 'Vini' }), ME).kind, 'ace');
  // Riot sends Stolen as the string "True"/"False".
  assert.deepEqual(momentOf(ev('BaronKill', { KillerName: 'Vini', Stolen: 'True' }), ME), { kind: 'steal', objective: 'baron', auto: 'steal', rank: 2 });
  assert.deepEqual(momentOf(ev('DragonKill', { KillerName: 'Vini', Stolen: 'False' }), ME), { kind: 'objective', objective: 'dragon', auto: null, rank: 1 });
  assert.equal(momentOf(ev('DragonKill', { KillerName: 'Other', Stolen: 'True' }), ME), null);
  assert.equal(momentOf(ev('TurretKilled', { KillerName: 'Vini' }), ME), null);
  assert.equal(momentOf(ev('GameStart'), ME), null);
});

test('moments close together make one clip: the length setting before the first, 5 s after the last', () => {
  assert.deepEqual(clipSpan([10_000], 30), { end: 15_000, seconds: 30 });
  // A kill, then a double kill 4 s later: one clip 4 s longer, ending 5 s after the double.
  assert.deepEqual(clipSpan([10_000, 14_000], 30), { end: 19_000, seconds: 34 });
  assert.equal(clipSpan([0, 1_000_000], 30).seconds, 300, 'never longer than the shell takes');
});
