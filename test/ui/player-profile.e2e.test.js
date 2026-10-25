import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, startRealServer, hasChrome } from '../e2e/client.mjs';

test('passport restores the same ID, loadout, ownership, DIY, skins and history in a fresh origin', {
  skip: !(process.env.SP_E2E === '1' && hasChrome()), timeout: 90000,
}, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sp-passport-e2e-'));
  assert.ok(path.resolve(dir).startsWith(path.resolve(tmpdir()) + path.sep + 'sp-passport-e2e-'));
  const previous = process.env.SP_PROFILE_DIR;
  process.env.SP_PROFILE_DIR = path.join(dir, 'profiles');
  let srv, source, target;
  try {
    srv = await startRealServer();
    const P = (await import('puppeteer-core')).default;
    source = new Client(P, srv.base, 'profile-source', { prefix: 'player-profile', w: 1280, h: 800 });
    await source.open(); await source.enter('档案博士');
    await source.click('[data-testid="loadout-open"]');
    await source.page.waitForSelector('.lo-card');
    await source.page.waitForFunction(async () => (await import('/js/profileSync.js')).profileState.get().status === 'saved');
    const passport = await source.page.evaluate(async () => {
      const l = await import('/js/ui/loadoutSync.js');
      const stats = await import('/js/ui/stats.js');
      l.setEntries({ chess_char_1_01_a: { skill: 0 } });
      l.setOpsMap({ char_003_kalts: { potential: 1, cultivate: 0 } });
      l.setNotOwned(['chess_char_1_01_a']);
      l.setDiyPicks({ chess_char_6_diy1_a: { charId: 'char_003_kalts', skillIndex: 0, uniEquipId: null } });
      (await import('/js/store.js')).savePref('diy.act2autochess-v2_1', { v: 1, picks: { chess_char_6_diy1_a: { charId: 'char_003_kalts', skillIndex: 1 } } });
      (await import('/js/ui/skins.js')).setSkins({ char_003_kalts: 'test_skin' });
      const me = globalThis.__SP__.store.get().me;
      stats.saveStats({ v: 2, records: [{ id: 'passport-history', v: 2, t: Date.now(), end: 'settled', selfId: me.playerId,
        players: [{ playerId: me.playerId, name: me.name, isBot: false, stats: { dmgDealt: 1234 } }], victory: true, roundsPassed: 3 }] });
      return (await import('/js/profileSync.js')).exportPassport();
    });
    const file = path.join(dir, 'passport.json');
    writeFileSync(file, JSON.stringify(passport));
    const id = passport.playerId;
    target = new Client(P, srv.base.replace('127.0.0.1', 'localhost'), 'profile-restored', { prefix: 'player-profile', w: 1280, h: 800 });
    await target.open();
    // The fallback passport flow must work with the classic worker, which has no directory message listener.
    await target.page.evaluate(async () => { await navigator.serviceWorker.register('/sw.js', { scope: '/' }); });
    await target.page.waitForFunction(() => navigator.serviceWorker.controller?.scriptURL.endsWith('/sw.js'));
    await target.click('.player-profile button', '玩家档案与通行证');
    await target.page.waitForSelector('.player-profile input[accept^=".json"]');
    await (await target.page.$('.player-profile input[accept^=".json"]')).uploadFile(file);
    await target.page.waitForFunction(() => document.querySelector('.player-profile [role="alert"]')?.textContent.includes('请先关闭'));
    await source.close(); source = null;
    await (await target.page.$('.player-profile input[accept^=".json"]')).uploadFile(file);
    await target.page.waitForFunction((id) => globalThis.__SP__?.store.get().me.playerId === id, { timeout: 20000 }, id);
    await target.click('[data-testid="loadout-open"]');
    await target.page.waitForSelector('.lo-card');
    const restored = await target.page.evaluate(async () => {
      const l = (await import('/js/ui/loadoutSync.js')).loadoutStore.get();
      return { entries: l.entries, ops: l.ops, notOwned: l.notOwned, diy: l.diy,
        previousVersionDiy: (await import('/js/store.js')).loadPref('diy.act2autochess-v2_1', null),
        skins: (await import('/js/ui/skins.js')).skinsStore.get().skins,
        records: (await import('/js/ui/stats.js')).loadStats().records.map((r) => ({ id: r.id, selfId: r.selfId })) };
    });
    assert.deepEqual(restored.entries, { chess_char_1_01_a: { skill: 0 } });
    assert.deepEqual(restored.ops.char_003_kalts, { potential: 1, cultivate: 0 });
    assert.deepEqual(restored.notOwned, ['chess_char_1_01_a']);
    assert.equal(restored.diy.chess_char_6_diy1_a.charId, 'char_003_kalts');
    assert.equal(restored.previousVersionDiy.picks.chess_char_6_diy1_a.skillIndex, 1);
    assert.equal(restored.skins.char_003_kalts, 'test_skin');
    assert.deepEqual(restored.records, [{ id: 'passport-history', selfId: id }]);
    await target.page.evaluate(async () => {
      (await import('/js/ui/loadoutSync.js')).closeLoadout();
      (await import('/js/screens/stats.js')).openStats();
    });
    await target.page.waitForSelector('.st-note');
    assert.ok((await target.page.$eval('.st-note', (e) => e.textContent)).includes('自动同步到服主电脑'));
    await target.shot('restored');
    assert.deepEqual(target.problems, []);
  } finally {
    await source?.close(); await target?.close(); await srv?.stop();
    if (previous === undefined) delete process.env.SP_PROFILE_DIR; else process.env.SP_PROFILE_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
