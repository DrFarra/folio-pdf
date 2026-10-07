// Folio's version; scripts/check-release-version.mjs keeps it equal to package.json.
// A new version gets a new cache and the previous ones are deleted.
const VERSION = '0.9.4';
const CACHE = `folio-${VERSION}`;
const SHELL = ['/', '/theme.js', '/folio.svg', '/manifest.webmanifest', '/apple-touch-icon.png', '/folio-192.png', '/folio-512.png',
  '/sample.pdf', '/licenses/LICENSE.txt', '/fonts/dm-sans-regular.ttf', '/fonts/dm-sans-semibold.ttf'];
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL.map(path => new Request(path, { cache: 'reload' })));
    // The page loaded its entry script and styles before this worker existed.
    const html = await (await cache.match('/')).text();
    await cache.addAll([...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(match => match[1]))]);
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('folio-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  // PDFs opened by the user never make a network request. Range reads go straight to the network.
  if (request.method !== 'GET' || url.origin !== self.location.origin || request.headers.has('range')) return;
  // Only /assets/ names carry a content hash. Everything else, the page first,
  // comes from the network while online, so an update never mixes old and new files.
  if (url.pathname.startsWith('/assets/')) event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => store(event, request, response))));
  else event.respondWith(fromNetwork(event, request, request.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html') ? '/' : request));
});
async function fromNetwork(event, request, key) {
  try { return store(event, key, await fetch(request)); }
  catch (error) { const cached = await caches.match(key); if (cached) return cached; throw error; }
}
function store(event, key, response) {
  if (response.status === 200 && response.type === 'basic' && !response.redirected) {
    const copy = response.clone();
    event.waitUntil(caches.open(CACHE).then(cache => cache.put(key, copy)));
  }
  return response;
}
