'use strict';

/**
 * Endpoints de Órdenes de Trabajo (OT).
 *
 * Fase 7 (Supabase / PostgreSQL): las consultas son `await` y las operaciones
 * multi-tabla (OT + materiales) corren dentro de UNA transacción real, así un
 * corte en el runtime efímero de Vercel no deja la OT a medio cargar.
 */

const db = require('../db');
const { ApiError } = require('../lib/http');
const {
  textoRequerido, textoOpcional, decimal, fecha, booleano, enumOpcion, entero,
} = require('../lib/http');

/* ------------------------------------------------------------------ */
/* Materiales / placas de una OT (Fase 3)                              */
/* ------------------------------------------------------------------ */

/**
 * Valida la lista dinámica de materiales recibida en el body.
 * Entrada: [{ material_nombre, cantidad_placas, cantidad_consumida?, observaciones? }]
 * Devuelve filas listas para insertar (siempre dentro de una transacción).
 */
function validarMateriales(body) {
  if (body.materiales === undefined || body.materiales === null) return null;
  if (!Array.isArray(body.materiales)) {
    throw new ApiError(400, 'El campo "materiales" debe ser una lista.');
  }
  const filas = [];
  const vistos = new Map();
  body.materiales.forEach((m, i) => {
    if (!m || typeof m !== 'object') throw new ApiError(400, `Material #${i + 1}: formato inválido.`);
    const nombre = textoRequerido(m.material_nombre, `Material #${i + 1} (nombre)`, { max: 140 });
    const clave = nombre.toLowerCase();
    if (vistos.has(clave)) {
      throw new ApiError(400,
        `El material "${nombre}" está repetido (aparece en las filas ${vistos.get(clave)} y ${i + 1}). Junte las cantidades en una sola fila.`);
    }
    vistos.set(clave, i + 1);
    const requeridas = decimal(m.cantidad_placas, `Material "${nombre}" (cantidad de placas)`,
      { min: 0.01, max: 100000, requerido: true });
    const consumidas = m.cantidad_consumida === undefined || m.cantidad_consumida === null || m.cantidad_consumida === ''
      ? 0
      : decimal(m.cantidad_consumida, `Material "${nombre}" (placas consumidas)`, { min: 0, max: 100000 });
    if (consumidas > requeridas) {
      throw new ApiError(400,
        `Material "${nombre}": las placas consumidas (${consumidas}) no pueden superar las requeridas (${requeridas}).`);
    }
    filas.push({
      material_nombre: nombre,
      cantidad_placas: requeridas,
      cantidad_consumida: consumidas,
      observaciones: textoOpcional(m.observaciones, `Material "${nombre}" (observaciones)`, { max: 300 }),
    });
  });
  return filas;
}

/** Inserta la lista de materiales de una OT (usar dentro de transacción). */
async function insertarMateriales(otId, filas, ahora) {
  const ids = [];
  for (const f of filas) {
    const r = await db.run(`
      INSERT INTO ot_materiales
        (ot_id, material_nombre, cantidad_placas, cantidad_consumida, observaciones,
         fecha_creacion, fecha_actualizacion)
      VALUES (?, ?, ?, ?, ?, ?, ?);`,
      otId, f.material_nombre, f.cantidad_placas, f.cantidad_consumida, f.observaciones, ahora, ahora
    );
    ids.push(r.lastInsertRowid);
  }
  return ids;
}

/** Materiales de una OT con resumen de placas (usado por create/update). */
async function conMateriales(otId) {
  const materiales = (await db.all(
    'SELECT * FROM ot_materiales WHERE ot_id = ? ORDER BY id;', otId
  )).map(db.mapMaterial);
  return {
    materiales,
    resumen_materiales: db.resumenMateriales(materiales),
  };
}

/**
 * Sectores requeridos por una OT: el flujo regular de SU línea + los
 * especiales que la OT tenga marcados. Los inactivos quedan fuera (no deben
 * bloquear el avance de la OT).
 */
function sectoresRequeridos(ot, sectores) {
  const linea = ot.linea_area || 'Placares';
  const requeridos = sectores.filter(
    (s) => !s.clave_especial && s.activo !== false && db.sectorAplica(s, linea)
  );
  for (const s of sectores) {
    if (!s.clave_especial || s.activo === false) continue;
    if (!db.sectorAplica(s, linea)) continue;
    if (ot[`requiere_${s.clave_especial}`]) requeridos.push(s);
  }
  // Orden estable para el progreso/UI: el de la línea primero, luego los demás.
  return requeridos.sort((a, b) => {
    const propia = ((a.linea_area || '') === linea ? 0 : 1) - ((b.linea_area || '') === linea ? 0 : 1);
    return propia || (Number(a.orden_flujo) - Number(b.orden_flujo)) || (a.id - b.id);
  });
}

/* ------------------------------------------------------------------ */
/* Carga batch (anti N+1)                                              */
/* ------------------------------------------------------------------ */
/*
 * El listado hace SIEMPRE 3 viajes a la base, sin importar cuántas OTs
 * devuelva:
 *   1. OTs + catálogo de sectores (una sola consulta con `json_agg`).
 *   2. Etapas finalizadas/abiertas de todas las OTs (`ot_id = ANY(?)`).
 *   3. Materiales + no conformidades de todas las OTs (`ot_id = ANY(?)`).
 * El cruce posterior es 100 % CPU y usa Map indexados por ot_id.
 */

function jsonArray(valor) {
  if (Array.isArray(valor)) return valor;
  if (typeof valor === 'string') {
    try {
      const parseado = JSON.parse(valor);
      return Array.isArray(parseado) ? parseado : null;
    } catch {
      return null;
    }
  }
  return null;
}

function jsonObject(valor) {
  if (valor && typeof valor === 'object' && !Array.isArray(valor)) return valor;
  if (typeof valor === 'string') {
    try {
      const parseado = JSON.parse(valor);
      return parseado && typeof parseado === 'object' && !Array.isArray(parseado) ? parseado : null;
    } catch {
      return null;
    }
  }
  return null;
}

function tiempoRegistro(valor) {
  if (!valor) return 0;
  const t = new Date(valor).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** Mapa ot_id -> { finalizados, finalizadosSet, minutos, abierta }. */
function indexarEtapas(registros) {
  const mapa = new Map();
  for (const fila of registros || []) {
    const otId = Number(fila.ot_id);
    let ctx = mapa.get(otId);
    if (!ctx) {
      ctx = { finalizados: [], finalizadosSet: new Set(), minutos: 0, abierta: null };
      mapa.set(otId, ctx);
    }
    if (fila.estado_etapa === 'Finalizado') {
      ctx.minutos += Number(fila.duracion_minutos) || 0;
      const sectorId = Number(fila.sector_id);
      if (!ctx.finalizadosSet.has(sectorId)) {
        ctx.finalizadosSet.add(sectorId);
        ctx.finalizados.push(sectorId);
      }
    } else if (fila.estado_etapa === 'En Proceso' || fila.estado_etapa === 'Pausado') {
      // La consulta ya ordena, pero se compara igual para que el ensamblado
      // no dependa del orden que devuelva un driver/mock.
      if (!ctx.abierta
        || tiempoRegistro(fila.fecha_hora_inicio) > tiempoRegistro(ctx.abierta.fecha_hora_inicio)
        || (tiempoRegistro(fila.fecha_hora_inicio) === tiempoRegistro(ctx.abierta.fecha_hora_inicio)
          && Number(fila.id) > Number(ctx.abierta.id))) {
        ctx.abierta = fila;
      }
    }
  }
  return mapa;
}

function mapAlertaNoConformidad(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    ot_id: Number(row.ot_id),
    sector_id: row.sector_id === null || row.sector_id === undefined ? null : Number(row.sector_id),
    nombre_sector: row.nombre_sector || null,
    tipo_falla: row.tipo_falla,
    estado: row.estado,
    accion_correctiva: row.accion_correctiva || null,
    fecha_registro: row.fecha_registro || null,
    fecha_registro_local: db.aLocalLegible(row.fecha_registro),
  };
}

/** Mapa ot_id -> { materiales, alertas } a partir de la consulta 3. */
function indexarMaterialesYAlertas(filas) {
  const mapa = new Map();
  for (const fila of filas || []) {
    const otId = Number(fila.ot_id);
    const materiales = (jsonArray(fila.materiales) || []).map(db.mapMaterial);
    const alertas = (jsonArray(fila.alertas) || []).map(mapAlertaNoConformidad);
    mapa.set(otId, { materiales, alertas });
  }
  return mapa;
}

/**
 * Enriquece una OT con el contexto ya cargado. Es una función pura: no
 * ejecuta SQL. El mismo ensamblado se usa en listado y detalle.
 */
function construirOT(ot, sectores, contexto = {}) {
  const requeridos = sectoresRequeridos(ot, sectores);
  const idsRequeridos = new Set(requeridos.map((s) => Number(s.id)));
  const ctx = contexto.etapas || { finalizados: [], finalizadosSet: new Set(), minutos: 0, abierta: null };
  const finalizadosAll = ctx.finalizados;
  // Set con id numérico y textual: los prerrequisitos comparan contra el id
  // tal como venga del catálogo de sectores.
  const finalizados = new Set();
  for (const id of finalizadosAll) {
    finalizados.add(id);
    finalizados.add(Number(id));
    finalizados.add(String(id));
  }
  const ok = finalizadosAll.filter((id) => idsRequeridos.has(Number(id))).length;

  // Sectores bloqueados por el flujo (prerrequisitos pendientes) — Fase 2.
  const bloqueados = {};
  if (ot.estado_general !== 'Finalizado') {
    for (const s of requeridos) {
      if (finalizados.has(Number(s.id))) continue;
      const faltan = db.prerrequisitosSector(ot, s.id, sectores, finalizados);
      if (faltan.length) {
        bloqueados[s.id] = `Requiere finalizar: ${faltan.map((f) => f.nombre_corto || f.nombre_sector).join(', ')}`;
      }
    }
  }

  const etapaActiva = ctx.abierta ? db.mapRegistro(ctx.abierta) : null;
  const materiales = (contexto.materiales && contexto.materiales.materiales) || [];
  const alertas = (contexto.materiales && contexto.materiales.alertas) || [];

  return {
    ...ot,
    sectores_requeridos: requeridos.map((s) => s.id),
    progreso: {
      sectores_requeridos: requeridos.length,
      sectores_finalizados: ok,
      porcentaje: requeridos.length ? Math.round((ok / requeridos.length) * 100) : 0,
      finalizados_ids: finalizadosAll,
    },
    minutos_acumulados: Math.round((ctx.minutos || 0) * 100) / 100,
    etapa_activa: etapaActiva,
    sectores_bloqueados: bloqueados,
    // Campos aditivos para los consumidores que ya los esperaban.
    sector_actual: etapaActiva ? {
      id: etapaActiva.sector_id,
      sector_id: etapaActiva.sector_id,
      nombre_sector: etapaActiva.nombre_sector || null,
      nombre_corto: etapaActiva.nombre_corto || null,
      estado_etapa: etapaActiva.estado_etapa,
      fecha_hora_inicio: etapaActiva.fecha_hora_inicio,
    } : null,
    etapas_completadas: finalizadosAll,
    total_etapas_completadas: finalizadosAll.length,
    materiales,
    resumen_materiales: db.resumenMateriales(materiales),
    alertas,
    alertas_abiertas: alertas.filter((a) => a.estado === 'Pendiente' || a.estado === 'En Reproceso').length,
  };
}

/** Filtros opcionales del listado (además del filtrado client-side actual). */
function filtrosOT(query = {}) {
  const where = [];
  const params = [];
  const linea = query.linea_area || query.linea;
  if (linea) {
    const valor = enumOpcion(linea, db.LINEAS_OT, 'Línea / área');
    where.push('o.linea_area = ?');
    params.push(valor);
  }
  const estado = query.estado || query.estado_general;
  if (estado) {
    const valor = enumOpcion(estado, db.ESTADOS_OT, 'Estado general');
    where.push('o.estado_general = ?');
    params.push(valor);
  }
  const texto = textoOpcional(query.q || query.buscar, 'Búsqueda', { max: 80 });
  if (texto) {
    const patron = `%${texto}%`;
    where.push('(o.numero_ot ILIKE ? OR o.cliente ILIKE ? OR o.modelo ILIKE ?)');
    params.push(patron, patron, patron);
  }
  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

/** Consulta 1: OTs filtradas + catálogo de sectores en un solo viaje. */
async function cargarSectoresYOTs(query = {}) {
  const { whereSql, params } = filtrosOT(query);
  const row = await db.get(`
    WITH ots AS (
      SELECT o.*,
             row_number() OVER (
               ORDER BY
                 CASE o.estado_general
                   WHEN 'En Producción' THEN 0
                   WHEN 'Detenido'      THEN 1
                   WHEN 'En Cola'       THEN 2
                   ELSE 3
                 END,
                 o.fecha_prometida IS NULL, o.fecha_prometida, o.numero_ot DESC
             ) AS __orden
        FROM ordenes_trabajo o
        ${whereSql}
    )
    SELECT
      COALESCE((SELECT json_agg(s ORDER BY s.id) FROM sectores s), '[]'::json) AS sectores,
      COALESCE((SELECT json_agg(o ORDER BY o.__orden) FROM ots o), '[]'::json) AS ordenes;
  `, ...params);

  let sectores = jsonArray(row && row.sectores);
  let ordenes = jsonArray(row && row.ordenes);

  // Fallback para drivers/mocks que no devuelven agregados JSON.
  if (!sectores || !ordenes) {
    const [filasSectores, filasOrdenes] = await Promise.all([
      db.all('SELECT * FROM sectores ORDER BY id;'),
      db.all(`
        SELECT * FROM ordenes_trabajo o
        ${whereSql}
        ORDER BY
          CASE o.estado_general
            WHEN 'En Producción' THEN 0
            WHEN 'Detenido'      THEN 1
            WHEN 'En Cola'       THEN 2
            ELSE 3
          END,
          o.fecha_prometida IS NULL, o.fecha_prometida, o.numero_ot DESC;`, ...params),
    ]);
    sectores = filasSectores;
    ordenes = filasOrdenes;
  }

  return {
    sectores: sectores.map(db.mapSector),
    ordenes: ordenes.map(db.mapOT),
  };
}

/** Consulta 1 (detalle): OT + sectores en un solo viaje. */
async function cargarOTPorId(id) {
  const row = await db.get(`
    SELECT
      COALESCE((SELECT json_agg(s ORDER BY s.id) FROM sectores s), '[]'::json) AS sectores,
      (SELECT to_jsonb(o) FROM ordenes_trabajo o WHERE o.id = ?) AS orden;
  `, id);

  let sectores = jsonArray(row && row.sectores);
  let orden = jsonObject(row && row.orden);

  if (!sectores) sectores = await db.all('SELECT * FROM sectores ORDER BY id;');
  if (!orden) orden = await db.get('SELECT * FROM ordenes_trabajo WHERE id = ?;', id);
  if (!orden) return null;

  return { sectores: sectores.map(db.mapSector), ot: db.mapOT(orden) };
}

/** Consulta 2: etapas de todas las OTs (finalizadas + abiertas vigentes). */
async function cargarRegistros(otIds, { todos = false } = {}) {
  if (!otIds.length) return [];
  const filtroEstados = todos
    ? ''
    : "AND r.estado_etapa IN ('Finalizado','En Proceso','Pausado')";
  // El listado sólo necesita los campos de progreso/etapa activa; el detalle
  // devuelve el registro completo para la UI y el CSV.
  const columnas = todos
    ? 'r.*'
    : `r.id, r.ot_id, r.sector_id, r.estado_etapa, r.operario_nombre,
       r.fecha_hora_inicio, r.pausa_inicio, r.segundos_pausados, r.duracion_minutos`;
  return db.all(`
    SELECT ${columnas}, s.nombre_sector, s.nombre_corto
      FROM registros_tiempos r
      JOIN sectores s ON s.id = r.sector_id
     WHERE r.ot_id = ANY(?)
       ${filtroEstados}
     ORDER BY r.ot_id, r.fecha_hora_inicio DESC, r.id DESC;`, otIds);
}

/** Consulta 3: materiales + no conformidades de todas las OTs. */
async function cargarMaterialesYAlertas(otIds) {
  if (!otIds.length) return new Map();
  const filas = await db.all(`
    WITH mats AS (
      SELECT m.ot_id, json_agg(m ORDER BY m.id) AS materiales
        FROM ot_materiales m
       WHERE m.ot_id = ANY(?)
       GROUP BY m.ot_id
    ),
    ncs AS (
      SELECT nc.ot_id,
             json_agg(json_build_object(
               'id', nc.id,
               'ot_id', nc.ot_id,
               'sector_id', nc.sector_id,
               'nombre_sector', s.nombre_sector,
               'tipo_falla', nc.tipo_falla,
               'estado', nc.estado,
               'accion_correctiva', nc.accion_correctiva,
               'fecha_registro', nc.fecha_registro
             ) ORDER BY nc.fecha_registro DESC, nc.id DESC) AS alertas
        FROM no_conformidades nc
        LEFT JOIN sectores s ON s.id = nc.sector_id
       WHERE nc.ot_id = ANY(?)
         AND nc.estado <> 'Descartado'
       GROUP BY nc.ot_id
    )
    SELECT COALESCE(m.ot_id, n.ot_id) AS ot_id,
           COALESCE(m.materiales, '[]'::json) AS materiales,
           COALESCE(n.alertas, '[]'::json) AS alertas
      FROM mats m
      FULL OUTER JOIN ncs n ON n.ot_id = m.ot_id;`, otIds, otIds);
  return indexarMaterialesYAlertas(filas);
}

/* ------------------------------ Handlers ------------------------------ */

async function listar({ query = {} } = {}) {
  // 1) OTs filtradas + sectores.
  const { sectores, ordenes } = await cargarSectoresYOTs(query);
  if (!ordenes.length) return { status: 200, data: { total: 0, ordenes: [] } };

  const ids = ordenes.map((ot) => ot.id);

  // 2 y 3) Etapas y materiales/NC de TODAS las OTs, en paralelo.
  const [registros, materiales] = await Promise.all([
    cargarRegistros(ids, { todos: false }),
    cargarMaterialesYAlertas(ids),
  ]);

  // Cruce O(1) en memoria por ot_id.
  const etapasPorOT = indexarEtapas(registros);
  const ordenesEnriquecidas = ordenes.map((ot) => construirOT(ot, sectores, {
    etapas: etapasPorOT.get(Number(ot.id)),
    materiales: materiales.get(Number(ot.id)),
  }));

  return {
    status: 200,
    data: { total: ordenes.length, ordenes: ordenesEnriquecidas },
  };
}

async function obtener({ params }) {
  const id = entero(params.id, 'id');

  // 1) OT + sectores; 2) todos sus registros; 3) materiales + NC.
  const contexto = await cargarOTPorId(id);
  if (!contexto) throw new ApiError(404, `No existe la OT con id ${id}.`);

  const [registrosRaw, materiales] = await Promise.all([
    cargarRegistros([id], { todos: true }),
    cargarMaterialesYAlertas([id]),
  ]);
  registrosRaw.sort((a, b) => (
    tiempoRegistro(b.fecha_hora_inicio) - tiempoRegistro(a.fecha_hora_inicio)
    || Number(b.id) - Number(a.id)
  ));
  const etapas = indexarEtapas(registrosRaw);
  const registros = registrosRaw.map(db.mapRegistro);

  return {
    status: 200,
    data: {
      ...construirOT(contexto.ot, contexto.sectores, {
        etapas: etapas.get(Number(id)),
        materiales: materiales.get(Number(id)),
      }),
      registros,
    },
  };
}

async function crear({ body }) {
  const ahora = db.ahoraUTC();
  const numeroOT = textoRequerido(body.numero_ot, 'Número de OT', { max: 40 }).toUpperCase();
  const cliente = textoRequerido(body.cliente, 'Cliente', { max: 120 });

  const existe = await db.get('SELECT id, numero_ot FROM ordenes_trabajo WHERE UPPER(numero_ot) = UPPER(?);', numeroOT);
  if (existe) throw new ApiError(409, `La ${existe.numero_ot} ya está cargada en el sistema.`);

  const datos = {
    numero_ot: numeroOT,
    cliente,
    modelo: textoOpcional(body.modelo, 'Modelo', { max: 80 }),
    linea_area: body.linea_area === undefined || body.linea_area === null || body.linea_area === ''
      ? 'Placares'
      : enumOpcion(body.linea_area, db.LINEAS_OT, 'Línea / área'),
    metros_lineales: decimal(body.metros_lineales, 'Metros lineales', { min: 0, max: 1000000, requerido: true }),
    fecha_prometida: fecha(body.fecha_prometida, 'Fecha prometida'),
    requiere_vidrio: booleano(body.requiere_vidrio) ? 1 : 0,
    requiere_lustre: booleano(body.requiere_lustre) ? 1 : 0,
    requiere_herreria: booleano(body.requiere_herreria) ? 1 : 0,
    requiere_especiales: booleano(body.requiere_especiales) ? 1 : 0,
    estado_general: body.estado_general ? enumOpcion(body.estado_general, db.ESTADOS_OT, 'Estado general') : 'En Cola',
  };
  const materiales = validarMateriales(body);

  const idOT = await db.transaccion(async () => {
    const r = await db.run(`
      INSERT INTO ordenes_trabajo
        (numero_ot, cliente, modelo, linea_area, metros_lineales, fecha_prometida,
         requiere_vidrio, requiere_lustre, requiere_herreria, requiere_especiales,
         estado_general, fecha_creacion, fecha_actualizacion)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      datos.numero_ot, datos.cliente, datos.modelo, datos.linea_area,
      datos.metros_lineales, datos.fecha_prometida,
      datos.requiere_vidrio, datos.requiere_lustre, datos.requiere_herreria, datos.requiere_especiales,
      datos.estado_general, ahora, ahora
    );
    if (materiales && materiales.length) await insertarMateriales(r.lastInsertRowid, materiales, ahora);
    return r.lastInsertRowid;
  });

  return {
    status: 201,
    data: { ...db.mapOT(await db.get('SELECT * FROM ordenes_trabajo WHERE id = ?;', idOT)), ...await conMateriales(idOT) },
  };
}

async function actualizar({ params, body }) {
  const id = entero(params.id, 'id');
  const actual = await db.get('SELECT * FROM ordenes_trabajo WHERE id = ?;', id);
  if (!actual) throw new ApiError(404, `No existe la OT con id ${id}.`);

  const numeroOT = body.numero_ot !== undefined
    ? textoRequerido(body.numero_ot, 'Número de OT', { max: 40 }).toUpperCase()
    : actual.numero_ot;
  const duplicada = await db.get(
    'SELECT id, numero_ot FROM ordenes_trabajo WHERE UPPER(numero_ot) = UPPER(?) AND id <> ?;',
    numeroOT, id
  );
  if (duplicada) throw new ApiError(409, `La ${duplicada.numero_ot} ya está cargada en el sistema.`);

  const nuevo = {
    numero_ot: numeroOT,
    cliente: body.cliente !== undefined ? textoRequerido(body.cliente, 'Cliente', { max: 120 }) : actual.cliente,
    modelo: body.modelo !== undefined ? textoOpcional(body.modelo, 'Modelo', { max: 80 }) : actual.modelo,
    linea_area: body.linea_area !== undefined
      ? enumOpcion(body.linea_area, db.LINEAS_OT, 'Línea / área')
      : actual.linea_area,
    metros_lineales: body.metros_lineales !== undefined
      ? decimal(body.metros_lineales, 'Metros lineales', { min: 0, max: 1000000, requerido: true })
      : Number(actual.metros_lineales),
    fecha_prometida: body.fecha_prometida !== undefined
      ? fecha(body.fecha_prometida, 'Fecha prometida')
      : actual.fecha_prometida,
    requiere_vidrio: body.requiere_vidrio !== undefined ? (booleano(body.requiere_vidrio) ? 1 : 0) : actual.requiere_vidrio,
    requiere_lustre: body.requiere_lustre !== undefined ? (booleano(body.requiere_lustre) ? 1 : 0) : actual.requiere_lustre,
    requiere_herreria: body.requiere_herreria !== undefined ? (booleano(body.requiere_herreria) ? 1 : 0) : actual.requiere_herreria,
    requiere_especiales: body.requiere_especiales !== undefined ? (booleano(body.requiere_especiales) ? 1 : 0) : actual.requiere_especiales,
    estado_general: body.estado_general !== undefined
      ? enumOpcion(body.estado_general, db.ESTADOS_OT, 'Estado general')
      : actual.estado_general,
  };

  const materiales = validarMateriales(body);
  const ahora = db.ahoraUTC();

  // Cambiar de línea re-scopa todo el flujo de la OT (los sectores exigidos y
  // el orden cambian). Sólo se permite mientras no haya etapas finalizadas:
  // una vez producido, moverla dejaría el progreso y los históricos incoherentes.
  if (nuevo.linea_area !== actual.linea_area) {
    const cerradas = (await db.get(
      `SELECT COUNT(*) AS n FROM registros_tiempos WHERE ot_id = ? AND estado_etapa = 'Finalizado';`,
      id
    )).n;
    if (cerradas > 0) {
      throw new ApiError(409,
        `La ${actual.numero_ot} ya tiene ${cerradas} etapa(s) finalizada(s): no se puede cambiar de línea ` +
        `(${actual.linea_area} → ${nuevo.linea_area}) sin romper el progreso y los reportes históricos.`,
        { accion: 'Cree una OT nueva en la línea correcta, o elimine esta y recárguela antes de producir.' });
    }
  }

  await db.transaccion(async () => {
    await db.run(`
      UPDATE ordenes_trabajo SET
        numero_ot = ?, cliente = ?, modelo = ?, linea_area = ?, metros_lineales = ?, fecha_prometida = ?,
        requiere_vidrio = ?, requiere_lustre = ?, requiere_herreria = ?, requiere_especiales = ?,
        estado_general = ?, fecha_actualizacion = ?
      WHERE id = ?;`,
      nuevo.numero_ot, nuevo.cliente, nuevo.modelo, nuevo.linea_area, nuevo.metros_lineales, nuevo.fecha_prometida,
      nuevo.requiere_vidrio, nuevo.requiere_lustre, nuevo.requiere_herreria, nuevo.requiere_especiales,
      nuevo.estado_general, ahora, id
    );
    // Solo toca materiales si el body trae la lista (compatibilidad con PATCH-like).
    if (materiales !== null) await reemplazarMateriales(id, body.materiales, materiales, ahora);
  });

  return {
    status: 200,
    data: { ...db.mapOT(await db.get('SELECT * FROM ordenes_trabajo WHERE id = ?;', id)), ...await conMateriales(id) },
  };
}

/**
 * Reemplaza la lista completa de materiales de una OT, preservando ids cuando
 * la fila trae `id` (update) e insertando/borrando el resto. Dentro de transacción.
 */
async function reemplazarMateriales(otId, crudo, filas, ahora) {
  const existentes = new Map(
    (await db.all('SELECT id FROM ot_materiales WHERE ot_id = ?;', otId)).map((r) => [r.id, true])
  );
  const conservados = new Set();

  for (let i = 0; i < crudo.length; i++) {
    const m = crudo[i];
    if (!m || m.id === undefined || m.id === null) continue; // fila nueva: ya validada, se inserta abajo
    const mid = entero(m.id, `Material #${i + 1} (id)`);
    if (!existentes.has(mid)) {
      throw new ApiError(400, `El material con id ${mid} no pertenece a la OT ${otId}.`);
    }
    conservados.add(mid);
    const f = filas[i];
    await db.run(`UPDATE ot_materiales SET
        material_nombre = ?, cantidad_placas = ?, cantidad_consumida = ?, observaciones = ?,
        fecha_actualizacion = ?
      WHERE id = ? AND ot_id = ?;`,
    f.material_nombre, f.cantidad_placas, f.cantidad_consumida, f.observaciones, ahora, mid, otId
    );
  }

  for (let i = 0; i < crudo.length; i++) {
    const m = crudo[i];
    if (m && m.id !== undefined && m.id !== null) continue;
    await insertarMateriales(otId, [filas[i]], ahora);
  }

  for (const mid of existentes.keys()) {
    if (!conservados.has(mid)) await db.run('DELETE FROM ot_materiales WHERE id = ?;', mid);
  }
}

/** PUT /api/ordenes/:id/materiales — reemplaza la lista completa de materiales. */
async function actualizarMateriales({ params, body }) {
  const id = entero(params.id, 'id');
  if (!await db.get('SELECT 1 FROM ordenes_trabajo WHERE id = ?;', id)) {
    throw new ApiError(404, `No existe la OT con id ${id}.`);
  }
  const filas = validarMateriales({ materiales: body.materiales });
  if (filas === null) throw new ApiError(400, 'El campo "materiales" es obligatorio en este endpoint.');

  const ahora = db.ahoraUTC();
  await db.transaccion(() => reemplazarMateriales(id, body.materiales, filas, ahora));
  return { status: 200, data: await conMateriales(id) };
}

/** PUT /api/ordenes/:id/materiales/:mid — actualiza consumo/observaciones de una línea. */
async function actualizarMaterial({ params, body }) {
  const id = entero(params.id, 'id');
  const mid = entero(params.mid, 'materialId');
  const actual = await db.get('SELECT * FROM ot_materiales WHERE id = ? AND ot_id = ?;', mid, id);
  if (!actual) throw new ApiError(404, `No existe el material ${mid} en la OT ${id}.`);

  const nombre = body.material_nombre === undefined ? actual.material_nombre
    : textoRequerido(body.material_nombre, 'Material (nombre)', { max: 140 });
  const requeridas = body.cantidad_placas === undefined ? Number(actual.cantidad_placas)
    : decimal(body.cantidad_placas, 'Material (cantidad de placas)', { min: 0.01, max: 100000, requerido: true });
  const consumidas = body.cantidad_consumida === undefined ? Number(actual.cantidad_consumida)
    : decimal(body.cantidad_consumida, 'Material (placas consumidas)', { min: 0, max: 100000 });
  if (consumidas > requeridas) {
    throw new ApiError(400,
      `Material "${nombre}": las placas consumidas (${consumidas}) no pueden superar las requeridas (${requeridas}).`);
  }
  const obs = body.observaciones === undefined ? (actual.observaciones || null)
    : textoOpcional(body.observaciones, 'Material (observaciones)', { max: 300 });

  await db.run(`UPDATE ot_materiales SET
      material_nombre = ?, cantidad_placas = ?, cantidad_consumida = ?, observaciones = ?,
      fecha_actualizacion = ?
    WHERE id = ?;`,
  nombre, requeridas, consumidas, obs, db.ahoraUTC(), mid
  );

  return {
    status: 200,
    data: {
      material: db.mapMaterial(await db.get('SELECT * FROM ot_materiales WHERE id = ?;', mid)),
      ...await conMateriales(id),
    },
  };
}

/**
 * Elimina una OT junto con todos sus registros y materiales.
 *
 * CONCURRENCIA (C-3): el DELETE no era transaccional. Un `iniciar` que llegara
 * en paralelo (validó "sin etapas abiertas" ANTES del recuento) podría INSERTAR
 * una etapa justo entre el `COUNT` y el `DELETE`, y el `ON DELETE CASCADE` la
 * borraría junto con la OT: el operario quedaría fichando contra una OT inexistente
 * y su etapa abierta desaparecería sin pasar por `finalizar`.
 *
 * Ahora todo ocurre dentro de una transacción con ADVISORY LOCK de OT (la misma
 * clave que toma `registros.iniciar`), de modo que iniciar y eliminar quedan
 * SERIALIZADOS: o la etapa entra antes y `eliminar` responde 409, o el borrado
 * ocupa el slot primero y `iniciar` ve la OT inexistente. Además la comprobación
 * de etapas abiertas se RE-VERIFICA dentro de la transacción, no fuera.
 */
async function eliminar({ params }) {
  const id = entero(params.id, 'id');

  return db.transaccion(async () => {
    // Bloquea la fila de la OT: nadie puede cambiarla ni fichar contra ella
    // mientras decidimos si procede el borrado.
    const ot = await db.get(
      'SELECT id, numero_ot FROM ordenes_trabajo WHERE id = ? FOR UPDATE;', id
    );
    if (!ot) throw new ApiError(404, `No existe la OT con id ${id}.`);

    // Re-check DENTRO de la transacción (bajo el lock de OT).
    const abiertas = Number((await db.get(
      `SELECT COUNT(*) AS n FROM registros_tiempos
        WHERE ot_id = ? AND estado_etapa IN ('En Proceso','Pausado');`,
      id
    )).n || 0);
    if (abiertas > 0) {
      throw new ApiError(409,
        `No se puede eliminar: la ${ot.numero_ot} tiene ${abiertas} etapa(s) en curso. Finalícelas primero.`);
    }

    const total = Number((await db.get(
      'SELECT COUNT(*) AS n FROM registros_tiempos WHERE ot_id = ?;', id)).n || 0);
    const mats = Number((await db.get(
      'SELECT COUNT(*) AS n FROM ot_materiales WHERE ot_id = ?;', id)).n || 0);

    const borrado = await db.run('DELETE FROM ordenes_trabajo WHERE id = ?;', id);
    if (!borrado.changes) {
      throw new ApiError(404, `La ${ot.numero_ot} ya no existe (otra sesión la eliminó).`);
    }

    return {
      status: 200,
      data: {
        eliminada: true,
        numero_ot: ot.numero_ot,
        registros_eliminados: total,
        materiales_eliminados: mats,
      },
    };
  }, [[db.LOCK_OT, id]]);
}

module.exports = {
  listar, obtener, crear, actualizar, eliminar,
  actualizarMateriales, actualizarMaterial,
  sectoresRequeridos,
};
