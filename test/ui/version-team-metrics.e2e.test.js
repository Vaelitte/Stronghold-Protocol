import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, hasChrome } from '../e2e/client.mjs';

test('historical version host forwards live counters for the human and three AI teammates', {
  skip: !(process.env.SP_E2E === '1' && hasChrome()), timeout: 120000,
}, async () => {
  const { startServer } = await import('../../server/index.js');
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, versions: { enabled: 'all' },
    matchHost: { matchOptions: { clientCombat: true, timerScale: 0.15, combatSpeed: 2, botRehearsal: 0 } } });
  const P = (await import('puppeteer-core')).default;
  const host = new Client(P, srv.url, 'version-team', { prefix: 'version-team', w: 1280, h: 800 });
  try {
    await host.open(); await host.enter('历史版本统计验收');
    await host.page.evaluate(async () => (await import('/js/versions.js')).setLobbyVersion('act1autochess'));
    await host.page.waitForFunction(() => globalThis.__SP_CONTENT__?.state()?.version === 'act1autochess'
      && globalThis.__SP_CONTENT__.state().status === 'ready');
    await host.createCoop('标准模拟');
    for (let i = 0; i < 3; i++) await host.click('button', '添加 AI 队友');
    await host.page.waitForFunction(() => !document.querySelector('.rs-go')?.disabled);
    // Match-host routing is under test; await the request instead of racing the room's entrance animation.
    const started = await host.page.evaluate(() => globalThis.__SP__.net.request('room.start', {}).then(r => r ?? null));
    assert.equal(started?.error ?? null, null);
    await host.waitFor(s => s.phase === 'INFO_CHECK', 'historical briefing');
    await host.page.evaluate(async () => {
      await globalThis.__SP__.net.request('g.infoReady', {});
      await globalThis.__SP__.net.request('g.autoplay', { on: true });
      globalThis.__versionSamples = [];
      globalThis.__SP__.net.on('b.metrics', m => globalThis.__versionSamples.push(m));
    });
    await host.waitFor(s => s.phase === 'COMBAT', 'historical combat', 60000);
    await host.click('button', '返回模拟');
    await host.click('.gm__metrics');
    await host.page.waitForFunction(() => {
      const samples = globalThis.__versionSamples;
      return samples.length > 1 && samples.at(-1).combat.rows.length > 0
        && samples.some(s => s.combat.seconds < samples.at(-1).combat.seconds);
    }, { timeout: 25000 });
    assert.equal(await host.page.$$eval('.combat-metrics__player', es => es.length), 4);
    assert.deepEqual(await host.page.$$eval('.combat-metrics__scopes button', es => es.map(e => e.textContent)), ['当前战斗', '本局累计']);
    assert.equal(await host.page.evaluate(() => globalThis.__SP__.store.get().room.version), 'act1autochess');
    assert.deepEqual(host.problems.filter(p => p.startsWith('pageerror:')), []);
    await host.shot('live');
  } catch (e) {
    if (host.page) {
      console.log(await host.page.evaluate(() => ({ samples: globalThis.__versionSamples?.slice(-2),
        phase: globalThis.__SP__.store.get().match.public?.phase,
        toasts: [...document.querySelectorAll('.toast__text')].map(e => e.textContent) })));
      await host.shot('failure');
    }
    throw e;
  }
  finally { await host.close(); await srv.close(); }
});
