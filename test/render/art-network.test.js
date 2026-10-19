import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAssetNetwork, fetchArt } from '../../public/js/assetNetwork.js';
import { createAssets, IMAGE_FAILURE_TTL_MS } from '../../public/js/assets.js';

test('art transfers bound concurrency, retry transient failures, and release failed slots', async () => {
  const network = createAssetNetwork({ concurrency: 2, retryDelays: [0], wait: async () => {} });
  let active = 0, peak = 0, calls = 0;
  const jobs = Array.from({ length: 6 }, (_, id) => network.run(async () => {
    active++; peak = Math.max(peak, active); calls++;
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
    if (id === 0) throw Object.assign(new Error('missing'), { status: 404 });
    return id;
  }));
  const results = await Promise.allSettled(jobs);
  assert.equal(peak, 2);
  assert.equal(calls, 6, 'a real 404 is not retried');
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 5);
  let tries = 0;
  assert.equal(await network.run(async () => { if (++tries === 1) throw Object.assign(new Error('busy'), { status: 503 }); return 'recovered'; }), 'recovered');
  assert.equal(tries, 2);
});

test('an art deadline aborts the body and frees the queue for the next file', async () => {
  const network = createAssetNetwork({ concurrency: 1, timeout: 10, retryDelays: [] });
  let aborted = false;
  const blocked = network.run(signal => new Promise(() => signal.addEventListener('abort', () => { aborted = true; })));
  const next = network.run(async () => 'next');
  await assert.rejects(blocked, /timed out/);
  assert.equal(aborted, true);
  assert.equal(await next, 'next');
});

test('images share one bounded retry and expired failures can recover without explicit retry', async () => {
  let calls = 0, healthy = false, now = 0;
  const assets = createAssets({ manifest: {}, imageNow: () => now,
    imageNetwork: createAssetNetwork({ retryDelays: [0, 0], wait: async () => {} }),
    loadImage: async url => { calls++; if (!healthy) throw new Error('connection reset'); return { src: url }; },
  });
  const first = assets.image('/map.webp');
  assert.equal(first, assets.image('/map.webp'), 'concurrent consumers join one transfer');
  assert.equal(await first, null);
  assert.equal(calls, 3, 'bounded retries');
  healthy = true;
  assert.equal(await assets.image('/map.webp'), null, 'do not hammer a failed URL');
  now = IMAGE_FAILURE_TTL_MS;
  assert.equal((await assets.image('/map.webp')).src, '/map.webp');
  assert.equal(calls, 4);
});

test('an optional manifest failure is not kept forever', async () => {
  let ready = false;
  const assets = createAssets({ manifest: {}, fetch: async () => ready
    ? { ok: true, json: async () => ({ groups: { map: {} } }) }
    : { ok: false, status: 404 },
  });
  assert.equal(await assets.local(), null);
  ready = true;
  assert.deepEqual(await assets.local(), { groups: { map: {} } });
});

test('hashed art requests use the browser cache and read the body under the queue deadline', async () => {
  let options;
  const result = await fetchArt('/assets/~0123456789abcdef/map.json', { fetch: async (_url, o) => {
    options = o; return { ok: true, json: async () => ({ map: true }) };
  } });
  assert.deepEqual(result, { map: true });
  assert.equal(options.cache, 'default');
  assert.ok(options.signal instanceof AbortSignal);
});

test('a connection reset while reading JSON is retried instead of treated as malformed data', async () => {
  let calls = 0;
  const result = await fetchArt('/scene.json', { fetch: async () => ({ ok: true, json: async () => {
    if (++calls === 1) throw new TypeError('connection reset while reading the body');
    return { scene: 'recovered' };
  } }) });
  assert.equal(calls, 2);
  assert.deepEqual(result, { scene: 'recovered' });
});
