import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, startRealServer, hasChrome, sleep } from '../e2e/client.mjs';

test('one human with three AI teammates: live AI metrics automatically follow the current battle from individual to unite', {
  skip: !(process.env.SP_E2E === '1' && hasChrome()), timeout: 180000,
}, async () => {
  let srv, host;
  const previous = process.env.SP_COMBAT;
  process.env.SP_COMBAT = 'client';
  try {
    srv = await startRealServer({ fast: { startRound: 3, timerScale: 0.3, combatSpeed: 2,
      kit: 0, botChess: ['chess_char_1_01_a', 'chess_char_1_03_a', 'chess_char_1_10_a'], idleBots: true, autoPlace: true } });
    const P = (await import('puppeteer-core')).default;
    host = new Client(P, srv.base, 'three-ai', { prefix: 'three-ai', w: 1280, h: 800 });
    await host.open(); await host.enter('三AI验收');
    await host.click('.mode-card', '同盟模拟'); await host.click('.diff-card', '标准模拟');
    await host.click('.create-box button', '创建同盟');
    await host.waitFor((s) => !!s.room?.code, 'room');
    for (let i = 0; i < 3; i++) { await host.click('button', '添加 AI 队友'); await sleep(150); }
    await host.click('.room-bar__right button', '开始模拟');
    await host.waitFor((s) => s.phase === 'INFO_CHECK', 'briefing');
    await host.click('.brief__foot .btn--primary', '准备就绪');
    await host.waitFor((s) => s.phase === 'BAND_DRAFT' && s.draft?.turn === s.me, 'draft turn');
    await host.click('.dband:not(.is-taken)', null, { nth: 1 });
    await host.click('.draft-detail__btns .btn--primary', '确认选择');
    const prep = await host.waitFor((s) => s.phase === 'PREP' || s.phase === 'SP_DRAFT' && s.sp?.turn === s.me, 'prep or choice');
    if (prep.phase === 'SP_DRAFT') { await host.click('.spcard.is-pickable'); await host.click('.spcard.is-armed'); }
    await host.waitFor((s) => s.phase === 'PREP', 'prep'); await host.click('.readybtn');
    await host.waitFor((s) => s.phase === 'COMBAT', 'combat');
    await host.page.evaluate(() => {
      globalThis.__aiSamples = [];
      globalThis.__SP__.net.on('b.metrics', (m) => globalThis.__aiSamples.push(m));
    });
    await host.click('.gm__metrics');
    await host.page.waitForFunction(() => {
      const pub = globalThis.__SP__.store.get().match.public;
      const bots = pub.players.filter((p) => p.isBot).map((p) => p.playerId);
      if (bots.length !== 3) return false;
      const progressing = bots.every((pid) => {
        const values = globalThis.__aiSamples.map((s) => Math.max(0, ...s.combatStages.normal.rows.filter((r) => r.ownerId === pid).map((r) => r.seconds)));
        return values.length > 1 && Math.max(...values) > Math.min(...values);
      });
      return progressing && bots.some((pid) => {
        const values = globalThis.__aiSamples.map((s) => s.combatStages.normal.rows.filter((r) => r.ownerId === pid).reduce((n, r) => n + r.damage + r.healing, 0));
        return values.length > 1 && Math.max(...values) > Math.min(...values);
      });
    }, { timeout: 25000 });
    assert.equal(await host.page.$$eval('.combat-metrics__player', (els) => els.length), 4);
    assert.deepEqual(await host.page.$$eval('.combat-metrics__scopes button', els => els.map(e => e.textContent)), ['当前战斗', '本局累计']);
    await host.shot('three-ai-live');
    await host.waitFor(s => s.phase === 'UNITE', 'unite after the empty human board leaks', 90000);
    await host.page.waitForFunction(() => {
      const sample = globalThis.__aiSamples.at(-1);
      if (sample?.combatKind !== 'unite' || sample.combatStages.normal.damage <= 0) return false;
      const shown = [...document.querySelectorAll('.combat-metrics__player .combat-metrics__totals > span:first-child b')]
        .reduce((sum, e) => sum + Number(e.textContent.replace(/,/g, '')), 0);
      return Math.abs(shown - sample.combat.damage) <= 2 && sample.combat.damage === sample.combatStages.unite.damage;
    }, { timeout: 20000 });
    assert.deepEqual(await host.page.$$eval('.combat-metrics__scopes button', els => els.map(e => e.textContent)), ['当前战斗', '本局累计']);
    await host.click('.combat-metrics__scopes button', '本局累计');
    await host.page.waitForFunction(() => {
      const sample = globalThis.__aiSamples.at(-1);
      const shown = [...document.querySelectorAll('.combat-metrics__player .combat-metrics__totals > span:first-child b')]
        .reduce((sum, e) => sum + Number(e.textContent.replace(/,/g, '')), 0);
      return sample?.combatKind === 'unite' && sample.combatMatch.damage > sample.combat.damage && Math.abs(shown - sample.combatMatch.damage) <= 2;
    }, { timeout: 10000 });
    await host.click('.combat-metrics__scopes button', '当前战斗');
    await host.shot('three-ai-unite');
    assert.deepEqual(host.problems.filter((p) => p.startsWith('pageerror:')), []);
  } catch (e) { if (host?.page) await host.shot('failure'); throw e; }
  finally {
    await host?.close(); await srv?.stop();
    if (previous === undefined) delete process.env.SP_COMBAT; else process.env.SP_COMBAT = previous;
  }
});
