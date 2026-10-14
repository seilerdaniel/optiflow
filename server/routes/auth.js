'use strict';

/**
 * ============================================================
 *  OPTIFLOW - Rutas de autenticación y usuarios (auditoría V-1)
 * ============================================================
 *  PÚBLICAS (sin sesión):
 *    POST /api/auth/login     { usuario, password } -> cookie HttpOnly
 *    POST /api/auth/logout    cierra la sesión vigente
 *    GET  /api/auth/usuario   { usuario: {...} | null } (200 siempre)
 *
 *  PROTEGIDAS (server.js aplica el middleware):
 *    GET  /api/usuarios       rol admin | encargado  (gestión)
 *    POST /api/usuarios       rol admin              (alta)
 *    PUT  /api/usuarios/:id   rol admin              (edición / password)
 *
 *  Los mensajes de login fallido son SIEMPRE genéricos (no revelan si el
 *  usuario existe) y hay rate limiting por IP+usuario (lib/auth).
 */

const db = require('../db');
const auth = require('../lib/auth');
const {
  ApiError, textoRequerido, textoOpcional, booleano, enumOpcion, entero,
} = require('../lib/http');

const ROLES = Object.freeze(['admin', 'encargado', 'operario']);

function publicarUsuario(u) {
  return { id: u.id, usuario: u.usuario, nombre: u.nombre, rol: u.rol };
}

function claveIntento(req) {
  const ip = String((req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '?'))
    .split(',')[0].trim();
  return `${ip}|${String((req.body && req.body.usuario) || '').toLowerCase()}`;
}

/* ------------------------------------------------------------------ */
/* Login / logout / quién soy                                          */
/* ------------------------------------------------------------------ */

async function login({ req, res, body }) {
  const usuario = String(body.usuario || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!usuario || !password) {
    throw new ApiError(400, 'Debe indicar usuario y contraseña.');
  }

  const clave = claveIntento(req);
  if (!auth.permitirIntento(clave)) {
    throw new ApiError(429, 'Demasiados intentos de acceso. Espere unos minutos y vuelva a intentar.',
      { accion: 'Si olvidó la contraseña, contacte al administrador del sistema.' });
  }

  const fila = await db.get(
    'SELECT id, usuario, nombre, rol, activo, password_hash, password_salt FROM usuarios WHERE usuario = ?;',
    usuario
  );
  const ok = fila && fila.activo && auth.verificarPassword(password, fila.password_hash, fila.password_salt);
  if (!ok) {
    throw new ApiError(401, 'Usuario o contraseña incorrectos.');
  }
  auth.registrarExito(clave);

  const { token, expira_en } = await auth.crearSesion(db, fila.id, req);
  await db.run('UPDATE usuarios SET ultimo_acceso = ? WHERE id = ?;', db.ahoraUTC(), fila.id);

  res.setHeader('Set-Cookie', auth.cookieSesion(token, req));
  return { status: 200, data: { usuario: publicarUsuario(fila), expira_en } };
}

async function logout({ req, res }) {
  const sesion = await auth.sesionDe(db, req);
  if (sesion) await auth.cerrarSesion(db, sesion.token);
  res.setHeader('Set-Cookie', auth.cookieBorrado(req));
  return { status: 200, data: { ok: true } };
}

async function usuarioActual({ req }) {
  const sesion = await auth.sesionDe(db, req);
  return {
    status: 200,
    data: { usuario: sesion ? publicarUsuario(sesion.usuario) : null },
  };
}

/* ------------------------------------------------------------------ */
/* Gestión de usuarios (sólo admin)                                    */
/* ------------------------------------------------------------------ */

async function listarUsuarios() {
  const filas = await db.all(`
    SELECT id, usuario, nombre, rol, activo, ultimo_acceso, fecha_creacion
      FROM usuarios
     ORDER BY activo DESC, lower(usuario) ASC
     LIMIT 500;`);
  return {
    status: 200,
    data: {
      total: filas.length,
      usuarios: filas.map((f) => ({
        id: f.id, usuario: f.usuario, nombre: f.nombre, rol: f.rol,
        activo: !!f.activo, ultimo_acceso: f.ultimo_acceso || null,
        fecha_creacion: f.fecha_creacion,
      })),
    },
  };
}

async function crearUsuario({ body }) {
  const usuario = textoRequerido(body.usuario, 'Usuario', { max: 40 }).toLowerCase();
  if (!/^[a-z0-9._-]+$/.test(usuario)) {
    throw new ApiError(400, 'El campo "Usuario" sólo puede tener letras minúsculas, números, punto, guion o guion bajo.');
  }
  const nombre = textoRequerido(body.nombre, 'Nombre visible', { max: 80 });
  const password = textoRequerido(body.password, 'Contraseña', { min: 6, max: 200 });
  const rol = enumOpcion(body.rol, ROLES, 'Rol');

  const existe = await db.get('SELECT id FROM usuarios WHERE usuario = ?;', usuario);
  if (existe) throw new ApiError(409, `El usuario "${usuario}" ya existe.`);

  const { hash, salt } = auth.hashearPassword(password);
  const ahora = db.ahoraUTC();
  const r = await db.run(`
    INSERT INTO usuarios (usuario, nombre, nombre_norm, email, password_hash, password_salt,
                          rol, activo, fecha_creacion, fecha_actualizacion)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
  usuario, nombre, usuario, textoOpcional(body.email, 'Email', { max: 120 }),
  hash, salt, rol, booleano(body.activo, true) ? 1 : 0, ahora, ahora);

  return { status: 201, data: db.mapUsuario(await db.get('SELECT * FROM usuarios WHERE id = ?;', r.lastInsertRowid)) };
}

async function actualizarUsuario({ params, body }) {
  const id = entero(params.id, 'id');
  const actual = await db.get('SELECT * FROM usuarios WHERE id = ?;', id);
  if (!actual) throw new ApiError(404, `No existe el usuario con id ${id}.`);

  const nombre = body.nombre === undefined ? actual.nombre
    : textoRequerido(body.nombre, 'Nombre visible', { max: 80 });
  const rol = body.rol === undefined ? actual.rol : enumOpcion(body.rol, ROLES, 'Rol');
  const activo = body.activo === undefined ? !!actual.activo : booleano(body.activo, !!actual.activo);
  const email = body.email === undefined ? actual.email
    : textoOpcional(body.email, 'Email', { max: 120 });

  // La contraseña sólo cambia si viene informada.
  let hash = actual.password_hash;
  let salt = actual.password_salt;
  if (body.password !== undefined && body.password !== null && body.password !== '') {
    const password = textoRequerido(body.password, 'Contraseña', { min: 6, max: 200 });
    ({ hash, salt } = auth.hashearPassword(password));
  }

  // Nunca se puede dejar al ÚLTIMO admin sin acceso o desactivado.
  if (actual.rol === 'admin' && (rol !== 'admin' || !activo)) {
    const otros = (await db.get(
      `SELECT COUNT(*) AS n FROM usuarios WHERE rol = 'admin' AND activo = 1 AND id <> ?;`, id
    )).n;
    if (!otros) {
      throw new ApiError(409, 'No se puede quitar el rol de admin ni desactivar al ÚLTIMO administrador activo.',
        { accion: 'Cree o reactive otro usuario admin antes de modificar este.' });
    }
  }

  await db.run(`
    UPDATE usuarios SET nombre = ?, rol = ?, activo = ?, email = ?,
                        password_hash = ?, password_salt = ?, fecha_actualizacion = ?
     WHERE id = ?;`,
  nombre, rol, activo ? 1 : 0, email, hash, salt, db.ahoraUTC(), id);

  return { status: 200, data: db.mapUsuario(await db.get('SELECT * FROM usuarios WHERE id = ?;', id)) };
}

module.exports = {
  login, logout, usuarioActual,
  listarUsuarios, crearUsuario, actualizarUsuario,
};
