'use strict';

/**
 * ============================================================
 *  OPTIFLOW - Protección de /admin en VERCEL (auditoría A-2)
 * ============================================================
 *  PROBLEMA: en Vercel los archivos de `public/` los sirve el CDN/edge
 *  estático ANTES de que cualquier Function vea la petición. Por eso
 *  `/admin.html` (y el rewrite `/admin` -> `/admin.html`) respondían
 *  200 con el panel completo a cualquiera: el gate de `server.js`
 *  (`servirEstatico`) nunca se ejecutaba en la nube. En local sí
 *  funcionaba, porque ahí TODO pasa por `http.createServer` -> `manejar`.
 *
 *  SOLUCIÓN: `vercel.json` protege las DOS puertas del panel con reglas
 *  válidas (array, no el objeto `beforeFiles`/`afterFiles` que sólo existe
 *  en Next.js y hace fallar el build de Vercel):
 *    · `/admin.html` (existe en public/ y el CDN lo serviría estático) ->
 *      REDIRECT 307 a `/admin`, que se evalúa ANTES del filesystem.
 *    · `/admin` (no existe como archivo estático) -> REWRITE a `/api/admin`.
 *  Esta Function es la única puerta de entrada al panel:
 *    · sin cookie de sesión válida -> 302 a /login.html (sin HTML alguno)
 *    · con sesión                  -> sirve el panel
 *
 *  El HTML se lee con un path LITERAL respecto de __dirname para que
 *  @vercel/nft lo rastree y lo incluya en el bundle de la Function
 *  (con un path dinámico/concatenado no lo haría y fallaría en runtime).
 */

const path = require('node:path');
const fs = require('node:fs');

const db = require('../server/db');
const auth = require('../server/lib/auth');
// Mismo patrón que api/[...slug].js: se reutiliza el servidor real.
// `server.js` NO arranca el http.createServer al ser requerido (va detrás de
// `require.main === module`), así que sólo aporta las constantes.
const { HEADERS_SEGURIDAD } = require('../server/server.js');

// Path literal (nft lo empaqueta). NO refactorizar a `path.join(__dirname, '..',
// RUTAS[n])` ni equivalentes: rompería el rastreo de archivos del bundler.
// `vercel.json` además fuerza `public/admin.html` con `includeFiles`, así que
// el archivo viaja en el bundle aunque nft no lo detecte por su cuenta.
const ARCHIVO_ADMIN = path.join(__dirname, '../public/admin.html');
const ARCHIVO_ADMIN_ALT = path.join(process.cwd(), 'public', 'admin.html');

/** Destino conservado tras el login (?siguiente=…). */
const DESTINO = '/admin';

module.exports = async function handler(req, res) {
  // Sólo GET/HEAD: el panel es lectura pura.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', ...HEADERS_SEGURIDAD });
    return res.end(JSON.stringify({ error: `Método ${req.method} no permitido.` }));
  }

  let sesion = null;
  try {
    sesion = await auth.sesionDe(db, req);
  } catch (e) {
    // Si la base no responde, NO se sirve el panel: se trata como sin sesión.
    console.error('[admin] No se pudo validar la sesión:', e && e.message);
    sesion = null;
  }

  if (!sesion) {
    res.writeHead(302, {
      Location: `/login.html?siguiente=${encodeURIComponent(DESTINO)}`,
      'Cache-Control': 'no-store',
      ...HEADERS_SEGURIDAD,
    });
    return res.end();
  }

  let html = null;
  let errorLectura = null;
  // Lectura resiliente: el path primario es el que nft/`includeFiles` empaqueta;
  // el alterno cubre runtimes que montan el proyecto con otro `cwd`.
  for (const archivo of [ARCHIVO_ADMIN, ARCHIVO_ADMIN_ALT]) {
    try {
      html = fs.readFileSync(archivo);
      break;
    } catch (e) {
      errorLectura = e;
    }
  }
  if (!html) {
    console.error('[admin] No se pudo leer admin.html:', errorLectura && errorLectura.message);
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', ...HEADERS_SEGURIDAD });
    return res.end(JSON.stringify({ error: 'No se pudo cargar el panel de administración.' }));
  }

  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': html.length,
    // El panel exige sesión: jamás en caché compartida ni del navegador.
    'Cache-Control': 'no-store',
    ...HEADERS_SEGURIDAD,
  });
  return res.end(html);
};
