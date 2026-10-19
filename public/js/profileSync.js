import { net, identity } from './net.js';
import { createStore, loadPref, savePref } from './store.js';
import { loadoutStore } from './ui/loadoutSync.js';
import { parseStored, parseStoredOps } from './ui/loadoutModel.js';
import { parseStoredOwnership } from './ui/ownershipModel.js';
import { parseStoredDiy } from './ui/diyModel.js';
import { setSkins } from './ui/skins.js';
import { loadStats, mergeStats, saveStats } from './ui/stats.js';

const keys = ['loadout', 'ownership', 'diy', 'skins', 'stats'];
export const profileState = createStore({ status: 'idle', playerId: null });
let revision = null, token = null, applying = false, timer = null, saving = null;
const dirty = new Set();
async function api(secret, method = 'GET', body = null) {
  const res = await fetch('/api/profile', { method, cache: 'no-store', signal: AbortSignal.timeout(12000),
    headers: { Authorization: `Bearer ${secret}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!res.ok) throw Object.assign(new Error('Profile request failed'), { status: res.status });
  return res.json();
}
function apply(p) {
  applying = true;
  try {
    for (const k of keys) if (Object.hasOwn(p.prefs, k)) {
      if (k === 'stats') saveStats(mergeStats(loadStats(), p.prefs.stats));
      else savePref(k, p.prefs[k]);
    }
    loadoutStore.set({ entries: parseStored(loadPref('loadout', null)), ops: parseStoredOps(loadPref('loadout', null)),
      notOwned: parseStoredOwnership(loadPref('ownership', null)), diy: parseStoredDiy(loadPref('diy', null)) });
    setSkins(loadPref('skins', {}));
  } finally { applying = false; }
}
export async function flushProfile() {
  clearTimeout(timer);
  if (saving) { await saving; return flushProfile(); }
  if (!token || revision == null || !dirty.size) return;
  const selected = [...dirty];
  selected.forEach((k) => dirty.delete(k));
  const prefs = Object.fromEntries(selected.map((k) => [k, loadPref(k, null)]));
  const secret = token;
  profileState.set({ status: 'saving' });
  saving = api(secret, 'PUT', { prefs, revision }).then((p) => {
    revision = p.revision;
    profileState.set({ status: 'saved', playerId: p.playerId });
  }).catch((e) => {
    selected.forEach((k) => dirty.add(k));
    profileState.set({ status: e.status === 409 ? 'conflict' : 'error' });
    throw e;
  }).finally(() => { saving = null; });
  return saving;
}
async function load(secret) {
  profileState.set({ status: 'loading' });
  const p = await api(secret);
  token = secret; revision = p.revision;
  apply(p);
  keys.forEach((k) => dirty.add(k));
  profileState.set({ status: 'saved', playerId: p.playerId });
  await flushProfile();
  return p;
}
export async function installProfileSync() {
  try {
    const health = await fetch('/healthz', { cache: 'no-store', signal: AbortSignal.timeout(5000) }).then((r) => r.json());
    if (!health.profiles) return;
  } catch { return; }
  const saved = identity.getToken();
  if (saved) { try { await load(saved); } catch { profileState.set({ status: 'error' }); } }
  net.on('welcome', (m) => {
    if (m.token !== token) {
      token = null; revision = null;
      void load(m.token).catch(() => profileState.set({ status: 'error' }));
    }
  });
  window.addEventListener('sp:pref', (e) => {
    if (applying || !keys.includes(e.detail)) return;
    dirty.add(e.detail);
    clearTimeout(timer);
    timer = setTimeout(() => { void flushProfile().catch(() => {}); }, 500);
  });
  window.addEventListener('online', () => { void flushProfile().catch(() => {}); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) void flushProfile().catch(() => {}); });
}
export async function exportPassport() {
  await flushProfile();
  if (profileState.get().status !== 'saved' || !token) throw new Error('Profile unavailable');
  return { kind: 'stronghold-player-passport', v: 1, playerId: profileState.get().playerId,
    token, name: identity.loadName(), prefs: Object.fromEntries(keys.map((k) => [k, loadPref(k, null)])) };
}
export async function retryProfile() {
  if (revision == null) {
    const secret = identity.getToken();
    if (secret) return load(secret);
    return;
  }
  return flushProfile();
}
export async function importPassport(raw) {
  if (raw?.kind !== 'stronghold-player-passport' || raw.v !== 1 || !/^[0-9a-f]{32}$/.test(raw.token || '')
    || typeof raw.playerId !== 'string' || typeof raw.name !== 'string') throw new Error('Invalid passport');
  const p = await api(raw.token);
  if (p.playerId !== raw.playerId) throw new Error('Wrong player');
  if (p.connected && identity.getToken() !== raw.token) throw Object.assign(new Error('Passport already active'), { code: 'passport-active' });
  applying = true;
  try { keys.forEach((k) => globalThis.localStorage?.removeItem(`sp.pref.${k}`)); }
  finally { applying = false; }
  apply(p);
  identity.saveName(raw.name); identity.saveToken(raw.token); identity.setEntered(true);
  location.reload();
}
