import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { startServer } from '../../server/index.js';
import { ProfileStore } from '../../server/profiles.js';
import { Client, hasChrome } from '../e2e/client.mjs';

async function tunnel(target) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url, method: req.method, origin: req.headers.origin, cors: req.headers['access-control-request-headers'] });
    const upstream = http.request(target + req.url, { method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers); r.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
  });
  server.on('upgrade', (req, client, head) => {
    const upstream = http.request(target + req.url, { headers: req.headers });
    upstream.on('upgrade', (r, socket, rest) => {
      client.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
      if (head.length) socket.write(head);
      if (rest.length) client.write(rest);
      socket.pipe(client); client.pipe(socket);
      client.on('error', () => socket.destroy()); socket.on('error', () => client.destroy());
      client.on('close', () => socket.destroy());
    });
    upstream.on('error', () => client.destroy()); upstream.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, hits,
    close: async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}

test('replacing a random tunnel automatically restores ID and all preferences and serves cached art with no new transfer', {
  skip: !(process.env.SP_E2E === '1' && hasChrome()), timeout: 120000,
}, async () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'sp-entry-browser-'));
  assert.ok(path.resolve(dir).startsWith(path.resolve(tmpdir()) + path.sep + 'sp-entry-browser-'));
  const file = path.join(dir, 'entry.json');
  let srv, first, second, client;
  try {
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, studio: false,
      profiles: new ProfileStore(path.join(dir, 'profiles')), browserEntryFile: file });
    first = await tunnel(srv.url); second = await tunnel(srv.url);
    const setRelay = (random) => fs.writeFileSync(file, JSON.stringify({ origin: srv.url, random }));
    for (let i = 0; i < 200 && !srv.assetIndex.stats().ready; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(srv.assetIndex.stats().ready, true);
    const P = (await import('puppeteer-core')).default;
    client = new Client(P, first.url, 'auto-entry', { prefix: 'auto-entry', w: 1280, h: 800 });
    await client.open(); await client.enter('自动恢复');
    await client.page.waitForFunction(async () => (await import('/js/profileSync.js')).profileState.get().status === 'saved');
    const saved = await client.page.evaluate(async () => {
      const l = await import('/js/ui/loadoutSync.js');
      l.setEntries({ chess_char_1_01_a: { skill: 0 } });
      l.setNotOwned(['chess_char_1_01_a']);
      l.setDiyPicks({ chess_char_6_diy1_a: { charId: 'char_003_kalts', skillIndex: 0, uniEquipId: null } });
      const p = await (await import('/js/profileSync.js')).exportPassport();
      const m = await fetch('/data/assets.json').then((r) => r.json());
      const paths = (await import('/js/assetDownload.js')).collectAssetUrls(m);
      const asset = paths.find((p) => /\/~[0-9a-f]{16}\/.*\.png$/.test(p));
      const bytes = await (await fetch(asset)).arrayBuffer();
      return { id: p.playerId, asset, bytes: bytes.byteLength, ws: globalThis.__SP__.net.ws.url };
    });
    assert.ok(saved.bytes > 0);
    assert.equal(new URL(saved.ws).port, new URL(first.url).port);
    // Enable the feature after an old random-origin profile already exists: no passport file is imported.
    setRelay(first.url);
    await client.page.goto(first.url, { waitUntil: 'domcontentloaded' });
    await client.page.waitForFunction((id) => globalThis.__SP__?.store.get().me.playerId === id, { timeout: 30000 }, saved.id);
    assert.equal(new URL(client.page.url()).origin, srv.url);
    await client.page.evaluate(async (asset) => { await (await fetch(asset)).arrayBuffer(); }, saved.asset);
    await client.page.waitForFunction(async (asset) => !!(await (await caches.open('sp-imported-assets-v1')).match(asset)), {}, saved.asset);
    setRelay(second.url);
    await client.page.goto(second.url, { waitUntil: 'domcontentloaded' });
    await client.page.waitForFunction((id) => globalThis.__SP__?.store.get().me.playerId === id, { timeout: 30000 }, saved.id);
    await client.page.waitForFunction(async () => (await import('/js/profileSync.js')).profileState.get().status === 'saved');
    const restored = await client.page.evaluate(async (asset) => {
      const l = (await import('/js/ui/loadoutSync.js')).loadoutStore.get();
      const data = await (await fetch(asset)).arrayBuffer();
      return { entries: l.entries, ownership: l.notOwned, diy: l.diy, bytes: data.byteLength,
        ws: globalThis.__SP__.net.ws.url, profile: (await import('/js/profileSync.js')).profileState.get().status };
    }, saved.asset);
    assert.deepEqual(restored.entries, { chess_char_1_01_a: { skill: 0 } });
    assert.deepEqual(restored.ownership, ['chess_char_1_01_a']);
    assert.equal(restored.diy.chess_char_6_diy1_a.charId, 'char_003_kalts');
    assert.equal(restored.bytes, saved.bytes);
    assert.equal(new URL(restored.ws).port, new URL(second.url).port);
    assert.equal(restored.profile, 'saved');
    assert.equal(second.hits.some((r) => r.url.split('?')[0] === saved.asset), false, 'previously cached art never reaches the new tunnel');
    assert.ok(second.hits.some((r) => r.url === '/api/profile'), 'the latest profile uses the new tunnel');
    await client.shot('restored-with-new-tunnel');
    assert.deepEqual(client.problems, []);
  } catch (e) {
    if (client?.page) {
      process.stderr.write(JSON.stringify({ url: client.page.url(), problems: client.problems,
        body: await client.page.$eval('body', (e) => e.textContent.slice(0, 800)), hits: first?.hits?.slice(-8) }) + '\n');
      await client.shot('failure');
    }
    throw e;
  } finally {
    await client?.close(); await first?.close(); await second?.close(); await srv?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
