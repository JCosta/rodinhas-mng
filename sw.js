// Service worker mínimo: permite instalar a app e abri-la sem rede (mostra a última versão guardada).
// Ficheiros da app: rede primeiro (sempre a versão mais recente), cache como recurso.
// Pedidos ao Supabase e a outros domínios nunca passam pela cache.
const CACHE = 'rodinhas-202611271030';
const BASE = ['./', './index.html', './styles.css', './app.js', './config.js', './theme.js', './vendor/supabase-js-2.119.2.mjs', './manifest.webmanifest', './icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(BASE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) { const copia = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copia)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('./index.html')))
  );
});
