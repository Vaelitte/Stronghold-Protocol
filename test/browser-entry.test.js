import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../server/index.js';
import { ProfileStore } from '../server/profiles.js';
import { createBrowserEntry, readBrowserEntry } from '../server/http/browserEntry.js';

test('browser entry authenticates one-use migration, limits CORS to its stable origin, and follows host configuration', async () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'sp-entry-'));
  assert.ok(path.resolve(dir).startsWith(path.resolve(tmpdir()) + path.sep + 'sp-entry-'));
  const file = path.join(dir, 'entry.json');
  let srv;
  try {
    assert.equal(readBrowserEntry(file), null);
    fs.writeFileSync(file, JSON.stringify({ origin: 'https://user:password@wrong.test', random: null }));
    assert.equal(readBrowserEntry(file), null);
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, assetIndex: false, studio: false,
      browserEntryFile: file, profiles: new ProfileStore(path.join(dir, 'profiles')) });
    const cfg = { origin: srv.url, random: 'https://first.trycloudflare.com' };
    fs.writeFileSync(file, JSON.stringify(cfg));
    assert.deepEqual(await fetch(srv.url + '/api/browser-entry').then((r) => r.json()), { v: 1, ...cfg });
    assert.ok((await fetch(srv.url).then((r) => r.text())).includes('/js/browserEntry.js'));
    assert.ok((await fetch(srv.url, { headers: { 'X-SP-Bridge': '1' } }).then((r) => r.text())).includes('id="sp-main"'));
    let response = await fetch(srv.url + '/healthz', { headers: { Origin: cfg.origin } });
    assert.equal(response.headers.get('access-control-allow-origin'), cfg.origin);
    response = await fetch(srv.url + '/healthz', { headers: { Origin: 'https://wrong.test' } });
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    response = await fetch(srv.url + '/api/profile', { method: 'OPTIONS', headers: { Origin: cfg.origin } });
    assert.equal(response.status, 204);
    const session = srv.registry.create('迁移测试');
    const headers = { Authorization: `Bearer ${session.token}` };
    assert.equal((await fetch(srv.url + '/api/browser-handoff', { method: 'POST' })).status, 403);
    session.connected = true;
    assert.equal((await fetch(srv.url + '/api/browser-handoff', { method: 'POST', headers })).status, 403);
    session.connected = false;
    const { code } = await fetch(srv.url + '/api/browser-handoff', { method: 'POST', headers }).then((r) => r.json());
    assert.match(code, /^[0-9a-f]{48}$/);
    assert.equal(code.includes(session.token), false);
    const redeem = () => fetch(srv.url + '/api/browser-handoff/' + code, { method: 'POST' });
    assert.equal((await (await redeem()).json()).playerId, session.playerId);
    assert.equal((await redeem()).status, 410);
    fs.writeFileSync(file, JSON.stringify({ ...cfg, random: 'https://second.trycloudflare.com' }));
    assert.equal((await fetch(srv.url + '/api/browser-entry?random=https://wrong.test').then((r) => r.json())).random, 'https://second.trycloudflare.com');
    // An expired code never becomes a long-lived second passport.
    let now = 0, body, status;
    const entry = createBrowserEntry({ file, publicDir: path.resolve('public'), registry: srv.registry, now: () => now });
    const res = { writeHead(s) { status = s; }, end(b) { body = JSON.parse(b); } };
    await entry.handle({ method: 'POST', headers: { host: new URL(srv.url).host, authorization: headers.Authorization } }, res, '/api/browser-handoff');
    now = 120001;
    await entry.handle({ method: 'POST', headers: { host: new URL(srv.url).host } }, res, '/api/browser-handoff/' + body.code);
    assert.equal(status, 410);
  } finally { await srv?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
