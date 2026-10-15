'use strict';

/**
 * MANTENIMIENTO PREVENTIVO (TPM) por HORAS NETAS de uso real de máquina.
 *
 * El mantenimiento NO se agenda por fecha de calendario sino por HORA NETA
 * de trabajo productivo: sólo se suman etapas `Finalizado` de
 * `registros_tiempos`, de modo que las pausas no corren el contador.
 *
 * REGLAS DE NEGOCIO:
 *  T1. "Horas desde último service" = SUMA(duracion_minutos)/60 del SECTOR
 *      − `horas_ultimo_mantenimiento` (fotografía del acumulado al hacerse el
 *      service). Nunca se pone el acumulado a cero: el histórico de horas de
 *      la máquina se conserva íntegro.
 *  T2. Estados de alerta por % de uso (horas_desde_service / intervalo):
 *        · ok         → < 80 %            (verde)
 *        · advertencia→ >= 80 % y < 100 % (amarillo)
 *        · critico    → >= 100 %          (rojo parpadeante / vencido)
 *  T3. Registrar un service vuelve a fotografiar el acumulado vigente y deja
 *      el contador "desde el último service" en 0, dejando rastro en
 *      `historial_mantenimiento` (técnico, hora, horas y observaciones).
 *  T4. Sólo las máquinas con `activo = 1` generan alertas; las inactivas se
 *      listan igual en el panel de gestión para poder reactivarlas.
 *  T5. Lecturas abiertas (coherente con /api/estado y /api/sectores, que la
 *      terminal consume). Las escrituras exigen rol gestión (admin/encargado).
 *
 * Un SECTOR puede tener varias máquinas TPM (p. ej. dos seccionadoras), pero
 * la misma máquina no se duplica dentro de un sector (índice único).
 */

const db = require('../db');
const {
  ApiError, textoRequerido, textoOpcional, entero, decimal, booleano,
} = require('../lib/http');

/** Redondea a 2 decimales, igual que el resto de la API. */
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;

/* ------------------------------------------------------------------ */
/* Cálculo de horas netas                                              */
/* ------------------------------------------------------------------ */

/**
 * Horas netas acumuladas POR SECTOR (T1). Un único GROUP BY alimenta a todas
 * las máquinas del listado: evita un N+1 y el costo lo paga un índice
 * (registros_tiempos crece, sectores son pocos).
 *
 * @returns {Map<number, number>} sector_id -> horas netas acumuladas
 */
async function horasPorSector() {
  const filas = await db.all(
    `SELECT sector_id, COALESCE(SUM(duracion_minutos), 0) AS minutos
       FROM registros_tiempos
      WHERE estado_etapa = 'Finalizado'
      GROUP BY sector_id;`
  );
  const mapa = new Map();
  for (const f of filas) mapa.set(Number(f.sector_id), Number(f.minutos || 0) / 60);
  return mapa;
}

/** Umbrales de alerta (T2), centralizados para que UI y API no diverjan. */
function estadoDeUso(pct) {
  if (pct >= 100) return 'critico';
  if (pct >= 80) return 'advertencia';
  return 'ok';
}

/** Enriquece una fila de `maquinas_tpm` con el cómputo en tiempo real. */
function computarMaquina(m, mapa) {
  const sectorId = Number(m.sector_id);
  const horasSector = mapa.get(sectorId) || 0;
  const base = Number(m.horas_ultimo_mantenimiento || 0);
  const objetivo = Number(m.intervalo_horas_target || 0);

  const desdeServicio = Math.max(0, horasSector - base);
  const pct = objetivo > 0 ? (desdeServicio / objetivo) * 100 : 0;

  return {
    id: Number(m.id),
    sector_id: sectorId,
    nombre_sector: m.nombre_sector || null,
    linea_area: m.linea_area || null,
    nombre_maquina: m.nombre_maquina,
    tarea_mantenimiento: m.tarea_mantenimiento,
    intervalo_horas_target: objetivo,
    horas_acumuladas_sector: r2(horasSector),
    horas_ultimo_mantenimiento: r2(base),
    horas_desde_ultimo_mantenimiento: r2(desdeServicio),
    horas_restantes: r2(Math.max(0, objetivo - desdeServicio)),
    pct_uso: r2(pct),
    estado: estadoDeUso(pct),
    activo: Number(m.activo) === 1,
  };
}

const SQL_MAQUINAS = `
  SELECT m.*, s.nombre_sector, s.linea_area
    FROM maquinas_tpm m
    JOIN sectores s ON s.id = m.sector_id`;

/** Normaliza los campos numéricos del historial para JSON. */
function mapHistorial(h) {
  return {
    id: Number(h.id),
    maquina_tpm_id: Number(h.maquina_tpm_id),
    nombre_maquina: h.nombre_maquina || null,
    tarea_mantenimiento: h.tarea_mantenimiento || null,
    nombre_sector: h.nombre_sector || null,
    tecnico_operario: h.tecnico_operario,
    fecha_hora: h.fecha_hora,
    horas_acumuladas_al_service: r2(h.horas_acumuladas_al_service),
    observaciones: h.observaciones || null,
  };
}

/* ------------------------------------------------------------------ */
/* Endpoints                                                           */
/* ------------------------------------------------------------------ */

/**
 * GET /api/tpm
 * Listado completo para el panel de Administración: máquinas con horas
 * netas computadas, % de uso, estado de alerta, historial y resumen.
 * Incluye las inactivas (T4) para poder gestionarlas.
 */
async function listar() {
  const maqs = await db.all(`${SQL_MAQUINAS}
     ORDER BY s.orden_flujo, s.nombre_sector, m.nombre_maquina;`);
  const mapa = await horasPorSector();
  const maquinas = maqs.map((m) => computarMaquina(m, mapa));

  const historial = await db.all(`
    SELECT h.id, h.maquina_tpm_id, h.tecnico_operario, h.fecha_hora,
           h.horas_acumuladas_al_service, h.observaciones,
           m.nombre_maquina, m.tarea_mantenimiento, s.nombre_sector
      FROM historial_mantenimiento h
      JOIN maquinas_tpm m ON m.id = h.maquina_tpm_id
      JOIN sectores s     ON s.id = m.sector_id
     ORDER BY h.fecha_hora DESC
     LIMIT 500;`);

  const resumen = { total: maquinas.length, ok: 0, advertencia: 0, critico: 0, inactivas: 0 };
  for (const m of maquinas) {
    if (!m.activo) resumen.inactivas += 1;
    resumen[m.estado] += 1;
  }

  return {
    status: 200,
    data: { maquinas, historial: historial.map(mapHistorial), resumen },
  };
}

/**
 * GET /api/tpm/estado
 * Vista ligera para la TERMINAL DE PLANTA: sólo máquinas activas, sin
 * historial. La terminal la usa para avisar cuando el sector elegido por el
 * operario tiene un mantenimiento VENCIDO.
 */
async function estado() {
  const maqs = await db.all(`${SQL_MAQUINAS}
     WHERE m.activo = 1
     ORDER BY s.orden_flujo, m.nombre_maquina;`);
  const mapa = await horasPorSector();
  const maquinas = maqs.map((m) => computarMaquina(m, mapa));

  return {
    status: 200,
    data: {
      maquinas,
      criticas: maquinas.filter((m) => m.estado === 'critico'),
      advertencias: maquinas.filter((m) => m.estado === 'advertencia'),
    },
  };
}

/**
 * POST /api/tpm/mantenimiento
 * Registra un service realizado: vuelve a fotografiar el acumulado vigente
 * (T3) y guarda el rastro en el historial. Transaccional y con advisory lock
 * por sector para que dos técnicos no reseteen a la vez.
 */
async function registrarMantenimiento({ body }) {
  const id = entero(body.maquina_tpm_id, 'maquina_tpm_id');
  const tecnico = textoRequerido(body.tecnico_operario, 'Técnico / Operario', { max: 120 });
  const observaciones = textoOpcional(body.observaciones, 'Observaciones', { max: 1000 });

  const maq = await db.get('SELECT * FROM maquinas_tpm WHERE id = ?;', id);
  if (!maq) throw new ApiError(404, `No existe la máquina TPM con id ${id}.`);

  const sectorId = Number(maq.sector_id);
  const ahora = db.ahoraUTC();

  return db.transaccion(async () => {
    // Relee el acumulado DENTRO de la transacción: la fotografía del service
    // debe reflejar exactamente las horas netas acumuladas al momento de
    // cerrarlo, no las que había al entrar el request.
    const acum = await db.get(
      `SELECT COALESCE(SUM(duracion_minutos), 0) AS minutos
         FROM registros_tiempos
        WHERE sector_id = ? AND estado_etapa = 'Finalizado';`,
      sectorId
    );
    const horas = Number(acum && acum.minutos || 0) / 60;

    await db.run(
      'UPDATE maquinas_tpm SET horas_ultimo_mantenimiento = ?, fecha_actualizacion = ? WHERE id = ?;',
      horas, ahora, id
    );

    const r = await db.run(
      `INSERT INTO historial_mantenimiento
         (maquina_tpm_id, tecnico_operario, fecha_hora,
          horas_acumuladas_al_service, observaciones, fecha_creacion)
       VALUES (?, ?, ?, ?, ?, ?);`,
      id, tecnico, ahora, horas, observaciones, ahora
    );

    return {
      status: 201,
      data: {
        ok: true,
        historial_id: r.lastInsertRowid,
        horas_acumuladas_al_service: r2(horas),
        horas_desde_ultimo_mantenimiento: 0,
      },
    };
  }, [[db.LOCK_SECTOR, sectorId]]);
}

/**
 * POST /api/tpm/configurar
 * Alta o modificación de una máquina TPM (metas, tarea, baseline y estado).
 * Los campos opcionales NO enviados conservan el valor vigente al editar, para
 * que un formulario incompleto no reactive una máquina dada de baja ni borre
 * el baseline de horas y dispare una falsa alarma crítica.
 */
async function configurar({ body }) {
  const sectorId = entero(body.sector_id, 'sector_id');
  const nombre = textoRequerido(body.nombre_maquina, 'nombre_maquina', { max: 160 });
  const tarea = textoRequerido(body.tarea_mantenimiento, 'tarea_mantenimiento', { max: 300 });
  const intervalo = decimal(body.intervalo_horas_target, 'intervalo_horas_target', {
    requerido: true, min: 1, max: 100000,
  });

  // null = "no enviado" → al editar se preserva el valor guardado.
  const horasBase = (body.horas_ultimo_mantenimiento === undefined
    || body.horas_ultimo_mantenimiento === null
    || body.horas_ultimo_mantenimiento === '')
    ? null
    : decimal(body.horas_ultimo_mantenimiento, 'horas_ultimo_mantenimiento', { min: 0, max: 10000000 });
  const activo = (body.activo === undefined || body.activo === null || body.activo === '')
    ? null
    : (booleano(body.activo, true) ? 1 : 0);

  const id = (body.id === undefined || body.id === null || body.id === '')
    ? null
    : entero(body.id, 'id');

  const sector = await db.get('SELECT id, nombre_sector FROM sectores WHERE id = ?;', sectorId);
  if (!sector) throw new ApiError(404, `No existe el sector con id ${sectorId}.`);

  // Misma condición que el índice único uq_tpm_sector_maquina (insensible a
  // mayúsculas): se valida en el handler para devolver un 409 comprensible.
  const choque = id
    ? await db.get(
      `SELECT id FROM maquinas_tpm
        WHERE sector_id = ? AND lower(nombre_maquina) = lower(?) AND id <> ?;`,
      sectorId, nombre, id
    )
    : await db.get(
      'SELECT id FROM maquinas_tpm WHERE sector_id = ? AND lower(nombre_maquina) = lower(?);',
      sectorId, nombre
    );
  if (choque) {
    throw new ApiError(409,
      `Ya existe una máquina llamada "${nombre}" en el sector ${sector.nombre_sector}.`,
      { accion: 'Renombre la máquina nueva o edite la existente.' });
  }

  const ahora = db.ahoraUTC();

  if (id) {
    const actual = await db.get('SELECT * FROM maquinas_tpm WHERE id = ?;', id);
    if (!actual) throw new ApiError(404, `No existe la máquina TPM con id ${id}.`);

    await db.run(
      `UPDATE maquinas_tpm
          SET sector_id = ?, nombre_maquina = ?, tarea_mantenimiento = ?,
              intervalo_horas_target = ?, horas_ultimo_mantenimiento = ?,
              activo = ?, fecha_actualizacion = ?
        WHERE id = ?;`,
      sectorId, nombre, tarea, intervalo,
      horasBase === null ? Number(actual.horas_ultimo_mantenimiento || 0) : horasBase,
      activo === null ? Number(actual.activo || 0) : activo,
      ahora, id
    );
    return { status: 200, data: { ok: true, id } };
  }

  const r = await db.run(
    `INSERT INTO maquinas_tpm
       (sector_id, nombre_maquina, tarea_mantenimiento, intervalo_horas_target,
        horas_ultimo_mantenimiento, activo, fecha_creacion, fecha_actualizacion)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
    sectorId, nombre, tarea, intervalo, horasBase === null ? 0 : horasBase,
    activo === null ? 1 : activo, ahora, ahora
  );

  return { status: 201, data: { ok: true, id: r.lastInsertRowid } };
}

module.exports = { listar, estado, registrarMantenimiento, configurar };
