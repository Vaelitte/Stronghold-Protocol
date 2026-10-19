// Stable browser storage; HTTP and WebSocket traffic can use an independently changing tunnel.
// (i18n-ignore-file: the worker's system fallback is bilingual.)
// A classic worker keeps the browser support of sw.js. Only the host's /api/browser-entry chooses a relay.
const ASSET_CACHE = 'sp-imported-assets-v1';
const ASSET_PATH = /^\/(?:assets|fonts|media)\/~[0-9a-f]{16}\//;
const AUTO_INDEX = '/sp-auto-index.json';
let configuration, configTime = 0, loading;
let indexJob;
const pendingPaths = new Set();

self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('message', (event) => { if (event.data?.t === 'activate') void self.skipWaiting(); });

async function config(force = false) {
  if (!force && configuration && Date.now() - configTime < 5000) return configuration;
  if (!loading) loading = (async () => {
    const r = await fetch('/api/browser-entry', { cache: 'no-store' });
    if (!r.ok) throw new Error('Browser entry unavailable');
    const p = await r.json();
    if (p.v !== 1 || p.origin !== self.location.origin) throw new Error('Wrong browser entry');
    if (p.random) {
      const u = new URL(p.random);
      if (u.origin !== p.random || u.username || u.password) throw new Error('Invalid relay');
    }
    configuration = p; configTime = Date.now(); return p;
  })().finally(() => { loading = null; });
  return loading;
}
function plainHeaders(response) {
  const headers = new Headers(response.headers);
  // Fetch has already decoded compression; the new basic Response must keep relative module URLs on this origin.
  for (const key of ['content-encoding', 'content-length', 'transfer-encoding', 'access-control-allow-origin']) headers.delete(key);
  return headers;
}
async function network(request, remote, navigation = false) {
  const url = new URL(request.url), headers = new Headers();
  for (const key of ['accept', 'accept-language', 'content-type', 'authorization', 'range']) {
    if (request.headers.has(key)) headers.set(key, request.headers.get(key));
  }
  if (navigation) { headers.set('X-SP-Bridge', '1'); headers.set('Accept', 'text/html'); }
  const target = new URL(url.pathname + url.search, remote);
  // Separate CORS-enabled static responses from the old direct site's HTTP cache. This constant version is reused;
  // it is not a timestamp/cache buster. Old no-CORS responses otherwise fail when migrating an existing browser.
  if (remote !== self.location.origin && !url.pathname.startsWith('/api/') && ['GET', 'HEAD'].includes(request.method)) target.searchParams.set('sp-cors', '1');
  const r = await fetch(target.href, {
    method: request.method, headers, credentials: remote === self.location.origin ? 'same-origin' : 'omit', mode: 'cors', redirect: 'error', cache: request.cache,
    ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: await request.clone().arrayBuffer() }),
  });
  const out = plainHeaders(r);
  if (navigation && r.ok && /text\/html/.test(out.get('content-type') || '')) {
    // A meta value, not inline executable code. The exact target comes from the server-owned configuration.
    const body = (await r.text()).replace('<head>', `<head><meta name="sp-relay-origin" content="${remote}">`);
    return new Response(body, { status: r.status, headers: out });
  }
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: out });
}
async function relay(event, url) {
  const p = await config(event.request.mode === 'navigate');
  let page = url;
  if (event.request.mode !== 'navigate' && event.clientId) {
    const client = await self.clients.get(event.clientId);
    if (client) page = new URL(client.url);
  }
  return page.searchParams.get('sp-relay') === 'random' && p.random ? p.random : p.origin;
}
async function cachedRange(hit, range) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) return null;
  const bytes = await hit.arrayBuffer(), length = bytes.byteLength;
  const start = match[1] ? Number(match[1]) : Math.max(0, length - Number(match[2]));
  const end = match[1] ? (match[2] ? Math.min(length - 1, Number(match[2])) : length - 1) : length - 1;
  const headers = new Headers(hit.headers);
  headers.set('Accept-Ranges', 'bytes');
  if (start >= length || end < start) {
    headers.set('Content-Range', `bytes */${length}`);
    return new Response(null, { status: 416, headers });
  }
  headers.set('Content-Range', `bytes ${start}-${end}/${length}`);
  headers.set('Content-Length', String(end - start + 1));
  return new Response(bytes.slice(start, end + 1), { status: 206, headers });
}
function rememberPath(path) {
  pendingPaths.add(path);
  if (!indexJob) indexJob = (async () => {
    // Batch the index independently of local ZIP imports. Never rewrite a 30,000-entry index per tiny texture.
    while (pendingPaths.size) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const batch = [...pendingPaths]; pendingPaths.clear();
      const cache = await caches.open(ASSET_CACHE);
      let list = [];
      try { list = await (await cache.match(AUTO_INDEX))?.json() || []; } catch { /* new index */ }
      const paths = new Set(Array.isArray(list) ? list : []);
      batch.forEach((value) => paths.add(value));
      await cache.put(AUTO_INDEX, new Response(JSON.stringify([...paths]), { headers: { 'Content-Type': 'application/json' } }));
    }
  })().finally(() => { indexJob = null; });
  return indexJob;
}
self.addEventListener('fetch', (event) => {
  const request = event.request, url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Entry discovery and worker updates must always reach the stable server directly, even with a dead old tunnel.
  if (url.pathname.startsWith('/api/browser-') || ['/bridge-sw.js', '/sw.js', '/browser-entry.html', '/js/browserEntry.js'].includes(url.pathname)) return;
  event.respondWith((async () => {
    const art = request.method === 'GET' && ASSET_PATH.test(url.pathname);
    let cache;
    if (art) {
      try {
        cache = await caches.open(ASSET_CACHE);
        const hit = await cache.match(url.origin + url.pathname);
        if (hit) {
          if (!request.headers.has('range')) return hit;
          const ranged = await cachedRange(hit, request.headers.get('range'));
          if (ranged) return ranged;
        }
      } catch { /* Storage is optional; a denied/quota-limited cache never prevents playing. */ }
    }
    const remote = await relay(event, url);
    const response = await network(request, remote, request.mode === 'navigate');
    const fullRange = /^bytes 0-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
    const completeAudio = response.status === 206 && fullRange && Number(fullRange[1]) + 1 === Number(fullRange[2]);
    if (cache && (response.status === 200 || completeAudio)
      && !/text\/html/.test(response.headers.get('content-type') || '')) {
      const copy = response.clone();
      event.waitUntil((async () => {
        const bytes = await copy.arrayBuffer();
        if (!bytes.byteLength || completeAudio && bytes.byteLength !== Number(fullRange[2])) return;
        const headers = new Headers(copy.headers);
        headers.delete('content-range'); headers.set('Content-Length', String(bytes.byteLength));
        await cache.put(url.origin + url.pathname, new Response(bytes, { headers }));
        await rememberPath(url.pathname);
      })().catch(() => {}));
    }
    return response;
  })().catch(() => new Response('连接暂时不可用，请刷新重试。 · Connection unavailable. Reload to retry.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })));
});
