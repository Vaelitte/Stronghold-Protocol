/** A pending local edit may advance only the revision it was based on. */
export function localProfileAction(raw, server) {
  if (!raw.pending) return 'server';
  if (!Number.isSafeInteger(raw.revision) || !raw.prefs || typeof raw.prefs !== 'object') throw new Error('Invalid local snapshot');
  if (server.revision === raw.revision) return 'local';
  if (canonical(raw.prefs) === canonical(server.prefs)) return 'server';
  throw Object.assign(new Error('Both copies changed'), { code: 'directory-conflict' });
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
