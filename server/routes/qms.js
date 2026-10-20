'use strict';

/**
 * MÓDULO QMS · CONTROL DE CALIDAD, NO CONFORMIDADES Y REPROCESOS
 * -----------------------------------------------------------------
 * Endpoints:
 *   POST  /api/qms/no-conformidades              (terminal / gestión)
 *   GET   /api/qms/no-conformidades              (lectura con filtros)
 *   PATCH /api/qms/no-conformidades/:id/resolver (gestión)
 *
 * Reglas de negocio:
 *   Q1. Toda no conformidad queda vinculada a una OT y a un sector reales.
 *   Q2. `tipo_falla` y `estado` se validan contra el catálogo compartido de
 *       db.js (TIPOS_FALLA_QMS / ESTADOS_QMS): la UI y la API nunca divergen.
 *   Q3. La foto se guarda en `foto_url`, ya sea un data URI comprimido en el
 *       dispositivo o una URL remota (Supabase Storage). Se valida el esquema
 *       y se acota el tamaño para no convertir el endpoint en un uploader
 *       abierto ni inflar la base.
 *   Q4. Al registrar una falla, si hay una etapa EN PROCESO para esa OT y
 *       sector, se pausa y se crea su evento en `eventos_pausa` (alimenta las
 *       métricas de horas perdidas). La OT activa pasa a "Detenido". Todo va
 *       en una transacción con advisory locks por OT y sector.
 *   Q5. Resolver una NC exige `accion_correctiva` y deja auditoría de quién y
 *       cuándo la cerró. Es idempotente sólo en el sentido de que una segunda
 *       resolución devuelve 409 en lugar de sobrescribir la anterior.
 */

const db = require('../db');
const {
  ApiError,
  textoRequerido,
  textoOpcional,
  entero,
  enumOpcion,
  fecha,
  booleano,
} = require('../lib/http');

const RE_PERIODO = /^\d{4}-\d{2}$/;
const MAX_FOTO = 3500000; // ~2,6 MB binarios luego de decodificar el base64.
const MAX_LISTA = 500;
const TIPOS_FALLA = db.TIPOS_FALLA_QMS;
const ESTADOS_QMS = db.ESTADOS_QMS;

const SQL_NC = `
  SELECT nc.*,
         o.numero_ot, o.cliente, o.linea_area,
         s.nombre_sector
    FROM no_conformidades nc
    JOIN ordenes_trabajo o ON o.id = nc.ot_id
    JOIN sectores s         ON s.id = nc.sector_id`;

/** Motivo de pausa existente que mejor representa cada tipo QMS. */
function motivoPausaDe(tipoFalla) {
  if (tipoFalla === 'Rotura de placa / Astillado') return 'Rotura de placa';
  if (tipoFalla === 'Error de plano') return 'Error de plano';
  if (tipoFalla === 'Falla de mecanizado / Cota') return 'Ajuste de herramienta';
  return 'Otro';
}

/**
 * Acepta `data:image/...;base64,...` o una URL http(s). Si llega un base64
 * "pelado" se le agrega el prefijo JPEG para no perder la evidencia.
 */
function normalizarFoto(body) {
  const base64 = body && body.foto_base64;
  const remota = body && body.foto_url;

  if (base64 !== undefined && base64 !== null && String(base64).trim() !== '') {
    let foto = String(base64).trim();
    if (!/^data:/i.test(foto)) foto = `data:image/jpeg;base64,${foto}`;
    foto = foto.replace(/\s+/g, '');
    if (!/^data:image\/(webp|jpe?g|png);base64,[A-Za-z0-9+/=]+$/i.test(foto)) {
      throw new ApiError(400,
        'La foto debe ser una imagen WEBP, JPEG o PNG codificada en base64.',
        { formatos: ['image/webp', 'image/jpeg', 'image/png'] });
    }
    if (foto.length > MAX_FOTO) {
      throw new ApiError(413,
        'La foto de evidencia es demasiado grande. Vuelva a tomarla con menor resolución.',
        { max_caracteres: MAX_FOTO });
    }
    return foto;
  }

  if (remota !== undefined && remota !== null && String(remota).trim() !== '') {
    const url = String(remota).trim();
    if (url.length > 4000) {
      throw new ApiError(400, 'La URL de la foto es demasiado larga.');
    }
    let parsed;
    try { parsed = new URL(url); } catch { parsed = null; }
    if (!parsed || !/^https?:$/.test(parsed.protocol)) {
      throw new ApiError(400, 'La URL de la foto debe comenzar con http:// o https://.');
    }
    return url;
  }

  return null;
}

/** Nombre visible del usuario que reporta (cae al usuario de la sesión). */
function nombreReportante(req) {
  const usuario = req && req.optiflowSesion && req.optiflowSesion.usuario;
  return usuario ? (usuario.nombre || usuario.usuario || null) : null;
}

/** Rango [inicio, fin) del mes LOCAL de planta para un período YYYY-MM. */
function rangoPeriodo(periodo) {
  const p = periodo || (db.hoyLocal() || '').slice(0, 7);
  if (!RE_PERIODO.test(String(p))) {
    throw new ApiError(400, 'El período debe tener formato AAAA-MM.');
  }
  const [anio, mes] = String(p).split('-').map(Number);
  if (mes < 1 || mes > 12) throw new ApiError(400, 'El mes del período no es válido.');
  const primerDia = `${p}-01`;
  const ultimoDia = new Date(Date.UTC(anio, mes, 0)).toISOString().slice(0, 10);
  const [desdeUTC, hastaUTC] = db.ventanaLocalUTC(primerDia, ultimoDia);
  return { periodo: p, primerDia, ultimoDia, desdeUTC, hastaUTC };
}

/**
 * Resumen ejecutivo del mes: total, estados, causa raíz y FTT.
 * FTT QMS = OTs que cerraron al menos una etapa en el mes y NO tienen una NC
 * vigente (se excluyen las Descartado, que fueron falsos positivos).
 */
async function resumen(periodo) {
  const rango = rangoPeriodo(periodo);

  const totales = await db.get(`
    SELECT COUNT(*) AS total,
           COUNT(*) FILTER (WHERE estado = 'Pendiente')   AS pendientes,
           COUNT(*) FILTER (WHERE estado = 'En Reproceso') AS en_reproceso,
           COUNT(*) FILTER (WHERE estado = 'Resuelto')    AS resueltas,
           COUNT(*) FILTER (WHERE estado = 'Descartado')  AS descartadas,
           COUNT(*) FILTER (WHERE estado IN ('Pendiente','En Reproceso')) AS abiertas
      FROM no_conformidades
     WHERE fecha_registro >= ? AND fecha_registro < ?;`,
  rango.desdeUTC, rango.hastaUTC);

  const porTipo = await db.all(`
    SELECT tipo_falla, COUNT(*) AS cantidad
      FROM no_conformidades
     WHERE fecha_registro >= ? AND fecha_registro < ?
       AND estado <> 'Descartado'
     GROUP BY tipo_falla
     ORDER BY cantidad DESC, tipo_falla ASC;`,
  rango.desdeUTC, rango.hastaUTC);

  const fttRow = await db.get(`
    WITH avanzadas AS (
      SELECT DISTINCT r.ot_id
        FROM registros_tiempos r
       WHERE r.estado_etapa = 'Finalizado'
         AND r.fecha_hora_inicio >= ? AND r.fecha_hora_inicio < ?
    ),
    con_nc AS (
      SELECT DISTINCT ot_id
        FROM no_conformidades
       WHERE fecha_registro >= ? AND fecha_registro < ?
         AND estado <> 'Descartado'
    )
    SELECT COUNT(*) AS evaluadas,
           COALESCE(SUM(CASE WHEN NOT EXISTS (
             SELECT 1 FROM con_nc c WHERE c.ot_id = avanzadas.ot_id
           ) THEN 1 ELSE 0 END), 0) AS conformes
      FROM avanzadas;`,
  rango.desdeUTC, rango.hastaUTC, rango.desdeUTC, rango.hastaUTC);

  const evaluadas = Number(fttRow.evaluadas || 0);
  const conformes = Number(fttRow.conformes || 0);
  const total = Number(totales.total || 0);
  const tipos = porTipo.map((x) => ({
    tipo_falla: x.tipo_falla,
    cantidad: Number(x.cantidad || 0),
  }));

  return {
    periodo: rango.periodo,
    desde: rango.primerDia,
    hasta: rango.ultimoDia,
    total_mes: total,
    pendientes: Number(totales.pendientes || 0),
    en_reproceso: Number(totales.en_reproceso || 0),
    resueltas_mes: Number(totales.resueltas || 0),
    descartadas_mes: Number(totales.descartadas || 0),
    abiertas: Number(totales.abiertas || 0),
    por_tipo: tipos,
    tipo_mas_recurrente: tipos[0] || null,
    ftt: {
      evaluadas,
      conformes,
      porcentaje: evaluadas > 0 ? Math.round((conformes / evaluadas) * 1000) / 10 : null,
    },
  };
}

/**
 * GET /api/qms/no-conformidades
 * Filtros opcionales: ot_id, sector_id, estado, tipo_falla, desde, hasta,
 * periodo (AAAA-MM para el resumen), limite.
 */
async function listar({ query }) {
  const where = [];
  const params = [];

  if (query.ot_id !== undefined && query.ot_id !== '') {
    where.push('nc.ot_id = ?');
    params.push(entero(query.ot_id, 'ot_id'));
  }
  if (query.sector_id !== undefined && query.sector_id !== '') {
    where.push('nc.sector_id = ?');
    params.push(entero(query.sector_id, 'sector_id'));
  }
  if (query.estado !== undefined && query.estado !== '') {
    where.push('nc.estado = ?');
    params.push(enumOpcion(query.estado, ESTADOS_QMS, 'estado'));
  }
  if (query.tipo_falla !== undefined && query.tipo_falla !== '') {
    where.push('nc.tipo_falla = ?');
    params.push(enumOpcion(query.tipo_falla, TIPOS_FALLA, 'tipo_falla'));
  }

  const desde = fecha(query.desde, 'desde');
  const hasta = fecha(query.hasta, 'hasta');
  if (desde) { where.push('nc.fecha_registro >= ?'); params.push(db.inicioDiaLocalUTC(desde)); }
  if (hasta) { where.push('nc.fecha_registro < ?'); params.push(db.inicioDiaLocalUTC(db.correrDias(hasta, 1))); }

  const limitePedido = Number(query.limite);
  const limite = query.limite === undefined || query.limite === ''
    ? 200
    : Math.min(MAX_LISTA, Math.max(1, Number.isFinite(limitePedido) ? Math.floor(limitePedido) : 200));

  const sql = `${SQL_NC}
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY nc.fecha_registro DESC, nc.id DESC
    LIMIT ?;`;

  const filas = await db.all(sql, ...params, limite);
  const resumenMes = await resumen(query.periodo);

  return {
    status: 200,
    data: {
      no_conformidades: filas.map(db.mapNoConformidad),
      resumen: resumenMes,
      filtros: {
        ot_id: query.ot_id || null,
        sector_id: query.sector_id || null,
        estado: query.estado || null,
        tipo_falla: query.tipo_falla || null,
        desde: desde || null,
        hasta: hasta || null,
        limite,
      },
    },
  };
}

/**
 * POST /api/qms/no-conformidades
 * Registra la NC, pausa la etapa abierta si corresponde y deja la OT activa
 * en "Detenido". `pausar_etapa:false` permite cargar una NC histórica sin
 * tocar el estado actual de planta.
 */
async function crear({ body, req }) {
  const otId = entero(body.ot_id, 'ot_id');
  const sectorId = entero(body.sector_id, 'sector_id');
  const tipoFalla = enumOpcion(body.tipo_falla, TIPOS_FALLA, 'tipo_falla');
  const observacion = textoOpcional(body.observacion, 'Observación', { max: 2000 });
  const operario = textoOpcional(body.operario_responsable, 'Operario responsable', { max: 120 });
  const reportaBody = textoOpcional(body.encargado_reporta, 'Encargado que reporta', { max: 120 });
  const encargado = reportaBody || nombreReportante(req);
  if (!encargado) {
    throw new ApiError(400, 'El campo "encargado_reporta" es obligatorio.');
  }
  const foto = normalizarFoto(body);
  const pausarEtapa = booleano(body.pausar_etapa, true);
  const estadoInicial = (body.estado === undefined || body.estado === null || body.estado === '')
    ? 'Pendiente'
    : enumOpcion(body.estado, ['Pendiente', 'En Reproceso'], 'estado');

  const ahora = db.ahoraUTC();

  const resultado = await db.transaccion(async () => {
    const ot = await db.get(
      'SELECT id, numero_ot, estado_general FROM ordenes_trabajo WHERE id = ? FOR UPDATE;', otId);
    if (!ot) throw new ApiError(404, `No existe la OT con id ${otId}.`);

    const sector = await db.get(
      'SELECT id, nombre_sector FROM sectores WHERE id = ?;', sectorId);
    if (!sector) throw new ApiError(404, `No existe el sector con id ${sectorId}.`);

    // Etapa abierta de ESA OT en ESE sector (la única que puede pausarse).
    const abierta = await db.get(`
      SELECT id, estado_etapa
        FROM registros_tiempos
       WHERE ot_id = ? AND sector_id = ?
         AND estado_etapa IN ('En Proceso','Pausado')
       ORDER BY id DESC
       LIMIT 1
       FOR UPDATE;`, otId, sectorId);

    let etapa = null;
    if (abierta) {
      const motivo = motivoPausaDe(tipoFalla);
      const obsPausa = `No conformidad QMS: ${tipoFalla}`
        + (observacion ? ` · ${observacion}` : '');
      if (abierta.estado_etapa === 'En Proceso' && pausarEtapa) {
        const upd = await db.run(`
          UPDATE registros_tiempos
             SET estado_etapa = 'Pausado', motivo_pausa = ?, pausa_inicio = ?,
                 observacion = COALESCE(?, observacion), fecha_actualizacion = ?
           WHERE id = ? AND estado_etapa = 'En Proceso';`,
        motivo, ahora, obsPausa.slice(0, 500), ahora, abierta.id);

        if (upd.changes) {
          await db.run(`
            INSERT INTO eventos_pausa
              (registro_id, motivo_pausa, observacion, inicio_pausa, fecha_creacion)
            VALUES (?, ?, ?, ?, ?);`,
          abierta.id, motivo, obsPausa.slice(0, 500), ahora, ahora);
          etapa = { id: Number(abierta.id), pausada: true, motivo_pausa: motivo };
        }
      }
      if (!etapa) {
        etapa = {
          id: Number(abierta.id),
          pausada: false,
          ya_estaba_pausada: abierta.estado_etapa === 'Pausado',
        };
      }
    }

    // La OT activa se detiene: una NC abierta no puede seguir avanzando como
    // si nada hubiera pasado. Las OTs Finalizadas conservan su estado (la NC
    // queda como registro de calidad posterior). Con `pausar_etapa:false`
    // (carga histórica) no se toca el estado actual de planta.
    let otEstado = ot.estado_general;
    if (pausarEtapa && ot.estado_general !== 'Finalizado'
      && (ot.estado_general === 'En Producción' || etapa)) {
      await db.run(
        `UPDATE ordenes_trabajo
            SET estado_general = 'Detenido', fecha_actualizacion = ?
          WHERE id = ?;`, ahora, otId);
      otEstado = 'Detenido';
    }

    const ins = await db.run(`
      INSERT INTO no_conformidades
        (ot_id, sector_id, operario_responsable, encargado_reporta, tipo_falla,
         observacion, foto_url, estado, fecha_registro, fecha_actualizacion)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    otId, sectorId, operario, encargado, tipoFalla, observacion, foto,
    estadoInicial, ahora, ahora);

    const nc = await db.get(`${SQL_NC} WHERE nc.id = ?;`, ins.lastInsertRowid);
    return {
      nc,
      etapa,
      ot: { id: Number(ot.id), numero_ot: ot.numero_ot, estado_general: otEstado },
    };
  }, [[db.LOCK_OT, otId], [db.LOCK_SECTOR, sectorId]]);

  return {
    status: 201,
    data: {
      ok: true,
      no_conformidad: db.mapNoConformidad(resultado.nc),
      etapa: resultado.etapa,
      ot: resultado.ot,
      resumen: await resumen(db.hoyLocal().slice(0, 7)),
    },
  };
}

/**
 * PATCH /api/qms/no-conformidades/:id/resolver
 * Cierra la NC como Resuelto con la acción correctiva. Sólo gestión
 * (admin/encargado) llega acá: el modo `auth: 'gestion'` de server.js ya lo
 * garantiza antes de leer el cuerpo.
 */
async function resolver({ params, body, req }) {
  const id = entero(params.id, 'id');
  const accion = textoRequerido(body.accion_correctiva, 'Acción correctiva', { max: 2000 });
  const usuario = nombreReportante(req) || 'Gestión';
  const ahora = db.ahoraUTC();

  const nc = await db.transaccion(async () => {
    const actual = await db.get(
      'SELECT id, estado FROM no_conformidades WHERE id = ? FOR UPDATE;', id);
    if (!actual) throw new ApiError(404, `No existe la no conformidad con id ${id}.`);
    if (actual.estado === 'Resuelto') {
      throw new ApiError(409, 'La no conformidad ya fue marcada como Resuelta.',
        { estado_actual: actual.estado });
    }
    if (actual.estado === 'Descartado') {
      throw new ApiError(409, 'La no conformidad fue descartada y no se puede resolver.',
        { estado_actual: actual.estado });
    }

    await db.run(`
      UPDATE no_conformidades
         SET estado = 'Resuelto', accion_correctiva = ?, resuelto_por = ?,
             fecha_resolucion = ?, fecha_actualizacion = ?
       WHERE id = ?;`, accion, usuario, ahora, ahora, id);

    return db.get(`${SQL_NC} WHERE nc.id = ?;`, id);
  }); // el lock real es la fila FOR UPDATE de la NC

  return {
    status: 200,
    data: {
      ok: true,
      no_conformidad: db.mapNoConformidad(nc),
      resumen: await resumen(db.hoyLocal().slice(0, 7)),
    },
  };
}

module.exports = {
  listar,
  crear,
  resolver,
  resumen,
  TIPOS_FALLA,
  ESTADOS_QMS,
};
