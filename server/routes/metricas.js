'use strict';

/**
 * Métricas ejecutivas del Dashboard (Fase 2), adaptadas a PostgreSQL (Fase 7).
 *
 *   GET /api/metricas?desde=AAAA-MM-DD&hasta=AAAA-MM-DD   (por defecto: últimos 30 días)
 *
 * Definiciones de negocio (docs/API.md):
 *   · Lead time       = inicio del flujo de la LÍNEA de la OT -> fin del último
 *                       sector de esa línea; sólo OTs cerradas en ambos extremos.
 *   · Cuello de botella = sector con más horas HOY (fecha local de planta) en
 *                       'En Proceso' + 'Pausado'.
 *   · FTT             = % de OTs que avanzaron (cerraron etapas) en el período
 *                       sin pausas por reproceso/error ('Error de plano',
 *                       'Rotura de placa').
 *
 * Fase 7: todas las consultas son `await` (Supabase/PostgreSQL de red) y las
 * ventanas de tiempo se arman en JS para no depender del huso del runtime
 * (Vercel corre en UTC; la fábrica opera en ZONA).
 */

const db = require('../db');
const { ApiError } = require('../lib/http');

const { MOTIVOS_REPROCESO, MOTIVOS_PAUSA, ESTADOS_OT, ESTADOS_ABIERTOS } = db;

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const DIAS_DEFECTO = 30;

/* ------------------------------------------------------------------ */
/* Helpers de fecha (zona de PLANTA, no del servidor)                   */
/* ------------------------------------------------------------------ */

/** 'YYYY-MM-DD' de HOY en la zona horaria de planta. */
function hoyLocal() {
  return db.aLocalLegible(db.ahoraUTC()).slice(0, 10);
}

/** Suma/resta días a 'YYYY-MM-DD' (sin depender del reloj del sistema). */
function correrDias(fechaLocal, dias) {
  const ms = Date.parse(`${fechaLocal}T12:00:00Z`) + dias * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** ISO UTC del medianoche LOCAL de `fechaLocal` (para ventanas "hoy"). */
function inicioDiaLocalUTC(fechaLocal) {
  const ahora = db.ahoraUTC();
  // Offset local real (ms) medido con el propio traductor de db.js.
  const offset = Date.parse(`${db.aLocalLegible(ahora).replace(' ', 'T')}Z`) - Date.parse(ahora);
  return new Date(Date.parse(`${fechaLocal}T00:00:00Z`) - offset).toISOString();
}

function parseFecha(valor, defecto) {
  if (valor === undefined || valor === null || valor === '') return defecto;
  const t = String(valor).trim();
  if (!RE_FECHA.test(t)) {
    throw new ApiError(400, 'Las fechas deben tener el formato AAAA-MM-DD.');
  }
  return t;
}

/** 3120.5 min -> '2 d 04 h'  |  95 min -> '1 h 35 m' */
function minutosLegibles(min) {
  if (min === null || min === undefined) return null;
  const total = Math.max(0, Math.round(min));
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  if (d > 0) return `${d} d ${String(h).padStart(2, '0')} h`;
  return `${h} h ${String(total % 60).padStart(2, '0')} m`;
}

const red1 = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);

/* ------------------------------------------------------------------ */
/* Bloques de métricas                                                  */
/* ------------------------------------------------------------------ */

/** OTs creadas en el período, por estado. */
async function metricasOTS(desde, hasta) {
  const filas = await db.all(`
    SELECT estado_general, COUNT(*) AS n
      FROM ordenes_trabajo
     WHERE substr(fecha_creacion, 1, 10) BETWEEN ? AND ?
     GROUP BY estado_general;`, desde, hasta);

  const porEstado = {};
  for (const e of ESTADOS_OT) porEstado[e] = 0;
  let total = 0;
  for (const f of filas) {
    porEstado[f.estado_general] = Number(f.n);
    total += Number(f.n);
  }
  // "Activas" = las que siguen en flujo (no finalizadas ni simples colas).
  const activas = porEstado['En Producción'] + porEstado.Detenido;
  return { total, activas, por_estado: porEstado };
}

/**
 * Lead time por OT: desde el primer registro del flujo de SU línea hasta el
 * último cierre de esa misma línea. Sólo OTs cerradas en ambos extremos
 * (`HAVING inicio_flujo IS NOT NULL`).
 */
async function metricasLeadTime(desde, hasta) {
  const filas = await db.all(`
    SELECT o.id,
           MIN(r.fecha_hora_inicio) AS inicio_flujo,
           MAX(r.fecha_hora_fin)    AS fin_flujo
      FROM ordenes_trabajo o
      JOIN registros_tiempos r ON r.ot_id = o.id
      JOIN sectores s          ON s.id = r.sector_id
     WHERE s.linea_area = o.linea_area          -- sólo el flujo propio de la línea
       AND substr(o.fecha_creacion, 1, 10) BETWEEN ? AND ?
     GROUP BY o.id
    HAVING MIN(r.fecha_hora_inicio) IS NOT NULL
       AND MAX(r.fecha_hora_fin) IS NOT NULL;`, desde, hasta);

  let suma = 0;
  for (const f of filas) {
    suma += (Date.parse(f.fin_flujo) - Date.parse(f.inicio_flujo)) / 60000;
  }
  const otsMedidas = filas.length;
  const promedio = otsMedidas ? Math.round((suma / otsMedidas) * 10) / 10 : null;
  return { ots_medidas: otsMedidas, promedio_minutos: promedio, promedio_legible: minutosLegibles(promedio) };
}

/** % de OTs que avanzaron sin pausas de reproceso (FTT). */
async function metricasFTT(desde, hasta) {
  const marcadores = MOTIVOS_REPROCESO.map(() => '?').join(',');
  const row = await db.get(`
    WITH avanzadas AS (
      SELECT DISTINCT r.ot_id
        FROM registros_tiempos r
       WHERE r.estado_etapa = 'Finalizado'
         AND substr(r.fecha_hora_inicio, 1, 10) BETWEEN ? AND ?
    )
    SELECT COUNT(*) AS evaluadas,
           SUM(CASE WHEN NOT EXISTS (
                  SELECT 1
                    FROM registros_tiempos r2
                    JOIN eventos_pausa ep ON ep.registro_id = r2.id
                   WHERE r2.ot_id = avanzadas.ot_id
                     AND ep.motivo_pausa IN (${marcadores})
                ) THEN 1 ELSE 0 END) AS conformes
      FROM avanzadas;`, desde, hasta, ...MOTIVOS_REPROCESO);

  const evaluadas = Number(row.evaluadas || 0);
  const conformes = Number(row.conformes || 0);
  const porcentaje = evaluadas > 0 ? Math.round((conformes / evaluadas) * 1000) / 10 : null;
  return { evaluadas, conformes, porcentaje, motivos_reproceso: [...MOTIVOS_REPROCESO] };
}

/** Pausas del período agrupadas por motivo (eventos_pausa). */
async function metricasPausas(desde, hasta) {
  const filas = await db.all(`
    SELECT ep.motivo_pausa AS motivo,
           COUNT(*)        AS frecuencia,
           COALESCE(SUM(ep.segundos), 0) AS segundos,
           SUM(CASE WHEN ep.fin_pausa IS NULL THEN 1 ELSE 0 END) AS abiertas
      FROM eventos_pausa ep
     WHERE substr(ep.inicio_pausa, 1, 10) BETWEEN ? AND ?
     GROUP BY ep.motivo_pausa
     ORDER BY segundos DESC, frecuencia DESC;`, desde, hasta);

  const lista = filas.map((f) => ({
    motivo: f.motivo,
    frecuencia: Number(f.frecuencia),
    horas_perdidas: red1(Number(f.segundos) / 3600),
  }));

  // Completar los motivos del catálogo sin eventos (la tabla del dashboard
  // lista siempre los cinco, para que desaparezcan sólo los "en cero").
  for (const motivo of MOTIVOS_PAUSA) {
    if (!lista.some((p) => p.motivo === motivo)) {
      lista.push({ motivo, frecuencia: 0, horas_perdidas: 0 });
    }
  }

  const abiertas = filas.reduce((n, f) => n + Number(f.abiertas || 0), 0);
  return {
    lista,
    nota: abiertas
      ? `Hay ${abiertas} pausa(s) aún abiertas: sus horas se computarán al reanudarse.`
      : null,
  };
}

/**
 * Carga de HOY por sector: horas en 'En Proceso' y en 'Pausado' dentro de la
 * ventana [medianoche local, ahora], sobre etapas abiertas Y cerradas hoy.
 * Se calcula en JS a partir de las ventanas crudas para no filtrar por huso
 * horario en SQL (el runtime de Vercel está en UTC).
 */
async function cargaHoy() {
  const ahora = db.ahoraUTC();
  const ahoraMs = Date.parse(ahora);
  const hoy = hoyLocal();
  const inicioMs = Date.parse(inicioDiaLocalUTC(hoy));

  const registros = await db.all(`
    SELECT r.id, r.sector_id, r.estado_etapa, r.fecha_hora_inicio, r.fecha_hora_fin,
           s.nombre_sector, s.nombre_corto
      FROM registros_tiempos r
      JOIN sectores s ON s.id = r.sector_id
     WHERE r.fecha_hora_inicio <= ?
       AND (r.fecha_hora_fin IS NULL OR r.fecha_hora_fin >= ?);`, ahora, inicioDiaLocalUTC(hoy));

  const porSector = new Map();
  if (!registros.length) return { filas: [], hoy };

  const pausas = await db.all(`
    SELECT ep.registro_id, ep.inicio_pausa, ep.fin_pausa
      FROM eventos_pausa ep
     WHERE ep.registro_id = ANY($1::bigint[]);`, [registros.map((r) => r.id)]);

  const pausasPorRegistro = new Map();
  for (const p of pausas) {
    if (!pausasPorRegistro.has(p.registro_id)) pausasPorRegistro.set(p.registro_id, []);
    pausasPorRegistro.get(p.registro_id).push(p);
  }

  const solape = (aIni, aFin, bIni, bFin) => Math.max(0, Math.min(aFin, bFin) - Math.max(aIni, bIni));

  for (const r of registros) {
    const vIni = Math.max(Date.parse(r.fecha_hora_inicio), inicioMs);
    const vFin = r.fecha_hora_fin ? Math.min(Date.parse(r.fecha_hora_fin), ahoraMs) : ahoraMs;
    if (vFin <= vIni) continue; // no tocó hoy

    let pausadoMs = 0;
    for (const p of pausasPorRegistro.get(r.id) || []) {
      const pIni = Math.max(Date.parse(p.inicio_pausa), vIni);
      const pFin = p.fin_pausa ? Math.min(Date.parse(p.fin_pausa), vFin) : vFin;
      pausadoMs += solape(pIni, pFin, vIni, vFin);
    }
    pausadoMs = Math.min(pausadoMs, vFin - vIni);

    let fila = porSector.get(r.sector_id);
    if (!fila) {
      fila = {
        sector_id: r.sector_id,
        nombre_sector: r.nombre_sector,
        nombre_corto: r.nombre_corto,
        segundos_en_proceso: 0,
        segundos_pausado: 0,
        etapas_abiertas: 0,
        pausas_hoy: 0,
      };
      porSector.set(r.sector_id, fila);
    }
    fila.segundos_en_proceso += (vFin - vIni) - pausadoMs;
    fila.segundos_pausado += pausadoMs;
    if (ESTADOS_ABIERTOS.includes(r.estado_etapa)) fila.etapas_abiertas += 1;
  }

  // Pausas que EMPEZARON hoy (para el contador "pausas_hoy" del cuello).
  for (const p of pausas) {
    if (Date.parse(p.inicio_pausa) >= inicioMs) {
      const fila = porSector.get(
        registros.find((r) => r.id === p.registro_id)?.sector_id
      );
      if (fila) fila.pausas_hoy += 1;
    }
  }

  const filas = [...porSector.values()]
    .map((f) => ({
      sector_id: f.sector_id,
      nombre_sector: f.nombre_sector,
      nombre_corto: f.nombre_corto,
      horas_en_proceso: red1(f.segundos_en_proceso / 3600),
      horas_pausado: red1(f.segundos_pausado / 3600),
      horas_total: red1((f.segundos_en_proceso + f.segundos_pausado) / 3600),
      etapas_abiertas: f.etapas_abiertas,
      pausas_hoy: f.pausas_hoy,
    }))
    .filter((f) => f.horas_total > 0 || f.etapas_abiertas > 0)
    .sort((a, b) => b.horas_total - a.horas_total || a.nombre_sector.localeCompare(b.nombre_sector));

  return { filas, hoy };
}

/* ------------------------------------------------------------------ */
/* Handler                                                              */
/* ------------------------------------------------------------------ */

/**
 * GET /api/metricas
 * Responde el tablero completo que consume el Dashboard de Administración.
 */
async function calcular({ query }) {
  const hoy = hoyLocal();
  const hasta = parseFecha(query.hasta, hoy);
  const desde = parseFecha(query.desde, correrDias(hasta, -DIAS_DEFECTO));
  if (desde > hasta) {
    throw new ApiError(400, 'El campo "desde" no puede ser posterior a "hasta".');
  }

  const [ots, leadTime, ftt, pausas, carga] = await Promise.all([
    metricasOTS(desde, hasta),
    metricasLeadTime(desde, hasta),
    metricasFTT(desde, hasta),
    metricasPausas(desde, hasta),
    cargaHoy(),
  ]);

  const cuello = carga.filas[0] && carga.filas[0].horas_total > 0
    ? { ...carga.filas[0] }
    : null;

  return {
    status: 200,
    data: {
      periodo: { desde, hasta, dia_cuello_botella: carga.hoy },
      ots,
      lead_time: leadTime,
      ftt,
      cuello_botella: cuello,
      sectores_carga_hoy: carga.filas,
      pausas_por_motivo: pausas.lista,
      generado_en: db.ahoraUTC(),
      ...(pausas.nota ? { _nota_historica: pausas.nota } : {}),
    },
  };
}

module.exports = { calcular };
