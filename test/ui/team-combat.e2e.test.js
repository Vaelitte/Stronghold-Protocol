import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, startRealServer, hasChrome, sleep } from '../e2e/client.mjs';

test('real four-player combat: team columns, both scopes, latest sampling interval, centering and stop on close', {
  skip: !(process.env.SP_E2E === '1' && hasChrome()), timeout: 180000,
}, async () => {
  let srv, host, guest;
  const previous = process.env.SP_COMBAT;
  process.env.SP_COMBAT = 'client';
  try {
    srv = await startRealServer({ fast: { startRound: 3, timerScale: 0.3, combatSpeed: 1,
      kits: [['chess_char_1_10_a', 'chess_char_1_12_a'], ['chess_char_1_03_a', 'chess_char_1_09_a']],
      botChess: ['chess_char_1_10_a', 'chess_char_1_12_a'], idleBots: true, autoPlace: true } });
    const P = (await import('puppeteer-core')).default;
    host = new Client(P, srv.base, 'team-host', { prefix: 'team-combat', w: 1280, h: 800 });
    guest = new Client(P, srv.base, 'team-guest', { prefix: 'team-combat-guest', w: 1280, h: 800 });
    await host.open(); await host.enter('统计博士');
    await host.click('.mode-card', '同盟模拟'); await host.click('.diff-card', '标准模拟');
    await host.click('.create-box button', '创建同盟');
    const code = (await host.waitFor((s) => !!s.room?.code, 'room')).room.code;
    for (let i = 0; i < 2; i++) { await host.click('button', '添加 AI 队友'); await sleep(300); }
    await guest.open(`?room=${code}`); await guest.enter('队友博士');
    await guest.waitFor((s) => s.room?.code === code, 'joined');
    await guest.click('.room-bar__right button', '准备就绪'); await host.click('.room-bar__right button', '开始模拟');
    for (const c of [host, guest]) { await c.waitFor((s) => s.phase === 'INFO_CHECK', 'briefing'); await c.click('.brief__foot .btn--primary', '准备就绪'); }
    const picked = new Set(), start = Date.now();
    while (picked.size < 2 && Date.now() - start < 60000) {
      for (const c of [host, guest]) {
        const s = await c.st();
        if (s.phase && !['INFO_CHECK', 'BAND_DRAFT'].includes(s.phase)) { picked.add(c.label); continue; }
        if (s.phase !== 'BAND_DRAFT' || picked.has(c.label) || s.draft?.turn !== s.me) continue;
        await c.click('.dband:not(.is-taken)', null, { nth: 1 }); await sleep(100);
        await c.click('.draft-detail__btns .btn--primary', '确认选择'); picked.add(c.label);
      }
      await sleep(150);
    }
    for (const c of [host, guest]) { await c.waitFor((s) => s.phase === 'PREP', 'prep'); if (!(await c.st()).ready) await c.click('.readybtn'); }
    await host.waitFor((s) => s.phase === 'COMBAT', 'combat');
    await host.page.waitForSelector('.gm__metrics');
    assert.equal(await host.page.$eval('.gm__fs', (e) => e.nextElementSibling?.classList.contains('gm__metrics')), true);
    await host.page.evaluate(() => {
      globalThis.__teamSamples = [];
      globalThis.__SP__.net.on('b.metrics', (m) => globalThis.__teamSamples.push({ at: Date.now(), damage: m.combat.damage, pending: m.pendingPlayers,
        rows: m.combat.rows, kind: m.combatKind, stages: m.combatStages }));
    });
    await host.click('.gm__metrics');
    await host.page.waitForFunction(() => globalThis.__teamSamples.length >= 2);
    assert.equal(await host.page.$$eval('.combat-metrics__player', (els) => els.length), 4);
    for (const label of ['当前战斗', '本局累计', '总伤害', '总治疗', '物理', '法术', '真实', '元素', 'DPS', 'HPS']) {
      assert.ok((await host.page.$eval('#combat-metrics-panel', (e) => e.textContent)).includes(label), label);
    }
    await host.page.waitForFunction(() => globalThis.__teamSamples.some((m) => m.damage > 0 && !m.pending.length), { timeout: 20000 });
    assert.equal(await host.page.$eval('.combat-metrics__scopes button[aria-pressed="true"]', (e) => e.textContent), '当前战斗');
    assert.deepEqual(await host.page.$$eval('.combat-metrics__scopes button', els => els.map(e => e.textContent)), ['当前战斗', '本局累计']);
    await host.page.waitForFunction(() => {
      const samples = globalThis.__teamSamples;
      const bots = globalThis.__SP__.store.get().match.public.players.filter((p) => p.isBot).map((p) => p.playerId);
      return bots.some((id) => {
        const values = samples.map((s) => s.rows.filter((r) => r.ownerId === id).reduce((n, r) => n + r.damage, 0));
        return Math.max(...values) > Math.min(...values);
      });
    }, { timeout: 20000 });
    const counters = await host.page.evaluate(async () => {
      const runner = (await import('/js/battle/runner.js')).battleRunner;
      return [...runner._entries.values()].map((e) => ({ authority: e.authoritative, time: e.battle?.time,
        meter: e.combatMetrics?.().rows.reduce((n, r) => n + r.damage, 0),
        simDamage: e.battle?.allyUnits?.reduce((n, u) => n + (u.stats?.dmg || 0), 0) }));
    });
    assert.ok(counters.every((r) => Math.abs((r.meter || 0) - r.simDamage) < 1e-6), 'human counters equal actual simulation damage');
    await host.click('.combat-metrics__scopes button', '本局累计'); await host.click('.combat-metrics__scopes button', '当前战斗');
    const slider = await host.page.$('.combat-metrics__frequency input');
    await slider.focus(); await host.page.keyboard.press('End'); await host.page.keyboard.press('ArrowLeft');
    assert.equal(await slider.evaluate((e) => e.value), '4');
    await sleep(300);
    const count = await host.page.evaluate(() => globalThis.__teamSamples.length);
    await sleep(5600);
    const after = await host.page.evaluate(() => globalThis.__teamSamples.length);
    assert.ok(after - count >= 1 && after - count <= 2, 'five-second sampling skips intermediate updates');
    const geometry = await host.page.$eval('#combat-metrics-panel', (e) => {
      const r = e.getBoundingClientRect(); return { cx: r.x + r.width / 2, cy: r.y + r.height / 2, w: innerWidth, h: innerHeight, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    });
    assert.ok(Math.abs(geometry.cx - geometry.w / 2) < 3 && Math.abs(geometry.cy - geometry.h / 2) < 3);
    assert.ok(geometry.left >= 0 && geometry.right <= geometry.w && geometry.top >= 0 && geometry.bottom <= geometry.h);
    await host.shot('four-player-1280');
    await host.page.setViewport({ width: 756, height: 366 }); await sleep(300); await host.shot('four-player-phone');
    await host.click('.combat-metrics__close'); await sleep(300);
    const closedCount = await host.page.evaluate(() => globalThis.__teamSamples.length);
    await sleep(1600);
    assert.equal(await host.page.evaluate(() => globalThis.__teamSamples.length), closedCount);
    assert.deepEqual(host.problems.filter((p) => p.startsWith('pageerror:')), []);
  } catch (e) { if (host?.page) await host.shot('failure'); throw e; }
  finally {
    await host?.close(); await guest?.close(); await srv?.stop();
    if (previous === undefined) delete process.env.SP_COMBAT; else process.env.SP_COMBAT = previous;
  }
});
