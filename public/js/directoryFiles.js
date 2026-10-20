// Portable format. Only our namespace is touched; disconnect never deletes player files.
const SPACE = 'Stronghold-data';
export async function profileFile(root, create = false) {
  const dir = await root.getDirectoryHandle(SPACE, { create });
  return dir.getFileHandle('player.json', { create });
}
export async function readDirectoryProfile(root) {
  try {
    const file = await (await profileFile(root)).getFile();
    if (file.size > 4 * 1024 * 1024) throw new Error('Profile too large');
    return JSON.parse(await file.text());
  } catch (e) { if (e.name === 'NotFoundError') return null; throw e; }
}
export async function writeDirectoryProfile(root, value) {
  const file = await profileFile(root, true), writer = await file.createWritable();
  try { await writer.write(JSON.stringify(value)); await writer.close(); }
  catch (e) { await writer.abort().catch(() => {}); throw e; }
}
/** Keys exclude the rotating origin. Audio assets/media aliases share bytes. */
export function directoryAssetKey(pathname) {
  if (typeof pathname !== 'string' || /[?#\\\0]/.test(pathname)) return null;
  const m = /^\/(assets|fonts|media)\/~([0-9a-f]{16})\/(.+)$/.exec(pathname);
  if (!m) return null;
  let decoded;
  try { decoded = decodeURIComponent(m[3]); } catch { return null; }
  if (/[\\\0]/.test(decoded) || decoded.split('/').some(p => !p || p === '.' || p === '..')) return null;
  return m[1] === 'media' || (m[1] === 'assets' && decoded.startsWith('audio/'))
    ? `audio:${m[2]}` : `path:${pathname}`;
}
async function assetFile(root, key, create) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
  const name = Array.from(digest, n => n.toString(16).padStart(2, '0')).join('');
  const dir = await (await (await root.getDirectoryHandle(SPACE, { create })).getDirectoryHandle('assets', { create }))
    .getDirectoryHandle(name.slice(0, 2), { create });
  return dir.getFileHandle(`${name}.bin`, { create });
}
/** One atomic container per asset: uint32 header length + JSON metadata + body. */
export async function writeDirectoryAsset(root, pathname, body, type) {
  const key = directoryAssetKey(pathname), size = body instanceof Blob ? body.size : body.byteLength;
  if (!key || !size || /text\/html/i.test(type || '')) throw new Error('Invalid asset');
  const header = new TextEncoder().encode(JSON.stringify({ v: 1, key, type: type || 'application/octet-stream', size }));
  const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, header.length, true);
  const file = await assetFile(root, key, true), writer = await file.createWritable();
  try { await writer.write(new Blob([len, header, body])); await writer.close(); }
  catch (e) { await writer.abort().catch(() => {}); throw e; }
}
export async function readDirectoryAsset(root, pathname) {
  const key = directoryAssetKey(pathname);
  if (!key) return null;
  try {
    const file = await (await assetFile(root, key, false)).getFile();
    if (file.size < 5) return null;
    const n = new DataView(await file.slice(0, 4).arrayBuffer()).getUint32(0, true);
    if (!n || n > 4096 || n + 4 >= file.size) return null;
    const header = JSON.parse(await file.slice(4, n + 4).text());
    if (header.v !== 1 || header.key !== key || header.size !== file.size - n - 4 || typeof header.type !== 'string') return null;
    return file.slice(n + 4, file.size, header.type);
  } catch (e) { if (e.name === 'NotFoundError') return null; throw e; }
}
export function assetResponse(blob, range = null) {
  const headers = { 'Content-Type': blob.type || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Length': String(blob.size) };
  if (!range) return new Response(blob, { headers });
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  const fail = () => new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${blob.size}` } });
  if (!match || (!match[1] && !match[2])) return fail();
  const start = match[1] ? Number(match[1]) : Math.max(0, blob.size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(blob.size - 1, Number(match[2])) : blob.size - 1;
  if (start > end || start >= blob.size || (!match[1] && Number(match[2]) === 0)) return fail();
  return new Response(blob.slice(start, end + 1), { status: 206, headers: { ...headers,
    'Content-Range': `bytes ${start}-${end}/${blob.size}`, 'Content-Length': String(end - start + 1) } });
}
