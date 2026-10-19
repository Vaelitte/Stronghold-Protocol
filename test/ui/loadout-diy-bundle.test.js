import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { exportPayload, parseImport } from '../../public/js/ui/loadoutModel.js';
import { diySlotList, pickOptions, defaultPick, sanitizeDiyPicks } from '../../public/js/ui/diyModel.js';
import { applyLoadoutEntries, loadoutStore, setDiyPicks, setOpsMap, setEntries } from '../../public/js/ui/loadoutSync.js';
import { KITTED_CHARS } from '../../server/sim/content/kits/index.js';

const data = Object.fromEntries(['chess', 'backups'].map(name => [name, JSON.parse(readFileSync(new URL(`../../data/${name}.json`, import.meta.url), 'utf8'))]));
const getChess = id => Object.hasOwn(data.chess, id) ? data.chess[id] : null;
const kit = [...KITTED_CHARS];
const picks = {};
for (const slot of diySlotList(data)) {
  const choice = pickOptions(slot.slotId, picks, data, kit).find(p => !p.taken);
  picks[slot.slotId] = defaultPick(choice.charId, slot.slotId, data);
}
picks.chess_char_5_diy1_a = { charId: 'char_112_siege', skillIndex: 2, uniEquipId: 'uniequip_002_siege' };

test('one loadout payload round-trips all four DIY slots, skill/module choices and cultivation', () => {
  const ops = { char_112_siege: { potential: 2, cultivate: 1 } };
  const payload = exportPayload({}, { diy: picks, ops });
  const parsed = parseImport(JSON.stringify(payload));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.diy, picks);
  assert.deepEqual(parsed.ops, ops);
  assert.equal(Object.keys(parsed.diy).length, 4);
  payload.diy.chess_char_5_diy1_a.skillIndex = 0;
  assert.equal(picks.chess_char_5_diy1_a.skillIndex, 2, 'export is a copy');
});

test('bundled import validates, persists, leaves old-file picks unchanged and supports explicit clearing', () => {
  const before = loadoutStore.get();
  try {
    const result = applyLoadoutEntries({}, getChess, { diy: picks, diyData: data, kitted: kit });
    assert.equal(result.diy, 4);
    assert.equal(result.diyApplied, true);
    assert.deepEqual(loadoutStore.get().diy, sanitizeDiyPicks(picks, data, kit));
    const saved = loadoutStore.get().diy;
    applyLoadoutEntries({}, getChess);
    assert.equal(loadoutStore.get().diy, saved, 'old files do not touch DIY');
    const unavailable = applyLoadoutEntries({}, getChess, { diy: { fake_slot: { charId: 'char_missing' } }, diyData: data, kitted: kit });
    assert.equal(unavailable.diyApplied, false);
    assert.equal(loadoutStore.get().diy, saved, 'an entirely unavailable roster does not erase picks');
    const empty = parseImport(exportPayload({}, { diy: {} }));
    assert.equal(empty.ok, true);
    const cleared = applyLoadoutEntries({}, getChess, { diy: empty.diy, diyData: data, kitted: kit });
    assert.equal(cleared.diyApplied, true);
    assert.deepEqual(loadoutStore.get().diy, {});
  } finally { setDiyPicks(before.diy); setOpsMap(before.ops); setEntries(before.entries); }
});

test('malformed DIY and prototype injection never silently clear slots', () => {
  for (const diy of [[], null, 'bad', { broken: {} }, JSON.parse('{"__proto__":{"charId":"x"}}')]) {
    assert.equal(parseImport({ kind: 'stronghold.loadout', v: 1, entries: {}, diy }).ok, false);
  }
});
