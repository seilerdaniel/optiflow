'use strict';

/**
 * OPTIFLOW - Tareas programadas de notificación (Cron)
 * ----------------------------------------------------
 *
 *   POST /api/cron/alertas-excedidas   etapas activas por encima del umbral
 *   POST /api/cron/resumen-diario      resumen de cierre de turno
 *   GET  /api/cron/estado              diagnóstico de configuración
 *
 * Están pensadas para un disparador EXTERNO (Vercel Cron, GitHub Actions,
 * un `curl` en el server de la planta o un schedule del SO). La autenticación
 * usa el modo `cron` de server.js: sesión de gestión O el token estático
 * `OPTIFLOW_CRON_TOKEN` (header `X-Optiflow-Token` o `?token=`).
 *
 * ANTI-SPAM: ambos disparos guardan en memoria la última vez que corrieron,
 * para que un cron mal configurado que llame cada minuto no sature el canal
 * de jefatura. Es memoria de proceso: en un runtime serverless efímero se
 * reinicia, pero el programa real (cierre de turno / una vez por día) no
 * dispara dos veces.
 *
 * CERO dependencias: sólo `db`, `metricas` y el servicio de notificaciones.
 */

const db = require('../db');
const { ApiError } = require('../lib/http');
const notificaciones = require('../lib/notificaciones');
const metricas = require('./metricas');
const registrosRuta = require('./registros');

/** 'YYYY-MM-DD' de HOY en la zona horaria de PLANTA (no del runtime). */
function hoyLocal() {
  return db.aLocalLegible(db.ahoraUTC()).slice(0, 10);
}

/* --------------------------- Anti-spam ----------------------------- */

const ULTIMA_EJECUCION = new Map();

/**
 * ¿Puede correr `clave` ahora?  Devuelve false si corrió hace menos de
 * `minutosEntre` (a menos que se pida `forzar`).
 */
function puedeCorrer(clave, minutosEntre, forzar) {
  if (forzar) return true;
  const ultima = ULTIMA_EJECUCION.get(clave) || 0;
  return (Date.now() - ultima) >= minutosEntre * 60000;
}
function marcar(clave) { ULTIMA_EJECUCION.set(clave, Date.now()); }

/** Minutos transcurridos (netos) de una etapa, reutilizando la regla de planta. */
const netos = (row) => registrosRuta.minutosTranscurridos(row);

/* ------------------------------------------------------------------ */
/* 1. Alertas de tiempo excedido                                       */
/* ------------------------------------------------------------------ */

/**
 * Evalúa TODAS las etapas abiertas ('En Proceso' y 'Pausado') contra el
 * umbral de su sector (db.UMRALES_MINUTOS) y emite `tiempo_excedido` por
 * cada una que lo superó.
 *
 * Sólo se avisa de etapas cuyo exceso está por debajo de `topeMinutos` (por
 * defecto 24 h) para no repetir la alerta eternamente si alguien olvidó un
 * ficho abierto de hace tres días: ese caso queda igualmente visible en el
 * panel de la terminal.
 */
async function alertasExcedidas({ query }) {
  if (!notificaciones.activas()) {
    throw new ApiError(409, 'Las notificaciones están deshabilitadas o sin canales configurados.',
      { accion: 'Defina NOTIFICACIONES_HABILITADAS=true y WHATSAPP_WEBHOOK_URL / TELEGRAM_* en .env.' });
  }

  const forzar = ['1', 'true', 'si'].includes(String(query.forzar || '').toLowerCase());
  if (!puedeCorrer('excedidas', 30, forzar)) {
    return {
      status: 200,
      data: { ok: true, omitido: true, motivo: 'Corrió hace menos de 30 minutos (use ?forzar=1).' },
    };
  }

  const topeMinutos = Math.max(1, Number(query.tope_minutos) || 1440);

  const abiertas = await db.all(`
    SELECT r.*, s.nombre_sector, o.numero_ot, o.cliente
      FROM registros_tiempos r
      JOIN sectores s        ON s.id = r.sector_id
      JOIN ordenes_trabajo o ON o.id = r.ot_id
     WHERE r.estado_etapa IN ('En Proceso','Pausado')
     ORDER BY r.fecha_hora_inicio;`);

  const excedidas = [];
  const disparos = [];

  for (const row of abiertas) {
    const minutos = netos(row);
    const umbral = db.umbralMinutos(row);
    if (!(minutos > umbral)) continue;
    if (minutos > umbral + topeMinutos) continue; // muy vieja: ya se informó

    excedidas.push({
      registro_id: Number(row.id),
      numero_ot: row.numero_ot,
      nombre_sector: row.nombre_sector,
      minutos: Math.round(minutos),
      umbral,
    });

    disparos.push(notificaciones.enviarNotificacion('tiempo_excedido', {
      numero_ot: row.numero_ot,
      cliente: row.cliente,
      nombre_sector: row.nombre_sector,
      operario_nombre: row.operario_nombre,
      tiempo_actual: Math.round(minutos),
      tiempo_limite: umbral,
    }));
  }

  // allSettled: aunque un canal falle, el resto se envía y nada se propaga.
  const resultados = await Promise.allSettled(disparos);
  const enviados = resultados.filter((x) => x.status === 'fulfilled' && x.value.ok).length;
  const errores = resultados
    .filter((x) => x.status === 'fulfilled' && !x.value.ok)
    .flatMap((x) => x.value.errores);

  marcar('excedidas');

  return {
    status: 200,
    data: {
      ok: true,
      evaluadas: abiertas.length,
      excedidas: excedidas.length,
      enviados,
      detalle: excedidas,
      ...(errores.length ? { errores } : {}),
    },
  };
}

/* ------------------------------------------------------------------ */
/* 2. Resumen diario de planta                                          */
/* ------------------------------------------------------------------ */

/** Suma de horas perdidas y causa principal del período. */
function resumirPausas(lista) {
  const horas = (lista || [])
    .reduce((n, p) => n + Number(p.horas_perdidas || 0), 0);
  const principal = (lista || []).find((p) => Number(p.frecuencia) > 0);
  return {
    horas: Math.round(horas * 10) / 10,
    causa: principal ? principal.motivo : 'Sin pausas registradas',
  };
}

/**
 * POST /api/cron/resumen-diario
 * Recicla el MISMO cálculo del dashboard (metricas.calcular) para que el
 * número del WhatsApp coincida siempre con el panel de Administración.
 */
async function resumenDiario({ query }) {
  if (!notificaciones.activas()) {
    throw new ApiError(409, 'Las notificaciones están deshabilitadas o sin canales configurados.',
      { accion: 'Defina NOTIFICACIONES_HABILITADAS=true y WHATSAPP_WEBHOOK_URL / TELEGRAM_* en .env.' });
  }

  const hoy = hoyLocal();
  const forzar = ['1', 'true', 'si'].includes(String(query.forzar || '').toLowerCase());
  const clave = `resumen:${hoy}`;
  if (!puedeCorrer(clave, 60, forzar)) {
    return {
      status: 200,
      data: { ok: true, omitido: true, fecha: hoy, motivo: 'El resumen de hoy ya se envió (use ?forzar=1).' },
    };
  }

  // Ventana = el día LOCAL de planta completo.
  const m = await metricas.calcular({ query: { desde: hoy, hasta: hoy } });
  const d = m.data;

  // "Finalizadas" = OTs que se CERRARON hoy (estado + sello de actualización),
  // no las creadas hoy: es lo que a la jefatura le interesa al cierre del turno.
  const finalizadasHoy = Number((await db.get(
    `SELECT COUNT(*) AS n FROM ordenes_trabajo
      WHERE estado_general = 'Finalizado' AND substr(fecha_actualizacion, 1, 10) = ?;`,
    hoy
  )).n || 0);

  const pausas = resumirPausas(d.pausas_por_motivo);
  const leadDias = d.lead_time && d.lead_time.promedio_minutos !== null
    ? Math.round((Number(d.lead_time.promedio_minutos) / 1440) * 10) / 10
    : null;

  const datos = {
    fecha_hoy: hoy,
    total_ots: finalizadasHoy,
    lead_time_promedio: leadDias === null ? '—' : leadDias.toFixed(1),
    horas_pausa: pausas.horas,
    causa_principal: pausas.causa,
    ftt_porcentaje: (d.ftt && d.ftt.porcentaje !== null && d.ftt.porcentaje !== undefined)
      ? d.ftt.porcentaje : '—',
  };

  const r = await notificaciones.enviarNotificacion('resumen_diario', datos);
  marcar(clave);

  return {
    status: 200,
    data: {
      ok: r.ok,
      fecha: hoy,
      datos,
      canales: r.canales,
      ...(r.errores.length ? { errores: r.errores } : {}),
      ...(d._nota_historica ? { nota_historica: d._nota_historica } : {}),
    },
  };
}

/* ------------------------------------------------------------------ */
/* 3. Diagnóstico                                                       */
/* ------------------------------------------------------------------ */

/** GET /api/cron/estado - qué canales hay y qué eventos dispara cada cosa. */
async function estadoCron() {
  return {
    status: 200,
    data: {
      ...notificaciones.estado(),
      zona_horaria: db.ZONA,
      fecha_hoy: hoyLocal(),
      umbrales_minutos: db.UMBRALES_MINUTOS,
      eventos: {
        pausa_critica: 'Al pausar una etapa con motivo crítico (registros.js).',
        avance_estacion: 'Al finalizar una etapa (registros.js).',
        tiempo_excedido: 'POST /api/cron/alertas-excedidas (evalúa etapas abiertas).',
        resumen_diario: 'POST /api/cron/resumen-diario (cierre de turno).',
      },
    },
  };
}

module.exports = { alertasExcedidas, resumenDiario, estadoCron };
