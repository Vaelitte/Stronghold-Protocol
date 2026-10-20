// Retire the former cross-origin bridge for clients which still have it installed.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil((async () => {
  await self.registration.unregister();
  for (const client of await self.clients.matchAll({ type: 'window' })) await client.navigate(new URL('/', self.location.origin).href);
})()));
