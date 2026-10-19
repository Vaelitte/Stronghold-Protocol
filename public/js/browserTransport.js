/** The relay is supplied only by the trusted service worker, never an arbitrary query-string URL. */
export function browserRelay(doc = globalThis.document) {
  const value = doc?.querySelector?.('meta[name="sp-relay-origin"]')?.content;
  try { return value ? new URL(value).origin : null; } catch { return null; }
}
export function relayWorkerUrl(url) {
  const result = new URL(url);
  if (browserRelay() && new URLSearchParams(globalThis.location?.search).get('sp-relay') === 'random') result.searchParams.set('sp-relay', 'random');
  return result;
}
