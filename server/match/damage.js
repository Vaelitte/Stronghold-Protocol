// Per-round combat accounting: replace field snapshots, never sum replicas/takeovers twice.
import { combineCombat } from '../../shared/combatMetrics.js';

export function rememberDamageFields(m) {
  if (!m.damageHistory || m.damageHistoryRound !== m.round) {
    m.damageMatchHistory ??= new Map();
    if (m.damageHistory) m.damageMatchHistory.set(m.damageHistoryRound, fieldRecords(m.damageHistory));
    m.damageHistory = new Map(); m.damageHistoryRound = m.round;
  }
  for (const f of m.fields || []) {
    f.damageRound ??= m.round;
    if (f.damageRound === m.round) m.damageHistory.set(f, f);
  }
}
export function roundCombat(m) {
  rememberDamageFields(m);
  const records = fieldRecords(m.damageHistory);
  m.damageMatchHistory ??= new Map();
  m.damageMatchHistory.set(m.round, records);
  return combineCombat(records);
}
function fieldRecords(fields) {
  const records = [];
  for (const f of fields.values()) {
    const server = f.battle?.combatMetrics?.();
    let r = f.damageRecord;
    if (server && (!r || server.seconds >= r.seconds)) r = server;
    if (r) records.push(r);
  }
  return records;
}
export function matchCombat(m) {
  return combineCombat([...(m.damageMatchHistory?.values() || [])].flat());
}
export function acceptDamage(f, msg) {
  if (!Array.isArray(msg.damage) || msg.gt < (f.damageRecord?.seconds || 0)) return;
  const rows = msg.damage.filter((r) => f.players.includes(r.ownerId));
  f.damageRecord = { seconds: msg.gt, owners: f.players.slice(), rows };
}

/** Coalesce simultaneous viewers into one fresh sample of every authoritative battlefield. */
export function requestCombatSample(m, playerId) {
  if (m.damageSample?.round === m.round) { m.damageSample.viewers.add(playerId); return; }
  const sample = { id: `${m.round}.${m.damageSampleSeq = (m.damageSampleSeq || 0) + 1}`, round: m.round,
    viewers: new Set([playerId]), waiting: new Map(), timer: null };
  m.damageSample = sample;
  const finish = () => {
    if (m.damageSample !== sample) return;
    if (sample.timer) m.cancel(sample.timer);
    m.damageSample = null;
    if (m.disposed || m.round !== sample.round) return;
    const pendingPlayers = [...new Set([...sample.waiting.values()]
      .filter((f) => m.fields.includes(f) && f.mode === 'client' && !f.done).flatMap((f) => f.players))];
    const msg = { t: 'b.metrics', sampleId: sample.id, round: m.round,
      combat: roundCombat(m), combatMatch: matchCombat(m), pendingPlayers };
    for (const pid of sample.viewers) m.sendTo(pid, msg);
  };
  sample.finish = finish;
  for (const f of m.fields || []) if (f.cc && !f.done && f.mode === 'client' && f.authority) {
    sample.waiting.set(f.battleId, f);
  }
  for (const f of sample.waiting.values()) m.sendTo(f.authority, { t: 'b.metricsQuery', sampleId: sample.id, battleId: f.battleId });
  if (!sample.waiting.size) finish();
  else sample.timer = m.later(2000, finish);
}
export function receiveCombatSample(m, ps, msg) {
  const s = m.damageSample;
  if (!s || s.id !== msg.sampleId || s.round !== m.round) return;
  const f = s.waiting.get(msg.battleId);
  if (!f || f.authority !== ps.playerId || f.mode !== 'client') return;
  acceptDamage(f, msg);
  s.waiting.delete(msg.battleId);
  if (!s.waiting.size) s.finish();
}
