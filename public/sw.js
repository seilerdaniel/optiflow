/* ============================================================
 * OPTIFLOW - Service Worker (PWA) · Fase 7
 * ------------------------------------------------------------
 * Estrategia (M-7 · auditoría):
 *   · JS y CSS (/js/*, /css/*): NETWORK-FIRST con fallback a caché.
 *     La red manda siempre que haya conexión, garantizando que tras
 *     cada deploy la tablet de planta reciba la versión más reciente
 *     del código en la PRIMERA carga (antes: cache-first entregaba los
 *     bytes viejos y sólo actualizaba en la siguiente recarga, dejando
 *     HTML nuevo con JS viejo). Sin red, se sirve la última copia
 *     conocida y la app sigue operativa.
 *   · Resto de estáticos (iconos, fuentes, manifest): cache-first con
 *     revalidación en segundo plano. Cambian poco y son caros en datos.
 *   · Navegación (HTML): network-first con fallback al cache
 *     (siempre sirve la última versión conocida).
 *   · API (/api/*): SIN cacheo. Los datos de producción son
 *     transaccionales (iniciar/pausar/finalizar etapas) y nunca
 *     deben responder desde una caché vieja.
 *
 * El nombre del caché incluye versión: al desplegar un cambio,
 * bump CACHE_VERSION para descartar los assets viejos.
 * ============================================================ */

const CACHE_VERSION = 'v10';
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

  // Estáticos CRÍTICOS (JS/CSS): NETWORK-FIRST con fallback a caché.
  //
  // Antes eran cache-first + revalidación en 2º plano (stale-while-revalidate),
  // lo que entregaba los bytes VIEJOS en la primera carga tras cada deploy y
  // sólo los actualizaba en la siguiente recarga. Con HTML network-first y JS
  // cache-first la app podía quedar DESINCRONIZADA: un admin.html nuevo
  // ejecutando un admin.js viejo (rompiendo, p.ej., el command palette o el
  // flash de fichado).
  //
  // Ahora la red manda siempre que haya conexión (la planta tiene wifi
  // intermitente, pero no caído), y la caché sólo actúa como respaldo
  // offline. Los assets no cambian de nombre (sin hash), así que el
  // CACHE_VERSION sigue siendo el que invalida tras un deploy.
  if (esCritico(url.pathname)) {
    evento.respondWith(
      caches.open(CACHE_ESTATICOS).then(async (c) => {
        try {
          const respuesta = await fetch(request);
          // Sólo se cachean respuestas completas (2xx); un 404/500 nunca
          // debe quedar guardado y quedarse pegado para siempre.
          if (respuesta && respuesta.ok) c.put(request, respuesta.clone());
          return respuesta;
        } catch {
          // Sin red: se sirve la última versión conocida (modo planta offline).
          return (await c.match(request)) || Response.error();
        }
      })
    );
    return;
  }

  // Resto de estáticos (imágenes, fuentes, manifest): cache-first +
  // revalidación en segundo plano. Cambian poco y son caros en datos.
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

/** Assets cuya versión debe viajar SIEMPRE con el HTML: código y estilos. */
function esCritico(pathname) {
  return pathname.startsWith('/js/') || pathname.startsWith('/css/');
}

function esEstatico(pathname) {
  return /\.(css|js|png|jpg|jpeg|svg|ico|woff2?)$/.test(pathname)
    || pathname === '/manifest.json';
}
