import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { directoryAssetKey } from '../../public/js/directoryFiles.js';
const code = fs.readFileSync(new URL('../../public/local-sync-sw.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '');
function worker(network, { local = null, writeError = false } = {}) {
  const callbacks = {}, stored = [], requests = [];
  const self = { location: { origin: 'https://game.test' }, addEventListener(t, fn) { callbacks[t] = fn; } };
  vm.runInNewContext(code, { self, URL, Promise, Number, Set, Response, directoryAssetKey,
    rememberedDirectory: async () => ({}), readDirectoryAsset: async () => local,
    writeDirectoryAsset: async (...args) => { if (writeError) throw new Error('disk full'); stored.push(args); },
    assetResponse: blob => new Response(blob), caches: { open: async () => ({ match: async () => null }) },
    fetch: async req => { requests.push(req.url); return network.clone(); },
  });
  return { stored, requests,
    async get(url = 'https://game.test/assets/~0123456789abcdef/test.png', method = 'GET') {
      const jobs = []; let response;
      callbacks.fetch({ request: new Request(url, { method }), respondWith(job) { response = job; }, waitUntil(job) { jobs.push(job); } });
      const result = await response;
      await Promise.all(jobs); return result;
    },
    async flush() { let result; const jobs = []; callbacks.message({ data: { t: 'directory.flush' }, ports: [{ postMessage(value) { result = value; } }], waitUntil(job) { jobs.push(job); } }); await Promise.all(jobs); return result; },
  };
}
test('directory worker excludes code, API, foreign origins and non-GET requests', async () => {
  const w = worker(new Response('x'));
  for (const [url, method] of [['https://game.test/js/main.js', 'GET'], ['https://game.test/api/profile', 'GET'],
    ['https://other.test/assets/~0123456789abcdef/test.png', 'GET'], ['https://game.test/assets/~0123456789abcdef/test.png', 'POST']]) assert.equal(await w.get(url, method), undefined);
  assert.equal(w.requests.length, 0); assert.equal(w.stored.length, 0);
});
test('directory hits avoid the tunnel; complete downloads are saved but failures/HTML/partial/empty responses are not', async () => {
  const disk = worker(new Response('network'), { local: new Blob(['local']) });
  assert.equal(await (await disk.get()).text(), 'local'); assert.equal(disk.requests.length, 0);
  const good = worker(new Response('png', { headers: { 'Content-Type': 'image/png' } }));
  assert.equal(await (await good.get()).text(), 'png'); assert.equal(good.stored.length, 1);
  const whole = worker(new Response('png', { status: 206, headers: { 'Content-Range': 'bytes 0-2/3', 'Content-Type': 'image/png' } }));
  await whole.get(); assert.equal(whole.stored.length, 1);
  for (const response of [new Response('missing', { status: 404 }), new Response('error', { status: 500 }), new Response(''),
    new Response('<html>', { headers: { 'Content-Type': 'text/html' } }),
    new Response('png', { status: 206, headers: { 'Content-Range': 'bytes 0-2/10' } }),
    new Response('truncated', { status: 206, headers: { 'Content-Range': 'bytes 0-2/3' } })]) {
    const w = worker(response); await w.get(); assert.equal(w.stored.length, 0);
  }
});
test('disk failure does not stop network play, and manual flush reports unsuccessful writes', async () => {
  const w = worker(new Response('png'), { writeError: true });
  assert.equal(await (await w.get()).text(), 'png'); assert.equal((await w.flush()).ok, false);
});
