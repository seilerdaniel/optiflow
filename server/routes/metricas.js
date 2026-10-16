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
const { ApiError, decimal } = require('../lib/http');

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
/* Objetivo mensual de CORTE (metros lineales de corte)                */
/* ------------------------------------------------------------------ */

const RE_PERIODO = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 'YYYY-MM' del mes en curso en la zona de PLANTA (no la del servidor). */
function periodoActual() {
  return hoyLocal().slice(0, 7);
}

/** 'YYYY-MM-DD' del primer día del mes SIGUIENTE a `periodo`. */
function inicioMesSiguiente(periodo) {
  const anio = Number(periodo.slice(0, 4));
  const mes = Number(periodo.slice(5, 7));
  return mes === 12
    ? `${anio + 1}-01-01`
    : `${anio}-${String(mes + 1).padStart(2, '0')}-01`;
}

/**
 * Días enteros entre dos 'YYYY-MM-DD'. La segunda fecha NO se cuenta, así que
 * `diasEntre('2026-10-01','2026-11-01')` devuelve 31 (los días de octubre).
 * Se usa mediodía UTC para que el cálculo no se tambalee con cambios de huso.
 */
function diasEntre(desde, hasta) {
  return Math.round(
    (Date.parse(`${hasta}T12:00:00Z`) - Date.parse(`${desde}T12:00:00Z`)) / 86400000
  );
}

/** Redondea a 2 decimales: evita colgar ruido de coma flotante en el JSON. */
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : 0);

/**
 * Metas por defecto del esquema (mismas cifras que el DDL de ambas fuentes).
 * Sólo se usan como red de seguridad para el mes en curso: ver `leerObjetivo`.
 */
const META_DEFECTO = Object.freeze({
  meta_metros_totales: 1200,
  meta_metros_placares: 800,
  meta_metros_cocinas: 400,
});

/**
 * Lee la meta de `periodo`.
 *
 * `crearSiFalta = true` (por defecto) la siembra con los defaults si todavía
 * no existe. Ese es el comportamiento correcto para el MES EN CURSO —el
 * tablero no puede quedar sin meta el día 1— y para el POST, que es quien
 * crea el registro del mes que la planta decide configurar.
 *
 * `crearSiFalta = false` es el de HISTÓRICO: con el selector de meses de la
 * Analítica ahora se puede recorrer el año, y un GET no debe dejar filas
 * inventadas en la base ni fabricar un contrafactual con los defaults. Un mes
 * que nunca se configuró devuelve `null` y el endpoint lo marca con
 * `meta_configurada: false`, para que la UI diga "sin meta" en vez de
 * evaluarlo contra un objetivo que la planta nunca fijó.
 */
async function leerObjetivo(periodo, crearSiFalta = true) {
  const fila = await db.get(
    'SELECT * FROM objetivos_produccion WHERE periodo = ?;', periodo
  );
  if (fila || !crearSiFalta) return fila || null;

  await db.run(
    'INSERT INTO objetivos_produccion (periodo) VALUES (?) ON CONFLICT (periodo) DO NOTHING;',
    periodo
  );
  // Relee: si otra invocación ganó la carrera, devolvemos SU fila.
  return db.get('SELECT * FROM objetivos_produccion WHERE periodo = ?;', periodo);
}

/**
 * Día LOCAL al que se acreditan los metros de una OT: el arranque del corte
 * RECORTADO al rango [mesInicio, ultimoDia].
 *
 * El recorte es lo que garantiza `SUMA(serie.metros) === cortados`: una OT
 * que arrancó en el mes anterior acredita al día 1 (no desaparece del total)
 * y una fecha imposible (reloj corrido, zona equivocada) nunca cae fuera de
 * la serie que el tablero va a mostrar.
 *
 * Sin inicio conocido se acredita al día 1: es el criterio conservador.
 * Exportada aparte para poder testearla sin necesidad de base de datos.
 */
function diaAcreditado(inicioCorte, mesInicio, ultimoDia) {
  const legible = inicioCorte ? db.aLocalLegible(inicioCorte) : null;
  let dia = legible ? legible.slice(0, 10) : mesInicio;
  if (dia < mesInicio) dia = mesInicio;
  if (dia > ultimoDia) dia = ultimoDia;
  return dia;
}

/**
 * GET /api/metricas/objetivo-corte[?periodo=YYYY-MM]
 *
 * Semántica del cómputo (definición de negocio, documentada para la planta):
 *
 *  · QUÉ SE CUENTA: la suma de `metros_lineales` de las OTs cuyo PRIMER
 *    sector de su propia línea —el corte, p. ej. 'Seccionadora / Corte' en
 *    Placares o 'Seccionadora B / Corte Módulos' en Cocinas— haya arrancado
 *    O terminado dentro del mes. Es el criterio "iniciado o completado" del
 *    requerimiento: una OT que entró en corte el 30 del mes anterior y salió
 *    el 2 del mes siguiente se computa en ambos meses.
 *
 *  · CÓMO SE IDENTIFICA ESE SECTOR: NO se hardcodea el nombre. Se usa la
 *    MISMA regla que `db.prerrequisitosSector` (primer sector regular de la
 *    línea: `orden_flujo` mínimo entre los sectores activos, sin clave
 *    especial y con `linea_area` igual a la de la OT). Si la planta agrega o
 *    renombra un sector, el cómputo se adapta solo.
 *
 *  · A QUÉ DÍA SE ACREDITA: al día LOCAL en que arrancó el corte, RECORTADO
 *    al mes consultado. El recorte es lo que garantiza
 *    `SUMA(serie.metros) === cortados`: un corte que empezó en el mes
 *    anterior acredita sus metros al día 1, nunca se pierden del total.
 *    Esa regla vive en `diaAcreditado()`, exportada para testearla.
 *
 *  · POR QUÉ TODO EN JS: el runtime de Vercel está en UTC y la fábrica
 *    opera en ZONA. `substr(fecha,1,10)` en SQL agruparía por día UTC y
 *    desplazaría la última hora de cada jornada al día siguiente (o al mes
 *    siguiente el último día). Las ventanas se arman con
 *    `inicioDiaLocalUTC()` y los días con `db.aLocalLegible()`, igual que el
 *    resto de este archivo.
 *
 *  · PROYECCIÓN: `ritmo_diario_promedio × días_del_mes`. El ritmo es
 *    metros ÷ días transcurridos, es decir el promedio real de lo corrido.
 *    En un mes CERRADO los días transcurridos son todos, así que la
 *    proyección coincide con el resultado final: por eso la UI la presenta
 *    como "resultado" y no como "proyección" cuando el mes ya terminó.
 *
 *  · PERÍODOS HISTÓRICOS: `?periodo=` sólo AUTO-CREA la fila del mes en
 *    curso. Un mes viejo sin meta responde `meta_configurada: false` con
 *    porcentaje/diferencia/ideales anulados, en vez de inventar un objetivo
 *    con los defaults; así recorrer el selector no ensucia la base ni miente
 *    sobre la historia. Quien quiera configurarlo lo hace vía POST.
 */
async function objetivoCorte({ query }) {
  const periodo = query && query.periodo !== undefined && query.periodo !== ''
    ? String(query.periodo).trim()
    : periodoActual();
  if (!RE_PERIODO.test(periodo)) {
    throw new ApiError(400, 'El campo "periodo" debe tener el formato YYYY-MM.');
  }

  const esMesEnCurso = periodo === periodoActual();

  // Sólo el mes en curso se auto-crea. Un mes histórico sin registro se
  // reporta como NO configurado en lugar de inventarle un objetivo.
  const meta = await leerObjetivo(periodo, esMesEnCurso);
  // Red de seguridad: el mes en curso SIEMPRE tiene meta, aunque la fila no
  // haya llegado a creerse (carrera entre dos invocaciones en frío).
  const configurada = esMesEnCurso || !!meta;
  const fuente = meta || (esMesEnCurso ? META_DEFECTO : null);
  const metaTotales = Number((fuente && fuente.meta_metros_totales) || 0);
  const metaPlacares = Number((fuente && fuente.meta_metros_placares) || 0);
  const metaCocinas = Number((fuente && fuente.meta_metros_cocinas) || 0);

  const mesInicio = `${periodo}-01`;
  const mesFin = inicioMesSiguiente(periodo);
  const hoy = hoyLocal();

  const diasTotales = Math.max(1, diasEntre(mesInicio, mesFin));
  // Mes aún futuro -> 0 días transcurridos (no se fabrica un "día 1" falso).
  const diasTranscurridos = hoy < mesInicio
    ? 0
    : Math.min(diasTotales, diasEntre(mesInicio, hoy) + 1);
  const diasRestantes = diasTotales - diasTranscurridos;

  // Límite superior del recorte: el último día que la serie va a mostrar.
  const ultimoDia = diasTranscurridos > 0
    ? correrDias(mesInicio, diasTranscurridos - 1)
    : mesInicio;

  // Corte de cada OT, con su intervalo, y filtro de MES por solape.
  //   min(inicio) < fin_del_mes  AND  (fin IS NULL OR fin >= inicio_del_mes)
  const filas = await db.all(`
    SELECT o.id,
           o.numero_ot,
           o.metros_lineales,
           o.linea_area,
           min(r.fecha_hora_inicio) AS inicio_corte,
           max(r.fecha_hora_fin)    AS fin_corte
      FROM ordenes_trabajo o
      JOIN registros_tiempos r ON r.ot_id = o.id
      JOIN sectores s          ON s.id  = r.sector_id
     WHERE s.activo = 1
       AND s.clave_especial IS NULL
       AND s.linea_area = o.linea_area
       AND s.orden_flujo = (
             SELECT min(s2.orden_flujo)
               FROM sectores s2
              WHERE s2.activo = 1
                AND s2.clave_especial IS NULL
                AND s2.linea_area = o.linea_area
           )
     GROUP BY o.id, o.numero_ot, o.metros_lineales, o.linea_area
    HAVING min(r.fecha_hora_inicio) < ?
       AND (max(r.fecha_hora_fin) IS NULL OR max(r.fecha_hora_fin) >= ?);`,
    inicioDiaLocalUTC(mesFin), inicioDiaLocalUTC(mesInicio)
  );

  const porDia = new Map();
  const porLineaCrudo = { Placares: 0, Cocinas: 0 };
  let total = 0;

  for (const f of filas) {
    const metros = Number(f.metros_lineales || 0);
    total += metros;
    if (Object.prototype.hasOwnProperty.call(porLineaCrudo, f.linea_area)) {
      porLineaCrudo[f.linea_area] += metros;
    }

    const dia = diaAcreditado(f.inicio_corte, mesInicio, ultimoDia);
    porDia.set(dia, (porDia.get(dia) || 0) + metros);
  }

  const ritmoDiario = diasTranscurridos > 0 ? total / diasTranscurridos : 0;
  // Sin meta configurada no hay "ideal" que trazar: se envía null para que el
  // gráfico NO pinte una recta en cero disfrazada de objetivo real.
  const idealDiario = configurada && metaTotales > 0 ? metaTotales / diasTotales : null;

  // Serie día a día de los días TRANSCURRIDOS (los futuros no se inventan).
  const serie = [];
  let acumulado = 0;
  for (let i = 0; i < diasTranscurridos; i += 1) {
    const dia = correrDias(mesInicio, i);
    const m = r2(porDia.get(dia) || 0);
    acumulado += m;
    serie.push({
      fecha: dia,
      metros: m,
      acumulado: r2(acumulado),
      ideal: idealDiario === null ? null : r2(idealDiario),
      ideal_acumulado: idealDiario === null ? null : r2(idealDiario * (i + 1)),
    });
  }

  const porcentaje = configurada && metaTotales > 0
    ? r2((total / metaTotales) * 100)
    : null;
  const proyeccion = r2(ritmoDiario * diasTotales);
  const porLinea = [
    {
      linea: 'Placares',
      meta: metaPlacares,
      cortados: r2(porLineaCrudo.Placares),
      porcentaje: metaPlacares > 0 ? r2((porLineaCrudo.Placares / metaPlacares) * 100) : null,
    },
    {
      linea: 'Cocinas',
      meta: metaCocinas,
      cortados: r2(porLineaCrudo.Cocinas),
      porcentaje: metaCocinas > 0 ? r2((porLineaCrudo.Cocinas / metaCocinas) * 100) : null,
    },
  ];

  return {
    status: 200,
    data: {
      periodo,
      es_mes_en_curso: esMesEnCurso,
      // false en meses históricos que la planta nunca configuró: el resto de
      // campos (porcentaje, diferencia, ideales del gráfico) vienen anulados.
      meta_configurada: configurada,
      meta: { totales: metaTotales, placares: metaPlacares, cocinas: metaCocinas },
      cortados: r2(total),
      porcentaje,
      dias: {
        transcurridos: diasTranscurridos,
        totales: diasTotales,
        restantes: diasRestantes,
      },
      ritmo_diario: r2(ritmoDiario),
      // Lo que hay que sostener por día para llegar a la meta exacta.
      ritmo_necesario: diasRestantes > 0 && metaTotales > total
        ? r2((metaTotales - total) / diasRestantes)
        : 0,
      proyeccion_cierre: proyeccion,
      diferencia_proyeccion: configurada && metaTotales > 0
        ? r2(proyeccion - metaTotales)
        : null,
      por_linea: porLinea,
      serie,
      ots_contadas: filas.length,
      generado_en: db.ahoraUTC(),
    },
  };
}

/**
 * POST /api/metricas/objetivo-corte
 * Actualiza las metas mensuales. Requiere sesión de gestión (admin/encargado).
 *
 * · `periodo` es opcional: si no viene, se escribe el mes en curso. Existe
 *   para poder precargar la meta del mes que viene; GET lo acepta igual, así
 *   lo que se escribe se puede volver a leer.
 * · Las tres metas son OPCIONALES: las que no llegan conservan su valor.
 *   Así un cliente puede mover sólo la meta total sin reenviar las líneas.
 * · Toda meta se limita a 99.999.999,99 porque la columna es numeric(10,2):
 *   sin ese tope, un número más grande haría fallar el INSERT con 22003 y la
 *   consulta terminaría en un 500 genérico en lugar de un 040 entendible.
 */
async function guardarObjetivoCorte({ body }) {
  const periodo = body.periodo === undefined || body.periodo === null || body.periodo === ''
    ? periodoActual()
    : String(body.periodo).trim();
  if (!RE_PERIODO.test(periodo)) {
    throw new ApiError(400, 'El campo "periodo" debe tener el formato YYYY-MM.');
  }

  // El POST SIEMPRE crea si falta: así se da de alta la meta de un mes
  // histórico o del que viene, sin tocar el registro de ningún otro período
  // (el UPDATE de más abajo filtra exactamente por este `periodo`).
  const actual = await leerObjetivo(periodo, true);

  const rango = { min: 0, max: 99999999.99, requerido: false, porDefecto: null };
  const recibidas = {
    meta_metros_totales: decimal(body.meta_metros_totales, 'Meta de metros totales', rango),
    meta_metros_placares: decimal(body.meta_metros_placares, 'Meta de metros Placares', rango),
    meta_metros_cocinas: decimal(body.meta_metros_cocinas, 'Meta de metros Cocinas', rango),
  };

  if (Object.values(recibidas).every((v) => v === null)) {
    throw new ApiError(
      400,
      'Enviá al menos una meta (total, Placares o Cocinas) para actualizar.'
    );
  }

  const finales = {
    meta_metros_totales: recibidas.meta_metros_totales !== null
      ? recibidas.meta_metros_totales
      : Number(actual.meta_metros_totales),
    meta_metros_placares: recibidas.meta_metros_placares !== null
      ? recibidas.meta_metros_placares
      : Number(actual.meta_metros_placares),
    meta_metros_cocinas: recibidas.meta_metros_cocinas !== null
      ? recibidas.meta_metros_cocinas
      : Number(actual.meta_metros_cocinas),
  };

  await db.run(`
    UPDATE objetivos_produccion
       SET meta_metros_totales  = ?,
           meta_metros_placares = ?,
           meta_metros_cocinas  = ?
     WHERE periodo = ?;`,
    finales.meta_metros_totales,
    finales.meta_metros_placares,
    finales.meta_metros_cocinas,
    periodo
  );

  return { status: 200, data: { ok: true, periodo, meta: finales } };
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

module.exports = {
  calcular,
  objetivoCorte,
  guardarObjetivoCorte,
  // Utilidades del módulo exportadas para poder testear el cómputo de fechas
  // (bisiestos, cierre de mes, cambio de período) sin necesidad de base.
  _pruebas: { periodoActual, inicioMesSiguiente, diasEntre, diaAcreditado, r2, META_DEFECTO },
};
