import { rememberedDirectory } from './js/directoryHandle.js';
import { directoryAssetKey, readDirectoryAsset, writeDirectoryAsset, assetResponse } from './js/directoryFiles.js';

let rootJob = null;
const writes = new Set();
let failedWrites = 0;
const root = () => rootJob ||= rememberedDirectory().catch(() => null);
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => {
  if (event.data?.t === 'directory.changed') { rootJob = Promise.resolve(event.data.handle || null); failedWrites = 0; event.ports[0]?.postMessage({ ok: true }); }
  if (event.data?.t === 'directory.flush') event.waitUntil(Promise.allSettled([...writes]).then(() => {
    event.ports[0]?.postMessage({ ok: failedWrites === 0 }); failedWrites = 0;
  }));
});
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || !directoryAssetKey(url.pathname)) return;
  event.respondWith((async () => {
    const handle = await root();
    if (handle) {
      try { const body = await readDirectoryAsset(handle, url.pathname); if (body) return assetResponse(body, request.headers.get('range')); } catch { /* disk/permission failure: use network */ }
    }
    let hit;
    try { hit = await (await caches.open('sp-imported-assets-v1')).match(url.origin + url.pathname); } catch { /* storage unavailable */ }
    if (hit) {
      const body = await hit.blob();
      if (handle) keep(event, writeDirectoryAsset(handle, url.pathname, body, body.type));
      return assetResponse(body, request.headers.get('range'));
    }
    const response = await fetch(request);
    const range = /^bytes 0-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
    const complete = response.status === 200 || (response.status === 206 && range && Number(range[1]) + 1 === Number(range[2]));
    if (handle && complete && !/text\/html/i.test(response.headers.get('content-type') || '')) {
      keep(event, response.clone().blob().then(body => {
        if (body.size && (response.status !== 206 || body.size === Number(range[2]))) return writeDirectoryAsset(handle, url.pathname, body, body.type);
      }));
    }
    return response;
  })());
});
function keep(event, job) {
  const safe = job.catch(() => { failedWrites++; }).finally(() => writes.delete(safe));
  writes.add(safe); event.waitUntil(safe);
}
