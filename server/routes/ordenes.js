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

/** Materiales de una OT con resumen de placas. */
async function conMateriales(otId) {
  const materiales = (await db.all(
    'SELECT * FROM ot_materiales WHERE ot_id = ? ORDER BY id;', otId
  )).map(db.mapMaterial);
  const requeridas = Math.round(materiales.reduce((a, m) => a + m.cantidad_placas, 0) * 100) / 100;
  const consumidas = Math.round(materiales.reduce((a, m) => a + m.cantidad_consumida, 0) * 100) / 100;
  return {
    materiales,
    resumen_materiales: {
      lineas: materiales.length,
      placas_requeridas: requeridas,
      placas_consumidas: consumidas,
      placas_restantes: Math.max(0, Math.round((requeridas - consumidas) * 100) / 100),
      porcentaje_consumo: requeridas > 0 ? Math.round((consumidas / requeridas) * 100) : 0,
    },
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

/** Enriquece una OT con progreso, minutos y etapa abierta actual. */
async function conProgreso(ot, sectores, resumen) {
  const requeridos = sectoresRequeridos(ot, sectores);
  const idsRequeridos = new Set(requeridos.map((s) => s.id));
  const r = resumen.get(ot.id) || { abiertas: 0, minutos: 0, sectoresOk: 0, ultimo: null };

  // Sectores ya finalizados (DISTINCT sobre la tabla de registros).
  const finalizadosAll = (await db.all(
    `SELECT DISTINCT sector_id FROM registros_tiempos
      WHERE ot_id = ? AND estado_etapa = 'Finalizado';`,
    ot.id
  )).map((x) => x.sector_id);
  const finalizados = new Set(finalizadosAll);
  const ok = finalizadosAll.filter((id) => idsRequeridos.has(id)).length;

  // Sectores bloqueados por el flujo (prerrequisitos pendientes) — Fase 2.
  const bloqueados = {};
  if (ot.estado_general !== 'Finalizado') {
    for (const s of requeridos) {
      if (finalizados.has(s.id)) continue;
      const faltan = db.prerrequisitosSector(ot, s.id, sectores, finalizados);
      if (faltan.length) {
        bloqueados[s.id] = `Requiere finalizar: ${faltan.map((f) => f.nombre_corto || f.nombre_sector).join(', ')}`;
      }
    }
  }

  const abierta = await db.get(
    `SELECT r.id, r.sector_id, r.estado_etapa, r.operario_nombre, r.fecha_hora_inicio, r.pausa_inicio,
            r.segundos_pausados, s.nombre_sector, s.nombre_corto
       FROM registros_tiempos r
       JOIN sectores s ON s.id = r.sector_id
      WHERE r.ot_id = ? AND r.estado_etapa IN ('En Proceso','Pausado')
      ORDER BY r.fecha_hora_inicio DESC LIMIT 1;`,
    ot.id
  );

  return {
    ...ot,
    sectores_requeridos: requeridos.map((s) => s.id),
    progreso: {
      sectores_requeridos: requeridos.length,
      sectores_finalizados: ok,
      porcentaje: requeridos.length ? Math.round((ok / requeridos.length) * 100) : 0,
      finalizados_ids: finalizadosAll,
    },
    minutos_acumulados: Math.round((r.minutos || 0) * 100) / 100,
    etapa_activa: abierta ? db.mapRegistro(abierta) : null,
    sectores_bloqueados: bloqueados,
  };
}

async function resumenPorOT() {
  const mapa = new Map();
  const abiertas = await db.all(
    `SELECT ot_id, COUNT(*) AS n FROM registros_tiempos
      WHERE estado_etapa IN ('En Proceso','Pausado') GROUP BY ot_id;`
  );
  for (const a of abiertas) {
    mapa.set(a.ot_id, { abiertas: a.n, minutos: 0, sectoresOk: 0 });
  }
  const fin = await db.all(
    `SELECT ot_id, SUM(COALESCE(duracion_minutos,0)) AS minutos, COUNT(DISTINCT sector_id) AS sectores
       FROM registros_tiempos WHERE estado_etapa = 'Finalizado' GROUP BY ot_id;`
  );
  for (const f of fin) {
    const prev = mapa.get(f.ot_id) || { abiertas: 0, minutos: 0, sectoresOk: 0 };
    prev.minutos = Number(f.minutos) || 0;
    prev.sectoresOk = f.sectores;
    mapa.set(f.ot_id, prev);
  }
  return mapa;
}

/* ------------------------------ Handlers ------------------------------ */

async function listar() {
  const sectores = (await db.all('SELECT * FROM sectores ORDER BY id;')).map(db.mapSector);
  const resumen = await resumenPorOT();
  const orden = await db.all(`
    SELECT * FROM ordenes_trabajo
    ORDER BY
      CASE estado_general
        WHEN 'En Producción' THEN 0
        WHEN 'Detenido'      THEN 1
        WHEN 'En Cola'       THEN 2
        ELSE 3
      END,
      fecha_prometida IS NULL, fecha_prometida, numero_ot DESC;`);

  const ordenes = [];
  for (const o of orden) {
    ordenes.push(await conProgreso(db.mapOT(o), sectores, resumen));
  }
  return { status: 200, data: { total: orden.length, ordenes } };
}

async function obtener({ params }) {
  const id = entero(params.id, 'id');
  const row = await db.get('SELECT * FROM ordenes_trabajo WHERE id = ?;', id);
  if (!row) throw new ApiError(404, `No existe la OT con id ${id}.`);
  const sectores = (await db.all('SELECT * FROM sectores ORDER BY id;')).map(db.mapSector);
  const resumen = await resumenPorOT();

  const registros = (await db.all(`
    SELECT r.*, s.nombre_sector, s.nombre_corto
      FROM registros_tiempos r
      JOIN sectores s ON s.id = r.sector_id
     WHERE r.ot_id = ?
     ORDER BY r.fecha_hora_inicio DESC;`, id)).map(db.mapRegistro);

  return {
    status: 200,
    data: { ...await conProgreso(db.mapOT(row), sectores, resumen), registros, ...await conMateriales(id) },
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

async function eliminar({ params }) {
  const id = entero(params.id, 'id');
  const ot = await db.get('SELECT * FROM ordenes_trabajo WHERE id = ?;', id);
  if (!ot) throw new ApiError(404, `No existe la OT con id ${id}.`);

  const abiertas = (await db.get(
    `SELECT COUNT(*) AS n FROM registros_tiempos WHERE ot_id = ? AND estado_etapa IN ('En Proceso','Pausado');`,
    id
  )).n;
  if (abiertas > 0) {
    throw new ApiError(409, `No se puede eliminar: la ${ot.numero_ot} tiene ${abiertas} etapa(s) en curso. Finalícelas primero.`);
  }

  const total = (await db.get('SELECT COUNT(*) AS n FROM registros_tiempos WHERE ot_id = ?;', id)).n;
  const mats = (await db.get('SELECT COUNT(*) AS n FROM ot_materiales WHERE ot_id = ?;', id)).n;
  await db.run('DELETE FROM ordenes_trabajo WHERE id = ?;', id);
  return {
    status: 200,
    data: { eliminada: true, numero_ot: ot.numero_ot, registros_eliminados: total, materiales_eliminados: mats },
  };
}

module.exports = {
  listar, obtener, crear, actualizar, eliminar,
  actualizarMateriales, actualizarMaterial,
  sectoresRequeridos,
};
