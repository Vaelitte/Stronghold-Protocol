// Personal deployment: durable identities and preferences, outside every static mount.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';

const hash = (token) => createHash('sha256').update(token).digest('hex');
export const PROFILE_KEYS = new Set(['loadout', 'ownership', 'diy', 'skins', 'stats']);
export const PROFILE_MAX_BYTES = 3 * 1024 * 1024;
export class ProfileStore {
  constructor(dir) { this.dir = path.resolve(dir); }
  file(token) { return path.join(this.dir, `${hash(token)}.json`); }
  read(token) {
    if (!/^[0-9a-f]{32}$/.test(token || '')) return null;
    const file = this.file(token);
    if (!existsSync(file)) return null;
    const p = JSON.parse(readFileSync(file, 'utf8'));
    if (p.v !== 1 || typeof p.playerId !== 'string' || !p.prefs) throw new Error('Invalid player profile');
    return p;
  }
  write(token, value) {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > PROFILE_MAX_BYTES) throw new Error('Profile too large');
    mkdirSync(this.dir, { recursive: true });
    const file = this.file(token), temp = `${file}.tmp`;
    writeFileSync(temp, text, { mode: 0o600 });
    renameSync(temp, file);
    return value;
  }
  ensure(s) {
    return this.read(s.token) || this.write(s.token, { v: 1, playerId: s.playerId, name: s.name, revision: 0, prefs: {} });
  }
  update(s, prefs, revision) {
    const p = this.ensure(s);
    if (revision !== p.revision) return null;
    if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)
      || Object.keys(prefs).some((k) => !PROFILE_KEYS.has(k))) throw new Error('Invalid preferences');
    return this.write(s.token, { ...p, name: s.name, revision: p.revision + 1, prefs: { ...p.prefs, ...prefs } });
  }
}

/** Bearer authentication: a passport is never placed in a URL or a cookie. */
export async function profileRequest(req, res, registry, profiles) {
  res.setHeader('Cache-Control', 'no-store');
  const reply = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
  const token = /^Bearer ([0-9a-f]{32})$/.exec(req.headers.authorization || '')?.[1];
  const s = token && registry.byToken(token);
  if (!s) { reply(401, { error: 'unauthorized' }); return; }
  if (req.method === 'GET') { reply(200, { ...profiles.ensure(s), connected: s.connected }); return; }
  if (req.method !== 'PUT') { reply(405, { error: 'method' }); return; }
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) { reply(415, { error: 'json' }); return; }
  let size = 0;
  const chunks = [];
  req.setTimeout(15000, () => req.destroy());
  for await (const chunk of req) {
    size += chunk.length;
    if (size > PROFILE_MAX_BYTES) { reply(413, { error: 'too-large' }); return; }
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const p = profiles.update(s, body.prefs, body.revision);
    reply(p ? 200 : 409, p || { error: 'conflict' });
  } catch { reply(400, { error: 'invalid-profile' }); }
}
