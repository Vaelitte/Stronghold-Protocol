import { createStore, store } from './store.js';
import { identity } from './net.js';
import { capturePassport, flushProfile, profileState, restorePassport } from './profileSync.js';
import { rememberedDirectory } from './directoryHandle.js';
import { readDirectoryProfile, writeDirectoryProfile, writeDirectoryAsset, directoryAssetKey } from './directoryFiles.js';
import { createAssetImport } from './assetPack.js';
import { contentTypeFor, registerImportedAssetWorker } from './assetCache.js';

export const directoryState = createStore({ status: 'off', name: '', at: null, error: null, importing: null });
let root = null, boundToken = null, timer = null, saving = null, changed = 0, written = 0;
let importer = null;
export const directorySupported = () => globalThis.isSecureContext && typeof globalThis.showDirectoryPicker === 'function';
function readyDirectoryWorker() {
  const sw = navigator.serviceWorker;
  if (!sw) return Promise.reject(new Error('Asset worker unavailable'));
  return new Promise((resolve, reject) => {
    const finish = error => { clearTimeout(timeout); sw.removeEventListener('controllerchange', check); error ? reject(error) : resolve(); };
    const check = () => { if (sw.controller && new URL(sw.controller.scriptURL).pathname === '/local-sync-sw.js') finish(null); };
    const timeout = setTimeout(() => finish(new Error('Asset worker unavailable')), 15000);
    sw.addEventListener('controllerchange', check);
    if (sw.controller && new URL(sw.controller.scriptURL).pathname === '/local-sync-sw.js') { check(); return; }
    void registerImportedAssetWorker().then(ok => { if (ok) check(); else finish(new Error('Asset worker unavailable')); });
  });
}
async function workerMessage(t, extra = {}) {
  const controller = navigator.serviceWorker?.controller;
  if (!controller || new URL(controller.scriptURL).pathname !== '/local-sync-sw.js') return;
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel(), timeout = setTimeout(() => { channel.port1.close(); reject(new Error('Worker timeout')); }, 15000);
    channel.port1.onmessage = e => { clearTimeout(timeout); channel.port1.close(); e.data.ok ? resolve(e.data) : reject(new Error('Asset writes failed')); };
    controller.postMessage({ t, ...extra }, [channel.port2]);
  });
}
function failed(e) { directoryState.set({ status: 'error', error: e.code || 'directory-error' }); }
function schedule() {
  if (!root) return;
  changed++; clearTimeout(timer);
  timer = setTimeout(() => { void saveLocal().catch(failed); }, 700);
}
async function saveLocal() {
  if (saving) { await saving; if (written < changed) return saveLocal(); return; }
  if (!root) return;
  const snapshot = capturePassport();
  if (!snapshot) return;
  if (boundToken && boundToken !== snapshot.token) throw new Error('Different identity');
  const handle = root, seq = changed;
  boundToken = snapshot.token;
  directoryState.set({ status: 'saving', error: null });
  saving = writeDirectoryProfile(handle, snapshot).then(() => {
    written = seq; directoryState.set({ status: 'saved', at: Date.now(), error: null });
  }).finally(() => { saving = null; });
  await saving;
  if (written < changed) return saveLocal();
}
/** Read before installing server sync, so an unsent local edit is never overwritten at boot. */
export async function restoreRememberedDirectory() {
  if (!directorySupported()) return;
  try {
    const handle = await rememberedDirectory();
    if (!handle) return;
    if (await handle.queryPermission({ mode: 'readwrite' }) !== 'granted') {
      directoryState.set({ status: 'permission', name: handle.name }); return;
    }
    await attach(handle, false);
  } catch (e) { failed(e); }
}
async function attach(handle, reload) {
  // Read/validate first. A corrupt, active or conflicting profile must never be overwritten.
  const saved = await readDirectoryProfile(handle);
  if (saved) await restorePassport(saved, { local: true });
  await rememberedDirectory(handle);
  await readyDirectoryWorker();
  await workerMessage('directory.changed', { handle });
  root = handle; boundToken = saved?.token || identity.getToken();
  directoryState.set({ status: 'ready', name: handle.name, error: null });
  if (saved && reload) { location.reload(); return; }
  schedule();
}
export async function chooseDirectory() {
  if (store.get().room) throw new Error('Leave room first');
  // Picker must be called directly from the click's user gesture, before any await.
  const handle = await globalThis.showDirectoryPicker({ mode: 'readwrite', id: 'stronghold-data' });
  if (saving) await saving;
  await flushProfile();
  try { await attach(handle, true); } catch (e) { failed(e); throw e; }
}
export async function syncDirectory() {
  if (!root) throw new Error('Choose directory first');
  let serverError = null;
  try { await flushProfile(); } catch (e) { serverError = e; }
  changed++; await saveLocal();
  if (!capturePassport()) throw new Error('Log in first');
  await readyDirectoryWorker();
  await workerMessage('directory.flush');
  if (serverError) directoryState.set({ status: 'local-only', error: null });
}
export async function disconnectDirectory() {
  if (importer) throw new Error('Sync in progress');
  if (saving) await saving.catch(() => {});
  root = null; boundToken = null; clearTimeout(timer);
  await rememberedDirectory(null).catch(() => {});
  await workerMessage('directory.changed', { handle: null }).catch(() => {});
  directoryState.set({ status: 'off', name: '', at: null, error: null });
}
export async function importDirectoryAssets(file) {
  if (!root || importer) throw new Error('Choose directory first');
  const handle = root;
  importer = createAssetImport({ storeAssets: async (urls, bytes) => {
    const seen = new Set();
    for (const url of urls) {
      const key = directoryAssetKey(url);
      if (!key || seen.has(key)) continue;
      seen.add(key); await writeDirectoryAsset(handle, url, bytes, contentTypeFor(url));
    }
  } });
  const unsubscribe = importer.subscribe(s => directoryState.set({ importing: s }));
  try {
    await importer.start({ type: 'zip', data: file });
    const result = importer.get();
    if (result.phase === 'error' || result.failed || result.rejected || !result.accepted) throw new Error('Asset import incomplete');
  } finally { unsubscribe(); importer = null; }
}
export function installDirectorySync() {
  window.addEventListener('sp:pref', schedule);
  profileState.subscribe(s => { if (s.status === 'saved') schedule(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { clearTimeout(timer); void saveLocal().catch(failed); } });
  window.addEventListener('beforeunload', e => {
    if (root && (saving || written < changed || importer)) { e.preventDefault(); e.returnValue = ''; }
  });
}
