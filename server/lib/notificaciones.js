'use strict';

/**
 * OPTIFLOW - Servicio de Notificaciones Automatizadas (WhatsApp / Telegram)
 * ------------------------------------------------------------------------
 *
 * REGLAS DE ORO del proyecto respetadas acá:
 *   · CERO dependencias npm. Todo se hace con `fetch` global (Node >= 18) y
 *     `AbortSignal.timeout`, sin SDKs de WhatsApp ni librerías de Telegram.
 *   · NUNCA rompe la aplicación: `enviarNotificacion` devuelve una promesa
 *     que NO se rechaza jamás. Si no hay internet, si el gateway está caído o
 *     si falta configuración, se resuelve con `{ ok:false }` y se loguea.
 *   · No bloquea el hilo: los envíos son fire-and-forget vía
 *     `dispararNotificacion()`, que no espera la respuesta.
 *
 * VARIABLES DE ENTORNO (ver .env.example):
 *   NOTIFICACIONES_HABILITADAS  'true' | 'false'  ( interruptor maestro )
 *   WHATSAPP_WEBHOOK_URL        Gateway (Evolution API / Baileys / Twilio…)
 *   TELEGRAM_BOT_TOKEN          Token del bot (api.telegram.org)
 *   TELEGRAM_CHAT_ID            Chat o grupo destino
 *
 * Se leen de forma PEREZOSA (en cada envío, no al cargar el módulo) para no
 * depender del orden de `require`: el parseador de `.env` vive en db.js y
 * sólo garantiza las variables cuando ese módulo ya fue cargado. Por eso se
 * importa abajo, además de usarlo para la zona horaria de planta.
 */

const db = require('../db');

/** Timeout de cada petición saliente: corto a propósito. */
const TIMEOUT_MS = Math.max(1000, Number(process.env.NOTIFICACIONES_TIMEOUT_MS) || 8000);

/**
 * Motivos de pausa que disparan la alerta `pausa_critica`.
 * Son los que implican detención REAL de la línea (rotura, error de plano o
 * ajuste de herramienta). "Falta de herrajes" y "Otro" quedan fuera: suelen
 * ser esperas administrativas y saturarían el canal de jefatura.
 */
const MOTIVOS_ALERTA_PAUSA = Object.freeze([
  'Rotura de placa',
  'Error de plano',
  'Ajuste de herramienta',
]);

/* ------------------------------------------------------------------ */
/* Configuración (lazy)                                                */
/* ------------------------------------------------------------------ */

const VERDADERO = /^(1|true|si|sí|on|yes|y)$/i;

function configuracion() {
  return {
    habilitadas: VERDADERO.test(String(process.env.NOTIFICACIONES_HABILITADAS || '').trim()),
    whatsappUrl: (process.env.WHATSAPP_WEBHOOK_URL || '').trim(),
    telegramToken: (process.env.TELEGRAM_BOT_TOKEN || '').trim(),
    telegramChatId: (process.env.TELEGRAM_CHAT_ID || '').trim(),
  };
}

/** Interruptor maestro: ¿hay algún canal configurado y habilitado? */
function activas() {
  const c = configuracion();
  if (!c.habilitadas) return false;
  return !!(c.whatsappUrl || (c.telegramToken && c.telegramChatId));
}

/** Diagnóstico para /api/salud y el script de prueba. */
function estado() {
  const c = configuracion();
  return {
    habilitadas: c.habilitadas,
    activas: activas(),
    whatsapp: c.whatsappUrl ? 'configurado' : 'sin configurar',
    telegram: (c.telegramToken && c.telegramChatId) ? 'configurado' : 'sin configurar',
    motivos_alerta_pausa: [...MOTIVOS_ALERTA_PAUSA],
  };
}

/** Motivo de pausa que debe generar `pausa_critica`. */
function esMotivoCritico(motivo) {
  return MOTIVOS_ALERTA_PAUSA.includes(motivo);
}

/* ------------------------------------------------------------------ */
/* Plantillas (texto plano con emojis, formato *negrita* de WhatsApp y  */
/* Telegram Markdown; en otros gateways se envía igual, sin formato)    */
/* ------------------------------------------------------------------ */

const PLANTILLAS = Object.freeze({
  /**
   * A. ALERTA DE DETENCIÓN EN PLANTA
   */
  pausa_critica: (d) => [
    '⚠️ *OPTIFLOW | ALERTA DE DETENCIÓN*',
    '',
    `📁 *OT:* ${d.numero_ot} — ${d.cliente}`,
    `🏭 *Sector:* ${d.nombre_sector}`,
    `👤 *Operario:* ${d.operario_nombre}`,
    '⏱️ *Estado:* PAUSADO',
    `🛑 *Motivo:* ${d.motivo_pausa}`,
    `📝 *Obs:* ${d.observacion}`,
    '',
    '📌 *Notificado automáticamente a Jefatura de Planta y Oficina Técnica.*',
  ].join('\n'),

  /**
   * B. PASE DE ESTACIÓN / OT LISTA
   */
  avance_estacion: (d) => [
    '🟢 *OPTIFLOW | AVANCE DE PRODUCCIÓN*',
    '',
    `📁 *OT:* ${d.numero_ot} — ${d.cliente}`,
    `🏭 *Sector Completado:* ${d.sector_anterior}`,
    `👤 *Responsable:* ${d.operario_nombre}`,
    `⏱️ *Duración Etapa:* ${d.duracion_formateada}`,
    '',
    `➡️ *Próximo Sector:* ${d.siguiente_sector}`,
    '📦 *Ubicación Pallet:* Buffer Intermedio Línea',
  ].join('\n'),

  /**
   * C. ALERTA DE TIEMPO EXCEDIDO
   */
  tiempo_excedido: (d) => [
    '🔴 *OPTIFLOW | TIEMPO EXCEDIDO EN ETAPA*',
    '',
    `📁 *OT:* ${d.numero_ot} — ${d.cliente}`,
    `🏭 *Sector:* ${d.nombre_sector}`,
    `👤 *Responsable:* ${d.operario_nombre}`,
    `⏳ *Tiempo Transcurrido:* ${d.tiempo_actual} min (Límite: ${d.tiempo_limite} min)`,
    '',
    '⚠️ *Atención:* La OT acumula un desvío significativo. Se requiere verificación en el puesto.',
  ].join('\n'),

  /**
   * D. RESUMEN DIARIO DE PLANTA
   */
  resumen_diario: (d) => [
    '📊 *OPTIFLOW | RESUMEN DIARIO DE PLANTA*',
    `📅 *Fecha:* ${d.fecha_hoy}`,
    '',
    `✅ *OTs Finalizadas:* ${d.total_ots}`,
    `⏱️ *Lead Time Promedio:* ${d.lead_time_promedio} días`,
    `🛑 *Horas Perdidas por Pausas:* ${d.horas_pausa}h`,
    `🥇 *Causa Principal de Pausa:* ${d.causa_principal}`,
    `📈 *Índice FTT (Calidad a la 1ª):* ${d.ftt_porcentaje}%`,
    '',
    '📋 *Consulte el panel completo en: https://optiflow-taupe.vercel.app/admin*',
  ].join('\n'),
});

const TIPOS = Object.freeze(Object.keys(PLANTILLAS));

/** Texto por defecto cuando un dato viene vacío o nulo. */
const VACIO = '—';

/**
 * Resuelve los campos de la plantilla con `—` cuando faltan.
 *
 * Las plantillas son funciones con template literals (`${d.numero_ot}`), así
 * que un campo ausente se interpolaría como "undefined" y arruinaría el
 * mensaje en el celular del jefe. Este Proxy intercepta la LECTURA de
 * cualquier clave y devuelve `—` si no hay valor, sin que cada plantilla
 * tenga que poner `|| '—'` en cada línea.
 */
function conVacios(datos) {
  const d = datos || {};
  return new Proxy(d, {
    get(obj, clave) {
      const v = obj[clave];
      if (v === undefined || v === null || v === '') return VACIO;
      return v;
    },
  });
}

/**
 * Construye el cuerpo del mensaje para un tipo de evento.
 * Lanza sólo si el tipo es desconocido (error de programación, no de red).
 */
function construirMensaje(tipo, datos) {
  const plantilla = PLANTILLAS[tipo];
  if (!plantilla) {
    throw new Error(`Tipo de notificación desconocido: "${tipo}". Válidos: ${TIPOS.join(', ')}`);
  }
  return plantilla(conVacios(datos));
}

/** Duración en minutos -> '2 h 15 min' / '45 min' (misma regla que la UI). */
function minutosLegibles(min) {
  if (min === null || min === undefined) return VACIO;
  const total = Math.max(0, Math.round(Number(min)));
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  return hh > 0 ? `${hh} h ${String(mm).padStart(2, '0')} min` : `${mm} min`;
}

/* ------------------------------------------------------------------ */
/* Transporte                                                          */
/* ------------------------------------------------------------------ */

/**
 * POST JSON genérico. A diferencia de `enviarNotificacion`, ESTA función sí
 * puede rechazar: es el nivel bajo y sólo la usan los remitentes, que ya
 * atrapan el error.
 */
async function postJSON(url, cuerpo) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    // No seguir redirecciones: un gateway que redirige suele ser un error de
    // configuración, y seguirlo alargaría el timeout del endpoint de planta.
    redirect: 'error',
  });
  if (!r.ok) {
    const texto = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status}${texto ? `: ${texto.slice(0, 160)}` : ''}`);
  }
  return r;
}

/**
 * WhatsApp vía webhook / gateway.
 * El payload es deliberadamente GENÉRICO (`text` + `message`) para servir a
 * Evolution API, Baileys o un middleware propio sin adaptadores.
 */
async function enviarWhatsApp(mensaje, cfg, tipo) {
  await postJSON(cfg.whatsappUrl, {
    event: 'message',
    text: mensaje,
    message: mensaje,
    tipo,
    origen: 'optiflow',
    enviado_en: db.ahoraUTC(),
  });
  return 'whatsapp';
}

/** Telegram Bot API: sendMessage con Markdown (la negrita usa *asteriscos*). */
async function enviarTelegram(mensaje, cfg) {
  // Base configurable sólo para probar contra un mock o pasar por un proxy
  // corporativo; en planta se usa la API pública por defecto.
  const base = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
  await postJSON(`${base}/bot${cfg.telegramToken}/sendMessage`, {
    chat_id: cfg.telegramChatId,
    text: mensaje,
    parse_mode: 'Markdown',
    // Las URLs largas arruinan el mensaje en el celular: sólo texto.
    disable_web_page_preview: true,
  });
  return 'telegram';
}

/* ------------------------------------------------------------------ */
/* API pública                                                         */
/* ------------------------------------------------------------------ */

/**
 * Envía una notificación a TODOS los canales configurados.
 *
 * @param {string} tipo  pausa_critica | avance_estacion | tiempo_excedido | resumen_diario
 * @param {object} datos campos de la plantilla
 * @returns {Promise<{ok:boolean, tipo:string, canales:string[], errores:string[]}>}
 *          NUNCA se rechaza: un fallo de red queda en `errores`.
 */
async function enviarNotificacion(tipo, datos) {
  const cfg = configuracion();
  const resultado = { ok: false, tipo, canales: [], errores: [] };

  // Se construye ANTES de mirar el interruptor: un tipo mal escrito es un
  // error de programación y conviene verlo aunque el módulo esté apagado.
  let mensaje;
  try {
    mensaje = construirMensaje(tipo, datos);
  } catch (e) {
    resultado.errores.push(String(e.message || e));
    return resultado;
  }

  if (!cfg.habilitadas) {
    resultado.errores.push('Notificaciones deshabilitadas (NOTIFICACIONES_HABILITADAS).');
    return resultado;
  }

  // Cada envío se etiqueta con su canal: así un canal que FALLA queda en
  // `errores` y NO cuenta como exitoso (con un .catch interno la promesa se
  // resolvería igual y falsearía el resultado).
  const envios = [];
  if (cfg.whatsappUrl) {
    envios.push({ canal: 'whatsapp', p: enviarWhatsApp(mensaje, cfg, tipo) });
  }
  if (cfg.telegramToken && cfg.telegramChatId) {
    envios.push({ canal: 'telegram', p: enviarTelegram(mensaje, cfg) });
  }

  if (!envios.length) {
    resultado.errores.push('Sin canales configurados (WHATSAPP_WEBHOOK_URL / TELEGRAM_*).');
    return resultado;
  }

  // allSettled nunca rechaza: por eso `enviarNotificacion` tampoco lo hace.
  const r = await Promise.allSettled(envios.map((e) => e.p));
  r.forEach((x, i) => {
    if (x.status === 'fulfilled') {
      resultado.canales.push(envios[i].canal);
    } else {
      const msg = (x.reason && x.reason.message) || String(x.reason);
      resultado.errores.push(`${envios[i].canal}: ${msg}`);
    }
  });
  resultado.ok = resultado.canales.length > 0;

  if (resultado.ok) {
    console.log(`[notificaciones] ${tipo} → ${resultado.canales.join(' + ')}`);
  } else if (resultado.errores.length) {
    console.warn(`[notificaciones] ${tipo} falló: ${resultado.errores.join(' | ')}`);
  }
  return resultado;
}

/**
 * Dispara SIN esperar (fire-and-forget) para no sumar latencia al fichado de
 * planta. Cacheca cualquier rechazo: aunque `enviarNotificacion` no rechaza,
 * esto protege ante un error sincrónico inesperado al construir la llamada.
 */
function dispararNotificacion(tipo, datos) {
  try {
    Promise.resolve(enviarNotificacion(tipo, datos)).catch(() => {});
  } catch { /* noop: las notificaciones jamás rompen el endpoint */ }
}

module.exports = {
  TIPOS,
  MOTIVOS_ALERTA_PAUSA,
  PLANTILLAS,
  activas,
  estado,
  esMotivoCritico,
  construirMensaje,
  minutosLegibles,
  enviarNotificacion,
  dispararNotificacion,
};
