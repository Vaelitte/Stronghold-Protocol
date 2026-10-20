import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assetResponse, directoryAssetKey, readDirectoryAsset, writeDirectoryAsset, readDirectoryProfile, writeDirectoryProfile } from '../../public/js/directoryFiles.js';
import { localProfileAction } from '../../public/js/directoryProfile.js';

function memoryDirectory() {
  const nodes = new Map();
  return { nodes,
    async getDirectoryHandle(name, { create } = {}) {
      if (!nodes.has(name)) { if (!create) throw new DOMException('', 'NotFoundError'); nodes.set(name, memoryDirectory()); }
      return nodes.get(name);
    },
    async getFileHandle(name, { create } = {}) {
      if (!nodes.has(name)) { if (!create) throw new DOMException('', 'NotFoundError'); nodes.set(name, new Blob()); }
      return {
        async getFile() { return nodes.get(name); },
        async createWritable() {
          let next = null;
          return { async write(value) { next = new Blob([value]); }, async close() { nodes.set(name, next); }, async abort() {} };
        },
      };
    },
  };
}
const path = '/assets/~0123456789abcdef/audio/test.mp3';
test('portable art/profile namespace survives independent connections and audio aliases without an origin', async () => {
  const root = memoryDirectory();
  root.nodes.set('unrelated.txt', new Blob(['keep']));
  assert.equal(await readDirectoryProfile(root), null);
  await writeDirectoryProfile(root, { token: 'private', prefs: { diy: { slot: 'char' } } });
  assert.equal((await readDirectoryProfile(root)).prefs.diy.slot, 'char');
  await writeDirectoryAsset(root, path, new TextEncoder().encode('abcdef'), 'audio/mpeg');
  const hit = await readDirectoryAsset(root, '/media/~0123456789abcdef/test');
  assert.equal(await hit.text(), 'abcdef');
  assert.equal(hit.type, 'audio/mpeg');
  assert.equal(await readDirectoryAsset(root, path.replace('0123456789abcdef', '1123456789abcdef')), null);
  assert.equal(await root.nodes.get('unrelated.txt').text(), 'keep');
});
test('directory keys reject untrusted paths, while partial/foreign files cannot be read as art', async () => {
  for (const bad of ['/js/main.js', '/api/profile', '/assets/plain.png', '/assets/~0123456789abcdef/%2e%2e/a.png',
    '/assets/~0123456789abcdef/%00.png', path + '?x=1', path + '#x', path.replace('audio/', 'a\\')]) assert.equal(directoryAssetKey(bad), null, bad);
  const root = memoryDirectory();
  await assert.rejects(writeDirectoryAsset(root, path, new Blob(), 'audio/mpeg'));
  await assert.rejects(writeDirectoryAsset(root, path, new Blob(['html']), 'text/html'));
  await writeDirectoryAsset(root, path, new Blob(['abcdef']), 'audio/mpeg');
  const buckets = root.nodes.get('Stronghold-data').nodes.get('assets').nodes;
  const files = [...buckets.values()][0].nodes, name = [...files.keys()][0];
  files.set(name, files.get(name).slice(0, -1));
  assert.equal(await readDirectoryAsset(root, path), null, 'a truncated container is never served');
});
test('directory audio handles valid suffix/open ranges and rejects invalid ranges', async () => {
  const body = new Blob(['abcdef'], { type: 'audio/mpeg' });
  for (const [range, expected] of [['bytes=1-3', 'bcd'], ['bytes=4-', 'ef'], ['bytes=-2', 'ef'], ['bytes=0-99', 'abcdef']]) {
    const response = assetResponse(body, range);
    assert.equal(response.status, 206); assert.equal(response.headers.get('content-type'), 'audio/mpeg');
    assert.equal(await response.text(), expected);
  }
  for (const bad of ['bytes=6-', 'bytes=3-1', 'bytes=-0', 'bytes=-', 'bytes=0-1,4-5']) assert.equal(assetResponse(body, bad).status, 416);
});
test('directory profiles prefer latest server data, recover unsent edits and never silently overwrite concurrent changes', () => {
  const prefs = { diy: { b: 2, a: 1 } };
  assert.equal(localProfileAction({ pending: false }, { revision: 9 }), 'server');
  assert.equal(localProfileAction({ pending: true, revision: 8, prefs }, { revision: 8, prefs: {} }), 'local');
  assert.equal(localProfileAction({ pending: true, revision: 8, prefs }, { revision: 9, prefs: { diy: { a: 1, b: 2 } } }), 'server');
  assert.throws(() => localProfileAction({ pending: true, revision: 8, prefs }, { revision: 9, prefs: {} }), { code: 'directory-conflict' });
  assert.throws(() => localProfileAction({ pending: true }, { revision: 9 }));
});
