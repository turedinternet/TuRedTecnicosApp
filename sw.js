const CACHE_NAME = 'tarifario-tured-v3';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './config.js',
  './manifest.json',
  './tarifas.json',
  './qrcode.min.js',
  './icon-192.png',
  './icon-512.png',
  './Logo TuRed Minimalista.png',
  './Logo TuRed completo.png',
  'https://www.gstatic.com/firebasejs/10.14.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.14.0/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js'
];

// Instalar el Service Worker y precachear los assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[Service Worker] Precaching app shell...');
      return cache.addAll(ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// Activar el Service Worker y limpiar cachés antiguas
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[Service Worker] Removing old cache:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Estrategia de Fetch: Stale-While-Revalidate para archivos locales, Network-First para APIs
self.addEventListener('fetch', (event) => {
  // Ignorar peticiones de otros esquemas que no sean HTTP/HTTPS (como chrome-extension o file://)
  if (!event.request.url.startsWith('http')) return;

  const url = new URL(event.request.url);

  // Para Firestore sync u otras APIs de Firebase, dejar que el navegador/SDK lo maneje de forma nativa
  if (url.hostname.includes('firestore.googleapis.com') || url.hostname.includes('identitytoolkit.googleapis.com')) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        // Devolver la respuesta en caché y buscar actualizaciones en red en segundo plano
        fetch(event.request).then((networkResponse) => {
          if (networkResponse.status === 200) {
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, networkResponse));
          }
        }).catch((err) => console.log('[Service Worker] background fetch failed', err));
        
        return cachedResponse;
      }

      // Si no está en caché, ir a la red
      return fetch(event.request).then((networkResponse) => {
        // Guardar nuevas peticiones en caché (por ejemplo, imágenes o fuentes CDN de Google Fonts)
        if (networkResponse.status === 200 && (event.request.method === 'GET')) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => {
        // Fallback offline en caso de que falle la red por completo y no esté en caché
        if (event.request.headers.get('accept').includes('text/html')) {
          return caches.match('./index.html');
        }
      });
    })
  );
});
