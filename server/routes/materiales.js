'use strict';

/**
 * Catálogo DINÁMICO de materiales / placas (Fase: Dashboard Integrado).
 *
 *   GET /api/materiales/catalogo?espesor=18&familia=Melamina&buscar=blanca
 *
 * No existe un maestro de materiales: las placas se declaran por OT en
 * `ot_materiales`. Este endpoint reconstruye el catálogo agregando esas
 * líneas para obtener, por MATERIAL:
 *   · familias de placa (Melamina / MDF / Fibroplus / Otro)
 *   · espesor derivado del nombre (no hay columna: se infiere)
 *   · placas requeridas y consumidas acumuladas
 *   · cantidad de OTs que lo usan
 *
 * REGLAS:
 *  M1. El espesor se DERIVA del nombre con regex (`18mm`, `18 mm`, `18 Mm`).
 *      Si no hay número claro, queda `null` (la UI lo muestra como "n/d").
 *  M2. La familia se clasifica por palabras clave del nombre; lo no
 *      reconocido cae en "Otro" para no perder material del inventario.
 *  M3. El agregado es de sólo lectura: la gestión de cantidades sigue en
 *      el detalle de cada OT (PUT /api/ordenes/:id/materiales).
 */

const db = require('../db');

/** Extrae el espesor en mm del nombre del material (regla M1). */
function espesorDeNombre(nombre) {
  const t = String(nombre || '');
  // 18mm | 18 mm | 18Mm | 18 mm. | (18) — toma el primer número con unidad o paréntesis.
  const m = t.match(/(\d{1,3}(?:[.,]\d)?)\s*(?:mm\b|m\b)|\((\d{1,3}(?:[.,]\d)?)\s*mm?\)/i);
  const bruto = m ? (m[1] || m[2]) : null;
  if (bruto === null) return null;
  const v = Number(String(bruto).replace(',', '.'));
  return Number.isFinite(v) && v > 0 && v <= 100 ? Math.round(v * 10) / 10 : null;
}

/** Clasifica la familia de placa por palabras clave (regla M2). */
function familiaDeNombre(nombre) {
  const t = String(nombre || '').toLowerCase();
  if (t.includes('melamina')) return 'Melamina';
  if (/\bmdf\b/.test(t)) return 'MDF';
  if (t.includes('fibroplus') || t.includes('fibro')) return 'Fibroplus';
  return 'Otro';
}

/** Redondea a 2 decimales de forma consistente con el resto de la API. */
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;

/**
 * GET /api/materiales/catalogo
 * Devuelve el catálogo agregado + los filtros ya aplicados.
 */
async function catalogo({ query }) {
  const filas = await db.all(`
    SELECT m.material_nombre,
           SUM(m.cantidad_placas)     AS requeridas,
           SUM(m.cantidad_consumida)  AS consumidas,
           COUNT(DISTINCT m.ot_id)    AS ots,
           MAX(o.fecha_creacion)      AS ultima_fecha
      FROM ot_materiales m
      JOIN ordenes_trabajo o ON o.id = m.ot_id
     GROUP BY m.material_nombre
     ORDER BY SUM(m.cantidad_placas) DESC, m.material_nombre ASC;`);

  let catalogo_ = filas.map((f) => {
    const requeridas = r2(f.requeridas);
    const consumidas = r2(f.consumidas);
    const pct = requeridas > 0 ? Math.round((consumidas / requeridas) * 1000) / 10 : 0;
    return {
      material_nombre: f.material_nombre,
      familia: familiaDeNombre(f.material_nombre),
      espesor_mm: espesorDeNombre(f.material_nombre),
      placas_requeridas: requeridas,
      placas_consumidas: consumidas,
      placas_restantes: Math.max(0, r2(requeridas - consumidas)),
      pct_consumo: pct,
      ots_usan: Number(f.ots || 0),
      ultima_fecha: f.ultima_fecha || null,
    };
  });

  // Filtros (aplicados en memoria: el volumen es el catálogo, no los registros).
  if (query.espesor) {
    const v = Number(String(query.espesor).replace(',', '.'));
    if (Number.isFinite(v)) {
      catalogo_ = catalogo_.filter((m) => m.espesor_mm !== null && Math.abs(m.espesor_mm - v) < 0.05);
    }
  }
  if (query.familia) {
    const fam = String(query.familia).toLowerCase();
    catalogo_ = catalogo_.filter((m) => m.familia.toLowerCase() === fam);
  }
  if (query.buscar) {
    const q = String(query.buscar).toLowerCase();
    catalogo_ = catalogo_.filter((m) => m.material_nombre.toLowerCase().includes(q));
  }

  // Espesores disponibles (para poblar el desplegable sin segundo request).
  const espesores = [...new Set(filas.map((f) => espesorDeNombre(f.material_nombre)).filter((v) => v !== null))]
    .sort((a, b) => a - b);

  // Resumen por familia (tarjetas del panel).
  const porFamilia = {};
  for (const m of filas) {
    const fam = familiaDeNombre(m.material_nombre);
    if (!porFamilia[fam]) porFamilia[fam] = { familia: fam, materiales: 0, requeridas: 0, consumidas: 0 };
    porFamilia[fam].materiales += 1;
    porFamilia[fam].requeridas = r2(porFamilia[fam].requeridas + Number(m.requeridas));
    porFamilia[fam].consumidas = r2(porFamilia[fam].consumidas + Number(m.consumidas));
  }

  return {
    status: 200,
    data: {
      total: catalogo_.length,
      espesores_disponibles: espesores,
      resumen_familias: Object.values(porFamilia).sort((a, b) => b.requeridas - a.requeridas),
      catalogo: catalogo_,
      nota: 'El espesor se deriva del nombre del material; la gestión de cantidades es por OT.',
    },
  };
}

module.exports = { catalogo, espesorDeNombre, familiaDeNombre };
