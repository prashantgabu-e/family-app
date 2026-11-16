const CACHE = 'family-tree-v3'
self.addEventListener('install', (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(['./']))))
self.addEventListener('activate', (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim())) )
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return
  event.respondWith(fetch(event.request).then((response) => {
    if (new URL(event.request.url).origin === location.origin) caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()))
    return response
  }).catch(() => caches.match(event.request)))
})
