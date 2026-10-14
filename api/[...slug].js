'use strict';

/**
 * ============================================================
 *  OPTIFLOW - Vercel Serverless Function (catch-all de /api/*)
 *  Fase 7
 * ============================================================
 *  Cualquier petición a /api/... cae acá (Vercel mapea
 *  api/[...slug].js -> /api/*). Se reutiliza `manejar()` del servidor
 *  local tal cual: enruta, ejecuta el handler y responde JSON.
 *
 *  Los archivos estáticos (public/) los sirve Vercel directamente;
 *  esta función sólo atiende la API.
 *
 *  Variables de entorno requeridas en Vercel (Project → Settings):
 *    SUPABASE_DB_URL   cadena de conexión de Supabase (pooler, puerto 6543)
 *    OPTIFLOW_TZ       (opcional) zona horaria de planta,
 *                      por defecto America/Argentina/Buenos_Aires
 */

const { manejar } = require('../server/server.js');

module.exports = async function handler(req, res) {
  // `manejar` arma la URL con `new URL(req.url, host)`. En Vercel, `req.url`
  // para un catch-all ya incluye el prefijo /api/...; si faltara (por algún
  // cambio futuro del runtime), lo re-prefijamos usando el slug capturado.
  if (!req.url.startsWith('/api/')) {
    const slug = (req.query && req.query.slug) || [];
    const partes = Array.isArray(slug) ? slug : [slug];
    req.url = `/api/${partes.join('/')}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
  }
  return manejar(req, res);
};
