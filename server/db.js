'use strict';

/**
 * Optiflow - Capa de acceso a datos (PostgreSQL / Supabase)
 * ---------------------------------------------------------------
 * FASE 7: se reemplaza `node:sqlite` por el driver `pg` conectado al
 * pooler de Supabase mediante la variable de entorno `SUPABASE_DB_URL`
 * (alias aceptado: `DATABASE_URL`).
 *
 * IMPORTANTE - cambio de sincronía:
 *   SQLite trabaja de forma SINCRONA (`db.get(...)` devolvía la fila ya).
 *   Postgres es de red, así que `get/all/run/transaccion` ahora devuelven
 *   PROMESAS y todas las rutas las hacen `await`. La API pública se
 *   mantiene con la misma forma para que la lógica de negocio no cambie.
 *
 * Reglas de tiempo (igual que en las fases anteriores):
 *  - Todos los timestamps se guardan en ISO-8601 UTC generado por el SERVIDOR
 *    (nunca por el navegador) para evitar discrepancias de reloj/huso horario.
 *  - Se guardan además los segundos acumulados de pausa para poder calcular
 *    la duración neta de trabajo productivo.
 *
 * Por eso en supabase_schema.sql las fechas son TEXT y no timestamptz:
 * el resto del código usa substr(fecha,1,10) para comparar por día.
 */

const fs = require('node:fs');
const path = require('node:path');
const { Pool, types } = require('pg');
// lib/auth NO requiere '../db' (recibe el db por parámetro), así que no hay ciclo.
const auth = require('./lib/auth');

const ROOT = path.resolve(__dirname, '..');
const SCHEMA_FILE = path.join(ROOT, 'supabase_schema.sql');

/**
 * Carga `.env` del proyecto si existe (sólo para el arranque LOCAL).
 * En Vercel las variables se configuran en el dashboard y este archivo no
 * existe, así que no hace nada. Sin dependencias externas: parsea KEY=VALUE.
 * No pisa variables ya definidas (un export del shell tiene prioridad).
 */
(function cargarEnv() {
  const archivo = path.join(ROOT, '.env');
  if (!fs.existsSync(archivo)) return;
  for (const linea of fs.readFileSync(archivo, 'utf8').split(/\r?\n/)) {
    const t = linea.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    const clave = t.slice(0, i).trim();
    let valor = t.slice(i + 1).trim();
    // Quita comillas envolventes simples o dobles.
    if ((valor.startsWith('"') && valor.endsWith('"')) || (valor.startsWith("'") && valor.endsWith("'"))) {
      valor = valor.slice(1, -1);
    }
    if (!(clave in process.env)) process.env[clave] = valor;
  }
})();

/**
 * Zona horaria de PLANTA. En la PC local se tomaba del sistema operativo;
 * en Vercel el runtime es UTC, así que ahora es explícita y configurable.
 */
const ZONA = process.env.OPTIFLOW_TZ || 'America/Argentina/Buenos_Aires';

/* ------------------------------------------------------------------ */
/* Conversión de tipos de Postgres                                     */
/* ------------------------------------------------------------------ */
// COUNT/SUM devuelven int8 (20) y numeric (1700): por defecto `pg` los
// devuelve como STRING para no perder precisión. Acá se casan con el
// comportamiento de SQLite, que devolvía números (`.n`, `Number(...)`).
types.setTypeParser(20, (v) => (v === null || v === undefined ? null : Number(v)));
types.setTypeParser(1700, (v) => (v === null || v === undefined ? null : Number(v)));

/* ------------------------------------------------------------------ */
/* Constantes de negocio (sin cambios respecto de las fases 1..6)      */
/* ------------------------------------------------------------------ */

const ESTADOS_OT = Object.freeze(['En Cola', 'En Producción', 'Detenido', 'Finalizado']);
const ESTADOS_ETAPA = Object.freeze(['En Proceso', 'Pausado', 'Finalizado']);
const MOTIVOS_PAUSA = Object.freeze([
  'Falta de herrajes',
  'Error de plano',
  'Ajuste de herramienta',
  'Rotura de placa',
  'Otro',
]);

/** Motivos de pausa que implican reproceso / error ( afectan el índice FTT ). */
const MOTIVOS_REPROCESO = Object.freeze(['Error de plano', 'Rotura de placa']);

/**
 * Umbrales de tiempo por sector (minutos) para alertas de etapa prolongada.
 * Si un sector no figura, se aplica `defecto`.
 */
const UMBRALES_MINUTOS = Object.freeze({
  defecto: 240,
  por_sector: Object.freeze({
    'Seccionadora / Corte': 120,
    'Pantógrafo CNC / Mecanizado': 120,
    'Armado de Cajoneras': 180,
    'Especiales': 180,
  }),
});

/** Sector crítico del flujo (nombre_sector exacto). */
const SECTOR_CONTROL = 'Control de Calidad';

/** Etapas que todavía no fueron cerradas (activas / en curso). */
const ESTADOS_ABIERTOS = Object.freeze(['En Proceso', 'Pausado']);

/**
 * Sectores de trabajo (maestro).
 * [0] nombre_sector (UNIQUE)   [1] nombre_corto (UI)
 * [2] es_compartido            [3] clave_especial (enlaza con el flag requiere_* de la OT)
 * [4] linea_area               [5] orden_flujo (secuencia visual dentro de la línea)
 * [6] operarios_sugeridos      (texto libre, separado por comas)
 */
const SECTORES_BASE = Object.freeze([
  // --- Placares (orden 1..7) ---
  ['Seccionadora / Corte', 'Corte', 0, null, 'Placares', 1, null],
  ['Enfiladora', 'Enfiladora', 0, null, 'Placares', 2, null],
  ['Pantógrafo CNC / Mecanizado', 'Pantógrafo', 0, null, 'Placares', 3, null],
  ['Armado de Cajoneras', 'Cajoneras', 1, null, 'Placares', 4, null],
  ['Colocación de Herrajes', 'Herrajes', 1, null, 'Placares', 5, null],
  ['Control de Calidad', 'Control de Calidad', 1, null, 'Placares', 6, null],
  ['Embalaje Final', 'Embalaje', 1, null, 'Placares', 7, null],
  // --- Cocinas (orden 1..5) ---
  ['Seccionadora B / Corte Módulos', 'Corte B', 0, null, 'Cocinas', 1, null],
  ['Enfilado de Cantos Cocina', 'Enfilado Cocina', 0, null, 'Cocinas', 2, null],
  ['Mecanizado de Puertas de Cocina', 'Mec. Puertas', 0, null, 'Cocinas', 3, 'José'],
  ['Armado de Módulos de Cocina', 'Módulos Cocina', 0, null, 'Cocinas', 4, null],
  ['Secuenciado y Distribución de Piezas', 'Secuenciado', 0, null, 'Cocinas', 5, 'Joel, Tiago'],
  // --- Compartidos / especiales (orden 1..4) ---
  ['Puertas de Vidrio', 'Vidrio', 0, 'vidrio', 'Compartido', 1, 'Tomás'],
  ['Lustre', 'Lustre', 1, 'lustre', 'Compartido', 2, 'Alejandro'],
  ['Herrería', 'Herrería', 1, 'herreria', 'Compartido', 3, 'Julio, Jony'],
  ['Especiales', 'Especiales', 1, 'especiales', 'Compartido', 4, 'Pablo'],
]);

/** Líneas de área que puede tener un SECTOR (clasificación del catálogo). */
const LINEAS_AREA = Object.freeze(['Placares', 'Cocinas', 'Compartido', 'General']);
/** Líneas de área que puede tener una OT (define qué sectores debe recorrer). */
const LINEAS_OT = Object.freeze(['Placares', 'Cocinas']);

/** Sectores del flujo normal (siempre aplican a toda OT). */
const CLAVES_ESPECIALES = Object.freeze(['vidrio', 'lustre', 'herreria', 'especiales']);

/** Nómina inicial de la fábrica (sembrada una sola vez). */
const OPERARIOS_NOMINA = Object.freeze([
  'Diego', 'Nacho', 'Cristian', 'Pato', 'Daniel Lopez', 'Lucas V', 'Tomas',
  'Ruben', 'Rodrigo', 'Matias', 'Alberto', 'BETO', 'Marcos', 'Javier',
]);

const DEMO_OT = [
  {
    numero_ot: 'OT-1710', cliente: 'TEX CARE VESTIDOR', modelo: 'L.MATE',
    metros_lineales: 24.5, fecha_prometida: '2026-10-20',
    requiere_vidrio: 1, requiere_lustre: 0, requiere_herreria: 0, requiere_especiales: 0,
  },
  {
    numero_ot: 'OT-1711', cliente: 'MUEBLAR DEL SUR', modelo: 'NORDIK',
    metros_lineales: 18, fecha_prometida: '2026-10-24',
    requiere_vidrio: 0, requiere_lustre: 1, requiere_herreria: 0, requiere_especiales: 0,
  },
  {
    numero_ot: 'OT-1712', cliente: 'OFICINAS PUNTA CARRETAS', modelo: 'CUSTOM',
    metros_lineales: 42.5, fecha_prometida: '2026-11-03',
    requiere_vidrio: 1, requiere_lustre: 0, requiere_herreria: 1, requiere_especiales: 1,
  },
];

/* ------------------------------------------------------------------ */
/* Conexión                                                            */
/* ------------------------------------------------------------------ */

let pool = null;
let poolListo = null;

/** Cliente dedicado mientras dura una transacción (no se mezcla con otros). */
const { AsyncLocalStorage } = require('node:async_hooks');
const enTransaccion = new AsyncLocalStorage();

/** Cadena de conexión: SUPABASE_DB_URL (recomendado) o DATABASE_URL. */
function cadenaConexion() {
  const url = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) {
    throw new Error(
      'Falta la variable de entorno SUPABASE_DB_URL.\n' +
      '  Supabase Dashboard → Project Settings → Database → Connection string (URI)\n' +
      '  → usar el pooler (puerto 6543) y copiarla a las variables de entorno de Vercel.'
    );
  }
  return url;
}

function opcionesPool() {
  const enVercel = !!process.env.VERCEL;
  const opts = {
    connectionString: cadenaConexion(),
    // Vercel/serverless: pocas conexiones por instancia. Supabase free permite
    // ~200 en el pooler, pero conviene ser conservador.
    max: Number(process.env.PG_POOL_MAX) || (enVercel ? 3 : 10),
    idleTimeoutMillis: Number(process.env.PG_IDLE_MS) || 30000,
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_MS) || 10000,
    allowExitOnIdle: enVercel,
  };
  // El pooler de Supabase exige TLS. `sslmode=require` en la cadena ya lo pide;
  // aquí se refuerza para los motores que no propagan el parámetro.
  const sslExplicito = process.env.PG_SSL;
  const necesitaSSL = sslExplicito !== '0' && sslExplicito !== 'false'
    && !/^postgres(ql)?:\/\/(localhost|127\.)/i.test(opts.connectionString);
  if (necesitaSSL) {
    // Supabase termina con un certificado propio; se acepta la cadena del
    // sistema y se relaja la verificación del hostname sólo si PG_SSL_VERIFY=0.
    opts.ssl = { rejectUnauthorized: process.env.PG_SSL_VERIFY === '1' };
  }
  return opts;
}

/**
 * Abre (o reutiliza) el pool. Idempotente y seguro de llamar en cada
 * invocación serverless: en warm starts devuelve el pool cacheado.
 *
 * ORDEN CRÍTICO (auditoría A-3/A-4): el pool SÓLO queda visible (`pool`) una
 * vez que el esquema y las semillas terminaron bien. Si asegurarEsquema() o
 * sembrar() fallan, se cierra el pool recién abierto y se limpian todas las
 * referencias, para que el siguiente intento arranque de cero en lugar de
 * reutilizar una base a medio migrar.
 */
async function abrirConexion() {
  if (pool) return pool;
  if (poolListo) return poolListo;

  poolListo = (async () => {
    const p = new Pool(opcionesPool());
    p.on('error', (e) => console.error('[pg] error de cliente inactivo:', e.message));

    try {
      // Verifica la conexión real.
      const cliente = await p.connect();
      try {
        const r = await cliente.query('select version() as v, current_database() as db;');
        console.log(`  · PostgreSQL: ${r.rows[0].db} (${String(r.rows[0].v).split(' ').slice(0, 2).join(' ')})`);
      } finally {
        cliente.release();
      }

      await asegurarEsquema(p);
      await sembrar(p);

      pool = p; // sólo queda publicado si TODO salió bien
      return p;
    } catch (e) {
      try { await p.end(); } catch { /* noop */ }
      pool = null;
      throw e;
    }
  })();

  try {
    return await poolListo;
  } catch (e) {
    poolListo = null; // permite reintentar en el próximo arranque
    pool = null;
    throw e;
  }
}

/** Cierra el pool (útil en tests / apagado ordenado). */
async function cerrarConexion() {
  if (!pool) return;
  const p = pool;
  pool = null;
  poolListo = null;
  await p.end();
}

/**
 * Aplica supabase_schema.sql si la base todavía no tiene la tabla `sectores`.
 * Es idempotente: si la base ya existe, sólo corre las migraciones incrementales.
 */
async function asegurarEsquema(p) {
  const r = await p.query(`select to_regclass('public.sectores') as t;`);
  const vacia = !r.rows[0].t;

  if (vacia) {
    if (!fs.existsSync(SCHEMA_FILE)) {
      throw new Error(
        `La base está vacía y no se encontró ${SCHEMA_FILE}.\n` +
        '  Ejecutá ese archivo desde el SQL Editor de Supabase antes de arrancar.'
      );
    }
    const ddl = fs.readFileSync(SCHEMA_FILE, 'utf8');
    await p.query(ddl);
    console.log('  · Esquema de Supabase aplicado (supabase_schema.sql)');
  } else {
    // Migraciones incrementales (replica agregarColumnaSiNoExiste de SQLite).
    await p.query(`
      alter table registros_tiempos add column if not exists pausa_inicio text;
      alter table registros_tiempos add column if not exists segundos_pausados double precision not null default 0;
      alter table sectores          add column if not exists linea_area text not null default 'General';
      alter table sectores          add column if not exists orden_flujo integer not null default 0;
      alter table sectores          add column if not exists operarios_sugeridos text;
      alter table sectores          add column if not exists activo smallint not null default 1;
      alter table ordenes_trabajo   add column if not exists linea_area text not null default 'Placares';
    `);
    // Migración de integridad (auditoría C-1/C-2/A-5): índices únicos
    // parciales que impiden DO ETAPAS ABIERTAS por OT+sector y por operario.
    await cerrarEtapasDuplicadas(p);
    await p.query(INDICES_UNICOS_ABIERTAS);

    // Tablas de autenticación (V-1): bases creadas antes de incorporar
    // usuarios/sesiones las reciben aquí de forma idempotente.
    await p.query(TABLAS_AUTH);
  }
}

/**
 * Índices únicos parciales sobre etapas ABIERTAS (C-1 y C-2). Son la última
 * línea de defensa de la concurrencia: aunque dos peticiones simultáneas
 * pasen las validaciones R1/R3, Postgres rechaza la segunda inserción (23505).
 * `registros.js` traduce ese error a un 409 entendible para la planta.
 */
const INDICES_UNICOS_ABIERTAS = `
  create unique index if not exists uq_reg_ot_sector_abierta
    on public.registros_tiempos (ot_id, sector_id)
    where estado_etapa in ('En Proceso','Pausado');

  create unique index if not exists uq_reg_operario_abierto
    on public.registros_tiempos (lower(operario_nombre))
    where estado_etapa in ('En Proceso','Pausado');
`;

/** Tablas de autenticación para bases existentes (idempotente, V-1). */
const TABLAS_AUTH = `
  create table if not exists public.usuarios (
    id             bigint generated by default as identity primary key,
    usuario        text   not null unique,
    nombre         text   not null,
    nombre_norm    text   not null unique,
    email          text,
    password_hash  text   not null,
    password_salt  text   not null,
    rol            text   not null default 'operario',
    activo         smallint not null default 1,
    ultimo_acceso  text,
    fecha_creacion text   not null,
    fecha_actualizacion text not null
  );
  create table if not exists public.sesiones (
    id            bigint generated by default as identity primary key,
    usuario_id    bigint not null references public.usuarios(id) on delete cascade,
    token_hash    text   not null unique,
    ip            text,
    user_agent    text,
    creada_en     text   not null,
    expira_en     text   not null,
    cerrada_en    text,
    fecha_creacion text  not null
  );
  create index if not exists idx_ses_usuario on public.sesiones (usuario_id, cerrada_en);
  create index if not exists idx_ses_expira  on public.sesiones (expira_en);
`;

/**
 * Migración de datos previa a los índices únicos: si la base todavía tiene
 * etapas abiertas duplicadas (el bug que permitía la ausencia de índice),
 * se cierran automáticamente conservando SÓLO la más reciente de cada grupo.
 * Los duplicados viejos quedan 'Finalizado' con una observación que explica
 * el cierre, para no perder la trazabilidad del tiempo trabajado.
 */
async function cerrarEtapasDuplicadas(p) {
  // 1) Identificar las etapas abiertas que duplican OT+sector o al operario.
  const dup = await p.query(`
    WITH abiertas AS (
      SELECT id,
             ROW_NUMBER() OVER (PARTITION BY ot_id, sector_id
                                ORDER BY fecha_hora_inicio DESC, id DESC) AS rn_sector,
             ROW_NUMBER() OVER (PARTITION BY lower(operario_nombre)
                                ORDER BY fecha_hora_inicio DESC, id DESC) AS rn_operario
        FROM public.registros_tiempos
       WHERE estado_etapa IN ('En Proceso','Pausado')
    )
    SELECT id FROM abiertas WHERE rn_sector > 1 OR rn_operario > 1;
  `);
  const ids = dup.rows.map((x) => Number(x.id));
  if (!ids.length) return;

  // 2) Cerrarlas conservando SÓLO la más reciente de cada grupo. Las viejas
  //    quedan 'Finalizado' con una observación que explica el cierre (no se
  //    pierde el tiempo trabajado, sólo se invalida la apertura duplicada).
  await p.query(`
    UPDATE public.registros_tiempos r
       SET estado_etapa     = 'Finalizado',
           fecha_hora_fin   = coalesce(r.fecha_hora_fin, r.fecha_hora_inicio),
           duracion_minutos = greatest(0, round((
             extract(epoch from (coalesce(r.fecha_hora_fin, r.fecha_hora_inicio)::timestamptz
                                 - r.fecha_hora_inicio::timestamptz))
             - coalesce(r.segundos_pausados, 0)) / 60.0, 2)),
           pausa_inicio     = NULL,
           observacion      = coalesce(r.observacion || ' · ', '')
                             || 'Cierre automático por migración de integridad (etapa abierta duplicada).',
           -- to_char inline: bases antiguas podrían no tener optiflow_ts_utc().
           fecha_actualizacion = to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
     WHERE r.id = ANY($1::bigint[]);
  `, [ids]);

  // 3) Cerrar los eventos de pausa huérfanos SÓLO de esas etapas.
  await p.query(`
    UPDATE public.eventos_pausa
       SET fin_pausa = to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
     WHERE fin_pausa IS NULL AND registro_id = ANY($1::bigint[]);
  `, [ids]);

  console.log(`  · Migración de integridad: ${ids.length} etapa(s) abierta(s) duplicada(s) cerradas (se conservó la más reciente)`);
}

/* ------------------------------------------------------------------ */
/* Semillas (idempotentes)                                             */
/* ------------------------------------------------------------------ */

/** Inserta sectores base y OTs de demostración si faltan (idempotente). */
async function sembrar(database) {
  const ahora = ahoraUTC();

  // Sectores: ON CONFLICT DO NOTHING sobre el UNIQUE de nombre_sector. Así una
  // base ya en producción recibe los sectores nuevos (p. ej. Cocinas) sin pisar
  // lo que el usuario haya editado (es_compartido, orden, línea, etc.).
  const antes = (await database.query('select count(*) as n from sectores;')).rows[0].n;
  for (const s of SECTORES_BASE) {
    await database.query(
      `insert into sectores
         (nombre_sector, nombre_corto, es_compartido, clave_especial,
          linea_area, orden_flujo, operarios_sugeridos, activo)
       values ($1,$2,$3,$4,$5,$6,$7,1)
       on conflict (nombre_sector) do nothing;`,
      [s[0], s[1], s[2], s[3], s[4], s[5], s[6]]
    );
  }
  const despues = (await database.query('select count(*) as n from sectores;')).rows[0].n;
  if (despues > antes) console.log(`  · ${despues - antes} sectores del catálogo sembrados`);

  const cantOT = (await database.query('select count(*) as n from ordenes_trabajo;')).rows[0].n;
  if (cantOT === 0) {
    for (const ot of DEMO_OT) {
      await database.query(
        `insert into ordenes_trabajo
           (numero_ot, cliente, modelo, metros_lineales, fecha_prometida,
            requiere_vidrio, requiere_lustre, requiere_herreria, requiere_especiales,
            estado_general, fecha_creacion, fecha_actualizacion)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'En Cola',$10,$10);`,
        [ot.numero_ot, ot.cliente, ot.modelo, ot.metros_lineales, ot.fecha_prometida,
          ot.requiere_vidrio, ot.requiere_lustre, ot.requiere_herreria, ot.requiere_especiales,
          ahora]
      );
    }
    console.log(`  · ${DEMO_OT.length} OTs de ejemplo cargadas (puede eliminarlas desde Administración)`);
  }

  // Nómina de operarios: ON CONFLICT idempotente (unicidad sobre nombre_norm).
  // Si el usuario dio de baja a alguien, no se lo re-activa al reiniciar.
  const antesOp = (await database.query('select count(*) as n from operarios;')).rows[0].n;
  for (const nombre of OPERARIOS_NOMINA) {
    await database.query(
      `insert into operarios (nombre, nombre_norm, activo, fecha_creacion)
       values ($1,$2,1,$3) on conflict (nombre_norm) do nothing;`,
      [nombre, claveNormalizada(nombre), ahora]
    );
  }
  const despuesOp = (await database.query('select count(*) as n from operarios;')).rows[0].n;
  if (despuesOp > antesOp) {
    console.log(`  · ${despuesOp - antesOp} operarios de la nómina sembrados`);
  }

  // Administrador inicial (auditoría V-1): sólo si la tabla `usuarios` está
  // vacía. La contraseña sale de OPTIFLOW_ADMIN_PASSWORD o se genera al azar
  // y se imprime UNA sola vez (no vuelve a mostrarse jamás).
  const admin = await auth.asegurarAdminInicial(database);
  if (admin.creado) {
    console.log(`  · Usuario administrador inicial creado: "${admin.usuario}"`);
    if (admin.passwordGenerada) {
      console.log('');
      console.log('    ╔══════════════════════════════════════════════════════════════╗');
      console.log('    ║  CONTRASEÑA INICIAL DEL ADMINISTRADOR (apúntela AHORA):      ║');
      console.log(`    ║  usuario : ${String(admin.usuario).padEnd(47)}║`);
      console.log(`    ║  clave   : ${String(admin.password).padEnd(47)}║`);
      console.log('    ║  Se muestra sólo una vez. Cámbiela tras el primer ingreso.   ║');
      console.log('    ╚══════════════════════════════════════════════════════════════╝');
      console.log('');
    }
  }
}

/* ------------------------------------------------------------------ */
/* Utilidades de fecha (siempre desde el reloj del servidor)           */
/* ------------------------------------------------------------------ */

function ahoraUTC() {
  return new Date().toISOString();
}

const _fmtLocal = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONA,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false, hourCycle: 'h23',
});

/** 'YYYY-MM-DD HH:MM:SS' en la zona horaria de PLANTA (configurable). */
function aLocalLegible(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = Object.fromEntries(_fmtLocal.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** Duración neta en minutos (descontando pausas), redondeada a 2 decimales. */
function calcularDuracionMinutos(inicioISO, finISO, segundosPausados, pausaInicioISO) {
  const ms = new Date(finISO).getTime() - new Date(inicioISO).getTime();
  let segundos = segundosPausados || 0;
  if (pausaInicioISO) {
    segundos += (new Date(finISO).getTime() - new Date(pausaInicioISO).getTime()) / 1000;
  }
  const minutos = (ms / 1000 - segundos) / 60;
  return Math.max(0, Math.round(minutos * 100) / 100);
}

/**
 * Clave de comparación de nombres de operarios.
 * Normaliza (minúsculas + sin acentos + espacios colapsados) para que la
 * unicidad y el auto-guardado sean insensibles a tildes, igual que hace el
 * frontend con FORMATO.normalizar.
 */
function claveNormalizada(nombre) {
  return String(nombre || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/* ------------------------------------------------------------------ */
/* Puente de sintaxis SQLite -> PostgreSQL                              */
/* ------------------------------------------------------------------ */

/**
 * Convierte los marcadores posicionales `?` de SQLite en `$1..$n` de Postgres.
 * Ignora todo lo que esté dentro de comillas simples ('literal con ?').
 */
function aPlaceholders(sql) {
  let dentro = false;
  let n = 0;
  let out = '';
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") {
      out += c;
      if (dentro && sql[i + 1] === "'") { out += "'"; i++; continue; }
      dentro = !dentro;
      continue;
    }
    if (!dentro && c === '?') { n += 1; out += '$' + n; continue; }
    out += c;
  }
  // LIMIT/OFFSET parametrizados: Postgres necesita el tipo explícito.
  out = out.replace(/\bLIMIT\s+\$(\d+)/gi, 'LIMIT $$$1::bigint');
  out = out.replace(/\bOFFSET\s+\$(\d+)/gi, 'OFFSET $$$1::bigint');
  return out;
}

/** ¿Es un INSERT? (para pedirle a Postgres el id generado). */
function esInsert(sql) {
  return /^\s*(\/\*.*?\*\/\s*)*insert\s+into/i.test(sql);
}

function conReturning(sql) {
  if (!esInsert(sql) || /\breturning\b/i.test(sql)) return sql;
  return /;\s*$/.test(sql) ? sql.replace(/;\s*$/, ' RETURNING id;') : `${sql} RETURNING id`;
}

/* ------------------------------------------------------------------ */
/* Helpers de consulta (ASÍNCRONOS)                                    */
/* ------------------------------------------------------------------ */

async function consultar(sql, params) {
  const cliente = await abrirConexion();
  const sqlPG = aPlaceholders(sql);
  const arg = params && params.length ? [params] : [];
  // Dentro de una transacción hay que usar SIEMPRE el mismo cliente,
  // o Postgres no ve los cambios ni puede hacer COMMIT/ROLLBACK.
  const dentro = enTransaccion.getStore();
  if (dentro) return dentro.query(sqlPG, ...arg);
  return cliente.query(sqlPG, ...arg);
}

/** Primera fila (o undefined), igual que el `.get()` de node:sqlite. */
async function get(sql, ...params) {
  const r = await consultar(sql, params);
  return r.rows.length ? r.rows[0] : undefined;
}

/** Todas las filas, igual que el `.all()` de node:sqlite. */
async function all(sql, ...params) {
  const r = await consultar(sql, params);
  return r.rows;
}

/**
 * Ejecuta un INSERT/UPDATE/DELETE.
 * Devuelve { changes, lastInsertRowid } como hacía node:sqlite, para que los
 * handlers no cambien. Los INSERT llevan `RETURNING id` automáticamente.
 */
async function run(sql, ...params) {
  const sqlFinal = conReturning(sql.trim());
  const r = await consultar(sqlFinal, params);
  const id = r.rows && r.rows[0] && r.rows[0].id !== undefined ? Number(r.rows[0].id) : 0;
  return { changes: Number(r.rowCount || 0), lastInsertRowid: id };
}

/**
 * Ejecuta `fn` dentro de una transacción real (BEGIN/COMMIT/ROLLBACK).
 * `fn` puede ser async. Se usa AsyncLocalStorage para que, si dos peticiones
 * concurrentes transaccionan a la vez, cada una vea SU cliente y no se pisen.
 *
 * `claves` (opcional, auditoría A-5): lista de claves de serialización
 * [clase, id] que se toman como ADVISORY LOCKS de transacción ANTES de
 * ejecutar `fn`. `pg_advisory_xact_lock` libera los locks SOLO al hacer
 * COMMIT/ROLLBACK, así que dos peticiones que disputan el mismo sector /
 * OT / operario quedan serializadas aunque lleguen en paralelo desde
 * distintas instancias serverless. Las claves se ordenan y deduplican para
 * evitar deadlocks entre transacciones que toman los mismos recursos.
 *
 * Clases de lock (constantés): 1 = sector, 2 = OT, 3 = operario.
 */
const LOCK_SECTOR = 1;
const LOCK_OT = 2;
const LOCK_OPERARIO = 3;

async function transaccion(fn, claves) {
  const cliente = await abrirConexion();
  const c = await cliente.connect();
  try {
    return await enTransaccion.run(c, async () => {
      await c.query('BEGIN');
      try {
        if (claves && claves.length) {
          const ordenadas = [...new Map(
            claves.filter(Boolean).map(([clase, id]) => [`${clase}:${id}`, [clase, Number(id)]])
          ).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
          for (const [clase, id] of ordenadas) {
            await c.query('SELECT pg_advisory_xact_lock($1, $2);', [clase, id]);
          }
        }
        const r = await fn();
        await c.query('COMMIT');
        return r;
      } catch (e) {
        try { await c.query('ROLLBACK'); } catch { /* noop */ }
        throw e;
      }
    });
  } finally {
    c.release();
  }
}

/* ------------------------------------------------------------------ */
/* Mappers                                                             */
/* ------------------------------------------------------------------ */

/** Convierte los 0/1 (SMALLINT) en booleanos reales para la API/JSON. */
function mapOT(row) {
  if (!row) return null;
  return {
    id: row.id,
    numero_ot: row.numero_ot,
    cliente: row.cliente,
    modelo: row.modelo,
    linea_area: row.linea_area || 'Placares',
    metros_lineales: Number(row.metros_lineales),
    fecha_prometida: row.fecha_prometida,
    requiere_vidrio: !!row.requiere_vidrio,
    requiere_lustre: !!row.requiere_lustre,
    requiere_herreria: !!row.requiere_herreria,
    requiere_especiales: !!row.requiere_especiales,
    estado_general: row.estado_general,
    fecha_creacion: row.fecha_creacion,
    fecha_actualizacion: row.fecha_actualizacion,
  };
}

function mapSector(row) {
  if (!row) return null;
  return {
    id: row.id,
    nombre_sector: row.nombre_sector,
    nombre_corto: row.nombre_corto,
    es_compartido: !!row.es_compartido,
    clave_especial: row.clave_especial || null,
    linea_area: row.linea_area || 'General',
    orden_flujo: Number(row.orden_flujo || 0),
    // Texto libre "José" | "Joel, Tiago"; null cuando no hay sugeridos.
    operarios_sugeridos: row.operarios_sugeridos || null,
    activo: row.activo === undefined ? true : !!row.activo,
  };
}

function mapRegistro(row) {
  if (!row) return null;
  const duracion = row.duracion_minutos === null || row.duracion_minutos === undefined
    ? null
    : Number(row.duracion_minutos);
  return {
    id: row.id,
    ot_id: row.ot_id,
    sector_id: row.sector_id,
    operario_nombre: row.operario_nombre,
    fecha_hora_inicio: row.fecha_hora_inicio,
    fecha_hora_fin: row.fecha_hora_fin,
    duracion_minutos: duracion,
    // Horas hombre consumidas en la etapa (1 operario por etapa => h.h. = minutos / 60).
    horas_hombre: duracion === null ? null : Math.round((duracion / 60) * 10000) / 10000,
    estado_etapa: row.estado_etapa,
    motivo_pausa: row.motivo_pausa,
    observacion: row.observacion,
    pausa_inicio: row.pausa_inicio,
    segundos_pausados: Number(row.segundos_pausados || 0),
    // --- campos derivados para la UI (no persistidos) ---
    fecha_hora_inicio_local: aLocalLegible(row.fecha_hora_inicio),
    fecha_hora_fin_local: aLocalLegible(row.fecha_hora_fin),
    pausa_inicio_local: aLocalLegible(row.pausa_inicio),
    // Datos "pegados" del JOIN
    numero_ot: row.numero_ot || undefined,
    cliente: row.cliente || undefined,
    modelo: row.modelo || undefined,
    nombre_sector: row.nombre_sector || undefined,
    nombre_corto: row.nombre_corto || undefined,
  };
}

/** Material/placa requerido por una OT. */
function mapMaterial(row) {
  if (!row) return null;
  const requeridas = Number(row.cantidad_placas);
  const consumidas = Number(row.cantidad_consumida || 0);
  return {
    id: row.id,
    ot_id: row.ot_id,
    material_nombre: row.material_nombre,
    cantidad_placas: requeridas,
    cantidad_consumida: consumidas,
    placas_restantes: Math.max(0, Math.round((requeridas - consumidas) * 100) / 100),
    observaciones: row.observaciones || null,
    fecha_actualizacion: row.fecha_actualizacion,
  };
}

/** Operario del maestro. */
function mapOperario(row) {
  if (!row) return null;
  return {
    id: row.id,
    nombre: row.nombre,
    activo: !!row.activo,
    fecha_creacion: row.fecha_creacion,
    // Enriquecimiento opcional (cuando el handler trae estas columnas).
    etapas: row.etapas !== undefined ? Number(row.etapas) : undefined,
    etapas_abiertas: row.etapas_abiertas !== undefined ? Number(row.etapas_abiertas) : undefined,
    ultima_actividad: row.ultima_actividad || undefined,
  };
}

/** Usuario del sistema (autenticación). NUNCA expone password_hash/salt. */
function mapUsuario(row) {
  if (!row) return null;
  return {
    id: row.id,
    usuario: row.usuario,
    nombre: row.nombre,
    email: row.email || null,
    rol: row.rol,
    activo: !!row.activo,
    ultimo_acceso: row.ultimo_acceso || null,
    fecha_creacion: row.fecha_creacion,
  };
}

/* ------------------------------------------------------------------ */
/* Reglas de negocio puras (sin SQL: idénticas a las fases anteriores)  */
/* ------------------------------------------------------------------ */

/** Minutos de umbral para una etapa prolongada en un sector (nombre o fila). */
function umbralMinutos(sectorOMatriz) {
  const nombre = typeof sectorOMatriz === 'string'
    ? sectorOMatriz
    : (sectorOMatriz && (sectorOMatriz.nombre_sector || '')) || '';
  return UMBRALES_MINUTOS.por_sector[nombre] || UMBRALES_MINUTOS.defecto;
}

/**
 * ¿Aplica `sector` a una OT de la línea `linea`?  (regla R8)
 */
function sectorAplica(sector, linea) {
  const l = (sector && sector.linea_area) || 'General';
  return l === linea || l === 'Compartido' || l === 'General';
}

/**
 * Sectores activos que una OT de `linea` debe recorrer, en orden de flujo.
 */
function sectoresDeLinea(sectores, linea) {
  return (sectores || [])
    .filter((s) => !s.clave_especial && s.activo !== false && sectorAplica(s, linea))
    .sort((a, b) => {
      const propia = ((a.linea_area || '') === linea ? 0 : 1) - ((b.linea_area || '') === linea ? 0 : 1);
      return propia || (Number(a.orden_flujo) - Number(b.orden_flujo)) || (a.id - b.id);
    });
}

/**
 * Reglas de precedencia del flujo (anti-conflictos) — regla R6.
 *  P1. Orden del flujo regular de LA LÍNEA de la OT.
 *  P2. Los sectores especiales exigen al menos el corte de la línea finalizado.
 *  P3. Control de Calidad exige todos los especiales REQUERIDOS por la OT.
 */
function prerrequisitosSector(ot, sectorId, sectores, finalizadosIds) {
  const finalizados = finalizadosIds instanceof Set
    ? finalizadosIds
    : new Set(finalizadosIds || []);
  const sector = sectores.find((s) => s.id === sectorId);
  if (!sector || finalizados.has(sectorId)) return [];

  const linea = (ot && ot.linea_area) || 'Placares';
  const regulares = sectoresDeLinea(sectores, linea);
  // Primera etapa de la línea = su "corte" (p. ej. 'Seccionadora / Corte'
  // en Placares o 'Seccionadora B / Corte Módulos' en Cocinas).
  const corte = regulares.find((s) => s.linea_area === linea) || regulares[0];
  const faltantes = new Map();

  if (sector.clave_especial) {
    // P2: especiales requieren el corte de la línea finalizado.
    if (corte && !finalizados.has(corte.id)) faltantes.set(corte.id, corte);
  } else {
    // P1: todos los sectores regulares ANTERIORES en el orden de la línea.
    for (const prev of regulares) {
      if (prev.id === sector.id) break;
      if (!finalizados.has(prev.id)) faltantes.set(prev.id, prev);
    }
  }

  // P3: Control de Calidad exige los especiales requeridos por la OT.
  if (sector.nombre_sector === SECTOR_CONTROL) {
    for (const s of sectores) {
      if (!s.clave_especial) continue;
      if (!ot[`requiere_${s.clave_especial}`]) continue;
      if (!finalizados.has(s.id)) faltantes.set(s.id, s);
    }
  }

  return [...faltantes.values()];
}

/** Set de ids de sectores finalizados de una OT. */
async function sectoresFinalizadosIds(otId) {
  const filas = await all(
    `SELECT DISTINCT sector_id FROM registros_tiempos
      WHERE ot_id = $1 AND estado_etapa = 'Finalizado';`, otId
  );
  return new Set(filas.map((r) => r.sector_id));
}

/* ------------------------------------------------------------------ */
/* Exports                                                             */
/* ------------------------------------------------------------------ */

module.exports = {
  ROOT,
  SCHEMA_FILE,
  ZONA,
  ESTADOS_OT,
  ESTADOS_ETAPA,
  ESTADOS_ABIERTOS,
  MOTIVOS_PAUSA,
  MOTIVOS_REPROCESO,
  UMBRALES_MINUTOS,
  CLAVES_ESPECIALES,
  OPERARIOS_NOMINA,
  LINEAS_AREA,
  LINEAS_OT,
  SECTORES_BASE,
  abrirConexion,
  cerrarConexion,
  get,
  all,
  run,
  transaccion,
  LOCK_SECTOR,
  LOCK_OT,
  LOCK_OPERARIO,
  /** Clave int32 determinística de un operario para advisory locks. */
  claveLockOperario: (nombre) => auth.clave32(claveNormalizada(nombre)),
  ahoraUTC,
  aLocalLegible,
  calcularDuracionMinutos,
  claveNormalizada,
  umbralMinutos,
  sectorAplica,
  sectoresDeLinea,
  prerrequisitosSector,
  sectoresFinalizadosIds,
  mapOT,
  mapSector,
  mapRegistro,
  mapMaterial,
  mapOperario,
  mapUsuario,
};
