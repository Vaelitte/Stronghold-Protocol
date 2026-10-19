import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rememberDamageFields, roundCombat, matchCombat, requestCombatSample, receiveCombatSample } from '../../server/match/damage.js';
import { validateC2S } from '../../shared/protocol.js';

const row = (ownerId, damage, healing = 0) => ({ ownerId, defId: 'chess_test', name: '测试干员', kind: 'op', damage, healing,
  types: { phys: damage, arts: 0, true: 0, elemental: 0 } });
function fixture() {
  const sent = [], timers = [];
  const fields = ['p1', 'p2'].map((p) => ({ cc: true, battleId: p, fieldId: p, players: [p], authority: p, mode: 'client', done: false }));
  const m = { round: 3, fields, sendTo: (pid, msg) => sent.push({ pid, ...msg }), later: (ms, fn) => { timers.push(fn); return fn; }, cancel() {} };
  return { m, fields, sent, timers };
}
test('sampling asks for the latest snapshot, coalesces viewers, skips intermediate states and never replays them', () => {
  const { m, sent } = fixture();
  requestCombatSample(m, 'p1'); requestCombatSample(m, 'p2');
  assert.equal(sent.length, 2, 'one query per field, even with two viewers');
  const sampleId = sent[0].sampleId;
  receiveCombatSample(m, { playerId: 'p2' }, { sampleId, battleId: 'p1', gt: 12, damage: [row('p1', 999)] });
  assert.equal(m.damageSample.waiting.size, 2, 'another player cannot report this field');
  receiveCombatSample(m, { playerId: 'p1' }, { sampleId, battleId: 'p1', gt: 12, damage: [row('p1', 120, 24), row('outsider', 999)] });
  receiveCombatSample(m, { playerId: 'p2' }, { sampleId, battleId: 'p2', gt: 14, damage: [row('p2', 280)] });
  assert.equal(sent.length, 4, 'one latest snapshot per viewer');
  assert.deepEqual(sent[2].combat.rows.map((r) => r.damage), [280, 120]);
  assert.equal(sent[2].combat.rows.find((r) => r.ownerId === 'p1').dps, 10);
  assert.equal(sent[2].combat.healing, 24);
  requestCombatSample(m, 'p1');
  const next = m.damageSample.id;
  receiveCombatSample(m, { playerId: 'p1' }, { sampleId: next, battleId: 'p1', gt: 20, damage: [row('p1', 450)] });
  receiveCombatSample(m, { playerId: 'p2' }, { sampleId: next, battleId: 'p2', gt: 20, damage: [row('p2', 900)] });
  assert.equal(sent.at(-1).combat.damage, 1350, 'replace cumulative counters, do not add earlier snapshots');
  assert.equal(m.damageSample, null);
});
test('normal, unite, boss pairs, takeovers and next-round match totals keep each owner exactly once', () => {
  const { m, fields } = fixture();
  fields[0].damageRecord = { seconds: 10, owners: ['p1'], rows: [row('p1', 100)] };
  fields[1].damageRecord = { seconds: 10, owners: ['p2'], rows: [row('p2', 200)] };
  rememberDamageFields(m);
  m.fields = [{ players: ['p1', 'p2'], battle: { combatMetrics: () => ({ seconds: 5, owners: ['p1', 'p2'], rows: [row('p1', 30), row('p2', 40)] }) } }];
  assert.equal(roundCombat(m).damage, 370);
  assert.equal(roundCombat(m).damage, 370, 'reading again does not add the same fields');
  m.round = 4; rememberDamageFields(m); m.fields = [];
  const pair = { players: ['p1', 'p2'], damageRecord: { seconds: 8, owners: ['p1', 'p2'], rows: [row('p1', 50), row('p2', 60)] } };
  m.fields = [pair];
  assert.equal(roundCombat(m).damage, 110);
  pair.battle = { combatMetrics: () => ({ seconds: 4, owners: ['p1', 'p2'], rows: [row('p1', 20)] }) };
  assert.equal(roundCombat(m).damage, 110, 'a restarting fallback does not erase the latest counters');
  pair.battle.combatMetrics = () => ({ seconds: 9, owners: ['p1', 'p2'], rows: [row('p1', 80), row('p2', 90)] });
  assert.equal(roundCombat(m).damage, 170, 'caught-up fallback replaces the original field');
  assert.equal(matchCombat(m).damage, 540);
});
test('sample timeout is explicit; stale reports, invalid numbers and oversized rows cannot become current data', () => {
  const { m, sent, timers } = fixture();
  requestCombatSample(m, 'p1');
  const oldId = m.damageSample.id;
  timers[0]();
  assert.deepEqual(sent.at(-1).pendingPlayers, ['p1', 'p2']);
  requestCombatSample(m, 'p1');
  receiveCombatSample(m, { playerId: 'p1' }, { sampleId: oldId, battleId: 'p1', gt: 10, damage: [row('p1', 5)] });
  assert.equal(m.damageSample.waiting.size, 2);
  const msg = { t: 'b.metricsReport', sampleId: '3.1', battleId: 'p1', gt: 10, damage: [row('p1', 50)] };
  assert.equal(validateC2S(msg), null);
  assert.ok(validateC2S({ ...msg, damage: [row('p1', -1)] }));
  assert.ok(validateC2S({ ...msg, damage: Array(129).fill(row('p1', 0)) }));
});
