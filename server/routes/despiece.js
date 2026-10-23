'use strict';

/**
 * ============================================================
 *  OPTIFLOW - Oficina Técnica: despiece, bultos y pañol
 * ============================================================
 *
 * Endpoints (los registra server/server.js):
 *   GET    /api/ot/:id/despiece
 *   POST   /api/ot/:id/despiece
 *   GET    /api/ot/:id/hoja-herrajes
 *   PATCH  /api/ot/:id/despacho/bulto/:numero_bulto
 *   PATCH  /api/ot/:id/herrajes/:hid/entrega
 *
 * MODELO:
 *   · El despiece se guarda en bloque (módulos con piezas anidadas +
 *     herrajes). Es el formato natural para pegar/importar desde Excel y
 *     para que una sola transacción deje la OT consistente.
 *   · `numero_bulto` SIEMPRE lo asigna el servidor, secuencial desde 1 por OT
 *     y en el orden en que llegan los módulos/piezas. El cliente no puede
 *     imponerlo: así no hay bultos duplicados ni huecos.
 *   · Al reemplazar, se preserva `cargado_en_flete`/`fecha_cargado` de las
 *     piezas que siguen siendo la MISMA pieza física (mueble + módulo + tipo +
 *     nombre + medidas + color). Una edición de la oficina no borra el trabajo
 *     ya hecho por Control de Flete.
 *   · Si alguna pieza es laqueada, la OT queda marcada con `requiere_lustre`.
 *     La marca sólo se enciende: apagarla automáticamente podría sacar del
 *     flujo un lustre pedido por otra vía.
 */

const db = require('../db');
const {
  ApiError, textoRequerido, textoOpcional, decimal, entero, booleano, enumOpcion,
} = require('../lib/http');

/**
 * Catálogo cerrado de tipos de pieza. Es el único campo con semántica de
 * proceso (una "Pieza Cajonera" se relaciona con `cantidad_cajoneras`), por eso
 * se valida contra lista. Placa, color y espesor quedan abiertos a propósito:
 * los proveedores cambian códigos y la importación desde Excel no debe fallar
 * por un espesor de 16 mm que no esté en la lista corta de la UI.
 *
 * IMPORTANTE: mantener sincronizado con DESPIECE_TIPOS_PIEZA en
 * public/js/admin.js.
 */
const TIPOS_PIEZA = Object.freeze([
  'Lateral',
  'Estante',
  'Piso',
  'Techo',
  'Fondo 18mm',
  'Ajuste',
  'Cierratecho',
  'Zócalo',
  'Pieza Cajonera',
]);

// Topes defensivos: el body ya está limitado a 1 MB por lib/http.js, pero
// estos límites evitan una transacción eterna en el runtime de Vercel.
const MAX_MODULOS = 500;
const MAX_PIEZAS_TOTAL = 5000;
const MAX_HERRAJES = 2000;

/* ------------------------------------------------------------------ */
/* Helpers numéricos / de forma                                       */
/* ------------------------------------------------------------------ */

/** Redondeo a 3 decimales para m² (las piezas chicas no deben dar 0.00). */
function r3(valor) {
  return Math.round(Number(valor || 0) * 1000) / 1000;
}

/** Entero >= `min`; vacío devuelve `porDefecto` (para mueble/módulo/cajoneras). */
function enteroMin(valor, campo, min, porDefecto) {
  if (valor === undefined || valor === null || valor === '') return porDefecto;
  const n = Number(valor);
  if (!Number.isInteger(n) || n < min) {
    throw new ApiError(400, `El campo "${campo}" debe ser un entero mayor o igual a ${min}.`);
  }
  return n;
}

/** Lista obligatoria (acepta `[]`, que significa "vaciar"). */
function listaObligatoria(valor, campo) {
  if (valor === undefined || valor === null) {
    throw new ApiError(400, `El campo "${campo}" es obligatorio. Enviá [] para vaciarlo.`);
  }
  if (!Array.isArray(valor)) {
    throw new ApiError(400, `El campo "${campo}" debe ser una lista.`);
  }
  return valor;
}

function objeto(valor, campo) {
  if (!valor || typeof valor !== 'object' || Array.isArray(valor)) {
    throw new ApiError(400, `El campo "${campo}" debe ser un objeto.`);
  }
  return valor;
}

/* ------------------------------------------------------------------ */
/* Validación del body                                                */
/* ------------------------------------------------------------------ */

function validarPieza(valor, nModulo, nPieza) {
  const ref = `pieza #${nPieza} del módulo #${nModulo}`;
  const p = objeto(valor, ref);

  return {
    tipo_pieza: enumOpcion(p.tipo_pieza, TIPOS_PIEZA, `Tipo de la ${ref}`),
    nombre_pieza: textoRequerido(p.nombre_pieza, `Nombre de la ${ref}`, { max: 100 }),
    cantidad: enteroMin(p.cantidad, `Cantidad de la ${ref}`, 1, 1),
    ancho_mm: decimal(p.ancho_mm, `Ancho de la ${ref}`, {
      min: 0.01, max: 999999.99, requerido: true,
    }),
    profundidad_mm: decimal(p.profundidad_mm, `Profundidad de la ${ref}`, {
      min: 0.01, max: 999999.99, requerido: true,
    }),
    espesor_mm: decimal(p.espesor_mm, `Espesor de la ${ref}`, {
      min: 0.01, max: 999.99, requerido: true,
    }),
    tipo_placa: textoRequerido(p.tipo_placa, `Tipo de placa de la ${ref}`, { max: 100 }),
    color_codigo: textoRequerido(p.color_codigo, `Color/código de la ${ref}`, { max: 100 }),
    es_laqueado: booleano(p.es_laqueado, false),
    es_enchapado: booleano(p.es_enchapado, false),
    filos_cantidad: enteroMin(p.filos_cantidad, `Filos de la ${ref}`, 0, 0),
    filos_detalle: textoOpcional(p.filos_detalle, `Detalle de filos de la ${ref}`, { max: 100 }),
  };
}

function validarModulos(valor) {
  const crudos = listaObligatoria(valor, 'módulos');
  if (crudos.length > MAX_MODULOS) {
    throw new ApiError(400, `El despiece supera el máximo de ${MAX_MODULOS} módulos.`);
  }

  let totalPiezas = 0;

  return crudos.map((valorModulo, i) => {
    const n = i + 1;
    const m = objeto(valorModulo, `módulo #${n}`);
    const piezasCrudas = m.piezas === undefined || m.piezas === null ? [] : m.piezas;
    if (!Array.isArray(piezasCrudas)) {
      throw new ApiError(400, `Las piezas del módulo #${n} deben ser una lista.`);
    }

    totalPiezas += piezasCrudas.length;
    if (totalPiezas > MAX_PIEZAS_TOTAL) {
      throw new ApiError(400, `El despiece supera el máximo de ${MAX_PIEZAS_TOTAL} piezas.`);
    }

    return {
      mueble_numero: enteroMin(m.mueble_numero, `N° de mueble del módulo #${n}`, 1, 1),
      modulo_numero: enteroMin(m.modulo_numero, `N° de módulo #${n}`, 1, 1),
      nombre_modulo: textoRequerido(m.nombre_modulo, `Nombre del módulo #${n}`, { max: 150 }),
      metros_lineales: decimal(m.metros_lineales, `Metros lineales del módulo #${n}`, {
        min: 0, max: 999999.99, porDefecto: 0,
      }),
      posee_puertas_vidrio_rometal: booleano(m.posee_puertas_vidrio_rometal, false),
      cantidad_cajoneras: enteroMin(m.cantidad_cajoneras, `Cajoneras del módulo #${n}`, 0, 0),
      observaciones: textoOpcional(m.observaciones, `Observaciones del módulo #${n}`, { max: 2000 }),
      piezas: piezasCrudas.map((p, j) => validarPieza(p, n, j + 1)),
    };
  });
}

function validarHerrajes(valor) {
  const crudos = listaObligatoria(valor, 'herrajes');
  if (crudos.length > MAX_HERRAJES) {
    throw new ApiError(400, `La lista de herrajes supera el máximo de ${MAX_HERRAJES}.`);
  }

  return crudos.map((valorHerraje, i) => {
    const n = i + 1;
    const h = objeto(valorHerraje, `herraje #${n}`);
    return {
      mueble_numero: enteroMin(h.mueble_numero, `N° de mueble del herraje #${n}`, 1, 1),
      herraje_nombre: textoRequerido(h.herraje_nombre, `Nombre del herraje #${n}`, { max: 150 }),
      codigo_sku: textoOpcional(h.codigo_sku, `SKU del herraje #${n}`, { max: 50 }),
      cantidad: enteroMin(h.cantidad, `Cantidad del herraje #${n}`, 1, 1),
      entregado_por_panol: booleano(h.entregado_por_panol, false),
      observaciones: textoOpcional(h.observaciones, `Observaciones del herraje #${n}`, { max: 2000 }),
    };
  });
}

/* ------------------------------------------------------------------ */
/* Mappers                                                            */
/* ------------------------------------------------------------------ */

function aFechaISO(valor) {
  if (!valor) return null;
  const d = new Date(valor);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function mapOT(o) {
  return {
    id: Number(o.id),
    numero_ot: o.numero_ot,
    cliente: o.cliente,
    modelo: o.modelo || null,
    linea_area: o.linea_area,
    metros_lineales: Number(o.metros_lineales) || 0,
    estado_general: o.estado_general,
    fecha_prometida: o.fecha_prometida ? String(o.fecha_prometida).slice(0, 10) : null,
    requiere_lustre: !!o.requiere_lustre,
  };
}

function mapModulo(m) {
  return {
    id: Number(m.id),
    mueble_numero: Number(m.mueble_numero),
    modulo_numero: Number(m.modulo_numero),
    nombre_modulo: m.nombre_modulo,
    metros_lineales: Number(m.metros_lineales) || 0,
    posee_puertas_vidrio_rometal: !!m.posee_puertas_vidrio_rometal,
    cantidad_cajoneras: Number(m.cantidad_cajoneras) || 0,
    observaciones: m.observaciones || null,
  };
}

function mapPieza(p) {
  return {
    id: Number(p.id),
    modulo_id: Number(p.modulo_id),
    mueble_numero: Number(p.mueble_numero),
    modulo_numero: Number(p.modulo_numero),
    nombre_modulo: p.nombre_modulo,
    numero_bulto: Number(p.numero_bulto),
    tipo_pieza: p.tipo_pieza,
    nombre_pieza: p.nombre_pieza,
    cantidad: Number(p.cantidad) || 0,
    ancho_mm: Number(p.ancho_mm) || 0,
    profundidad_mm: Number(p.profundidad_mm) || 0,
    espesor_mm: Number(p.espesor_mm) || 0,
    tipo_placa: p.tipo_placa,
    color_codigo: p.color_codigo,
    es_laqueado: !!p.es_laqueado,
    es_enchapado: !!p.es_enchapado,
    filos_cantidad: Number(p.filos_cantidad) || 0,
    filos_detalle: p.filos_detalle || null,
    cargado_en_flete: !!p.cargado_en_flete,
    fecha_cargado: aFechaISO(p.fecha_cargado),
  };
}

function mapHerraje(h) {
  return {
    id: Number(h.id),
    mueble_numero: Number(h.mueble_numero),
    herraje_nombre: h.herraje_nombre,
    codigo_sku: h.codigo_sku || null,
    cantidad: Number(h.cantidad) || 0,
    entregado_por_panol: !!h.entregado_por_panol,
    observaciones: h.observaciones || null,
  };
}

/* ------------------------------------------------------------------ */
/* Consultas                                                          */
/* ------------------------------------------------------------------ */

async function otBasica(id) {
  const ot = await db.get(
    `SELECT id, numero_ot, cliente, modelo, linea_area, metros_lineales,
            estado_general, fecha_prometida, requiere_lustre
       FROM ordenes_trabajo
      WHERE id = ?;`,
    id
  );
  if (!ot) throw new ApiError(404, `No existe la OT con id ${id}.`);
  return ot;
}

/** Área de una fila de pieza en m² (cantidad incluida). */
function areaPieza(p) {
  return (Number(p.ancho_mm) * Number(p.profundidad_mm) * Number(p.cantidad)) / 1000000;
}

/** Resumen de placas agrupado por sustrato + espesor + color. */
function resumenPlacas(piezas) {
  const mapa = new Map();
  for (const p of piezas) {
    const clave = `${p.tipo_placa}\u0000${p.espesor_mm}\u0000${p.color_codigo}`;
    let g = mapa.get(clave);
    if (!g) {
      g = {
        tipo_placa: p.tipo_placa,
        espesor_mm: p.espesor_mm,
        color_codigo: p.color_codigo,
        filas: 0,
        piezas: 0,
        laqueadas: 0,
        m2: 0,
      };
      mapa.set(clave, g);
    }
    g.filas += 1;
    g.piezas += p.cantidad;
    g.laqueadas += p.es_laqueado ? p.cantidad : 0;
    g.m2 += areaPieza(p);
  }

  return [...mapa.values()]
    .map((g) => ({ ...g, m2: r3(g.m2) }))
    .sort((a, b) => a.tipo_placa.localeCompare(b.tipo_placa, 'es')
      || a.espesor_mm - b.espesor_mm
      || a.color_codigo.localeCompare(b.color_codigo, 'es'));
}

/** Bultos para Control de Flete: un bulto está cargado si TODAS sus piezas lo están. */
function resumenBultos(piezas) {
  const mapa = new Map();
  for (const p of piezas) {
    let b = mapa.get(p.numero_bulto);
    if (!b) {
      b = {
        numero_bulto: p.numero_bulto,
        filas: 0,
        unidades: 0,
        m2: 0,
        cargado: true,
        fecha_cargado: null,
        modulos: new Set(),
      };
      mapa.set(p.numero_bulto, b);
    }
    b.filas += 1;
    b.unidades += p.cantidad;
    b.m2 += areaPieza(p);
    b.cargado = b.cargado && p.cargado_en_flete;
    if (p.fecha_cargado && (!b.fecha_cargado || p.fecha_cargado > b.fecha_cargado)) {
      b.fecha_cargado = p.fecha_cargado;
    }
    b.modulos.add(`M${p.mueble_numero} · Mód. ${p.modulo_numero}`);
  }

  return [...mapa.values()]
    .sort((a, b) => a.numero_bulto - b.numero_bulto)
    .map((b) => ({
      numero_bulto: b.numero_bulto,
      filas: b.filas,
      unidades: b.unidades,
      m2: r3(b.m2),
      cargado: b.cargado,
      fecha_cargado: b.fecha_cargado,
      modulos: [...b.modulos],
    }));
}

/**
 * Lee el despiece completo y lo devuelve listo para la UI:
 * módulos anidados + lista plana de piezas + resumen de placas + bultos.
 */
async function leerDespiece(id) {
  const ot = await otBasica(id);

  const [filasModulos, filasPiezas, filasHerrajes] = await Promise.all([
    db.all(
      `SELECT * FROM ot_despiece_modulos
        WHERE ot_id = ?
        ORDER BY id;`,
      id
    ),
    db.all(
      `SELECT p.*, m.mueble_numero, m.modulo_numero, m.nombre_modulo
         FROM ot_despiece_piezas p
         JOIN ot_despiece_modulos m ON m.id = p.modulo_id
        WHERE p.ot_id = ?
        ORDER BY p.numero_bulto, p.id;`,
      id
    ),
    db.all(
      `SELECT * FROM ot_herrajes_lista
        WHERE ot_id = ?
        ORDER BY mueble_numero, herraje_nombre, id;`,
      id
    ),
  ]);

  const modulos = filasModulos.map(mapModulo);
  const piezas = filasPiezas.map(mapPieza);
  const herrajes = filasHerrajes.map(mapHerraje);

  const porModulo = new Map(modulos.map((m) => [m.id, { ...m, piezas: [] }]));
  for (const p of piezas) {
    const modulo = porModulo.get(p.modulo_id);
    if (modulo) modulo.piezas.push(p);
  }

  const totalUnidades = piezas.reduce((s, p) => s + p.cantidad, 0);
  const totalM2 = r3(piezas.reduce((s, p) => s + areaPieza(p), 0));

  return {
    ot: mapOT(ot),
    modulos: [...porModulo.values()],
    piezas,
    herrajes,
    resumen_placas: resumenPlacas(piezas),
    bultos: resumenBultos(piezas),
    resumen: {
      modulos: modulos.length,
      filas_piezas: piezas.length,
      piezas: totalUnidades,
      bultos: new Set(piezas.map((p) => p.numero_bulto)).size,
      m2: totalM2,
      laqueadas: piezas.reduce((s, p) => s + (p.es_laqueado ? p.cantidad : 0), 0),
      herrajes: herrajes.length,
      unidades_herrajes: herrajes.reduce((s, h) => s + h.cantidad, 0),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Handlers                                                           */
/* ------------------------------------------------------------------ */

/** GET /api/ot/:id/despiece */
async function obtener({ params }) {
  const id = entero(params.id, 'id de la OT');
  return { status: 200, data: await leerDespiece(id) };
}

/**
 * POST /api/ot/:id/despiece
 *
 * Body:
 * {
 *   modulos: [{
 *     mueble_numero, modulo_numero, nombre_modulo, metros_lineales,
 *     posee_puertas_vidrio_rometal, cantidad_cajoneras, observaciones,
 *     piezas: [{
 *       tipo_pieza, nombre_pieza, cantidad, ancho_mm, profundidad_mm,
 *       espesor_mm, tipo_placa, color_codigo, es_laqueado, es_enchapado,
 *       filos_cantidad, filos_detalle
 *     }]
 *   }],
 *   herrajes: [{ mueble_numero, herraje_nombre, codigo_sku, cantidad,
 *                entregado_por_panol, observaciones }]   // opcional
 * }
 *
 * Si `herrajes` se omite, la lista existente se conserva. Si se envía `[]`,
 * se vacía. `numero_bulto` se ignora si viene: lo asigna el servidor.
 */
async function guardar({ params, body }) {
  const id = entero(params.id, 'id de la OT');
  const modulos = validarModulos(body.modulos);
  const reemplazaHerrajes = body.herrajes !== undefined;
  const herrajes = reemplazaHerrajes ? validarHerrajes(body.herrajes) : null;

  // 404 temprano y mensaje claro antes de abrir la transacción.
  await otBasica(id);

  const ahora = db.ahoraUTC();

  await db.transaccion(async () => {
    // 1) Estado de flete actual, para no perderlo al reemplazar el despiece.
    const previas = await db.all(
      `SELECT m.mueble_numero, m.modulo_numero, p.tipo_pieza, p.nombre_pieza,
              p.ancho_mm, p.profundidad_mm, p.espesor_mm, p.color_codigo,
              p.cargado_en_flete, p.fecha_cargado
         FROM ot_despiece_piezas p
         JOIN ot_despiece_modulos m ON m.id = p.modulo_id
        WHERE p.ot_id = ?;`,
      id
    );

    const clavePieza = (p) => [
      p.mueble_numero,
      p.modulo_numero,
      p.tipo_pieza,
      p.nombre_pieza,
      Number(p.ancho_mm).toFixed(2),
      Number(p.profundidad_mm).toFixed(2),
      Number(p.espesor_mm).toFixed(2),
      p.color_codigo,
    ].join('\u0000');

    // Cola por clave: si hay dos piezas idénticas, cada una conserva SU estado
    // en el mismo orden en que estaban.
    const cola = new Map();
    for (const p of previas) {
      const k = clavePieza(p);
      if (!cola.has(k)) cola.set(k, []);
      cola.get(k).push(p);
    }

    // 2) Reemplazo en bloque. Las piezas caen por CASCADE al borrar módulos,
    //    pero se borran explícitamente para que el orden sea obvio.
    await db.run('DELETE FROM ot_despiece_piezas WHERE ot_id = ?;', id);
    await db.run('DELETE FROM ot_despiece_modulos WHERE ot_id = ?;', id);
    if (reemplazaHerrajes) {
      await db.run('DELETE FROM ot_herrajes_lista WHERE ot_id = ?;', id);
    }

    // 3) Módulos + piezas. El bulto es un contador único por OT.
    //    Las piezas se insertan en LOTES (no una por una): una importación de
    //    Excel con cientos de filas no debe consumir cientos de round-trips
    //    dentro del límite de ejecución de Vercel.
    const LOTE = 200;
    const FILA_PIEZA = `(${Array(17).fill('?').join(', ')})`;
    const FILA_HERRAJE = `(${Array(7).fill('?').join(', ')})`;

    let numeroBulto = 1;
    let lotePiezas = [];
    let paramsPiezas = [];

    const volcarPiezas = async () => {
      if (!lotePiezas.length) return;
      await db.run(
        `INSERT INTO ot_despiece_piezas
           (modulo_id, ot_id, numero_bulto, tipo_pieza, nombre_pieza, cantidad,
            ancho_mm, profundidad_mm, espesor_mm, tipo_placa, color_codigo,
            es_laqueado, es_enchapado, filos_cantidad, filos_detalle,
            cargado_en_flete, fecha_cargado)
         VALUES ${lotePiezas.join(', ')};`,
        ...paramsPiezas
      );
      lotePiezas = [];
      paramsPiezas = [];
    };

    for (const m of modulos) {
      const ins = await db.run(
        `INSERT INTO ot_despiece_modulos
           (ot_id, mueble_numero, modulo_numero, nombre_modulo, metros_lineales,
            posee_puertas_vidrio_rometal, cantidad_cajoneras, observaciones)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
        id, m.mueble_numero, m.modulo_numero, m.nombre_modulo, m.metros_lineales,
        m.posee_puertas_vidrio_rometal, m.cantidad_cajoneras, m.observaciones
      );
      const moduloId = ins.lastInsertRowid;

      for (const p of m.piezas) {
        const clave = clavePieza({
          ...p,
          mueble_numero: m.mueble_numero,
          modulo_numero: m.modulo_numero,
        });
        const pendientes = cola.get(clave);
        const previa = pendientes && pendientes.length ? pendientes.shift() : null;

        lotePiezas.push(FILA_PIEZA);
        paramsPiezas.push(
          moduloId, id, numeroBulto, p.tipo_pieza, p.nombre_pieza, p.cantidad,
          p.ancho_mm, p.profundidad_mm, p.espesor_mm, p.tipo_placa, p.color_codigo,
          p.es_laqueado, p.es_enchapado, p.filos_cantidad, p.filos_detalle,
          previa ? !!previa.cargado_en_flete : false,
          previa ? previa.fecha_cargado : null
        );
        numeroBulto += 1;
        if (lotePiezas.length >= LOTE) await volcarPiezas();
      }
    }
    await volcarPiezas();

    // 4) Herrajes (sólo si el cliente los envió), también por lotes.
    if (reemplazaHerrajes) {
      for (let i = 0; i < herrajes.length; i += LOTE) {
        const grupo = herrajes.slice(i, i + LOTE);
        const placeholders = grupo.map(() => FILA_HERRAJE).join(', ');
        const params = [];
        for (const h of grupo) {
          params.push(
            id, h.mueble_numero, h.herraje_nombre, h.codigo_sku, h.cantidad,
            h.entregado_por_panol, h.observaciones
          );
        }
        await db.run(
          `INSERT INTO ot_herrajes_lista
             (ot_id, mueble_numero, herraje_nombre, codigo_sku, cantidad,
              entregado_por_panol, observaciones)
           VALUES ${placeholders};`,
          ...params
        );
      }
    }

    // 5) Derivación a Lustre: si hay al menos una pieza laqueada, la OT
    //    requiere el sector. Sólo se enciende (nunca se apaga solo).
    const hayLaqueado = modulos.some((m) => m.piezas.some((p) => p.es_laqueado));
    if (hayLaqueado) {
      await db.run(
        `UPDATE ordenes_trabajo
            SET requiere_lustre = 1, fecha_actualizacion = ?
          WHERE id = ?;`,
        ahora, id
      );
    }
  }, [[db.LOCK_OT, id]]);

  return { status: 200, data: await leerDespiece(id) };
}

/** GET /api/ot/:id/hoja-herrajes */
async function hojaHerrajes({ params }) {
  const id = entero(params.id, 'id de la OT');
  const ot = await otBasica(id);

  const filas = await db.all(
    `SELECT * FROM ot_herrajes_lista
      WHERE ot_id = ?
      ORDER BY mueble_numero, herraje_nombre, id;`,
    id
  );
  const herrajes = filas.map(mapHerraje);

  const porMueble = new Map();
  for (const h of herrajes) {
    if (!porMueble.has(h.mueble_numero)) porMueble.set(h.mueble_numero, []);
    porMueble.get(h.mueble_numero).push(h);
  }

  const muebles = [...porMueble.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([muebleNumero, lista]) => ({ mueble_numero: muebleNumero, herrajes: lista }));

  return {
    status: 200,
    data: {
      ot: mapOT(ot),
      muebles,
      resumen: {
        items: herrajes.length,
        unidades: herrajes.reduce((s, h) => s + h.cantidad, 0),
        entregados: herrajes.filter((h) => h.entregado_por_panol).length,
        pendientes: herrajes.filter((h) => !h.entregado_por_panol).length,
      },
      generado_en: new Date().toISOString(),
    },
  };
}

/**
 * PATCH /api/ot/:id/despacho/bulto/:numero_bulto
 * Body opcional: { cargado: true|false }. Sin body, alterna el estado actual.
 */
async function alternarBulto({ params, body }) {
  const id = entero(params.id, 'id de la OT');
  const numeroBulto = entero(params.numero_bulto, 'número de bulto');
  const tieneEstado = body && body.cargado !== undefined && body.cargado !== null;
  const estadoPedido = tieneEstado ? booleano(body.cargado) : null;
  const ahora = db.ahoraUTC();

  return db.transaccion(async () => {
    const filas = await db.all(
      `SELECT id, cargado_en_flete
         FROM ot_despiece_piezas
        WHERE ot_id = ? AND numero_bulto = ?;`,
      id, numeroBulto
    );
    if (!filas.length) {
      throw new ApiError(404, `La OT no tiene un bulto #${numeroBulto}.`);
    }

    const todasCargadas = filas.every((f) => !!f.cargado_en_flete);
    const nuevo = estadoPedido === null ? !todasCargadas : estadoPedido;

    await db.run(
      `UPDATE ot_despiece_piezas
          SET cargado_en_flete = ?, fecha_cargado = ?
        WHERE ot_id = ? AND numero_bulto = ?;`,
      nuevo, nuevo ? ahora : null, id, numeroBulto
    );

    return {
      status: 200,
      data: {
        ot_id: id,
        numero_bulto: numeroBulto,
        cargado: nuevo,
        piezas_afectadas: filas.length,
        fecha_cargado: nuevo ? ahora : null,
      },
    };
  }, [[db.LOCK_OT, id]]);
}

/**
 * PATCH /api/ot/:id/herrajes/:hid/entrega
 * Body opcional: { entregado_por_panol: true|false }. Sin body, alterna.
 */
async function marcarHerraje({ params, body }) {
  const id = entero(params.id, 'id de la OT');
  const hid = entero(params.hid, 'id del herraje');
  const tieneEstado = body && body.entregado_por_panol !== undefined
    && body.entregado_por_panol !== null;
  const estadoPedido = tieneEstado ? booleano(body.entregado_por_panol) : null;

  return db.transaccion(async () => {
    const fila = await db.get(
      `SELECT id, entregado_por_panol
         FROM ot_herrajes_lista
        WHERE id = ? AND ot_id = ?;`,
      hid, id
    );
    if (!fila) throw new ApiError(404, 'No existe ese herraje en la OT.');

    const nuevo = estadoPedido === null ? !fila.entregado_por_panol : estadoPedido;
    await db.run(
      `UPDATE ot_herrajes_lista
          SET entregado_por_panol = ?
        WHERE id = ? AND ot_id = ?;`,
      nuevo, hid, id
    );

    return {
      status: 200,
      data: { id: hid, ot_id: id, entregado_por_panol: nuevo },
    };
  }, [[db.LOCK_OT, id]]);
}

module.exports = {
  obtener,
  guardar,
  hojaHerrajes,
  alternarBulto,
  marcarHerraje,
  // Exportados para pruebas unitarias de los cálculos puros.
  _resumenPlacas: resumenPlacas,
  _resumenBultos: resumenBultos,
  _TIPOS_PIEZA: TIPOS_PIEZA,
};
