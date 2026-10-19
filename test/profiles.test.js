import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProfileStore } from '../server/profiles.js';
import { SessionRegistry } from '../server/net.js';
import { startServer } from '../server/index.js';

test('passport keeps its ID and private data after expiry and a full registry restart', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sp-profile-'));
  assert.ok(path.resolve(dir).startsWith(path.resolve(tmpdir()) + path.sep + 'sp-profile-'));
  try {
    const profiles = new ProfileStore(dir);
    let now = 100;
    const a = new SessionRegistry({ profiles, now: () => now, reconnectWindowMs: 1000 });
    const s = a.create('博士');
    profiles.ensure(s);
    const prefs = { loadout: { v: 1, entries: { chess_test: { skill: 1 } } }, ownership: { notOwned: ['x'] },
      diy: { picks: { diy1: { charId: 'char_test' } } }, stats: { v: 2, records: [{ id: 'record-1' }] } };
    profiles.update(s, prefs, 0);
    let expired = null;
    a.onRestoreExpired = (old) => { expired = old; };
    now = 10000;
    assert.equal(a.byToken(s.token).playerId, s.playerId);
    assert.equal(expired, s, 'old room/session expiry is delivered before restoring its permanent ID');
    const b = new SessionRegistry({ profiles: new ProfileStore(dir) });
    assert.equal(b.byToken(s.token).playerId, s.playerId);
    assert.deepEqual(profiles.read(s.token).prefs, prefs);
    assert.equal(b.byToken('0'.repeat(32)), null);
    const filename = readdirSync(dir)[0];
    assert.equal(filename.includes(s.token), false);
    assert.equal(readFileSync(path.join(dir, filename), 'utf8').includes(s.token), false);
    assert.equal(profiles.update(s, { diy: {} }, 0), null, 'stale writers cannot erase a newer profile');
    assert.throws(() => profiles.update(s, { arbitrary: 'x' }, 1));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('HTTP profiles require the secret, reject stale writes, and survive a server restart', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sp-profile-http-'));
  assert.ok(path.resolve(dir).startsWith(path.resolve(tmpdir()) + path.sep + 'sp-profile-http-'));
  let srv;
  try {
    const options = { port: 0, host: '127.0.0.1', quiet: true, assetIndex: false, studio: false, profiles: new ProfileStore(dir) };
    srv = await startServer(options);
    const session = srv.registry.create('联机测试');
    const headers = { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' };
    const route = () => `${srv.url}/api/profile`;
    assert.equal((await fetch(route())).status, 401);
    let p = await fetch(route(), { headers }).then((r) => r.json());
    assert.equal(p.playerId, session.playerId);
    const prefs = { stats: { v: 2, records: [] }, diy: { v: 1, picks: {} } };
    assert.equal((await fetch(route(), { method: 'PUT', headers, body: JSON.stringify({ revision: p.revision, prefs }) })).status, 200);
    assert.equal((await fetch(route(), { method: 'PUT', headers, body: JSON.stringify({ revision: p.revision, prefs: { stats: null } }) })).status, 409);
    await srv.close(); srv = await startServer(options);
    p = await fetch(route(), { headers }).then((r) => r.json());
    assert.equal(p.playerId, session.playerId);
    assert.deepEqual(p.prefs, prefs);
    assert.equal((await fetch(`${srv.url}/.profiles/anything.json`)).status, 404);
  } finally { await srv?.close(); rmSync(dir, { recursive: true, force: true }); }
});
