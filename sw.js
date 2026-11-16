// Service Worker: offline-fähig + Teilen-Ziel
const VERSION = 'pdfstudio-v1.0.2';
const CORE = [
  './', './index.html', './app.css', './app.js', './manifest.webmanifest',
  './vendor/pdfjs/pdf.min.mjs', './vendor/pdfjs/pdf.worker.min.mjs', './vendor/pdf-lib.esm.min.js',
  './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' umgeht den HTTP-Cache – sonst landen bei Updates alte Dateien im neuen Speicher
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(CORE.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION && k !== 'shared-files') await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // „Teilen → PDF Studio“ aus anderen Apps
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      try {
        const form = await e.request.formData();
        const file = form.get('file');
        if (file) {
          const cache = await caches.open('shared-files');
          await cache.put('shared.pdf', new Response(file, { headers: { 'x-name': encodeURIComponent(file.name || 'Geteilt.pdf'), 'content-type': 'application/pdf' } }));
        }
      } catch (err) { /* ignorieren */ }
      return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
    })());
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // App-Dateien: erst Cache, im Hintergrund aktualisieren; Schriften/CMaps bei Bedarf cachen
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(e.request, { ignoreSearch: url.pathname.endsWith('/') || url.pathname.endsWith('index.html') });
    const net = fetch(e.request.url, { cache: 'no-cache' }).then((res) => { if (res.ok) cache.put(e.request, res.clone()); return res; }).catch(() => null);
    return hit || (await net) || new Response('Offline', { status: 503 });
  })());
});
