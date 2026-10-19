import { identity } from './net.js';
import { t } from '../../shared/i18n.js';

const status = document.querySelector('#status'), error = document.querySelector('#error');
const retry = document.querySelector('#retry');
status.textContent = t('正在恢复身份和素材缓存…');
retry.textContent = t('重试');
retry.onclick = () => location.reload();

async function json(url, options = {}) {
  const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15000), ...options });
  if (!r.ok) throw new Error('Entry unavailable');
  return r.json();
}
async function run() {
  const config = await json('/api/browser-entry');
  // This path bypasses an already installed worker too, so a one-time old-origin migration is always redeemed.
  const target = new URL('/browser-entry.html', config.origin);
  if (location.origin !== config.origin) {
    // Migrate an existing identity from this old random origin without exporting a file.
    await identity.init();
    const token = identity.getToken();
    let code;
    if (token) {
      try { code = (await json('/api/browser-handoff', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).code; }
      catch { /* An identity open in another tab is not taken over. The stable origin keeps its own identity. */ }
    }
    target.searchParams.set('sp-relay', 'random');
    const room = new URLSearchParams(location.search).get('room');
    if (room) target.searchParams.set('room', room);
    if (code) target.hash = `handoff=${code}`;
    location.replace(target.href); return;
  }
  const code = new URLSearchParams(location.hash.slice(1)).get('handoff');
  // Remove even a one-use code from address/history before making any other requests.
  if (code) history.replaceState(null, '', location.pathname + location.search);
  await identity.init();
  if (code && /^[0-9a-f]{48}$/.test(code)) {
    const incoming = await json(`/api/browser-handoff/${code}`, { method: 'POST' });
    const current = identity.getToken();
    // A previously selected stable identity wins; do not silently switch to a different player's old tab.
    if (!current || current === incoming.token) {
      if (!current) for (const k of ['loadout', 'ownership', 'diy', 'skins', 'stats']) localStorage.removeItem(`sp.pref.${k}`);
      identity.saveToken(incoming.token); identity.saveName(incoming.name); identity.setEntered(true);
    }
  }
  if (!isSecureContext || !navigator.serviceWorker) throw new Error('Service worker unavailable');
  const registration = await navigator.serviceWorker.register('/bridge-sw.js', { scope: '/', updateViaCache: 'none' });
  await navigator.serviceWorker.ready;
  const wait = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Worker activation timed out')), 15000);
    const check = () => {
      if (navigator.serviceWorker.controller?.scriptURL === new URL('/bridge-sw.js', location.origin).href) {
        clearTimeout(timer); navigator.serviceWorker.removeEventListener('controllerchange', check); resolve();
      }
    };
    navigator.serviceWorker.addEventListener('controllerchange', check); check();
  });
  if (registration.waiting) registration.waiting.postMessage({ t: 'activate' });
  await wait;
  // The navigation itself is served through the selected tunnel by bridge-sw.js.
  location.replace('/' + location.search);
}
void run().catch(() => {
  status.textContent = '';
  error.textContent = t('自动恢复入口暂时不可用，请检查网络后重试。');
  retry.hidden = false;
});
