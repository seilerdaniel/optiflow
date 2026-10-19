'use strict';

/**
 * ============================================================
 *  RECONFIGURACIÓN DE RAÍZ DE LA AUTENTICACIÓN
 * ============================================================
 *
 * Punto de partida limpio: purga sesiones y usuarios y crea un único
 * administrador desde cero.
 *
 *   node server/tools/reconfigurar-auth.js
 *
 * ORDEN CRÍTICO (por cómo arranca db.js):
 *   1. `abrirConexion()` ejecuta `sembrar()` -> `asegurarAdminInicial()`,
 *      que sólo crea un admin SI `usuarios` está vacía. Por eso se ABRE
 *      primero (la tabla aún tiene los usuarios viejos -> no crea nada) y
 *      sólo DESPUÉS se trunca. Si la tabla estuviera ya vacía, el bootstrap
 *      crearía un admin con OPTIFLOW_ADMIN_PASSWORD y este script lo
 *      reemplazaría igualmente: el resultado final es siempre el mismo.
 *
 * TRUNCATE DE AMBAS TABLAS EN UNA SOLA SENTENCIA:
 *   `sesiones.usuario_id` referencia `usuarios(id)`. En PostgreSQL,
 *   `TRUNCATE usuarios` solo falla con "cannot truncate a table referenced
 *   in a foreign key constraint"; hay que listar las dos tablas juntas.
 *   No se usa CASCADE para no arrojar nunca sobre tablas desconocidas.
 *
 * HASH:
 *   scrypt (node:crypto) con los MISMOS parámetros que server/lib/auth.js
 *   (N=16384, keylen=64, salt de 16 bytes), en hex. Se verifica al final
 *   con `auth.verificarPassword`, la misma función que invoca el login.
 *
 * CREDENCIALES:
 *   Se pueden sobreescribir por entorno (recomendado en producción):
 *     OPTIFLOW_ADMIN_USER=admin
 *     OPTIFLOW_ADMIN_PASSWORD=1369ringo
 *   Si no existen, se usan los valores por defecto de esta instalación.
 */

const crypto = require('node:crypto');
const db = require('../db');
const auth = require('../lib/auth');

const USUARIO = (process.env.OPTIFLOW_ADMIN_USER || 'admin').trim().toLowerCase();
const PASSWORD = process.env.OPTIFLOW_ADMIN_PASSWORD || '1369ringo';
const ROL = 'admin';

// Idénticos a server/lib/auth.js (SCRYPT_OPS / SCRYPT_KEYLEN).
const SCRYPT_OPS = 16384;
const SCRYPT_KEYLEN = 64;

async function main() {
  await db.abrirConexion();

  // ---------- 1. Limpieza total (sesiones -> usuarios, una sentencia) ----------
  const antesSes = Number((await db.get('SELECT COUNT(*) AS n FROM sesiones;')).n);
  const antesUsu = Number((await db.get('SELECT COUNT(*) AS n FROM usuarios;')).n);

  await db.run('TRUNCATE TABLE sesiones, usuarios RESTART IDENTITY;');

  // ---------- 2. Admin desde cero con node:crypto (scrypt + salt) ----------
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(PASSWORD), salt, SCRYPT_KEYLEN, { N: SCRYPT_OPS });
  const hashHex = hash.toString('hex');
  const saltHex = salt.toString('hex');

  const ahora = db.ahoraUTC();
  await db.run(`
    INSERT INTO usuarios (usuario, nombre, nombre_norm, email, password_hash,
                          password_salt, rol, activo, fecha_creacion, fecha_actualizacion)
    VALUES (?, ?, ?, NULL, ?, ?, ?, 1, ?, ?);`,
  USUARIO, USUARIO, db.claveNormalizada(USUARIO), hashHex, saltHex, ROL, ahora, ahora);

  // ---------- 3. Verificación ----------
  // NOTA: la columna real es `usuario` (no existe `username`).
  const usuarios = await db.all(
    'SELECT id, usuario, rol, fecha_creacion FROM usuarios ORDER BY id;'
  );
  const nSesiones = Number((await db.get('SELECT COUNT(*) AS n FROM sesiones;')).n);
  const nUsuarios = usuarios.length;

  // El login resuelve por `usuario` y valida con auth.verificarPassword:
  // probarlo aquí demuestra que la clave escrita SÍ abrirá sesión.
  const fila = await db.get(
    'SELECT usuario, password_hash, password_salt, rol, activo FROM usuarios WHERE usuario = ?;',
    USUARIO
  );
  const claveValida = !!fila && auth.verificarPassword(PASSWORD, fila.password_hash, fila.password_salt);
  const rolOk = !!fila && fila.rol === ROL && Number(fila.activo) === 1;

  console.log('');
  console.log(`  · Antes: ${antesUsu} usuario(s) · ${antesSes} sesion(es)`);
  console.log(`  · TRUNCATE sesiones + usuarios ejecutado (RESTART IDENTITY)`);
  console.log('');
  console.log('  SELECT id, usuario, rol, fecha_creacion FROM usuarios;');
  console.log('  --------------------------------------------------');
  for (const u of usuarios) {
    console.log(`  ${String(u.id).padStart(3)} | ${String(u.usuario).padEnd(10)} | ${String(u.rol).padEnd(6)} | ${u.fecha_creacion}`);
  }
  console.log('  --------------------------------------------------');
  console.log(`  · usuarios  = ${nUsuarios} (esperado 1)  ${nUsuarios === 1 ? 'OK' : 'FALLO'}`);
  console.log(`  · sesiones  = ${nSesiones} (esperado 0)  ${nSesiones === 0 ? 'OK' : 'FALLO'}`);
  console.log(`  · scrypt    = ${hashHex.length} hex · salt = ${saltHex.length} hex · N=${SCRYPT_OPS}`);
  console.log(`  · clave     = ${claveValida ? 'valida por auth.verificarPassword OK' : 'NO VALIDA'}`);
  console.log(`  · rol/activo= ${rolOk ? 'admin + activo OK' : 'FALLO'}`);
  console.log('');

  const todoOk = nUsuarios === 1 && nSesiones === 0 && claveValida && rolOk;
  if (!todoOk) {
    console.error('[ERROR] La reconfiguración NO quedó en el estado esperado (ver arriba).');
    await db.cerrarConexion();
    process.exit(1);
  }

  console.log(`[OK] Base de datos reconfigurada: Usuario '${USUARIO}' creado correctamente con clave '${PASSWORD}'.`);
  console.log('');

  await db.cerrarConexion();
}

main().catch((e) => {
  console.error('[ERROR] Falló la reconfiguración:', e.message);
  process.exit(1);
});
