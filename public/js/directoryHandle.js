// The browser scopes handles/permission to this origin; a new hostname needs a user selection.
export function rememberedDirectory(value = undefined) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('sp-local-directory', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('handles');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('handles', value === undefined ? 'readonly' : 'readwrite');
      const store = tx.objectStore('handles');
      const op = value === undefined ? store.get('root') : value === null ? store.delete('root') : store.put(value, 'root');
      tx.oncomplete = () => { db.close(); resolve(op.result || null); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}
