'use strict';

/**
 * Exportación de `registros_tiempos` para Power BI / Excel / BI.
 *
 *   GET /api/export/registros.json?desde=2026-10-01&hasta=2026-10-31
 *   GET /api/export/registros.csv?desde=2026-10-01&hasta=2026-10-31&sep=,
 *
 * Ambos endpoints devuelven los datos "llave en mano" para Power BI:
 * incluyen fecha/hora en UTC (para modelar sin ambigüedades) y en la
 * hora local de planta (para los tableros).
 */

const db = require('../db');
const { celdaCSV, ApiError } = require('../lib/http');

const COLUMNAS = [
  ['id_registro', (r) => r.id],
  ['numero_ot', (r) => r.numero_ot],
  ['cliente', (r) => r.cliente],
  ['modelo', (r) => r.modelo],
  ['metros_lineales', (r) => r.metros_lineales],
  ['fecha_prometida', (r) => r.fecha_prometida],
  ['estado_ot', (r) => r.estado_ot],
  // Línea de la OT y clasificación del sector (para segmentar en Power BI).
  ['linea_ot', (r) => r.linea_ot],
  ['sector', (r) => r.nombre_sector],
  ['linea_area', (r) => r.linea_area],
  ['sector_compartido', (r) => (r.es_compartido ? 'SI' : 'NO')],
  ['es_compartido', (r) => (r.es_compartido ? 'SI' : 'NO')],
  ['operario', (r) => r.operario_nombre],
  ['fecha_hora_inicio_utc', (r) => r.fecha_hora_inicio],
  ['fecha_hora_inicio_local', (r) => r.fecha_hora_inicio_local],
  ['fecha_hora_fin_utc', (r) => r.fecha_hora_fin],
  ['fecha_hora_fin_local', (r) => r.fecha_hora_fin_local],
  ['duracion_minutos', (r) => (r.duracion_minutos === null ? '' : r.duracion_minutos)],
  ['duracion_horas', (r) => (r.duracion_minutos === null ? '' : Math.round((r.duracion_minutos / 60) * 10000) / 10000)],
  // Tiempo acumulado de la OT: sectores compartidos vs. el flujo de su línea.
  ['ot_minutos_compartidos', (r) => r.ot_minutos_compartidos],
  ['ot_minutos_estandar', (r) => r.ot_minutos_estandar],
  ['estado_etapa', (r) => r.estado_etapa],
  ['motivo_pausa', (r) => r.motivo_pausa],
  ['observacion', (r) => r.observacion],
];

function construirFiltros(query) {
  const filtros = [];
  const params = [];

  // Ventana SEMIABIERTA en la zona de planta (`[desde 00:00, hasta+1 00:00)`),
  // igual que en `registros.listar`: el extremo superior EXCLUSIVO evita
  // perder los registros de las 21:00–23:59 del último día filtrado.
  if (query.desde) {
    filtros.push('r.fecha_hora_inicio >= ?');
    params.push(db.inicioDiaLocalUTC(String(query.desde).slice(0, 10)));
  }
  if (query.hasta) {
    filtros.push('r.fecha_hora_inicio < ?');
    params.push(db.inicioDiaLocalUTC(db.correrDias(String(query.hasta).slice(0, 10), 1)));
  }
  if (query.ot_id) {
    filtros.push('r.ot_id = ?');
    params.push(Number(query.ot_id));
  }
  if (query.numero_ot) {
    filtros.push('UPPER(o.numero_ot) = UPPER(?)');
    params.push(String(query.numero_ot));
  }
  if (query.sector_id) {
    filtros.push('r.sector_id = ?');
    params.push(Number(query.sector_id));
  }
  if (query.estado) {
    const estados = db.ESTADOS_ETAPA;
    if (!estados.includes(query.estado)) {
      throw new ApiError(400, `estado debe ser uno de: ${estados.join(', ')}`);
    }
    filtros.push('r.estado_etapa = ?');
    params.push(query.estado);
  }
  if (query.operario) {
    filtros.push('r.operario_nombre = ?');
    params.push(String(query.operario));
  }
  return { where: filtros.length ? `WHERE ${filtros.join(' AND ')}` : '', params };
}

async function obtenerFilas(query) {
  const { where, params } = construirFiltros(query);
  const limite = Math.min(Number(query.limite) || 100000, 500000);

  const filas = await db.all(`
    SELECT r.id, r.operario_nombre, r.fecha_hora_inicio, r.fecha_hora_fin, r.duracion_minutos,
           r.estado_etapa, r.motivo_pausa, r.observacion,
           o.numero_ot, o.cliente, o.modelo, o.metros_lineales, o.fecha_prometida, o.estado_general,
           o.linea_area AS linea_ot,
           s.nombre_sector, s.es_compartido, s.linea_area AS linea_area,
           s.orden_flujo AS orden_flujo_sector
      FROM registros_tiempos r
      JOIN ordenes_trabajo o ON o.id = r.ot_id
      JOIN sectores s ON s.id = r.sector_id
      ${where}
     ORDER BY r.fecha_hora_inicio ASC, r.id ASC
     LIMIT ?;`, ...params, limite);

  // Tiempo acumulado por OT: sectores compartidos vs. el flujo de su propia
  // línea (sólo etapas cerradas).
  const minsPorOT = new Map();
  const mins = await db.all(`
    SELECT r.ot_id, o.numero_ot,
           SUM(CASE WHEN s.es_compartido = 1 THEN COALESCE(r.duracion_minutos, 0) ELSE 0 END) AS compartidos,
           SUM(CASE WHEN s.es_compartido = 0 THEN COALESCE(r.duracion_minutos, 0) ELSE 0 END) AS estandar
      FROM registros_tiempos r
      JOIN ordenes_trabajo o ON o.id = r.ot_id
      JOIN sectores s ON s.id = r.sector_id
     WHERE r.estado_etapa = 'Finalizado'
     GROUP BY r.ot_id, o.numero_ot;`);
  for (const m of mins) {
    minsPorOT.set(m.numero_ot, {
      compartidos: Math.round(Number(m.compartidos || 0) * 100) / 100,
      estandar: Math.round(Number(m.estandar || 0) * 100) / 100,
    });
  }

  return filas.map((row) => {
    const minsOT = minsPorOT.get(row.numero_ot) || { compartidos: 0, estandar: 0 };
    return {
      ...row,
      metros_lineales: Number(row.metros_lineales),
      duracion_minutos: row.duracion_minutos === null ? null : Number(row.duracion_minutos),
      es_compartido: !!row.es_compartido,
      ot_minutos_compartidos: minsOT.compartidos,
      ot_minutos_estandar: minsOT.estandar,
      fecha_hora_inicio_local: db.aLocalLegible(row.fecha_hora_inicio),
      fecha_hora_fin_local: db.aLocalLegible(row.fecha_hora_fin),
      fecha_prometida: row.fecha_prometida || '',
      motivo_pausa: row.motivo_pausa || '',
      observacion: row.observacion || '',
      estado_ot: row.estado_general,
    };
  });
}

async function exportarJSON({ query }) {
  const filas = await obtenerFilas(query);
  return {
    status: 200,
    data: {
      fuente: 'registros_tiempos',
      generado_en: db.ahoraUTC(),
      total: filas.length,
      filtros: {
        desde: query.desde || null,
        hasta: query.hasta || null,
        ot_id: query.ot_id || null,
        sector_id: query.sector_id || null,
        estado: query.estado || null,
        operario: query.operario || null,
      },
      registros: filas,
    },
  };
}

async function exportarCSV({ query }) {
  const filas = await obtenerFilas(query);
  const sep = query.sep === ';' ? ';' : ',';
  const bom = query.bom === '0' ? '' : '\uFEFF'; // BOM para que Excel/Power BI lean acentos

  const encabezado = COLUMNAS.map(([nombre]) => nombre).join(sep);
  const cuerpo = filas
    .map((f) => COLUMNAS.map(([, getter]) => celdaCSV(getter(f))).join(sep))
    .join('\r\n');

  const texto = `${bom}${encabezado}\r\n${cuerpo}${filas.length ? '\r\n' : ''}`;
  const fecha = new Date().toISOString().slice(0, 10);

  return {
    status: 200,
    text: texto,
    contentType: 'text/csv; charset=utf-8',
    headers: {
      'Content-Disposition': `attachment; filename="optiflow_registros_tiempos_${fecha}.csv"`,
      'X-Total-Registros': String(filas.length),
    },
  };
}

module.exports = { exportarCSV, exportarJSON };
