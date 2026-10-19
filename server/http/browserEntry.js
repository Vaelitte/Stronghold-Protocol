// Optional personal deployment: one browser origin, independently replaceable game tunnels.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { sendJson, sendError } from './common.js';

function origin(value) {
  try {
    const u = new URL(value);
    if (u.username || u.password || u.pathname !== '/' || u.search || u.hash) return null;
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) return null;
    return u.origin;
  } catch { return null; }
}

/** Public URLs only; never a token or a user-supplied proxy destination. Read again when a tunnel changes. */
export function readBrowserEntry(file) {
  try {
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    const fixed = origin(p.origin), random = origin(p.random);
    if (!fixed || (random && random === fixed)) return null;
    return { v: 1, origin: fixed, random };
  } catch { return null; }
}

export function createBrowserEntry({ file, publicDir, registry, now = Date.now }) {
  if (!file) return null;
  const page = fs.readFileSync(path.join(publicDir, 'browser-entry.html'));
  const tickets = new Map();
  const config = () => readBrowserEntry(file);
  const host = (req) => String(req.headers.host || '').toLowerCase();
  const sameHost = (req, url) => !!url && host(req) === new URL(url).host;
  function headers(req, res, csp) {
    const p = config();
    if (!p) return;
    // A new random hostname must also work after the service worker wakes from an older installation.
    const remote = ['https://*.trycloudflare.com', 'wss://*.trycloudflare.com',
      ...[p.origin, p.random].filter(Boolean).flatMap((u) => [u, u.replace(/^http/, 'ws')])];
    const fixed = new URL(p.origin);
    if (fixed.protocol === 'http:') remote.push(`http://${fixed.hostname}:*`, `ws://${fixed.hostname}:*`);
    if (csp) res.setHeader('Content-Security-Policy', csp.replace("connect-src 'self'", `connect-src 'self' ${[...new Set(remote)].join(' ')}`));
    if (req.headers.origin === p.origin) {
      res.setHeader('Access-Control-Allow-Origin', p.origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Type, Content-Range, Accept-Ranges, ETag');
    }
  }
  async function handle(req, res, rawPath) {
    const p = config();
    if (!p) return false;
    if (req.method === 'OPTIONS' && req.headers.origin === p.origin) {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, HEAD, PUT, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Accept, Accept-Language, Authorization, Content-Type, Range, X-SP-Bridge', 'Access-Control-Max-Age': '600' });
      res.end(); return true;
    }
    if (rawPath === '/api/browser-entry' && (req.method === 'GET' || req.method === 'HEAD')) {
      sendJson(req, res, 200, p); return true;
    }
    if (rawPath === '/api/browser-handoff' && req.method === 'POST') {
      for (const [key, value] of tickets) if (value.expires <= now()) tickets.delete(key);
      const session = registry.byToken(String(req.headers.authorization || '').replace(/^Bearer /, ''));
      if (!session || session.connected) { sendJson(req, res, 403, {}); return true; }
      if (tickets.size >= 256) { sendJson(req, res, 429, {}); return true; }
      const code = randomBytes(24).toString('hex');
      tickets.set(code, { token: session.token, name: session.name, playerId: session.playerId, expires: now() + 120000 });
      sendJson(req, res, 200, { code }); return true;
    }
    if (rawPath.startsWith('/api/browser-handoff/') && req.method === 'POST') {
      // A one-use opaque code is carried in a fragment; the actual passport never appears in a URL.
      if (!sameHost(req, p.origin)) { sendJson(req, res, 403, {}); return true; }
      const code = rawPath.slice('/api/browser-handoff/'.length);
      const ticket = tickets.get(code);
      tickets.delete(code);
      if (!ticket || ticket.expires <= now()) { sendJson(req, res, 410, {}); return true; }
      if (registry.byToken(ticket.token)?.connected) { sendJson(req, res, 409, {}); return true; }
      const { expires: _expires, ...passport } = ticket;
      sendJson(req, res, 200, passport); return true;
    }
    if ((rawPath === '/' || rawPath === '/index.html') && req.method === 'GET'
      && req.headers['x-sp-bridge'] !== '1' && (sameHost(req, p.origin) || sameHost(req, p.random))) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': page.length });
      res.end(page); return true;
    }
    if (rawPath.startsWith('/api/browser-')) { sendError(req, res, 404, '未找到 · Not found'); return true; }
    return false;
  }
  return { headers, handle };
}
