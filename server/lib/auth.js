'use strict';

/**
 * ============================================================
 *  OPTIFLOW - Autenticación de sesiones (auditoría V-1)
 * ============================================================
 *  - Contraseñas: scrypt (node:crypto) con salt aleatorio de 16 bytes.
 *    Se guardan hash+salt en `usuarios` (columnas password_hash/password_salt).
 *  - Sesiones: token aleatorio de 32 bytes viajado SÓLO en una cookie
 *    HttpOnly; en la base se guarda el SHA-256 del token (nunca el token).
 *  - Expiración fija (12 h por defecto, OPTIFLOW_SESION_HORAS).
 *  - Rate limiting simple en memoria para /api/auth/login.
 *
 *  ESTE MÓDULO NO REQUIERE `../db` (evita el ciclo con sembrar()): todas las
 *  funciones que tocan la base reciben el "db" como parámetro, al igual que
 *  operarios.asegurarOperario(db, nombre).
 */

const crypto = require('node:crypto');

const NOMBRE_COOKIE = 'optiflow_sesion';
const SECS_SESION = Math.max(1, Number(process.env.OPTIFLOW_SESION_HORAS) || 12) * 3600;
const SCRYPT_OPS = 16384;   // N por defecto de node (balance CPU/memoria)
const SCRYPT_KEYLEN = 64;

/* ------------------------------------------------------------------ */
/* Contraseñas                                                         */
/* ------------------------------------------------------------------ */

/** { hash, salt } en hex para una contraseña en texto plano. */
function hashearPassword(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN, { N: SCRYPT_OPS });
  return { hash: hash.toString('hex'), salt: salt.toString('hex') };
}

/** Comparación en tiempo constante (sin filtrar por longitud/timing). */
function verificarPassword(password, hashHex, saltHex) {
  if (!hashHex || !saltHex) return false;
  let esperado;
  try {
    esperado = Buffer.from(String(hashHex), 'hex');
  } catch {
    return false;
  }
  const sal = Buffer.from(String(saltHex), 'hex');
  const obtenido = crypto.scryptSync(String(password), sal, esperado.length || SCRYPT_KEYLEN, { N: SCRYPT_OPS });
  return esperado.length === obtenido.length && crypto.timingSafeEqual(esperado, obtenido);
}

/* ------------------------------------------------------------------ */
/* Tokens de sesión                                                    */
/* ------------------------------------------------------------------ */

/** Token opaco de 32 bytes (hex). Sólo viaja al cliente; no se persiste. */
function tokenSesion() {
  return crypto.randomBytes(32).toString('hex');
}

/** SHA-256 del token: lo que se guarda en `sesiones.token_hash`. */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** Clave int32 determinística (para advisory locks de pg). */
function clave32(texto) {
  const hex = crypto.createHash('sha256').update(String(texto)).digest('hex').slice(0, 8);
  return parseInt(hex, 16) | 0; // int32 con signo, rango válido de pg_advisory_*
}

/* ------------------------------------------------------------------ */
/* Cookies                                                             */
/* ------------------------------------------------------------------ */

function leerCookie(req, nombre) {
  const cabecera = req && req.headers && req.headers.cookie;
  if (!cabecera) return null;
  for (const par of String(cabecera).split(';')) {
    const i = par.indexOf('=');
    if (i < 0) continue;
    if (par.slice(0, i).trim() === nombre) {
      try { return decodeURIComponent(par.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

/** ¿La petición llegó por https? (Vercel termina TLS en el proxy). */
function esHttps(req) {
  const proto = req && req.headers && (req.headers['x-forwarded-proto'] || '');
  return String(proto).split(',')[0].trim() === 'https';
}

function cookieSesion(token, req) {
  const atributos = [
    `${NOMBRE_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${SECS_SESION}`,
  ];
  if (esHttps(req)) atributos.push('Secure');
  return atributos.join('; ');
}

function cookieBorrado(req) {
  const atributos = [`${NOMBRE_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (esHttps(req)) atributos.push('Secure');
  return atributos.join('; ');
}

/* ------------------------------------------------------------------ */
/* Sesiones en base de datos                                           */
/* ------------------------------------------------------------------ */

/**
 * Valida la cookie de la petición contra `sesiones` + `usuarios`.
 * Devuelve { sesion, usuario } o null si no hay sesión válida.
 */
async function sesionDe(db_, req) {
  const token = leerCookie(req, NOMBRE_COOKIE);
  if (!token) return null;
  const fila = await db_.get(`
    SELECT s.id AS sesion_id, s.expira_en, s.cerrada_en,
           u.id, u.usuario, u.nombre, u.rol, u.activo
      FROM sesiones s
      JOIN usuarios u ON u.id = s.usuario_id
     WHERE s.token_hash = ?;`, hashToken(token));
  if (!fila) return null;
  if (fila.cerrada_en) return null;
  if (Date.parse(fila.expira_en) <= Date.now()) return null;
  if (!fila.activo) return null;
  return {
    token,
    sesion: { id: fila.sesion_id, expira_en: fila.expira_en },
    usuario: { id: fila.id, usuario: fila.usuario, nombre: fila.nombre, rol: fila.rol },
  };
}

/** Crea la sesión y devuelve { token, expira_en }. */
async function crearSesion(db_, usuarioId, req) {
  const token = tokenSesion();
  const ahora = db_.ahoraUTC();
  const expira = new Date(Date.now() + SECS_SESION * 1000).toISOString();
  const ip = (req && (req.headers['x-forwarded-for'] || req.socket && req.socket.remoteAddress)) || null;
  const ua = (req && req.headers['user-agent']) || null;

  await db_.run(`
    INSERT INTO sesiones (usuario_id, token_hash, ip, user_agent, creada_en, expira_en, fecha_creacion)
    VALUES (?, ?, ?, ?, ?, ?, ?);`,
  usuarioId, hashToken(token), ip ? String(ip).split(',')[0].trim() : null,
  ua ? String(ua).slice(0, 300) : null, ahora, expira, ahora);

  // Limpieza oportunista de sesiones vencidas (barato: sólo al hacer login).
  await db_.run(`DELETE FROM sesiones WHERE expira_en < ?;`,
    new Date(Date.now() - 86400000).toISOString());

  return { token, expira_en: expira };
}

/** Cierra (invalida) la sesión del token dado. Idempotente. */
async function cerrarSesion(db_, token) {
  if (!token) return false;
  const r = await db_.run(
    'UPDATE sesiones SET cerrada_en = ? WHERE token_hash = ? AND cerrada_en IS NULL;',
    db_.ahoraUTC(), hashToken(token)
  );
  return r.changes > 0;
}

/* ------------------------------------------------------------------ */
/* Bootstrap del administrador inicial (auditoría V-1)                  */
/* ------------------------------------------------------------------ */

/**
 * Si la tabla `usuarios` está vacía, crea el administrador inicial:
 *  - usuario : OPTIFLOW_ADMIN_USER  (por defecto 'admin')
 *  - clave   : OPTIFLOW_ADMIN_PASSWORD  o, si no está, una ALEATORIA que se
 *              devuelve para imprimirla UNA sola vez en consola.
 * Devuelve { creado, usuario, passwordGenerada? }.
 */
async function asegurarAdminInicial(db_) {
  const total = (await db_.get('SELECT COUNT(*) AS n FROM usuarios;')).n;
  if (Number(total) > 0) return { creado: false };

  const usuario = (process.env.OPTIFLOW_ADMIN_USER || 'admin').trim().toLowerCase();
  const nombre = process.env.OPTIFLOW_ADMIN_NOMBRE || 'Administrador';
  const password = process.env.OPTIFLOW_ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  const { hash, salt } = hashearPassword(password);
  const ahora = db_.ahoraUTC();

  await db_.run(`
    INSERT INTO usuarios (usuario, nombre, nombre_norm, email, password_hash, password_salt,
                          rol, activo, fecha_creacion, fecha_actualizacion)
    VALUES (?, ?, ?, NULL, ?, ?, 'admin', 1, ?, ?);`,
  usuario, usuario, usuario, hash, salt, ahora, ahora);

  return { creado: true, usuario, passwordGenerada: !process.env.OPTIFLOW_ADMIN_PASSWORD };
}

/* ------------------------------------------------------------------ */
/* Rate limiting de login (en memoria, por instancia)                   */
/* ------------------------------------------------------------------ */

const INTENTOS_MAX = Math.max(1, Number(process.env.OPTIFLOW_LOGIN_MAX) || 8);
const VENTANA_MS = 15 * 60 * 1000;
const intentos = new Map(); // clave -> { n, desde }

/** ¿Se permiten más intentos de login para esta clave (IP|usuario)? */
function permitirIntento(clave) {
  const ahora = Date.now();
  const reg = intentos.get(clave);
  if (!reg || ahora - reg.desde > VENTANA_MS) {
    intentos.set(clave, { n: 1, desde: ahora });
    return true;
  }
  reg.n += 1;
  return reg.n <= INTENTOS_MAX;
}

function registrarExito(clave) {
  intentos.delete(clave);
}

/** Evita que el Map crezca sin límite entre logins. */
setInterval(() => {
  const ahora = Date.now();
  for (const [k, v] of intentos) if (ahora - v.desde > VENTANA_MS) intentos.delete(k);
}, 5 * 60 * 1000).unref();

module.exports = {
  NOMBRE_COOKIE,
  SECS_SESION,
  hashearPassword,
  verificarPassword,
  tokenSesion,
  hashToken,
  clave32,
  leerCookie,
  cookieSesion,
  cookieBorrado,
  sesionDe,
  crearSesion,
  cerrarSesion,
  asegurarAdminInicial,
  permitirIntento,
  registrarExito,
};
