import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { browserRelay, relayWorkerUrl } from '../../public/js/browserTransport.js';

test('stable worker caches only successful complete hashed art, serves audio ranges, and never trusts a relay from a URL', async () => {
  const listeners = {}, stored = new Map(), calls = [];
  const origin = 'https://entry.example.test', remote = 'https://trusted.trycloudflare.com';
  let denyCache = false, route = 'random';
  const cache = {
    async match(key) { return stored.get(new URL(key, origin).href)?.clone(); },
    async put(key, value) { if (denyCache) throw new Error('quota'); stored.set(new URL(key, origin).href, value.clone()); },
  };
  const ctx = { self: { location: { origin }, addEventListener: (k, fn) => { listeners[k] = fn; },
    skipWaiting: async () => {}, clients: { claim: async () => {}, get: async () => ({ url: origin + '/?sp-relay=' + route + '&url=https://evil.test' }) } },
  caches: { open: async () => cache }, URL, Headers, Request, Response, setTimeout: (fn) => { fn(); },
  fetch: async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (url === '/api/browser-entry') return Response.json({ v: 1, origin, random: remote });
    if (url.includes('error.png')) return new Response('missing', { status: 404 });
    if (url.includes('html.png')) return new Response('<html>', { headers: { 'Content-Type': 'text/html' } });
    if (url.includes('empty.png')) return new Response('');
    if (url.includes('full-audio')) return new Response('abcdef', { status: 206, headers: { 'Content-Type': 'audio/mpeg', 'Content-Range': 'bytes 0-5/6' } });
    if (url.includes('partial-audio')) return new Response('abc', { status: 206, headers: { 'Content-Type': 'audio/mpeg', 'Content-Range': 'bytes 0-2/6' } });
    return new Response('abcdef', { headers: { 'Content-Type': 'image/png' } });
  } };
  vm.runInNewContext(fs.readFileSync('public/bridge-sw.js', 'utf8'), ctx);
  async function request(path, init = {}) {
    let result;
    const jobs = [];
    listeners.fetch({ request: new Request(new URL(path, origin), init), clientId: 'page',
      respondWith(p) { result = p; }, waitUntil(p) { jobs.push(p); } });
    const response = result ? await result : null;
    await Promise.all(jobs); return response;
  }
  const file = '/assets/~0123456789abcdef/a.png';
  assert.equal(await (await request(file)).text(), 'abcdef');
  assert.equal(await (await cache.match(file)).text(), 'abcdef');
  const before = calls.length;
  assert.equal(await (await request(file)).text(), 'abcdef');
  assert.equal(calls.length, before);
  const range = await request(file, { headers: { Range: 'bytes=1-3' } });
  assert.equal(range.status, 206); assert.equal(await range.text(), 'bcd');
  assert.equal(range.headers.get('content-range'), 'bytes 1-3/6');
  const suffix = await request(file, { headers: { Range: 'bytes=-2' } });
  assert.equal(await suffix.text(), 'ef');
  assert.equal((await request(file, { headers: { Range: 'bytes=9-10' } })).status, 416);
  for (const name of ['html', 'error', 'empty']) {
    const path = `/assets/~0123456789abcdef/${name}.png`;
    await request(path); assert.equal(await cache.match(path), undefined);
  }
  const audio = '/media/~0123456789abcdef/full-audio';
  await request(audio, { headers: { Range: 'bytes=0-' } });
  assert.equal((await cache.match(audio)).status, 200);
  assert.equal(await (await request(audio, { headers: { Range: 'bytes=3-' } })).text(), 'def');
  const partial = '/media/~0123456789abcdef/partial-audio';
  await request(partial, { headers: { Range: 'bytes=0-2' } });
  assert.equal(await cache.match(partial), undefined);
  denyCache = true;
  assert.equal(await (await request('/assets/~0123456789abcdef/quota.png')).text(), 'abcdef');
  await request('/api/profile', { method: 'PUT', headers: { Authorization: 'Bearer private', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(calls.at(-1).url, remote + '/api/profile');
  assert.equal(calls.at(-1).opts.headers.get('authorization'), 'Bearer private');
  assert.equal(calls.at(-1).opts.credentials, 'omit', 'cross-origin relays do not receive browser cookies');
  route = 'fixed';
  await request('/healthz');
  assert.equal(calls.at(-1).opts.credentials, 'same-origin', 'the stable entry retains the tunnel visitor cookie');
  assert.equal(calls.some((c) => c.url.includes('evil.test')), false);
  assert.equal(await request('https://other.test/assets/~0123456789abcdef/a.png'), null);
});

test('worker URLs preserve the page’s transport while normal and Node callers keep ordinary URLs', () => {
  assert.equal(browserRelay(), null);
  assert.equal(relayWorkerUrl('https://entry.test/js/battle/simWorker.js').href, 'https://entry.test/js/battle/simWorker.js');
  assert.equal(browserRelay({ querySelector: () => ({ content: 'https://trusted.trycloudflare.com' }) }), 'https://trusted.trycloudflare.com');
});
