'use strict';

/**
 * Endpoints de Sectores (maestro de áreas de trabajo, Fase 5).
 *
 * REGLAS DE NEGOCIO:
 *  S1. El nombre es único en el maestro, insensible a mayúsculas y acentos
 *      (clave normalizada, igual que en operarios).
 *  S2. `linea_area` clasifica el sector: 'Placares' | 'Cocinas' (flujo propio),
 *      'Compartido' (talleres que atienden ambas líneas) o 'General'.
 *      Define qué OTs pueden fichar en él y en qué posición del flujo entra.
 *  S3. Por defecto sólo se listan los ACTIVOS (alimenta Terminal y filtros);
 *      `?todos=1` los incluye todos para la tabla de Administración.
 *  S4. Renombrar un sector NO necesita propagar nada a `registros_tiempos`:
 *      esa tabla guarda `sector_id` y todos los reportes hacen JOIN con
 *      `sectores`, así que el nombre histórico siempre se lee de la fuente
 *      única de verdad (no hay copia que se desincronice).
 *
 * Fase 7: todas las consultas son `await` porque el backing pasó de SQLite
 * (síncrono) a Supabase/PostgreSQL (de red).
 */

const db = require('../db');
const {
  ApiError, textoRequerido, textoOpcional, booleano, enumOpcion,
} = require('../lib/http');

const { claveNormalizada } = db;

/** Nombre corto por defecto cuando no se envía (la columna es NOT NULL). */
function derivarCorto(nombre) {
  const t = String(nombre).trim();
  return t.length <= 26 ? t : `${t.slice(0, 25).trimEnd()}…`;
}

/** `orden_flujo`: entero >= 0, o null/'' para asignarlo automáticamente. */
function parseOrden(valor) {
  if (valor === undefined || valor === null || valor === '') return null;
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 0) {
    throw new ApiError(400, 'El campo "orden_flujo" debe ser un entero mayor o igual a 0.');
  }
  return n;
}

/**
 * GET /api/sectores
 * Por defecto sólo activos (S3). `?todos=1` incluye los dados de baja.
 * Orden: por línea y luego por `orden_flujo` (la secuencia visual del flujo).
 */
async function listar({ query }) {
  const todos = query.todos === '1' || query.todos === 'true';
  const filas = (await db.all(`
    SELECT * FROM sectores
     ${todos ? '' : 'WHERE activo = 1'}
     ORDER BY CASE linea_area
                WHEN 'Placares'  THEN 0
                WHEN 'Cocinas'   THEN 1
                WHEN 'Compartido' THEN 2
                ELSE 3
              END,
              orden_flujo ASC, id ASC;`))
    .map(db.mapSector);

  // Actividad en vivo: cuántas etapas abiertas hay por sector ahora mismo.
  // (SQLite: GROUP_CONCAT(DISTINCT x) -> Postgres: string_agg(DISTINCT x, ','))
  const actividad = await db.all(`
    SELECT r.sector_id,
           COUNT(*) AS abiertas,
           string_agg(DISTINCT o.numero_ot, ',') AS ordenes
      FROM registros_tiempos r
      JOIN ordenes_trabajo o ON o.id = r.ot_id
     WHERE r.estado_etapa IN ('En Proceso','Pausado')
     GROUP BY r.sector_id;`);
  const porId = new Map(actividad.map((a) => [a.sector_id, a]));

  return {
    status: 200,
    data: {
      total: filas.length,
      incluye_inactivos: todos,
      sectores: filas.map((s) => ({
        ...s,
        etapas_abiertas: porId.get(s.id) ? porId.get(s.id).abiertas : 0,
        ordenes_activas: porId.get(s.id) ? String(porId.get(s.id).ordenes || '').split(',').filter(Boolean) : [],
      })),
    },
  };
}

/**
 * POST /api/sectores — alta de un sector/área de trabajo.
 * Body: { nombre_sector, linea_area?, es_compartido?, orden_flujo?,
 *         operarios_sugeridos?, nombre_corto? }
 * `409` si el nombre ya existe (insensible a mayúsculas/acentos) — S1.
 */
async function crear({ body }) {
  const nombre_sector = textoRequerido(body.nombre_sector, 'Nombre del sector', { max: 80 });
  const norm = claveNormalizada(nombre_sector);

  const existe = (await db.all('SELECT id, activo, nombre_sector FROM sectores;'))
    .find((s) => claveNormalizada(s.nombre_sector) === norm);
  if (existe) {
    throw new ApiError(409,
      `El sector "${nombre_sector}" ya existe${existe.activo ? '' : ' (y está DESACTIVADO)'}.`,
      { id: existe.id, accion: 'Edítelo desde la lista de sectores en lugar de crearlo de nuevo.' });
  }

  const linea_area = body.linea_area === undefined || body.linea_area === null || body.linea_area === ''
    ? 'General'
    : enumOpcion(body.linea_area, db.LINEAS_AREA, 'Línea / área');
  const nombre_corto = body.nombre_corto === undefined || body.nombre_corto === null || body.nombre_corto === ''
    ? derivarCorto(nombre_sector)
    : textoRequerido(body.nombre_corto, 'Nombre corto', { max: 30 });

  const orden = parseOrden(body.orden_flujo);
  const ordenFinal = orden === null ? await siguienteOrden(linea_area) : orden;

  const r = await db.run(`
    INSERT INTO sectores
      (nombre_sector, nombre_corto, es_compartido, clave_especial,
       linea_area, orden_flujo, operarios_sugeridos, activo)
    VALUES (?, ?, ?, NULL, ?, ?, ?, 1);`,
    nombre_sector, nombre_corto, booleano(body.es_compartido, false) ? 1 : 0,
    linea_area, ordenFinal,
    textoOpcional(body.operarios_sugeridos, 'Operarios sugeridos', { max: 300 })
  );

  return { status: 201, data: db.mapSector(await db.get('SELECT * FROM sectores WHERE id = ?;', r.lastInsertRowid)) };
}

/** Siguiente posición libre de `linea_area` (para no pedir el orden a mano). */
async function siguienteOrden(linea) {
  const row = await db.get('SELECT COALESCE(MAX(orden_flujo), 0) AS m FROM sectores WHERE linea_area = ?;', linea);
  return Number(row.m) + 1;
}

/**
 * PUT /api/sectores/:id — edición parcial.
 * Acepta: nombre_sector, nombre_corto, linea_area, es_compartido,
 * orden_flujo, operarios_sugeridos, activo. Los campos ausentes no cambian.
 */
async function actualizar({ params, body }) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, 'Identificador de sector inválido.');

  const actual = await db.get('SELECT * FROM sectores WHERE id = ?;', id);
  if (!actual) throw new ApiError(404, `No existe el sector con id ${id}.`);

  const nombre_sector = body.nombre_sector === undefined
    ? actual.nombre_sector
    : textoRequerido(body.nombre_sector, 'Nombre del sector', { max: 80 });

  // S1: el nuevo nombre no puede pertenecer a OTRO sector.
  if (claveNormalizada(nombre_sector) !== claveNormalizada(actual.nombre_sector)) {
    const choque = (await db.all('SELECT id, nombre_sector FROM sectores;'))
      .find((s) => s.id !== id && claveNormalizada(s.nombre_sector) === claveNormalizada(nombre_sector));
    if (choque) {
      throw new ApiError(409, `Ya existe otro sector llamado "${choque.nombre_sector}".`,
        { accion: 'Elija otro nombre o edite/elimine el sector en conflicto.' });
    }
  }

  const nombre_corto = body.nombre_corto === undefined
    ? actual.nombre_corto
    : (body.nombre_corto === null || String(body.nombre_corto).trim() === ''
      ? derivarCorto(nombre_sector)
      : textoRequerido(body.nombre_corto, 'Nombre corto', { max: 30 }));

  const linea_area = body.linea_area === undefined
    ? actual.linea_area
    : enumOpcion(body.linea_area, db.LINEAS_AREA, 'Línea / área');

  const ordenCrudo = body.orden_flujo === undefined ? undefined : parseOrden(body.orden_flujo);
  const orden = body.orden_flujo === undefined
    ? Number(actual.orden_flujo)
    : (ordenCrudo === null ? Number(actual.orden_flujo) : ordenCrudo);

  await db.run(`
    UPDATE sectores SET
      nombre_sector = ?, nombre_corto = ?, es_compartido = ?,
      linea_area = ?, orden_flujo = ?, operarios_sugeridos = ?, activo = ?
    WHERE id = ?;`,
    nombre_sector, nombre_corto,
    booleano(body.es_compartido, !!actual.es_compartido) ? 1 : 0,
    linea_area, orden,
    body.operarios_sugeridos === undefined
      ? actual.operarios_sugeridos
      : textoOpcional(body.operarios_sugeridos, 'Operarios sugeridos', { max: 300 }),
    booleano(body.activo, actual.activo === undefined ? true : !!actual.activo) ? 1 : 0,
    id
  );

  return {
    status: 200,
    data: {
      ...db.mapSector(await db.get('SELECT * FROM sectores WHERE id = ?;', id)),
      // S4: los registros históricos se leen por JOIN con sector_id, así que el
      // renombrado ya quedó reflejado en todos los reportes sin copias que mantener.
      registros_historicos_actualizados: (await db.get(
        'SELECT COUNT(*) AS n FROM registros_tiempos WHERE sector_id = ?;', id)).n,
    },
  };
}

module.exports = { listar, crear, actualizar };
