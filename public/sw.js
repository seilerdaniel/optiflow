/* ============================================================
 * OPTIFLOW - Service Worker (PWA) · Fase 7
 * ------------------------------------------------------------
 * Estrategia:
 *   · Estáticos (CSS/JS/iconos): cache-first con actualización en
 *     segundo plano (stale-while-revalidate). La app carga aunque
 *     la red de planta esté caída.
 *   · Navegación (HTML): network-first con fallback al cache
 *     (siempre sirve la última versión conocida).
 *   · API (/api/*): SIN cacheo. Los datos de producción son
 *     transaccionales (iniciar/pausar/finalizar etapas) y nunca
 *     deben responder desde una caché vieja.
 *
 * El nombre del caché incluye versión: al desplegar un cambio,
 * bump CACHE_VERSION para descartar los assets viejos.
 * ============================================================ */

const CACHE_VERSION = 'v9';
const CACHE_ESTATICOS = `optiflow-estaticos-${CACHE_VERSION}`;
const CACHE_PAGINAS = `optiflow-paginas-${CACHE_VERSION}`;

// Assets estáticos que conforman la app shell (se precachean al instalar).
// NOTA (V-1): /admin NO se precachea: el servidor lo protege con sesión y
// sólo debe servirse desde red. /login.html sí forma parte de la shell.
// /js/sidebar.js va en el shell porque ambas vistas (terminal y admin)
// dependen de él: sin precachearlo, la planta quedaría sin menú al operar
// con red caída.
// /js/lib/chart.umd.min.js se precachea para que el dashboard de analítica
// siga renderizando con la tablet sin conexión (vendor local: cero CDN).
const SHELL = [
  '/',
  '/login.html',
  '/css/app.css',
  '/js/api.js',
  '/js/login.js',
  '/js/sidebar.js',
  '/js/terminal.js',
  '/js/admin.js',
  '/js/lib/chart.umd.min.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (evento) => {
  evento.waitUntil(
    caches.open(CACHE_ESTATICOS)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil(
    caches.keys()
      .then((nombres) => Promise.all(
        nombres
          .filter((n) => n !== CACHE_ESTATICOS && n !== CACHE_PAGINAS)
          .map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (evento) => {
  const { request } = evento;
  if (request.method !== 'GET') return; // POST/PUT/DELETE siempre van a la red

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // externos (ej. api.qrserver) sin tocar

  // API: siempre red, jamás caché.
  if (url.pathname.startsWith('/api/')) return;

  // Navegaciones (HTML): network-first con fallback al cache.
  if (request.mode === 'navigate') {
    evento.respondWith(
      fetch(request)
        .then((respuesta) => {
          const copia = respuesta.clone();
          caches.open(CACHE_PAGINAS).then((c) => c.put(request, copia));
          return respuesta;
        })
        .catch(() => caches.match(request).then((r) => r || caches.match('/')))
    );
    return;
  }

  // Estáticos: cache-first + revalidación en segundo plano.
  if (esEstatico(url.pathname)) {
    evento.respondWith(
      caches.open(CACHE_ESTATICOS).then(async (c) => {
        const guardado = await c.match(request);
        const red = fetch(request)
          .then((respuesta) => {
            if (respuesta && respuesta.ok) c.put(request, respuesta.clone());
            return respuesta;
          })
          .catch(() => guardado);
        return guardado || red;
      })
    );
  }
});

function esEstatico(pathname) {
  return /\.(css|js|png|jpg|jpeg|svg|ico|woff2?)$/.test(pathname)
    || pathname === '/manifest.json';
}
