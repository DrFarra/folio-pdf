const CACHE = 'folio-0.4.0';
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(['/folio.svg', '/manifest.webmanifest', '/sample.pdf', '/fonts/dm-sans-regular.ttf', '/fonts/dm-sans-semibold.ttf'])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('folio-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Cache application assets only. PDFs opened by the user never make a network request.
  if (!/^\/(assets\/|fonts\/|pdfjs\/|ocr\/|folio\.svg$|sample\.pdf$|manifest\.webmanifest$)/.test(url.pathname)) return;
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
    if (response.ok && response.type === 'basic') { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(event.request, copy)); }
    return response;
  })));
});
