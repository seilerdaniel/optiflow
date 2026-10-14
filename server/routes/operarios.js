'use strict';

/**
 * Endpoints del maestro de operarios (Fase 4).
 *
 * REGLAS DE NEGOCIO:
 *  O1. El maestro es la fuente de verdad para desplegables; el nombre en
 *      `registros_tiempos` sigue siendo un TEXT libre (trazabilidad histórica),
 *      pero al iniciar una etapa se valida contra el maestro.
 *  O2. Operario INCONOCIDO en `POST /api/registros`: se auto-registra
 *      transparentemente como activo (no se bloquea la planta por un alta olvidada).
 *  O3. Operario DESACTIVADO: no puede iniciar etapas (409), pero su historial
 *      se conserva íntegro. Re-activarlo basta para volver a usarlo.
 *  O4. Renombrar un operario propaga el cambio a `registros_tiempos`
 *      (COLLATE NOCASE) para corregir typos sin partir las métricas históricas.
 *
 * Fase 7 (PostgreSQL):
 *  - Las consultas son `await`.
 *  - `COLLATE NOCASE` de SQLite (que sólo pliega ASCII) se reemplaza por
 *    `lower(a) = lower(b)`. Es equivalente para este caso de uso y además
 *    pliega acentos, igual que hace la clave normalizada `nombre_norm`.
 */

const db = require('../db');
const {
  ApiError, textoRequerido, booleano, entero,
} = require('../lib/http');

const { claveNormalizada } = db;

/**
 * Garantiza que el operario exista en el maestro (auto-guardado, regla O2).
 * - Si existe y está activo: OK.
 * - Si existe y está inactivo: 409 (regla O3).
 * - Si no existe: lo inserta como activo.
 * Devuelve siempre { id, nombre } con la grafía CANÓNICA del maestro: el
 * registro de tiempo debe guardar esa, no la tipeada, para que los contadores
 * por operario casen aunque se tipee sin acentos o con otra mayúscula.
 */
async function asegurarOperario(db_, nombre) {
  const norm = claveNormalizada(nombre);
  const existente = await db_.get('SELECT id, nombre, activo FROM operarios WHERE nombre_norm = ?;', norm);
  if (existente) {
    if (!existente.activo) {
      throw new ApiError(409,
        `El operario "${nombre}" está DESACTIVADO en el maestro y no puede iniciar etapas.`,
        { accion: 'Reactívelo desde Administración → Operarios o utilice otro operario.' });
    }
    return { id: existente.id, nombre: existente.nombre };
  }
  const r = await db_.run(
    'INSERT INTO operarios (nombre, nombre_norm, activo, fecha_creacion) VALUES (?, ?, 1, ?);',
    nombre, norm, db_.ahoraUTC()
  ).catch(async (e) => {
    // Alta concurrente del mismo nombre (índice único de nombre_norm): otra
    // petición ganó la carrera; se reutiliza su fila en lugar de fallar.
    if (e && e.code === '23505') {
      const ganador = await db_.get('SELECT id, nombre, activo FROM operarios WHERE nombre_norm = ?;', norm);
      if (ganador) return { changes: 0, lastInsertRowid: ganador.id, _nombre: ganador.nombre };
    }
    throw e;
  });
  if (r._nombre !== undefined) return { id: r.lastInsertRowid, nombre: r._nombre };
  return { id: r.lastInsertRowid, nombre };
}

/**
 * GET /api/operarios
 * Por defecto devuelve sólo los activos (alimenta desplegables de la Terminal).
 * `?todos=1` incluye los inactivos (para la tabla de Administración).
 * Conserva el shape histórico `{ operarios: [{ nombre, etapas, ultima_actividad }] }`
 * y agrega `id`/`activo` (aditivo, no rompe a los consumidores existentes).
 */
async function listar({ query }) {
  const incluirInactivos = query.todos === '1' || query.todos === 'true';
  const where = incluirInactivos ? '' : 'WHERE op.activo = 1';

  const filas = await db.all(`
    SELECT op.id, op.nombre, op.activo, op.fecha_creacion,
           COALESCE(r.etapas, 0)    AS etapas,
           COALESCE(r.abiertas, 0)  AS etapas_abiertas,
           r.ultima
      FROM operarios op
      LEFT JOIN (
        SELECT op2.id AS op_id,
               COUNT(r2.id) AS etapas,
               SUM(CASE WHEN r2.estado_etapa IN ('En Proceso','Pausado') THEN 1 ELSE 0 END) AS abiertas,
               MAX(r2.fecha_hora_inicio) AS ultima
          FROM operarios op2
          JOIN registros_tiempos r2 ON lower(r2.operario_nombre) = lower(op2.nombre)
         GROUP BY op2.id
      ) r ON r.op_id = op.id
      ${where}
     ORDER BY op.activo DESC, lower(op.nombre) ASC
     LIMIT 500;`);

  return {
    status: 200,
    data: {
      total: filas.length,
      operarios: filas.map((f) => ({
        id: f.id,
        nombre: f.nombre,
        activo: !!f.activo,
        etapas: Number(f.etapas || 0),
        etapas_abiertas: Number(f.etapas_abiertas || 0),
        ultima_actividad: f.ultima || null,
        fecha_creacion: f.fecha_creacion,
      })),
    },
  };
}

/** POST /api/operarios — alta de operario. */
async function crear({ body }) {
  const nombre = textoRequerido(body.nombre, 'Nombre del operario', { max: 80 });
  const norm = claveNormalizada(nombre);
  const existe = await db.get('SELECT id, activo FROM operarios WHERE nombre_norm = ?;', norm);
  if (existe) {
    throw new ApiError(409,
      `El operario "${nombre}" ya está registrado${existe.activo ? '' : ' (y está DESACTIVADO)'}.`,
      { id: existe.id, activo: !!existe.activo, accion: 'Edítelo o reactívelo desde la lista de operarios.' });
  }

  const r = await db.run(
    'INSERT INTO operarios (nombre, nombre_norm, activo, fecha_creacion) VALUES (?, ?, ?, ?);',
    nombre, norm, booleano(body.activo, true) ? 1 : 0, db.ahoraUTC()
  );
  return { status: 201, data: db.mapOperario(await db.get('SELECT * FROM operarios WHERE id = ?;', r.lastInsertRowid)) };
}

/**
 * PUT /api/operarios/:id — renombrar y/o activar-desactivar.
 * El renombrado propaga a `registros_tiempos` (regla O4) en una transacción.
 */
async function actualizar({ params, body }) {
  const id = entero(params.id, 'id');
  const actual = await db.get('SELECT * FROM operarios WHERE id = ?;', id);
  if (!actual) throw new ApiError(404, `No existe el operario con id ${id}.`);

  const nombreNuevo = body.nombre === undefined ? actual.nombre
    : textoRequerido(body.nombre, 'Nombre del operario', { max: 80 });
  const activoNuevo = body.activo === undefined ? !!actual.activo : booleano(body.activo, !!actual.activo);

  const normNuevo = claveNormalizada(nombreNuevo);
  // Cambio de grafía visible: se propaga a registros (aunque sólo cambie la tilde,
  // para no dejar el maestro y los históricos con ortografías distintas).
  const cambioGrafia = nombreNuevo !== actual.nombre;
  // Choque sólo aplica contra OTROS operarios (la misma clave normalizada del propio
  // operario no es un conflicto: es el mismo, p. ej. corregir su tilde).
  if (normNuevo !== actual.nombre_norm) {
    const choque = await db.get('SELECT id FROM operarios WHERE nombre_norm = ? AND id <> ?;', normNuevo, id);
    if (choque) {
      throw new ApiError(409, `Ya existe otro operario llamado "${nombreNuevo}".`,
        { accion: 'Elija otro nombre o edite/elimine el operario en conflicto.' });
    }
  }

  let registrosActualizados = 0;
  await db.transaccion(async () => {
    await db.run('UPDATE operarios SET nombre = ?, nombre_norm = ?, activo = ? WHERE id = ?;',
      nombreNuevo, normNuevo, activoNuevo ? 1 : 0, id);
    if (cambioGrafia) {
      const r = await db.run(
        'UPDATE registros_tiempos SET operario_nombre = ? WHERE lower(operario_nombre) = lower(?);',
        nombreNuevo, actual.nombre
      );
      registrosActualizados = r.changes;
    }
  });

  return {
    status: 200,
    data: {
      ...db.mapOperario(await db.get('SELECT * FROM operarios WHERE id = ?;', id)),
      registros_actualizados: registrosActualizados,
    },
  };
}

module.exports = { listar, crear, actualizar, asegurarOperario };
