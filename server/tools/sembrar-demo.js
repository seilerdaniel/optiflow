'use strict';

/**
 * Datos de DEMOSTRACIÓN para verificar el Dashboard Integrado de Métricas.
 *
 * La base recién creada llega vacía (`ot_materiales` y `registros_tiempos`
 * en 0 filas), por lo que los paneles de Materiales, Compartidos y los
 * gráficos de Chart.js no tienen nada que pintar. Este script carga un
 * escenario realista y reproducible:
 *
 *   · 4 OTs de las líneas Placares y Cocinas (una de cada línea cerrada,
 *     para que el filtro "Tiempo de ciclo por sector" tenga ambas opciones).
 *   · Etapas cerradas con duraciones reales + etapas abiertas y pausadas.
 *   · Pausas repartidas entre TODOS los motivos del catálogo real
 *     (MOTIVOS_PAUSA), incluidos los de reproceso que afectan el FTT.
 *   · Materiales con espesor escrito en el nombre (Melamina Blanca 18mm…),
 *     que es lo que el catálogo deriva para poblar el filtro de espesores.
 *
 * Es IDEMPOTENTE: borra sólo lo que este script crea (por prefijo de OT)
 * y lo vuelve a insertar. No toca usuarios, sectores ni el admin.
 *
 *   node server/tools/sembrar-demo.js
 */

const db = require('../db');

/** Hace `min` minutos desde ahora, en ISO con huso (el esquema guarda texto ISO). */
const haceMin = (min) => new Date(Date.now() - min * 60000).toISOString();
/** Fecha local `AAAA-MM-DD` con `desplazamientoDias` desde hoy (para prometidas). */
const fechaDias = (desplazamientoDias) => {
  const d = new Date();
  d.setDate(d.getDate() + desplazamientoDias);
  return d.toISOString().slice(0, 10);
};

const OPERARIOS = ['Gustavo Rivas', 'María Peralta', 'Jorge Sandoval', 'Lucía Ferreyra'];

/**
 * Etapas a crear. `o` = offset en horas desde el arranque de la OT;
 * `d` = duración en minutos. La OT se recorre de la primera a la última
 * sector de SU línea, dejando huecos entre etapas para que el KPI de
 * "standby entre sectores" tenga traspasos medibles.
 */
const ETAPAS = [
  // ---- OT-1710 · Placares · CERRADA de punta a punta (alimenta el lead time)
  { ot: 'OT-1710', sector: 1, o: 0, d: 95, estado: 'Finalizado' },
  { ot: 'OT-1710', sector: 2, o: 3, d: 140, estado: 'Finalizado' },
  { ot: 'OT-1710', sector: 3, o: 6, d: 78, estado: 'Finalizado',
    pausa: { motivo: 'Error de plano', min: 45 } },
  { ot: 'OT-1710', sector: 4, o: 9, d: 210, estado: 'Finalizado' },
  { ot: 'OT-1710', sector: 5, o: 13, d: 62, estado: 'Finalizado',
    pausa: { motivo: 'Falta de herrajes', min: 90 } },
  { ot: 'OT-1710', sector: 6, o: 16, d: 55, estado: 'Finalizado' },
  { ot: 'OT-1710', sector: 7, o: 19, d: 40, estado: 'Finalizado' },

  // ---- OT-1711 · Placares · en curso con un tramo pausado
  { ot: 'OT-1711', sector: 1, o: 2, d: 88, estado: 'Finalizado' },
  { ot: 'OT-1711', sector: 14, o: 5, d: 120, estado: 'Finalizado' },   // Lustre (compartido)
  { ot: 'OT-1711', sector: 2, o: 8, d: 165, estado: 'Finalizado' },
  { ot: 'OT-1711', sector: 3, o: 12, d: null, estado: 'Pausado',
    pausa: { motivo: 'Ajuste de herramienta', min: null } },

  // ---- OT-1712 · Placares · usa los tres talleres compartidos
  { ot: 'OT-1712', sector: 1, o: 1, d: 102, estado: 'Finalizado' },
  { ot: 'OT-1712', sector: 13, o: 4, d: 74, estado: 'Finalizado' },    // Vidrio
  { ot: 'OT-1712', sector: 15, o: 7, d: 155, estado: 'Finalizado',
    pausa: { motivo: 'Rotura de placa', min: 35 } },
  { ot: 'OT-1712', sector: 16, o: 11, d: 180, estado: 'Finalizado' },  // Especiales
  { ot: 'OT-1712', sector: 2, o: 15, d: 130, estado: 'Finalizado' },
  { ot: 'OT-1712', sector: 3, o: 18, d: null, estado: 'En Proceso' },  // etapa abierta

  // ---- OT-1713 · Cocinas · cerrada (el filtro de línea necesita ambas)
  { ot: 'OT-1713', sector: 8, o: 0, d: 84, estado: 'Finalizado' },
  { ot: 'OT-1713', sector: 9, o: 3, d: 112, estado: 'Finalizado' },
  { ot: 'OT-1713', sector: 10, o: 6, d: 96, estado: 'Finalizado',
    pausa: { motivo: 'Otro', min: 25 } },
  { ot: 'OT-1713', sector: 11, o: 9, d: 175, estado: 'Finalizado' },
  { ot: 'OT-1713', sector: 12, o: 13, d: 68, estado: 'Finalizado' },
];

/** OTs a crear además de las 3 sembradas por el esquema. */
const OTS_NUEVAS = [
  {
    numero_ot: 'OT-1713', cliente: 'Cocinas del Sur', modelo: 'Línea Córdoba',
    linea_area: 'Cocinas', metros_lineales: 14, fecha_prometida: fechaDias(4),
    estado: 'En Producción',
    materiales: [
      ['Melamina Roja 18mm', 12, 12],
      ['MDF 15mm', 6, 6],
      ['Fibroplus 6mm', 4, 3],
    ],
  },
];

/** Materiales para las OTs que ya existen (con espesor en el nombre). */
const MATERIALES_EXISTENTES = {
  'OT-1710': [
    ['Melamina Blanca 18mm', 22, 22],
    ['MDF 18mm', 10, 8],
    ['Fibroplus 6mm', 5, 2],
  ],
  'OT-1711': [
    ['Melamina Fenólica 15mm', 18, 9],
    ['MDF 15mm', 8, 4],
  ],
  'OT-1712': [
    ['Melamina Blanca 18mm', 30, 12],
    ['MDF 25mm', 7, 3],
    ['Fibroplus 6mm', 6, 1],
    ['Melamina Roble 18mm', 9, 0],
  ],
};

/** OT que queda DETENIDA y vencida: alimenta el KPI "OTs en riesgo". */
const OT_RIESGO = {
  numero_ot: 'OT-1699', cliente: 'Ferretería Central', modelo: 'Módulo Estante',
  linea_area: 'Placares', metros_lineales: 9, fecha_prometida: fechaDias(-3),
  estado: 'Detenido',
  materiales: [['Melamina Gris 18mm', 11, 4]],
};

async function main() {
  await db.abrirConexion();
  const ahora = new Date().toISOString();

  // ---------- 1. Limpieza idempotente de lo que creamos nosotros ----------
  await db.run(
    `DELETE FROM registros_tiempos
      WHERE ot_id IN (SELECT id FROM ordenes_trabajo
                       WHERE numero_ot IN ('OT-1710','OT-1711','OT-1712','OT-1713','OT-1699'));`
  );
  await db.run(
    `DELETE FROM ot_materiales
      WHERE ot_id IN (SELECT id FROM ordenes_trabajo
                       WHERE numero_ot IN ('OT-1710','OT-1711','OT-1712','OT-1713','OT-1699'));`
  );
  await db.run(`DELETE FROM ordenes_trabajo WHERE numero_ot IN ('OT-1713','OT-1699');`);

  // ---------- 2. Alta de las OTs nuevas (Cocinas + una en riesgo) ----------
  for (const ot of [OTS_NUEVAS[0], OT_RIESGO]) {
    await db.run(
      `INSERT INTO ordenes_trabajo
         (numero_ot, cliente, modelo, linea_area, metros_lineales, fecha_prometida,
          requiere_vidrio, requiere_lustre, requiere_herreria, requiere_especiales,
          estado_general, fecha_creacion, fecha_actualizacion)
       VALUES ($1,$2,$3,$4,$5,$6,0,0,0,0,$7,$8,$8);`,
      ot.numero_ot, ot.cliente, ot.modelo, ot.linea_area, ot.metros_lineales,
      ot.fecha_prometida, ot.estado, ahora
    );
  }

  const ots = await db.all(
    `SELECT id, numero_ot FROM ordenes_trabajo
      WHERE numero_ot IN ('OT-1710','OT-1711','OT-1712','OT-1713','OT-1699');`
  );
  const idOt = new Map(ots.map((o) => [o.numero_ot, Number(o.id)]));

  // ---------- 3. Materiales / placas ----------
  let matIns = 0;
  for (const [numero, lista] of Object.entries(MATERIALES_EXISTENTES)) {
    for (const [nombre, requeridas, consumidas] of lista) {
      await db.run(
        `INSERT INTO ot_materiales
           (ot_id, material_nombre, cantidad_placas, cantidad_consumida,
            observaciones, fecha_creacion, fecha_actualizacion)
         VALUES ($1,$2,$3,$4,NULL,$5,$5);`,
        idOt.get(numero), nombre, requeridas, consumidas, ahora
      );
      matIns += 1;
    }
  }
  for (const ot of [OTS_NUEVAS[0], OT_RIESGO]) {
    for (const [nombre, requeridas, consumidas] of ot.materiales) {
      await db.run(
        `INSERT INTO ot_materiales
           (ot_id, material_nombre, cantidad_placas, cantidad_consumida,
            observaciones, fecha_creacion, fecha_actualizacion)
         VALUES ($1,$2,$3,$4,NULL,$5,$5);`,
        idOt.get(ot.numero_ot), nombre, requeridas, consumidas, ahora
      );
      matIns += 1;
    }
  }

  // ---------- 4. Etapas / fichajes ----------
  // IMPORTANTE: las pausas se registran en `eventos_pausa` (la tabla que
  // alimenta `pausas_por_motivo` y el cálculo del FTT). El campo
  // `registros_tiempos.motivo_pausa` es sólo referencia de trazabilidad:
  // NO es la fuente de las métricas.
  let regIns = 0;
  for (const [i, e] of ETAPAS.entries()) {
    const operario = OPERARIOS[i % OPERARIOS.length];
    const inicio = haceMin(e.o * 60);
    let registroId = 0;

    if (e.estado === 'Finalizado') {
      const pausaMin = e.pausa && e.pausa.min ? e.pausa.min : 0;
      const dur = e.d + pausaMin;                 // duración total del tramo
      const fin = haceMin((e.o * 60) - dur);
      const r = await db.run(
        `INSERT INTO registros_tiempos
           (ot_id, sector_id, operario_nombre, fecha_hora_inicio, fecha_hora_fin,
            duracion_minutos, estado_etapa, motivo_pausa, observacion,
            pausa_inicio, segundos_pausados, fecha_creacion, fecha_actualizacion)
         VALUES ($1,$2,$3,$4,$5,$6,'Finalizado',$7,NULL,NULL,$8,$9,$9);`,
        idOt.get(e.ot), e.sector, operario, inicio, fin, dur,
        e.pausa ? e.pausa.motivo : null, pausaMin * 60, ahora
      );
      registroId = r.lastInsertRowid;

      // Evento de pausa CERRADO: ocurrió y terminó dentro del mismo tramo.
      if (pausaMin > 0) {
        await db.run(
          `INSERT INTO eventos_pausa
             (registro_id, motivo_pausa, observacion, inicio_pausa, fin_pausa,
              segundos, fecha_creacion)
           VALUES ($1,$2,'Demo: pausa registrada en planta',$3,$4,$5,$6);`,
          registroId, e.pausa.motivo,
          haceMin((e.o * 60) - e.d),   // al terminar el trabajo útil
          fin, pausaMin * 60, ahora
        );
      }
    } else if (e.estado === 'Pausado') {
      const r = await db.run(
        `INSERT INTO registros_tiempos
           (ot_id, sector_id, operario_nombre, fecha_hora_inicio, fecha_hora_fin,
            duracion_minutos, estado_etapa, motivo_pausa, observacion,
            pausa_inicio, segundos_pausados, fecha_creacion, fecha_actualizacion)
         VALUES ($1,$2,$3,$4,NULL,NULL,'Pausado',$5,'Demo: etapa pausada en planta',
                 $6,0,$7,$7);`,
        idOt.get(e.ot), e.sector, operario, inicio,
        e.pausa ? e.pausa.motivo : 'Otro', haceMin((e.o * 60) - 45), ahora
      );
      registroId = r.lastInsertRowid;

      // Evento de pausa ABIERTO: sigue corriendo (fin_pausa = NULL).
      await db.run(
        `INSERT INTO eventos_pausa
           (registro_id, motivo_pausa, observacion, inicio_pausa, fin_pausa,
            segundos, fecha_creacion)
         VALUES ($1,$2,'Demo: pausa abierta en planta',$3,NULL,0,$4);`,
        registroId, e.pausa ? e.pausa.motivo : 'Otro',
        haceMin((e.o * 60) - 45), ahora
      );
    } else {
      await db.run(
        `INSERT INTO registros_tiempos
           (ot_id, sector_id, operario_nombre, fecha_hora_inicio, fecha_hora_fin,
            duracion_minutos, estado_etapa, motivo_pausa, observacion,
            pausa_inicio, segundos_pausados, fecha_creacion, fecha_actualizacion)
         VALUES ($1,$2,$3,$4,NULL,NULL,'En Proceso',NULL,'Demo: etapa en curso',
                 NULL,0,$5,$5);`,
        idOt.get(e.ot), e.sector, operario, inicio, ahora
      );
    }
    regIns += 1;
  }

  const total = await db.get('select count(*)::int as n from registros_tiempos');
  const mats = await db.get('select count(*)::int as n from ot_materiales');
  const pausas = await db.get('select count(*)::int as n from eventos_pausa');
  console.log(`✔ Demo sembrada: ${regIns} etapas, ${matIns} líneas de material, ${pausas.n} eventos de pausa.`);
  console.log(`  registros_tiempos = ${total.n} · ot_materiales = ${mats.n} · eventos_pausa = ${pausas.n}`);

  await db.cerrarConexion();
}

main().catch((e) => { console.error('✗ Falló el demo:', e.message); process.exit(1); });
