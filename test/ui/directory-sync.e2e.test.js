import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, startRealServer, hasChrome } from '../e2e/client.mjs';

// OPFS supplies genuine structured-clonable FileSystemDirectoryHandles in headless Chrome.
// The OS directory picker itself requires the user's click and is not bypassed by this test.
test('direct game boots; a remembered directory restores pending profile edits and worker art/ranges after reload', {
  skip: !(process.env.SP_E2E === '1' && hasChrome()), timeout: 120000,
}, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sp-directory-e2e-'));
  const previous = process.env.SP_PROFILE_DIR;
  process.env.SP_PROFILE_DIR = path.join(dir, 'profiles');
  let srv, client, target;
  try {
    srv = await startRealServer();
    const P = (await import('puppeteer-core')).default;
    client = new Client(P, srv.base, 'directory-player', { prefix: 'directory-sync', w: 1280, h: 800 });
    await client.open();
    await client.page.waitForFunction(() => !!globalThis.__SP__);
    assert.equal(await client.page.$('#status'), null, 'no intermediate bridge gate');
    await client.page.evaluate(() => {
      globalThis.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('portable-test', { create: true });
    });
    await client.click('.player-profile button', '玩家档案与通行证');
    await client.click('.local-directory-sync button', '选择／重新连接目录');
    await client.page.waitForFunction(() => document.querySelector('[data-testid="directory-status"]')?.textContent.includes('目录已连接'));
    await client.page.keyboard.press('Escape');
    await client.enter('目录博士');
    await client.page.waitForFunction(async () => (await import('/js/localDirectorySync.js')).directoryState.get().status === 'saved');
    const id = await client.page.evaluate(() => globalThis.__SP__.store.get().me.playerId);
    const local = await client.page.evaluate(async () => {
      const profile = await import('/js/profileSync.js'), local = await import('/js/localDirectorySync.js');
      const native = globalThis.fetch;
      globalThis.fetch = (url, opts) => url === '/api/profile' && opts?.method === 'PUT' ? Promise.reject(new Error('test offline')) : native(url, opts);
      (await import('/js/ui/loadoutSync.js')).setDiyPicks({ chess_char_6_diy1_a: { charId: 'char_003_kalts', skillIndex: 0, uniEquipId: null } });
      await local.syncDirectory();
      const handle = await (await import('/js/directoryHandle.js')).rememberedDirectory();
      const saved = await (await import('/js/directoryFiles.js')).readDirectoryProfile(handle);
      globalThis.fetch = native;
      return { status: local.directoryState.get().status, pending: saved.pending, id: saved.playerId, revision: profile.capturePassport().revision };
    });
    assert.equal(local.status, 'local-only'); assert.equal(local.pending, true); assert.equal(local.id, id);
    await client.page.reload({ waitUntil: 'networkidle0' });
    await client.page.waitForFunction(async id => globalThis.__SP__?.store.get().me.playerId === id
      && (await import('/js/localDirectorySync.js')).directoryState.get().status === 'saved', { timeout: 25000 }, id);
    assert.equal(await client.page.evaluate(async () => (await import('/js/ui/loadoutSync.js')).loadoutStore.get().diy.chess_char_6_diy1_a.charId), 'char_003_kalts');
    const art = await client.page.evaluate(async () => {
      const handle = await (await import('/js/directoryHandle.js')).rememberedDirectory();
      const files = await import('/js/directoryFiles.js');
      // A content-keyed file deliberately absent from the server proves both worker disk access and no network fallback.
      const path = '/assets/~0123456789abcdef/audio/directory-test.mp3';
      await files.writeDirectoryAsset(handle, path, new Blob(['abcdef']), 'audio/mpeg');
      const response = await fetch('/media/~0123456789abcdef/directory-test', { headers: { Range: 'bytes=1-3' } });
      const body = await response.text();
      const manifest = await fetch('/data/assets.json').then(r => r.json());
      const collect = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(collect) : [];
      const png = collect(manifest).find(v => v.startsWith('/assets/~') && v.endsWith('.png'));
      const downloaded = await fetch(png); await downloaded.arrayBuffer();
      await (await import('/js/localDirectorySync.js')).syncDirectory();
      const stored = await files.readDirectoryAsset(handle, png);
      return { status: response.status, body, stored: stored?.size || 0, type: stored?.type, png };
    });
    assert.equal(art.status, 206); assert.equal(art.body, 'bcd'); assert.ok(art.stored > 0); assert.equal(art.type, 'image/png');
    await client.page.reload({ waitUntil: 'networkidle0' });
    const again = await client.page.evaluate(async path => {
      await navigator.serviceWorker.ready;
      const response = await fetch(path);
      return { status: response.status, text: await response.text() };
    }, '/media/~0123456789abcdef/directory-test');
    assert.deepEqual(again, { status: 200, text: 'abcdef' });
    await client.click('[data-testid="settings-btn"]');
    await client.page.waitForSelector('.player-profile > button');
    await client.page.$eval('.player-profile > button', e => e.scrollIntoView({ block: 'center' }));
    await client.click('.player-profile button', '玩家档案与通行证');
    await new Promise(resolve => setTimeout(resolve, 400)); // let the nested modal's fade/transform finish
    await client.shot('directory-settings');
    assert.deepEqual(client.problems, []);
    const portable = await client.page.evaluate(async () => {
      await (await import('/js/localDirectorySync.js')).syncDirectory();
      return (await import('/js/directoryFiles.js')).readDirectoryProfile(await (await import('/js/directoryHandle.js')).rememberedDirectory());
    });
    await client.close(); client = null;
    target = new Client(P, srv.base.replace('127.0.0.1', 'localhost'), 'directory-new-origin', { prefix: 'directory-sync', w: 1280, h: 800 });
    await target.open();
    await target.page.evaluate(async snapshot => {
      const handle = await (await navigator.storage.getDirectory()).getDirectoryHandle('portable-test', { create: true });
      const files = await import('/js/directoryFiles.js');
      // Seed an equivalent portable folder at the new origin; OPFS itself is origin-private.
      await files.writeDirectoryProfile(handle, snapshot);
      await files.writeDirectoryAsset(handle, '/assets/~0123456789abcdef/audio/directory-test.mp3', new Blob(['abcdef']), 'audio/mpeg');
      globalThis.showDirectoryPicker = async () => handle;
    }, portable);
    await target.click('.player-profile button', '玩家档案与通行证');
    await target.click('.local-directory-sync button', '选择／重新连接目录');
    await target.page.waitForFunction(id => globalThis.__SP__?.store.get().me.playerId === id, { timeout: 25000 }, id);
    const restored = await target.page.evaluate(async () => ({
      char: (await import('/js/ui/loadoutSync.js')).loadoutStore.get().diy.chess_char_6_diy1_a.charId,
      audio: await fetch('/media/~0123456789abcdef/directory-test').then(r => r.text()),
    }));
    assert.deepEqual(restored, { char: 'char_003_kalts', audio: 'abcdef' });
    assert.deepEqual(target.problems, []);
  } finally {
    await client?.close(); await target?.close(); await srv?.stop();
    if (previous === undefined) delete process.env.SP_PROFILE_DIR; else process.env.SP_PROFILE_DIR = previous;
    assert.ok(path.resolve(dir).startsWith(path.resolve(tmpdir()) + path.sep + 'sp-directory-e2e-'));
    rmSync(dir, { recursive: true, force: true });
  }
});
