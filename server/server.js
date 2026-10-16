'use strict';

/**
 * ============================================================
 *  OPTIFLOW - Servidor Web
 *  Control de Tiempos y Trazabilidad en Planta
 *  Fase 7 (Cloud: Supabase + Vercel)
 * ============================================================
 *  - Sirve la API JSON (/api/*) y la interfaz (public/)
 *  - Base de datos PostgreSQL en Supabase (server/db.js, pg)
 *  - En Vercel, api/[...slug].js reutiliza `manejar()` como Serverless
 *    Function; local, `main()` levanta un http.createServer en 0.0.0.0
 *    para que las tablets de planta se conecten por la IP de la red.
 */

process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name !== 'ExperimentalWarning') console.warn(`[${w.name}] ${w.message}`);
});

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { exec } = require('node:child_process');

const db = require('./db');
const auth = require('./lib/auth');
const { ApiError, sendJson, sendText, readBody, queryToObject } = require('./lib/http');
const ordenes = require('./routes/ordenes');
const sectores = require('./routes/sectores');
const registros = require('./routes/registros');
const operarios = require('./routes/operarios');
const exportador = require('./routes/export');
const metricas = require('./routes/metricas');
const materiales = require('./routes/materiales');
const tpm = require('./routes/tpm');
const cronRuta = require('./routes/cron');
const notificaciones = require('./lib/notificaciones');
const authRuta = require('./routes/auth');

const PUERTO = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VERSION = require('../package.json').version;

/** Producción = despliegue real (Vercel o NODE_ENV=production). */
const EN_PRODUCCION = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
/** OPTIFLOW_DEBUG=1 fuerza los mensajes técnicos aunque esté en producción. */
const debugActivado = () => process.env.OPTIFLOW_DEBUG === '1' || !EN_PRODUCCION;

/* ------------------------------------------------------------------ */
/* CORS (auditoría V-2): allowlist, nunca '*'                          */
/* ------------------------------------------------------------------ */

/** Orígenes extra permitidos (Power BI, dashboards), coma-separados. */
const ORIGENES_PERMITIDOS = (process.env.OPTIFLOW_CORS_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

/** Token estático para consumidores sin sesión (Power BI / scripts de BI). */
const TOKEN_EXPORT = process.env.OPTIFLOW_EXPORT_TOKEN || '';
/** Token estático para el disparador externo de /api/cron/* (sin sesión). */
const TOKEN_CRON = (process.env.OPTIFLOW_CRON_TOKEN || '').trim();

function mismoOrigen(req, origin) {
  try {
    const o = new URL(origin);
    return !!req.headers.host && o.host === req.headers.host;
  } catch {
    return false;
  }
}

/**
 * Headers CORS para una respuesta: sólo si el Origin es el propio host de la
 * app o figura en la allowlist. Sin Origin (curl, server-to-server) no se
 * emite nada: no hace falta.
 */
function cabecerasCORS(req) {
  const origin = req.headers.origin;
  if (!origin) return {};
  if (!mismoOrigen(req, origin) && !ORIGENES_PERMITIDOS.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
  };
}

/** Headers de seguridad aplicados a TODAS las respuestas (auditoría V-7). */
const HEADERS_SEGURIDAD = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
});

/** Compara dos tokens en tiempo constante vía su SHA-256. */
function tokenCoincide(enviado, esperado = TOKEN_EXPORT) {
  if (!esperado || !enviado) return false;
  const a = crypto.createHash('sha256').update(String(enviado)).digest();
  const b = crypto.createHash('sha256').update(esperado).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Roles con acceso a la gestión de planta (OTs, sectores, operarios). */
const ROLES_GESTION = new Set(['admin', 'encargado']);

/**
 * Middleware de sesión (auditoría V-1). Modos:
 *  - 'usuario' : cualquier sesión activa (terminal de fichado).
 *  - 'gestion' : rol admin o encargado (OTs / sectores / operarios).
 *  - 'admin'   : sólo rol admin (usuarios del sistema).
 *  - 'export'  : sesión válida O token estático (Power BI / BI programado).
 */
async function exigirAcceso(req, url, modo) {
  const sesion = await auth.sesionDe(db, req);
  req.optiflowSesion = sesion; // disponible para los handlers

  if (modo === 'export') {
    if (sesion) return sesion;
    const enviado = req.headers['x-optiflow-token'] || url.searchParams.get('token');
    if (tokenCoincide(enviado)) return null;
    throw new ApiError(401, 'La exportación requiere iniciar sesión o un token de acceso válido.',
      { accion: 'Inicie sesión en /admin o configure el parámetro ?token=… (OPTIFLOW_EXPORT_TOKEN).' });
  }

  // Tareas programadas (Vercel Cron / GitHub Actions / schedule del SO): no
  // tienen cookie de sesión, así que se autentican con OPTIFLOW_CRON_TOKEN.
  if (modo === 'cron') {
    if (sesion && ROLES_GESTION.has(sesion.usuario.rol)) return sesion;
    const enviado = req.headers['x-optiflow-token'] || url.searchParams.get('token');
    if (tokenCoincide(enviado, TOKEN_CRON)) return null;
    throw new ApiError(401, 'La tarea programada requiere sesión de gestión o un token válido.',
      { accion: 'Configure OPTIFLOW_CRON_TOKEN y envíelo como header X-Optiflow-Token o ?token=…' });
  }

  if (!sesion) {
    throw new ApiError(401, 'Debe iniciar sesión para usar esta función.',
      { accion: 'Ingrese con su usuario y contraseña desde la terminal o /login.html.' });
  }
  if (modo === 'gestion' && !ROLES_GESTION.has(sesion.usuario.rol)) {
    throw new ApiError(403, 'Su rol no tiene permiso para administrar la planta.',
      { rol_requerido: ['admin', 'encargado'], rol_actual: sesion.usuario.rol });
  }
  if (modo === 'admin' && sesion.usuario.rol !== 'admin') {
    throw new ApiError(403, 'Esta acción requiere rol de administrador.',
      { rol_requerido: ['admin'], rol_actual: sesion.usuario.rol });
  }
  return sesion;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/* ------------------------------------------------------------------ */
/* Tabla de rutas API                                                  */
/* ------------------------------------------------------------------ */


/**
 * Tabla de rutas API.
 * 4to elemento (opcional): { auth: 'usuario' | 'gestion' | 'admin' | 'export' }
 * -> server.js aplica el middleware de sesión ANTES de ejecutar el handler.
 */
const RUTAS = [
  // --- Sistema --- (públicos)
  ['GET', '/api/salud', () => ({
    status: 200,
    data: {
      ok: true, version: VERSION, servidor: 'Optiflow', hora_servidor: db.ahoraUTC(),
      // Diagnóstico de canales: permite verificar la configuración sin
      // tener que enviar un mensaje real de prueba.
      notificaciones: notificaciones.estado(),
    },
  })],

  ['GET', '/api/meta', () => ({
    status: 200,
    data: {
      version: VERSION,
      zona_horaria_servidor: db.ZONA,
      hora_servidor: db.ahoraUTC(),
      estados_ot: db.ESTADOS_OT,
      estados_etapa: db.ESTADOS_ETAPA,
      estados_abiertos: db.ESTADOS_ABIERTOS,
      motivos_pausa: db.MOTIVOS_PAUSA,
      motivos_reproceso: db.MOTIVOS_REPROCESO,
      umbrales_minutos: db.UMBRALES_MINUTOS,
      claves_especiales: db.CLAVES_ESPECIALES,
      lineas_ot: db.LINEAS_OT,
      lineas_area: db.LINEAS_AREA,
    },
  })],

  ['GET', '/api/hora', () => ({
    status: 200,
    data: { epoch_ms: Date.now(), iso: db.ahoraUTC(), zona_horaria: db.ZONA },
  })],

  // --- Autenticación (públicas: login/logout/consulta de sesión) ---
  ['POST', '/api/auth/login', authRuta.login],
  ['POST', '/api/auth/logout', authRuta.logout],
  ['GET', '/api/auth/usuario', authRuta.usuarioActual],

  // --- Usuarios del sistema (gestión de credenciales, sólo admin) ---
  ['GET', '/api/usuarios', authRuta.listarUsuarios, { auth: 'gestion' }],
  ['POST', '/api/usuarios', authRuta.crearUsuario, { auth: 'admin' }],
  ['PUT', '/api/usuarios/:id', authRuta.actualizarUsuario, { auth: 'admin' }],

  // --- Sectores ---
  ['GET', '/api/sectores', sectores.listar],
  ['POST', '/api/sectores', sectores.crear, { auth: 'gestion' }],
  ['PUT', '/api/sectores/:id', sectores.actualizar, { auth: 'gestion' }],

  // --- Órdenes de trabajo ---
  ['GET', '/api/ordenes', ordenes.listar],
  ['POST', '/api/ordenes', ordenes.crear, { auth: 'gestion' }],
  ['GET', '/api/ordenes/:id', ordenes.obtener],
  ['PUT', '/api/ordenes/:id', ordenes.actualizar, { auth: 'gestion' }],
  ['PUT', '/api/ordenes/:id/materiales', ordenes.actualizarMateriales, { auth: 'gestion' }],
  ['PUT', '/api/ordenes/:id/materiales/:mid', ordenes.actualizarMaterial, { auth: 'gestion' }],
  ['DELETE', '/api/ordenes/:id', ordenes.eliminar, { auth: 'gestion' }],

  // --- Registros de tiempos (escrituras de PLANTA: cualquier usuario) ---
  ['GET', '/api/estado', registros.estado],
  ['GET', '/api/registros', registros.listar],
  ['GET', '/api/registros/:id', registros.obtener],
  ['POST', '/api/registros', registros.iniciar, { auth: 'usuario' }],
  ['POST', '/api/registros/:id/pausar', registros.pausar, { auth: 'usuario' }],
  ['POST', '/api/registros/:id/reanudar', registros.reanudar, { auth: 'usuario' }],
  ['POST', '/api/registros/:id/finalizar', registros.finalizar, { auth: 'usuario' }],

  // --- Operarios (maestro, Fase 4) ---
  ['GET', '/api/operarios', operarios.listar],
  ['POST', '/api/operarios', operarios.crear, { auth: 'gestion' }],
  ['PUT', '/api/operarios/:id', operarios.actualizar, { auth: 'gestion' }],

  // --- Métricas / cuellos de botella (Fase 2) ---
  ['GET', '/api/metricas', metricas.calcular],

  // Catálogo dinámico de placas (reconstruido desde ot_materiales).
  ['GET', '/api/materiales/catalogo', materiales.catalogo],

  // --- Mantenimiento Preventivo (TPM) por horas netas de uso real ---
  // Lecturas abiertas (igual que /api/estado y /api/sectores, que consume la
  // terminal de planta para avisar de un mantenimiento vencido).
  ['GET', '/api/tpm/estado', tpm.estado],
  ['GET', '/api/tpm', tpm.listar],
  // Escrituras de gestión: registrar un service o cambiar las metas es tarea
  // de encargado/admin, no del operario que fiche en la terminal.
  ['POST', '/api/tpm/mantenimiento', tpm.registrarMantenimiento, { auth: 'gestion' }],
  ['POST', '/api/tpm/configurar', tpm.configurar, { auth: 'gestion' }],

  // --- Tareas programadas de notificación (disparador externo) ---
  // Modo 'cron': sesión de gestión O token estático OPTIFLOW_CRON_TOKEN.
  ['GET', '/api/cron/estado', cronRuta.estadoCron, { auth: 'cron' }],
  ['POST', '/api/cron/alertas-excedidas', cronRuta.alertasExcedidas, { auth: 'cron' }],
  ['POST', '/api/cron/resumen-diario', cronRuta.resumenDiario, { auth: 'cron' }],

  // --- Exportación (Power BI / Excel): sesión o token estático ---
  ['GET', '/api/export/registros', exportador.exportarJSON, { auth: 'export' }],
  ['GET', '/api/export/registros.json', exportador.exportarJSON, { auth: 'export' }],
  ['GET', '/api/export/registros.csv', exportador.exportarCSV, { auth: 'export' }],
];

function compilarRutas() {
  return RUTAS.map(([metodo, plantilla, handler, op]) => {
    const claves = [];
    const patron = plantilla
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/:([A-Za-z_]+)/g, (_, k) => {
        claves.push(k);
        return '([^/]+)';
      });
    return { metodo, regex: new RegExp(`^${patron}/?$`), claves, handler, op: op || null };
  });
}

const RUTAS_COMPILADAS = compilarRutas();

function enrutar(metodo, pathname) {
  let coincideRuta = false;
  for (const ruta of RUTAS_COMPILADAS) {
    const m = ruta.regex.exec(pathname);
    if (!m) continue;
    coincideRuta = true;
    if (ruta.metodo !== metodo) continue;
    const params = {};
    ruta.claves.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    return { handler: ruta.handler, params, op: ruta.op };
  }
  if (coincideRuta) {
    throw new ApiError(405, `Método ${metodo} no permitido en ${pathname}.`);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Archos estáticos                                                    */
/* ------------------------------------------------------------------ */

/**
 * Archivos estáticos de `public/`.
 * `/admin` (y /admin.html) exigen sesión válida (auditoría V-1): sin ella se
 * redirige a /login.html conservando el destino.
 */
async function servirEstatico(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel === '/admin' || rel === '/admin/') rel = '/admin.html';

  // Superficie de administración protegida.
  if (rel === '/admin.html') {
    const sesion = await auth.sesionDe(db, req);
    if (!sesion) {
      res.writeHead(302, { Location: '/login.html?siguiente=/admin', 'Cache-Control': 'no-store' });
      return res.end();
    }
  }

  const normalizado = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const archivo = path.join(PUBLIC_DIR, normalizado);
  if (!archivo.startsWith(PUBLIC_DIR)) {
    return sendText(res, 403, 'Acceso denegado', 'text/plain; charset=utf-8', cabecerasCORS(req));
  }

  let rutaArchivo = archivo;
  if (fs.existsSync(rutaArchivo) && fs.statSync(rutaArchivo).isDirectory()) {
    rutaArchivo = path.join(rutaArchivo, 'index.html');
  }
  if (!fs.existsSync(rutaArchivo) || !fs.statSync(rutaArchivo).isFile()) {
    return sendText(res, 404, 'Recurso no encontrado', 'text/plain; charset=utf-8', cabecerasCORS(req));
  }

  const ext = path.extname(rutaArchivo).toLowerCase();
  const esHTML = ext === '.html';
  const contenido = fs.readFileSync(rutaArchivo);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': contenido.length,
    // HTML: sin cachear (siempre versión fresca y protegida por sesión).
    //
    // CSS/JS: `no-cache` = "revalida con el servidor", NO "no guardes".
    // El offline lo resuelve el Service Worker (sw.js, cache-first con
    // CACHE_VERSION). Con `max-age>0` había DOS capas de caché: el HTTP
    // cache le entregaba bytes viejos a la precarga del SW, así que tras
    // cada deploy la planta podía ejecutar JS obsoleto hasta 5 minutos
    // aunque ya se hubiera subido CACHE_VERSION. Con `no-cache` el SW es
    // la única autoridad: al instalar/revalidar siempre baja lo último.
    'Cache-Control': esHTML ? 'no-store' : 'no-cache',
    ...HEADERS_SEGURIDAD,
    ...cabecerasCORS(req),
  });
  res.end(contenido);
}

/* ------------------------------------------------------------------ */
/* Servidor                                                            */
/* ------------------------------------------------------------------ */

async function manejar(req, res) {
  const inicio = Date.now();
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return sendJson(res, 400, { error: 'URL inválida' }, { ...HEADERS_SEGURIDAD, ...cabecerasCORS(req) });
  }
  const pathname = url.pathname;
  const cors = () => cabecerasCORS(req);

  try {
    if (req.method === 'OPTIONS') {
      // Preflight: sólo se responde si el Origin está permitido (V-2).
      const origin = req.headers.origin;
      const permitido = !origin || mismoOrigen(req, origin) || ORIGENES_PERMITIDOS.includes(origin);
      if (!permitido) {
        res.writeHead(403, { ...HEADERS_SEGURIDAD, 'Vary': 'Origin' });
        return res.end();
      }
      res.writeHead(204, {
        ...HEADERS_SEGURIDAD,
        ...cabecerasCORS(req),
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Optiflow-Token',
        'Access-Control-Max-Age': '86400',
      });
      return res.end();
    }

    if (pathname.startsWith('/api/')) {
      const ruta = enrutar(req.method, pathname);
      if (!ruta) throw new ApiError(404, `Endpoint no encontrado: ${req.method} ${pathname}`);

      // Middleware de sesión/autorización (auditoría V-1): se aplica ANTES de
      // leer el cuerpo para no consumir bandwidth de peticiones no autorizadas.
      if (ruta.op && ruta.op.auth) await exigirAcceso(req, url, ruta.op.auth);

      // Conexión perezosa: cada db.get/all/run/transaccion abre el pool por sí
      // mismo (en Vercel cada invocación serverless debe abrir su propio pool;
      // los warm starts reutilizan el pool cacheado en db.js). Así /api/salud,
      // /api/meta y /api/hora siguen respondiendo aunque aún no haya base.

      let body = {};
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        body = await readBody(req);
      }
      const salida = await ruta.handler({ params: ruta.params, query: queryToObject(url), body, req, res });

      if (salida && salida.text !== undefined) {
        return sendText(res, salida.status || 200, salida.text, salida.contentType || 'text/plain',
          { ...HEADERS_SEGURIDAD, ...cors(), ...(salida.headers || {}) });
      }
      return sendJson(res, (salida && salida.status) || 200,
        (salida && salida.data) !== undefined ? salida.data : salida,
        { ...HEADERS_SEGURIDAD, ...cors() });
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      return await servirEstatico(req, res, pathname);
    }
    throw new ApiError(405, `Método ${req.method} no permitido.`);
  } catch (err) {
    if (err instanceof ApiError) {
      return sendJson(res, err.status, { error: err.message, detalle: err.detalle || null },
        { ...HEADERS_SEGURIDAD, ...cors() });
    }
    console.error(`[ERROR] ${req.method} ${pathname}`, err);
    // Auditoría V-7/V-3: en producción NUNCA se filtra el detalle técnico
    // (mensaje de pg, stack, etc.) al cliente; se loguea completo en el server.
    const detalle = debugActivado() ? String(err && err.message || err) : null;
    return sendJson(res, 500, {
      error: 'Error interno del servidor.',
      ...(detalle ? { detalle } : { codigo: 'E_INTERNO' }),
    }, { ...HEADERS_SEGURIDAD, ...cors() });
  } finally {
    if (process.env.NODE_ENV !== 'production' && pathname.startsWith('/api/')) {
      console.log(`  ${req.method} ${pathname} -> ${res.statusCode} (${Date.now() - inicio} ms)`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Arranque                                                            */
/* ------------------------------------------------------------------ */

function ipLAN() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const lista of Object.values(interfaces)) {
    for (const itf of lista || []) {
      if (itf.family === 'IPv4' && !itf.internal) ips.push(itf.address);
    }
  }
  return ips;
}

function abrirNavegador(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

async function main() {
  console.log('');
  console.log('  ================================================================');
  console.log('   OPTIFLOW  -  Control de Tiempos y Trazabilidad en Planta');
  console.log('   Sector Placares  -  "De Otro Tiempo"   |   Fase 7 (Cloud)');
  console.log('  ================================================================');
  console.log('  · Abriendo base de datos (Supabase)...');
  await db.abrirConexion();

  const totalOT = (await db.get('SELECT COUNT(*) AS n FROM ordenes_trabajo;')).n;
  const totalReg = (await db.get('SELECT COUNT(*) AS n FROM registros_tiempos;')).n;
  const abiertas = (await db.get(
    `SELECT COUNT(*) AS n FROM registros_tiempos WHERE estado_etapa IN ('En Proceso','Pausado');`
  )).n;

  console.log(`  · Zona horaria : ${db.ZONA}`);
  console.log(`  · OTs: ${totalOT}  |  Registros de tiempo: ${totalReg}  |  Etapas abiertas: ${abiertas}`);
  console.log('  · Rutas API: ' + RUTAS.length + ' endpoints');
  console.log('');

  const servidor = http.createServer((req, res) => {
    manejar(req, res).catch((e) => {
      console.error('[FATAL]', e);
      try { sendJson(res, 500, { error: 'Error interno del servidor.' }); } catch { /* noop */ }
    });
  });

  servidor.listen(PUERTO, HOST, () => {
    const ips = ipLAN();
    console.log('  ---------------------------------------------------------------');
    console.log(`  SERVIDOR EN MARCHA  (puerto ${PUERTO})`);
    console.log(`    · En esta PC      : http://localhost:${PUERTO}`);
    ips.forEach((ip) => console.log(`    · Desde la planta : http://${ip}:${PUERTO}   <-- tablets / PCs`));
    console.log('  ---------------------------------------------------------------');
    console.log('    · Terminal de fichado : /');
    console.log('    · Administración OT   : /admin   (requiere iniciar sesión: /login.html)');
    console.log('    · Exportar CSV (BI)   : /api/export/registros.csv  (sesión o ?token=…)');
    console.log('  ---------------------------------------------------------------');
    console.log('    Para detener: Ctrl+C en esta ventana o detener.bat');
    console.log('');

    const args = process.argv.slice(2);
    if (!args.includes('--no-browser') && process.env.OPTIFLOW_NO_BROWSER !== '1') {
      setTimeout(() => abrirNavegador(`http://localhost:${PUERTO}`), 600);
    }
  });

  servidor.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n[ERROR] El puerto ${PUERTO} ya está en uso.`);
      console.error('        Cierre la instancia anterior de Optiflow (detener.bat) o\n');
      console.error('        ejecute: set PORT=3001 && start.bat\n');
    } else {
      console.error('[ERROR de red]', err);
    }
    process.exit(1);
  });

  const apagar = (senal) => {
    console.log(`\n  Cerrando Optiflow (${senal})...`);
    servidor.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  };
  process.on('SIGINT', () => apagar('SIGINT'));
  process.on('SIGTERM', () => apagar('SIGTERM'));
}

process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

// `manejar` se exporta para el Serverless Function de Vercel (api/[...slug].js).
// `main()` sólo se ejecuta cuando este archivo es el proceso de arranque local
// (node server/server.js / start.bat), no cuando lo requiere Vercel.
module.exports = { manejar, enrutar, servirEstatico };

if (require.main === module) {
  main().catch((e) => {
    console.error('\n[ERROR FATAL al arrancar]', e);
    process.exit(1);
  });
}
