'use strict';

/**
 * OPTIFLOW - Prueba rápida del módulo de Notificaciones
 * -----------------------------------------------------
 * No forma parte de la app: es una herramienta de consola para verificar la
 * configuración de WhatsApp/Telegram antes de dejarlo corriendo en planta.
 *
 * USO:
 *   node server/tools/probar-notificaciones.js                 # envía pausa_critica
 *   node server/tools/probar-notificaciones.js --tipo=resumen_diario
 *   node server/tools/probar-notificaciones.js --todos          # los 4 tipos
 *   node server/tools/probar-notificaciones.js --solo-mostrar   # sólo imprime
 *   node server/tools/probar-notificaciones.js --sin-db         # sin tocar la BD
 *
 * Requiere en .env (o en el entorno):
 *   NOTIFICACIONES_HABILITADAS=true
 *   WHATSAPP_WEBHOOK_URL=...   y/o   TELEGRAM_BOT_TOKEN=... + TELEGRAM_CHAT_ID=...
 */

// require('../db') dispara el parseo de .env (módulo con IIFE en la raíz);
// sin eso las variables del archivo no estarían en process.env.
const db = require('../db');
const notificaciones = require('../lib/notificaciones');

const args = process.argv.slice(2);
const tiene = (f) => args.includes(f);
const valorDe = (f, d) => {
  const a = args.find((x) => x.startsWith(`${f}=`));
  return a ? a.slice(f.length + 1) : d;
};

/** Datos simulados coherentes con la planta real. */
const DATOS = {
  pausa_critica: {
    numero_ot: 'OT-1713',
    cliente: 'TEX CARE VESTIDOR',
    nombre_sector: 'Seccionadora / Corte',
    operario_nombre: 'Mario Ríos',
    motivo_pausa: 'Rotura de placa',
    observacion: 'Placa de 18 mm agrietada en el corte diagonal.',
  },
  avance_estacion: {
    numero_ot: 'OT-1713',
    cliente: 'TEX CARE VESTIDOR',
    sector_anterior: 'Seccionadora / Corte',
    operario_nombre: 'Mario Ríos',
    duracion_formateada: notificaciones.minutosLegibles(95),
    siguiente_sector: 'Enfiladora',
  },
  tiempo_excedido: {
    numero_ot: 'OT-1710',
    cliente: 'COCINAS DEL SUR',
    nombre_sector: 'Pantógrafo CNC / Mecanizado',
    operario_nombre: 'José',
    tiempo_actual: 187,
    tiempo_limite: db.umbralMinutos('Pantógrafo CNC / Mecanizado'),
  },
  resumen_diario: {
    fecha_hoy: db.aLocalLegible(db.ahoraUTC()).slice(0, 10),
    total_ots: 7,
    lead_time_promedio: '3.4',
    horas_pausa: 5.5,
    causa_principal: 'Ajuste de herramienta',
    ftt_porcentaje: 86.7,
  },
};

function imprimirConfig() {
  const e = notificaciones.estado();
  console.log('\n--- CONFIGURACIÓN ---');
  console.log(`  NOTIFICACIONES_HABILITADAS : ${e.habilitadas}`);
  console.log(`  WhatsApp (webhook)         : ${e.whatsapp}`);
  console.log(`  Telegram (bot + chat)      : ${e.telegram}`);
  console.log(`  Zona horaria de planta     : ${db.ZONA}`);
  console.log(`  Motivos que alertan pausa  : ${e.motivos_alerta_pausa.join(' · ')}`);
  if (!e.activas) {
    console.log('\n  ⚠ El módulo está APAGADO o sin canales: ningún mensaje se enviará.');
    console.log('    Complete .env (ver .env.example) y vuelva a ejecutar.');
  }
}

function imprimirVistaPrevia(tipo) {
  const texto = notificaciones.construirMensaje(tipo, DATOS[tipo]);
  console.log(`\n--- VISTA PREVIA: ${tipo} ---`);
  console.log(texto.replace(/^/gm, '  '));
}

(async () => {
  const soloMostrar = tiene('--solo-mostrar') || tiene('--dry-run');
  const todos = tiene('--todos');
  const tipos = todos
    ? [...notificaciones.TIPOS]
    : [valorDe('--tipo', 'pausa_critica')];

  console.log('\n==============================================');
  console.log('  OPTIFLOW · Prueba del módulo de notificaciones');
  console.log('==============================================');
  imprimirConfig();

  for (const tipo of tipos) {
    if (!notificaciones.TIPOS.includes(tipo)) {
      console.log(`\n  ✗ Tipo desconocido: "${tipo}". Válidos: ${notificaciones.TIPOS.join(', ')}`);
      process.exitCode = 1;
      continue;
    }
    imprimirVistaPrevia(tipo);
  }

  if (soloMostrar) {
    console.log('\n  (Modo --solo-mostrar: no se envió nada.)\n');
    return;
  }

  for (const tipo of tipos) {
    console.log(`\n--- ENVÍO REAL: ${tipo} ---`);
    const r = await notificaciones.enviarNotificacion(tipo, DATOS[tipo]);
    if (r.ok) {
      console.log(`  ✓ Enviado por: ${r.canales.join(' + ')}`);
    } else {
      console.log('  ✗ No se envió.');
      for (const e of r.errores) console.log(`     · ${e}`);
      process.exitCode = 1;
    }
  }

  try { await db.cerrarConexion(); } catch { /* noop */ }
  console.log('');
})();
