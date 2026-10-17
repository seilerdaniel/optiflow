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
 *  SOLUCIÓN: `vercel.json` declara `/admin` y `/admin.html` como
 *  `beforeFiles` (rewrites que corren ANTES del filesystem estático) y
 *  apuntan acá. Esta Function es la única puerta de entrada al panel:
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
const ARCHIVO_ADMIN = path.join(__dirname, '..', 'public', 'admin.html');

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

  let html;
  try {
    html = fs.readFileSync(ARCHIVO_ADMIN);
  } catch (e) {
    console.error('[admin] No se pudo leer admin.html:', e && e.message);
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
