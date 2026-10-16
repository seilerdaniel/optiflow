'use strict';

/**
 * Endpoints de Registros de Tiempos (eventos de producción).
 *
 * REGLAS DE NEGOCIO IMPLEMENTADAS (Fase 1 + Fase 2):
 *  R1. No se puede iniciar una etapa si ya existe una etapa abierta
 *      para la MISMA OT en el MISMO sector.
 *  R2. Si el sector NO es compartido, no puede haber dos OTs trabajando
 *      en él al mismo tiempo.
 *  R3. Un operario no puede tener dos etapas abiertas al mismo tiempo
 *      (evita olvidos de "Finalizar" y fichajes cruzados).
 *  R4. Un sector especial (Vidrio/Lustre/Herrería/Especiales) sólo puede
 *      iniciar si la OT lo tiene marcado como requerido.
 *  R5. Las OTs en estado "Finalizado" no aceptan nuevas etapas.
 *  R6. Flujo por orden: no se puede iniciar un sector si sus sectores
 *      prerrequisito (ver db.prerrequisitosSector) no están finalizados.
 *      El orden se calcula DENTRO de la línea de la OT (Placares/Cocinas).
 *  R7. Un sector desactivado no acepta etapas nuevas.
 *  R8. Un sector sólo puede usarse en una OT de su propia línea (o si el
 *      sector es Compartido/General).
 *
 * Además, cada pausa genera un evento en `eventos_pausa` (motivo, inicio,
 * fin y segundos reales) para las métricas de horas perdidas.
 *
 * Todas las fechas/horas las genera SIEMPRE el servidor.
 *
 * Fase 7 (Supabase / PostgreSQL):
 *  - Las consultas son `await` (Postgres es de red, no síncrono como SQLite).
 *  - Las escrituras de cada acción se agrupan en UNA transacción real
 *    (BEGIN/COMMIT/ROLLBACK). En el entorno efímero de Vercel un corte a
 *    mitad de proceso dejaría la OT y la etapa incoherentes; con la
 *    transacción, o se aplica todo o no se aplica nada. Las reglas R1..R8
 *    y el auto-cierre de la OT no cambian.
 */

const db = require('../db');
const {
  ApiError, textoRequerido, textoOpcional, entero, enumOpcion,
} = require('../lib/http');
const notificaciones = require('../lib/notificaciones');
const operariosRuta = require('./operarios');
const ordenesRuta = require('./ordenes');

const ABIERTOS = "('En Proceso','Pausado')";

/** Minutos transcurridos (netos, descontando pausas) de una etapa abierta. */
function minutosTranscurridos(row) {
  if (!row || row.estado_etapa === 'Finalizado') return row && row.duracion_minutos ? Number(row.duracion_minutos) : 0;
  const ahora = Date.now();
  const ms = ahora - new Date(row.fecha_hora_inicio).getTime();
  let seg = Number(row.segundos_pausados || 0);
  if (row.pausa_inicio) seg += (ahora - new Date(row.pausa_inicio).getTime()) / 1000;
  return Math.max(0, Math.round(((ms / 1000 - seg) / 60) * 100) / 100);
}

function conMinutos(row) {
  const reg = db.mapRegistro(row);
  if (!reg) return reg;
  reg.minutos_transcurridos = row.estado_etapa === 'Finalizado'
    ? reg.duracion_minutos
    : minutosTranscurridos(row);
  return reg;
}

/* ------------------------- Notificaciones -------------------------- */
/*
 * Los envíos se hacen FUERA de la transacción y en modo fire-and-forget:
 * el cierre/pausa de una etapa ya está confirmado en base y un gateway de
 * mensajería caído (o sin internet en la planta) no debe poder revertirlo
 * ni sumar latencia al fichado. Sólo se consulta la fila cuando las
 * notificaciones están activas, así con el módulo apagado no hay queries extra.
 */

/** Datos comunes (OT, cliente, sector, operario) para las plantillas. */
async function datosDeNotificacion(registroId) {
  const f = await db.get(`
    SELECT r.operario_nombre, s.nombre_sector, o.numero_ot, o.cliente
      FROM registros_tiempos r
      JOIN sectores s       ON s.id = r.sector_id
      JOIN ordenes_trabajo o ON o.id = r.ot_id
     WHERE r.id = ?;`, registroId);
  if (!f) return null;
  return {
    numero_ot: f.numero_ot,
    cliente: f.cliente,
    nombre_sector: f.nombre_sector,
    operario_nombre: f.operario_nombre,
  };
}

/**
 * Próximo sector del flujo de la OT (o 'Fin de línea' si no queda ninguno).
 * Reutiliza la MISMA función que el auto-cierre de la OT, así el "próximo
 * sector" del mensaje coincide con lo que la terminal va a mostrar.
 */
async function sectorSiguienteDe(ot) {
  const todos = (await db.all('SELECT * FROM sectores ORDER BY id;')).map(db.mapSector);
  const requeridos = ordenesRuta.sectoresRequeridos(ot, todos);
  const finalizados = await db.sectoresFinalizadosIds(ot.id);
  const sig = requeridos.find((s) => !finalizados.has(s.id));
  return sig ? sig.nombre_sector : 'Fin de línea / Embalaje';
}

/* ------------------------- Estado en vivo ------------------------- */

async function estado({ query }) {
  const otId = query.ot_id ? entero(query.ot_id, 'ot_id') : null;

  const params = [];
  let where = `r.estado_etapa IN ${ABIERTOS}`;
  if (otId) {
    where += ' AND r.ot_id = ?';
    params.push(otId);
  }

  const abiertas = (await db.all(`
    SELECT r.*, s.nombre_sector, s.nombre_corto, s.es_compartido, s.clave_especial,
           o.numero_ot, o.cliente, o.estado_general
      FROM registros_tiempos r
      JOIN sectores s ON s.id = r.sector_id
      JOIN ordenes_trabajo o ON o.id = r.ot_id
     WHERE ${where}
     ORDER BY r.fecha_hora_inicio ASC;`, ...params)).map(conMinutos);

  // SQLite GROUP_CONCAT(DISTINCT x) -> Postgres string_agg(DISTINCT x, ',')
  const actividad = (await db.all(`
    SELECT r.sector_id, s.nombre_sector, COUNT(*) AS abiertas,
           string_agg(DISTINCT o.numero_ot, ',') AS ordenes
      FROM registros_tiempos r
      JOIN sectores s ON s.id = r.sector_id
      JOIN ordenes_trabajo o ON o.id = r.ot_id
     WHERE r.estado_etapa IN ${ABIERTOS}
     GROUP BY r.sector_id, s.nombre_sector;`))
    .map((a) => ({
      sector_id: a.sector_id,
      nombre_sector: a.nombre_sector,
      abiertas: a.abiertas,
      ordenes_activas: String(a.ordenes || '').split(',').filter(Boolean),
    }));

  return {
    status: 200,
    data: { ahora: db.ahoraUTC(), etapas_abiertas: abiertas, actividad_sectores: actividad },
  };
}

/* ----------------------------- Acciones ---------------------------- */

async function iniciar({ body }) {
  const otId = entero(body.ot_id, 'OT');
  const sectorId = entero(body.sector_id, 'Sector');
  const operario = textoRequerido(body.operario_nombre, 'Operario', { max: 80 });

  const ot = await db.get('SELECT * FROM ordenes_trabajo WHERE id = ?;', otId);
  if (!ot) throw new ApiError(404, `No existe la OT con id ${otId}.`);

  const sectorRow = await db.get('SELECT * FROM sectores WHERE id = ?;', sectorId);
  if (!sectorRow) throw new ApiError(404, `No existe el sector con id ${sectorId}.`);
  const sector = db.mapSector(sectorRow);

  // R7: un sector dado de baja no acepta etapas nuevas.
  if (!sector.activo) {
    throw new ApiError(409, `El sector "${sector.nombre_sector}" está DESACTIVADO.`,
      { accion: 'Reactívelo desde Administración → Sectores y Flujos si debe usarse.' });
  }

  // R8: el sector debe pertenecer a la línea de la OT (o ser Compartido/General).
  // Sin esto, una OT de Placares podría fichar en un puesto de Cocinas.
  const lineaOT = ot.linea_area || 'Placares';
  if (!db.sectorAplica(sector, lineaOT)) {
    throw new ApiError(409,
      `"${sector.nombre_sector}" pertenece a la línea ${sector.linea_area} y la ${ot.numero_ot} es de ${lineaOT}.`,
      { accion: 'Fiché en un sector de la línea de esta OT o edite la OT en Administración.' });
  }

  // O3: operario desactivado no puede iniciar (se valida temprano para que el
  // mensaje sea claro antes de las reglas de flujo). Usa la clave normalizada
  // para que "juan perez" caiga sobre "Juan Pérez".
  const opMaster = await db.get('SELECT id, activo FROM operarios WHERE nombre_norm = ?;', db.claveNormalizada(operario));
  if (opMaster && !opMaster.activo) {
    throw new ApiError(409,
      `El operario "${operario}" está DESACTIVADO en el maestro y no puede iniciar etapas.`,
      { accion: 'Reactívelo desde Administración → Operarios o utilice otro operario.' });
  }

  // R5
  if (ot.estado_general === 'Finalizado') {
    throw new ApiError(409, `La ${ot.numero_ot} está FINALIZADA: no se pueden iniciar nuevas etapas.`,
      { accion: 'Cambie el estado de la OT en Administración si es un error.' });
  }

  // R4
  if (sector.clave_especial && !ot[`requiere_${sector.clave_especial}`]) {
    throw new ApiError(409,
      `La ${ot.numero_ot} no está marcada como requiere "${sector.nombre_sector}".`,
      { accion: 'Edite la OT en Administración y marque la casilla correspondiente si es necesario.' });
  }

  // R6 - Flujo por orden (anti-conflictos)
  const sectores = (await db.all('SELECT * FROM sectores ORDER BY id;')).map(db.mapSector);
  const finalizados = await db.sectoresFinalizadosIds(otId);
  const faltantes = db.prerrequisitosSector(ot, sectorId, sectores, finalizados);
  if (faltantes.length) {
    throw new ApiError(409,
      `Flujo incompleto: antes de iniciar ${sector.nombre_sector} en la ${ot.numero_ot} ` +
      `debe finalizar: ${faltantes.map((f) => f.nombre_sector).join(', ')}.`,
      {
        sectores_faltantes: faltantes.map((f) => ({ id: f.id, nombre_sector: f.nombre_sector })),
        accion: 'Finalice los sectores indicados en el orden del flujo antes de iniciar este.',
      });
  }

  // R1
  const misma = await db.get(`
    SELECT r.*, s.nombre_sector FROM registros_tiempos r
      JOIN sectores s ON s.id = r.sector_id
     WHERE r.ot_id = ? AND r.sector_id = ? AND r.estado_etapa IN ${ABIERTOS}
     ORDER BY r.fecha_hora_inicio DESC LIMIT 1;`, otId, sectorId);
  if (misma) {
    throw new ApiError(409,
      `Ya hay una etapa ${misma.estado_etapa.toLowerCase()} de ${ot.numero_ot} en ${sector.nombre_sector} ` +
      `(operario ${misma.operario_nombre}, desde ${db.aLocalLegible(misma.fecha_hora_inicio)}).`,
      {
        etapa: conMinutos(misma),
        accion: misma.estado_etapa === 'Pausado'
          ? 'Reanude la etapa pausada o finalícela antes de iniciar otra.'
          : 'Finalice la etapa en curso antes de iniciar otra.',
      });
  }

  // R2
  if (!sector.es_compartido) {
    const ocupada = await db.get(`
      SELECT r.*, o.numero_ot, s.nombre_sector FROM registros_tiempos r
        JOIN ordenes_trabajo o ON o.id = r.ot_id
        JOIN sectores s ON s.id = r.sector_id
       WHERE r.sector_id = ? AND r.ot_id <> ? AND r.estado_etapa IN ${ABIERTOS}
       ORDER BY r.fecha_hora_inicio DESC LIMIT 1;`, sectorId, otId);
    if (ocupada) {
      throw new ApiError(409,
        `El sector ${sector.nombre_sector} NO es compartido y ya está trabajando la ${ocupada.numero_ot} ` +
        `(operario ${ocupada.operario_nombre}).`,
        { etapa: conMinutos(ocupada), accion: 'Espere a que finalice esa etapa o marque el sector como compartido.' });
    }
  }

  // R3
  // (SQLite: `= ? COLLATE NOCASE` -> Postgres: `lower(...) = lower(...)`)
  const delOperario = await db.get(`
    SELECT r.*, o.numero_ot, s.nombre_sector FROM registros_tiempos r
      JOIN ordenes_trabajo o ON o.id = r.ot_id
      JOIN sectores s ON s.id = r.sector_id
     WHERE lower(r.operario_nombre) = lower(?) AND r.estado_etapa IN ${ABIERTOS}
     ORDER BY r.fecha_hora_inicio DESC LIMIT 1;`, operario);
  if (delOperario) {
    throw new ApiError(409,
      `El operario ${operario} ya tiene una etapa abierta: ${delOperario.numero_ot} / ${delOperario.sector_nombre || delOperario.nombre_sector}.`,
      {
        etapa: conMinutos(delOperario),
        accion: 'Si es esa misma etapa, utilice REANUDAR o FINALIZAR; si no, finalícela antes de iniciar otra.',
      });
  }

  const ahora = db.ahoraUTC();

  // O2: auto-guardado transparente — si el nombre no está en el maestro, se da de alta.
  // Devuelve la grafía canónica del maestro; el registro debe guardar esa (no la
  // tipeada) para que los contadores por operario casen aunque se tipee sin acentos.
  const op = await operariosRuta.asegurarOperario(db, operario);
  const nombreOperario = op.nombre;

  // Escrituras atómicas: alta de la etapa + cambio de estado de la OT.
  // CONCURRENCIA (C-1/C-2/A-5/V-4): la transacción toma advisory locks de
  // sector + OT + operario, RE-VERIFICA R1/R2/R3 con el lock tomado (cierra el
  // hueco TOCTOU entre la validación y el INSERT) y los índices únicos
  // parciales son la última línea: si aún así entrara un duplicado, Postgres
  // responde 23505 y se traduce a un 409 entendible.
  let insert;
  try {
    insert = await db.transaccion(async () => {
      // R1 (re-check bajo lock): misma OT + mismo sector sin etapa abierta.
      const mismaAhora = await db.get(`
        SELECT r.*, s.nombre_sector FROM registros_tiempos r
          JOIN sectores s ON s.id = r.sector_id
         WHERE r.ot_id = ? AND r.sector_id = ? AND r.estado_etapa IN ${ABIERTOS}
         ORDER BY r.fecha_hora_inicio DESC LIMIT 1;`, otId, sectorId);
      if (mismaAhora) {
        throw new ApiError(409,
          `Ya hay una etapa ${mismaAhora.estado_etapa.toLowerCase()} de ${ot.numero_ot} en ${sector.nombre_sector} ` +
          `(operario ${mismaAhora.operario_nombre}, desde ${db.aLocalLegible(mismaAhora.fecha_hora_inicio)}).`,
          {
            etapa: conMinutos(mismaAhora),
            accion: mismaAhora.estado_etapa === 'Pausado'
              ? 'Reanude la etapa pausada o finalícela antes de iniciar otra.'
              : 'Finalice la etapa en curso antes de iniciar otra.',
          });
      }

      // R2 (re-check bajo lock): sector no compartido sin otra OT trabajando.
      if (!sector.es_compartido) {
        const ocupadaAhora = await db.get(`
          SELECT r.*, o.numero_ot FROM registros_tiempos r
            JOIN ordenes_trabajo o ON o.id = r.ot_id
           WHERE r.sector_id = ? AND r.ot_id <> ? AND r.estado_etapa IN ${ABIERTOS}
           ORDER BY r.fecha_hora_inicio DESC LIMIT 1;`, sectorId, otId);
        if (ocupadaAhora) {
          throw new ApiError(409,
            `El sector ${sector.nombre_sector} NO es compartido y ya está trabajando la ${ocupadaAhora.numero_ot} ` +
            `(operario ${ocupadaAhora.operario_nombre}).`,
            { accion: 'Espere a que finalice esa etapa o marque el sector como compartido.' });
        }
      }

      // R3 (re-check bajo lock): operario sin otra etapa abierta.
      const delOperarioAhora = await db.get(`
        SELECT r.*, o.numero_ot, s.nombre_sector FROM registros_tiempos r
          JOIN ordenes_trabajo o ON o.id = r.ot_id
          JOIN sectores s ON s.id = r.sector_id
         WHERE lower(r.operario_nombre) = lower(?) AND r.estado_etapa IN ${ABIERTOS}
         ORDER BY r.fecha_hora_inicio DESC LIMIT 1;`, nombreOperario);
      if (delOperarioAhora) {
        throw new ApiError(409,
          `El operario ${nombreOperario} ya tiene una etapa abierta: ${delOperarioAhora.numero_ot} / ` +
          `${delOperarioAhora.nombre_sector}.`,
          {
            etapa: conMinutos(delOperarioAhora),
            accion: 'Si es esa misma etapa, utilice REANUDAR o FINALIZAR; si no, finalícela antes de iniciar otra.',
          });
      }

      const alta = await db.run(`
        INSERT INTO registros_tiempos
          (ot_id, sector_id, operario_nombre, fecha_hora_inicio, estado_etapa,
           pausa_inicio, segundos_pausados, fecha_creacion, fecha_actualizacion)
        VALUES (?, ?, ?, ?, 'En Proceso', NULL, 0, ?, ?);`,
        otId, sectorId, nombreOperario, ahora, ahora, ahora
      );

      // Actualiza el estado general de la OT si estaba en cola o detenida.
      // Guarda con `changes`: si otra petición ya la puso en producción, no pasa nada.
      if (ot.estado_general === 'En Cola' || ot.estado_general === 'Detenido') {
        await db.run(
          `UPDATE ordenes_trabajo SET estado_general = 'En Producción', fecha_actualizacion = ?
            WHERE id = ? AND estado_general IN ('En Cola','Detenido');`,
          ahora, otId
        );
      }
      return alta;
    }, [
      [db.LOCK_OT, otId],
      [db.LOCK_SECTOR, sectorId],
      [db.LOCK_OPERARIO, db.claveLockOperario(nombreOperario)],
    ]);
  } catch (e) {
    // 23505 = violación del índice único parcial (etapa abierta duplicada).
    if (e && e.code === '23505') {
      throw new ApiError(409,
        `La ${ot.numero_ot} ya no puede iniciar en ${sector.nombre_sector}: otra etapa abierta entró al mismo tiempo.`,
        { accion: 'Actualice el estado en vivo e intente de nuevo.' });
    }
    throw e;
  }

  const creado = await db.get(`
    SELECT r.*, s.nombre_sector, s.nombre_corto, o.numero_ot, o.cliente
      FROM registros_tiempos r
      JOIN sectores s ON s.id = r.sector_id
      JOIN ordenes_trabajo o ON o.id = r.ot_id
     WHERE r.id = ?;`, insert.lastInsertRowid);

  return { status: 201, data: { registro: conMinutos(creado) } };
}

async function pausar({ params, body }) {
  const id = entero(params.id, 'id');
  const row = await db.get('SELECT * FROM registros_tiempos WHERE id = ?;', id);
  if (!row) throw new ApiError(404, `No existe el registro de tiempo con id ${id}.`);
  if (row.estado_etapa === 'Finalizado') throw new ApiError(409, 'La etapa ya fue finalizada: no se puede pausar.');
  if (row.estado_etapa === 'Pausado') throw new ApiError(409, 'La etapa ya está pausada.');

  const motivo = enumOpcion(body.motivo_pausa, db.MOTIVOS_PAUSA, 'Motivo de pausa');
  const obs = textoOpcional(body.observacion, 'Observación', { max: 500 });
  const ahora = db.ahoraUTC();

  // Etapa + evento de pausa van juntos: si falla uno, no debe quedar el otro.
  // V-4: el UPDATE lleva GUARDA de estado ('En Proceso') y se verifica
  // `changes`: si otra petición pausó/finalizó primero, esto no pisa nada.
  const r = await db.transaccion(async () => {
    const upd = await db.run(`
      UPDATE registros_tiempos
         SET estado_etapa = 'Pausado', motivo_pausa = ?, pausa_inicio = ?,
             observacion = COALESCE(?, observacion), fecha_actualizacion = ?
       WHERE id = ? AND estado_etapa = 'En Proceso';`,
      motivo, ahora, obs, ahora, id
    );
    if (!upd.changes) {
      const actual = await db.get('SELECT estado_etapa FROM registros_tiempos WHERE id = ?;', id);
      throw new ApiError(409,
        actual && actual.estado_etapa === 'Pausado'
          ? 'La etapa ya estaba pausada (acción repetida o en paralelo).'
          : 'La etapa ya fue finalizada: no se puede pausar.',
        { estado_actual: actual ? actual.estado_etapa : null });
    }

    // Evento de pausa (Fase 2): alimenta las métricas de horas perdidas por motivo.
    await db.run(`
      INSERT INTO eventos_pausa (registro_id, motivo_pausa, observacion, inicio_pausa, fecha_creacion)
      VALUES (?, ?, ?, ?, ?);`,
      id, motivo, obs, ahora, ahora
    );
    return upd;
  }, [
    [db.LOCK_OT, row.ot_id],
    [db.LOCK_SECTOR, row.sector_id],
  ]);

  if (!r) throw new ApiError(409, 'No se pudo pausar la etapa.');

  // ALERTA DE DETENCIÓN: sólo para los motivos que paran la línea de verdad
  // (Rotura de placa / Error de plano / Ajuste de herramienta).
  if (notificaciones.activas() && notificaciones.esMotivoCritico(motivo)) {
    const base = await datosDeNotificacion(id);
    if (base) {
      notificaciones.dispararNotificacion('pausa_critica', {
        ...base,
        motivo_pausa: motivo,
        observacion: obs,
      });
    }
  }

  return { status: 200, data: { registro: conMinutos(await db.get('SELECT * FROM registros_tiempos WHERE id = ?;', id)) } };
}

async function reanudar({ params, body }) {
  const id = entero(params.id, 'id');
  const row = await db.get('SELECT * FROM registros_tiempos WHERE id = ?;', id);
  if (!row) throw new ApiError(404, `No existe el registro de tiempo con id ${id}.`);
  if (row.estado_etapa === 'Finalizado') throw new ApiError(409, 'La etapa ya fue finalizada: no se puede reanudar.');
  if (row.estado_etapa !== 'Pausado') throw new ApiError(409, 'La etapa no está pausada.');

  const obs = textoOpcional(body && body.observacion, 'Observación', { max: 500 });

  // V-4/A-5: con los locks tomados se relee la fila (FOR UPDATE), se recalculan
  // los segundos acumulados sobre el estado REAL y el UPDATE lleva guarda de
  // estado ('Pausado') + verificación de `changes`: dos reanudos simultáneos
  // no pueden acuñar dos veces la misma pausa.
  await db.transaccion(async () => {
    const fresco = await db.get('SELECT * FROM registros_tiempos WHERE id = ? FOR UPDATE;', id);
    if (!fresco) throw new ApiError(404, `No existe el registro de tiempo con id ${id}.`);
    if (fresco.estado_etapa === 'Finalizado') throw new ApiError(409, 'La etapa ya fue finalizada: no se puede reanudar.');
    if (fresco.estado_etapa !== 'Pausado') throw new ApiError(409, 'La etapa no está pausada.');
    if (!fresco.pausa_inicio) throw new ApiError(409, 'La etapa no tiene una pausa registrada para reanudar.');

    const ahora = db.ahoraUTC();
    const acumulado = Number(fresco.segundos_pausados || 0) +
      Math.max(0, (new Date(ahora).getTime() - new Date(fresco.pausa_inicio).getTime()) / 1000);
    const segundosEstaPausa = acumulado - Number(fresco.segundos_pausados || 0);

    const upd = await db.run(`
      UPDATE registros_tiempos
         SET estado_etapa = 'En Proceso', pausa_inicio = NULL, segundos_pausados = ?,
             observacion = COALESCE(?, observacion), fecha_actualizacion = ?
       WHERE id = ? AND estado_etapa = 'Pausado';`,
      acumulado, obs, ahora, id
    );
    if (!upd.changes) throw new ApiError(409, 'La etapa ya no está pausada (acción repetida o en paralelo).');

    // Cierra el evento de pausa abierto (si existe) con los segundos reales.
    await db.run(`
      UPDATE eventos_pausa
         SET fin_pausa = ?, segundos = ?, observacion = COALESCE(observacion, ?)
       WHERE registro_id = ? AND fin_pausa IS NULL;`,
      ahora, Math.round(segundosEstaPausa * 100) / 100, obs, id
    );
  }, [
    [db.LOCK_OT, row.ot_id],
    [db.LOCK_SECTOR, row.sector_id],
  ]);

  return { status: 200, data: { registro: conMinutos(await db.get('SELECT * FROM registros_tiempos WHERE id = ?;', id)) } };
}

async function finalizar({ params, body }) {
  const id = entero(params.id, 'id');
  const row = await db.get('SELECT * FROM registros_tiempos WHERE id = ?;', id);
  if (!row) throw new ApiError(404, `No existe el registro de tiempo con id ${id}.`);
  if (row.estado_etapa === 'Finalizado') {
    throw new ApiError(409, 'La etapa ya fue finalizada.',
      { etapa: conMinutos(row) });
  }

  const obs = textoOpcional(body && body.observacion, 'Observacion', { max: 500 });
  let otAutoCerrada = false;

  // --- Escrituras atómicas (cierre de etapa + evento + auto-cierre de la OT) ---
  // V-4/A-5: se bloquea la fila (FOR UPDATE) bajo los advisory locks de la OT
  // y el sector; el cierre lleva guarda de estado y se verifica `changes`.
  await db.transaccion(async () => {
    const fresco = await db.get('SELECT * FROM registros_tiempos WHERE id = ? FOR UPDATE;', id);
    if (!fresco) throw new ApiError(404, `No existe el registro de tiempo con id ${id}.`);
    if (fresco.estado_etapa === 'Finalizado') {
      throw new ApiError(409, 'La etapa ya fue finalizada.', { etapa: conMinutos(fresco) });
    }

    const ahora = db.ahoraUTC();
    let segundos = Number(fresco.segundos_pausados || 0);
    let ultimaPausaSegundos = 0;
    if (fresco.pausa_inicio) {
      ultimaPausaSegundos = Math.max(0, (new Date(ahora).getTime() - new Date(fresco.pausa_inicio).getTime()) / 1000);
      segundos += ultimaPausaSegundos;
    }
    const duracion = db.calcularDuracionMinutos(fresco.fecha_hora_inicio, ahora, segundos, null);

    const upd = await db.run(`
      UPDATE registros_tiempos
         SET estado_etapa = 'Finalizado', fecha_hora_fin = ?, duracion_minutos = ?,
             pausa_inicio = NULL, segundos_pausados = ?,
             observacion = COALESCE(?, observacion), fecha_actualizacion = ?
       WHERE id = ? AND estado_etapa IN ('En Proceso','Pausado');`,
      ahora, duracion, segundos, obs, ahora, id
    );
    if (!upd.changes) throw new ApiError(409, 'La etapa cambió de estado; recargue e intente de nuevo.');

    // Si la etapa estaba pausada al finalizarla, cierra el evento de pausa pendiente.
    if (fresco.pausa_inicio) {
      await db.run(`
        UPDATE eventos_pausa
           SET fin_pausa = ?, segundos = ?
         WHERE registro_id = ? AND fin_pausa IS NULL;`,
        ahora, Math.round(ultimaPausaSegundos * 100) / 100, id
      );
    }

    // --- AUTO-CIERRE DE LA OT (auditoría C-3) ---
    // ANTES sólo se evaluaba al cerrar la "última etapa de la línea", lo que
    // dejaba OTs abiertas si el cierre llegaba por cualquier otro sector
    // (p. ej. un especial, o un cierre tras reordenar el flujo). Ahora se
    // evalúa en CIERRE DE CUALQUIER SECTOR: si no quedan etapas abiertas y
    // todos los sectores requeridos están finalizados, la OT se cierra.
    const abiertas = (await db.get(
      `SELECT COUNT(*) AS n FROM registros_tiempos WHERE ot_id = ? AND estado_etapa IN ${ABIERTOS};`,
      fresco.ot_id
    )).n;

    if (abiertas === 0) {
      const otFila = await db.get('SELECT * FROM ordenes_trabajo WHERE id = ?;', fresco.ot_id);
      if (otFila && otFila.estado_general !== 'Finalizado') {
        const otM = db.mapOT(otFila);
        const sectoresTodas = (await db.all('SELECT * FROM sectores ORDER BY id;')).map(db.mapSector);
        // Sólo cierra si TODO lo que la OT requiere está finalizado (los
        // especiales marcados incluidos), no sólo si no hay nada en curso.
        const requeridos = ordenesRuta.sectoresRequeridos(otM, sectoresTodas).map((s) => s.id);
        const finales = await db.sectoresFinalizadosIds(fresco.ot_id);
        const todoListo = requeridos.length > 0 && requeridos.every((rid) => finales.has(rid));

        if (todoListo) {
          // Guarda `changes`: si un admin/administración ya la cerró, no hay doble cierre.
          const cierre = await db.run(
            `UPDATE ordenes_trabajo SET estado_general = 'Finalizado', fecha_actualizacion = ?
              WHERE id = ? AND estado_general <> 'Finalizado';`,
            ahora, fresco.ot_id
          );
          otAutoCerrada = cierre.changes > 0;
        }
      }
    }
  }, [
    [db.LOCK_OT, row.ot_id],
    [db.LOCK_SECTOR, row.sector_id],
  ]);

  const registro = await db.get(`
    SELECT r.*, s.nombre_sector, s.nombre_corto, o.numero_ot, o.cliente
      FROM registros_tiempos r
      JOIN sectores s ON s.id = r.sector_id
      JOIN ordenes_trabajo o ON o.id = r.ot_id
     WHERE r.id = ?;`, id);
  const ot = db.mapOT(await db.get('SELECT * FROM ordenes_trabajo WHERE id = ?;', row.ot_id));

  // PASE DE ESTACIÓN: avisa a jefatura/oficina que la OT dejó un sector y
  // hacia dónde sigue. El cierre ya está confirmado, así que el envío va
  // aparte y jamás puede afectar la respuesta del fichado.
  if (notificaciones.activas() && registro) {
    notificaciones.dispararNotificacion('avance_estacion', {
      numero_ot: registro.numero_ot,
      cliente: registro.cliente,
      sector_anterior: registro.nombre_sector,
      operario_nombre: registro.operario_nombre,
      duracion_formateada: notificaciones.minutosLegibles(registro.duracion_minutos),
      siguiente_sector: await sectorSiguienteDe(ot).catch(() => null),
    });
  }

  return { status: 200, data: { registro: conMinutos(registro), ot, ot_auto_cerrada: otAutoCerrada } };
}

/* ----------------------------- Consultas --------------------------- */

async function listar({ query }) {
  const filtros = [];
  const params = [];

  if (query.ot_id) { filtros.push('r.ot_id = ?'); params.push(entero(query.ot_id, 'ot_id')); }
  if (query.sector_id) { filtros.push('r.sector_id = ?'); params.push(entero(query.sector_id, 'sector_id')); }
  if (query.estado) {
    filtros.push('r.estado_etapa = ?');
    params.push(enumOpcion(query.estado, db.ESTADOS_ETAPA, 'estado'));
  }
  if (query.desde) {
    filtros.push('substr(r.fecha_hora_inicio, 1, 10) >= ?');
    params.push(String(query.desde).slice(0, 10));
  }
  if (query.hasta) {
    filtros.push('substr(r.fecha_hora_inicio, 1, 10) <= ?');
    params.push(String(query.hasta).slice(0, 10));
  }
  if (query.operario) {
    filtros.push('r.operario_nombre = ?');
    params.push(String(query.operario));
  }

  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 500);
  const offset = Math.max(Number(query.offset) || 0, 0);
  const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';

  const total = (await db.get(
    `SELECT COUNT(*) AS n FROM registros_tiempos r ${where};`, ...params
  )).n;

  const registros = (await db.all(`
    SELECT r.*, s.nombre_sector, s.nombre_corto, o.numero_ot, o.cliente, o.modelo
      FROM registros_tiempos r
      JOIN sectores s ON s.id = r.sector_id
      JOIN ordenes_trabajo o ON o.id = r.ot_id
      ${where}
     ORDER BY r.fecha_hora_inicio DESC, r.id DESC
     LIMIT ? OFFSET ?;`, ...params, limit, offset)).map(conMinutos);

  return { status: 200, data: { total, limit, offset, registros } };
}

async function obtener({ params }) {
  const id = entero(params.id, 'id');
  const row = await db.get(`
    SELECT r.*, s.nombre_sector, s.nombre_corto, o.numero_ot, o.cliente, o.modelo
      FROM registros_tiempos r
      JOIN sectores s ON s.id = r.sector_id
      JOIN ordenes_trabajo o ON o.id = r.ot_id
     WHERE r.id = ?;`, id);
  if (!row) throw new ApiError(404, `No existe el registro de tiempo con id ${id}.`);
  return { status: 200, data: { registro: conMinutos(row) } };
}

module.exports = { estado, iniciar, pausar, reanudar, finalizar, listar, obtener, minutosTranscurridos };
