'use client';

import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import Link from 'next/link';

import { Badge } from '@/components/Badge';
import { EmptyState } from '@/components/EmptyState';
import { Panel } from '@/components/Panel';
import { browserApi, isApiError } from '@/lib/api';
import { formatInteger, formatM2, formatNumber, plural } from '@/lib/format';
import type { DespieceOT, DespiecePieza, HerrajeItem } from '@/types/optiflow';

/* ------------------------------------------------------------------ */
/* Catálogos y helpers                                                */
/* ------------------------------------------------------------------ */

/**
 * `tipo_pieza` es una lista cerrada y debe coincidir con TIPOS_PIEZA de
 * `server/routes/despiece.js`. Placa y espesor son sugerencias: la API acepta
 * valores de proveedor que no estén en la lista corta.
 */
const TIPOS_PIEZA = [
  'Lateral',
  'Estante',
  'Piso',
  'Techo',
  'Fondo 18mm',
  'Ajuste',
  'Cierratecho',
  'Zócalo',
  'Pieza Cajonera',
] as const;

const TIPOS_PLACA = [
  'MDF Crudo',
  'Melamina Aglomerado',
  'Melamina MDF',
  'Fondo Fibro',
  'Terciado',
] as const;

const ESPESORES = ['3', '5.5', '9', '12', '15', '18', '22', '25', '30'] as const;

const CAMPO_TABLA =
  'h-9 w-full rounded-md border border-white/10 bg-antracita/70 px-2 text-xs text-white placeholder:text-slate-600 focus:border-cian focus:outline-none focus:ring-2 focus:ring-cian/30 disabled:cursor-not-allowed disabled:opacity-50';
const CAMPO_TABLA_NUM = `${CAMPO_TABLA} text-right font-mono`;
const BOTON_QUITAR =
  'inline-flex h-8 w-8 items-center justify-center rounded-md border border-cocinas/40 bg-cocinas/10 text-xs text-red-200 transition-colors hover:bg-cocinas/20 disabled:cursor-not-allowed disabled:opacity-40';

interface PiezaDraft {
  uid: string;
  tipo_pieza: string;
  nombre_pieza: string;
  cantidad: string;
  ancho_mm: string;
  profundidad_mm: string;
  espesor_mm: string;
  tipo_placa: string;
  color_codigo: string;
  es_laqueado: boolean;
  es_enchapado: boolean;
  filos_cantidad: string;
  filos_detalle: string;
  observacion: string;
  numero_bulto: number;
  cargado_en_flete: boolean;
  fecha_cargado: string | null;
}

interface ModuloDraft {
  uid: string;
  mueble_numero: string;
  modulo_numero: string;
  nombre_modulo: string;
  metros_lineales: string;
  posee_puertas_vidrio_rometal: boolean;
  cantidad_cajoneras: string;
  observaciones: string;
  piezas: PiezaDraft[];
}

interface HerrajeDraft {
  uid: string;
  mueble_numero: string;
  herraje_nombre: string;
  codigo_sku: string;
  cantidad: string;
  observaciones: string;
  entregado_por_panol: boolean;
}

interface FormHerraje {
  mueble_numero: string;
  herraje_nombre: string;
  codigo_sku: string;
  cantidad: string;
  observaciones: string;
}

interface BultoVista {
  numero_bulto: number;
  descripcion: string;
  cantidad_piezas: number;
  cargado_en_flete: boolean;
  m2: number;
  modulos: Set<string>;
}

interface BultoPatch {
  cargado: boolean;
  fecha_cargado: string | null;
}

const FORM_HERRAJE: FormHerraje = {
  mueble_numero: '1',
  herraje_nombre: '',
  codigo_sku: '',
  cantidad: '1',
  observaciones: '',
};

let secuenciaUid = 0;

function nuevoUid(prefijo: string): string {
  secuenciaUid += 1;
  return `${prefijo}-${secuenciaUid}-${Date.now().toString(36)}`;
}

function aNumero(valor: string, porDefecto = 0): number {
  const n = Number(String(valor).replace(',', '.'));
  return Number.isFinite(n) ? n : porDefecto;
}

function aEntero(valor: string, porDefecto = 0): number {
  const n = Math.trunc(aNumero(valor, porDefecto));
  return Number.isFinite(n) ? n : porDefecto;
}

function areaPieza(p: PiezaDraft): number {
  return (aNumero(p.ancho_mm) * aNumero(p.profundidad_mm) * aNumero(p.cantidad)) / 1_000_000;
}

function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function opcionesConValor(lista: readonly string[], valor: string): string[] {
  return lista.includes(valor) ? [...lista] : [...lista, valor];
}

function desdePieza(pieza: DespiecePieza, indice: number): PiezaDraft {
  return {
    uid: `p-${indice}`,
    tipo_pieza: pieza.tipo_pieza,
    nombre_pieza: pieza.nombre_pieza,
    cantidad: String(pieza.cantidad ?? 1),
    ancho_mm: String(pieza.ancho_mm ?? ''),
    profundidad_mm: String(pieza.profundidad_mm ?? ''),
    espesor_mm: String(pieza.espesor_mm ?? ''),
    tipo_placa: pieza.tipo_placa,
    color_codigo: pieza.color_codigo,
    es_laqueado: pieza.es_laqueado,
    es_enchapado: pieza.es_enchapado,
    filos_cantidad: String(pieza.filos_cantidad ?? 0),
    filos_detalle: pieza.filos_detalle ?? '',
    observacion: pieza.observacion ?? '',
    numero_bulto: pieza.numero_bulto,
    cargado_en_flete: pieza.cargado_en_flete,
    fecha_cargado: pieza.fecha_cargado,
  };
}

function desdeModulo(modulo: DespieceOT['modulos'][number], indice: number): ModuloDraft {
  return {
    uid: `m-${indice}`,
    mueble_numero: String(modulo.mueble_numero),
    modulo_numero: String(modulo.modulo_numero),
    nombre_modulo: modulo.nombre_modulo,
    metros_lineales: String(modulo.metros_lineales ?? 0),
    posee_puertas_vidrio_rometal: modulo.posee_puertas_vidrio_rometal,
    cantidad_cajoneras: String(modulo.cantidad_cajoneras ?? 0),
    observaciones: modulo.observaciones ?? '',
    piezas: modulo.piezas.map(desdePieza),
  };
}

function desdeHerraje(herraje: HerrajeItem, indice: number): HerrajeDraft {
  return {
    uid: `h-${indice}`,
    mueble_numero: String(herraje.mueble_numero),
    herraje_nombre: herraje.herraje_nombre,
    codigo_sku: herraje.codigo_sku ?? '',
    cantidad: String(herraje.cantidad),
    observaciones: herraje.observaciones ?? '',
    entregado_por_panol: herraje.entregado_por_panol,
  };
}

function mensajeDeError(error: unknown): string {
  if (isApiError(error)) {
    if (typeof error.detail === 'string' && error.detail.trim()) {
      return `${error.message} ${error.detail}`;
    }
    return error.message;
  }
  return 'No se pudo completar la operación contra el API.';
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] px-4 py-3">
      <p className="label">{label}</p>
      <p className="mt-1 font-mono text-xl font-semibold text-white">{value}</p>
      {hint ? <p className="mt-0.5 text-[11px] text-slate-500">{hint}</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Editor                                                             */
/* ------------------------------------------------------------------ */

export interface DespieceEditorProps {
  data: DespieceOT;
  puedeGestionar: boolean;
}

export function DespieceEditor({ data, puedeGestionar }: DespieceEditorProps) {
  const [modulos, setModulos] = useState<ModuloDraft[]>(() => data.modulos.map(desdeModulo));
  const [herrajes, setHerrajes] = useState<HerrajeDraft[]>(() => data.herrajes.map(desdeHerraje));
  const [sucio, setSucio] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [bultoPendiente, setBultoPendiente] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [busqueda, setBusqueda] = useState('');
  const [formHerraje, setFormHerraje] = useState<FormHerraje>(FORM_HERRAJE);

  const puede = puedeGestionar;

  function tocar() {
    setSucio(true);
    setError(null);
    setAviso(null);
  }

  function cambiarModulo(indice: number, cambios: Partial<ModuloDraft>) {
    setModulos((prev) => prev.map((m, i) => (i === indice ? { ...m, ...cambios } : m)));
    tocar();
  }

  function cambiarPieza(moduloIndice: number, piezaIndice: number, cambios: Partial<PiezaDraft>) {
    setModulos((prev) =>
      prev.map((m, i) =>
        i === moduloIndice
          ? {
              ...m,
              piezas: m.piezas.map((p, j) => (j === piezaIndice ? { ...p, ...cambios } : p)),
            }
          : m,
      ),
    );
    tocar();
  }

  function agregarModulo() {
    const ultimo = modulos[modulos.length - 1];
    const mueble = ultimo ? Math.max(1, aEntero(ultimo.mueble_numero, 1)) : 1;
    const numero = ultimo ? Math.max(1, aEntero(ultimo.modulo_numero, 0) + 1) : 1;

    setModulos((prev) => [
      ...prev,
      {
        uid: nuevoUid('m'),
        mueble_numero: String(mueble),
        modulo_numero: String(numero),
        nombre_modulo: `Módulo ${numero}`,
        metros_lineales: '0',
        posee_puertas_vidrio_rometal: false,
        cantidad_cajoneras: '0',
        observaciones: '',
        piezas: [],
      },
    ]);
    tocar();
  }

  function eliminarModulo(indice: number) {
    const modulo = modulos[indice];
    if (!modulo) return;
    const piezas = modulo.piezas.length;
    if (
      !window.confirm(
        `¿Quitar el módulo "${modulo.nombre_modulo || 'sin nombre'}" y sus ${piezas} ${plural(piezas, 'fila de piezas', 'filas de piezas')}?`,
      )
    ) {
      return;
    }
    setModulos((prev) => prev.filter((_, i) => i !== indice));
    tocar();
  }

  function agregarPieza(moduloIndice: number) {
    setModulos((prev) =>
      prev.map((m, i) =>
        i === moduloIndice
          ? {
              ...m,
              piezas: [
                ...m.piezas,
                {
                  uid: nuevoUid('p'),
                  tipo_pieza: 'Lateral',
                  nombre_pieza: '',
                  cantidad: '1',
                  ancho_mm: '0',
                  profundidad_mm: '0',
                  espesor_mm: '18',
                  tipo_placa: 'Melamina Aglomerado',
                  color_codigo: '',
                  es_laqueado: false,
                  es_enchapado: false,
                  filos_cantidad: '0',
                  filos_detalle: '',
                  observacion: '',
                  numero_bulto: 0,
                  cargado_en_flete: false,
                  fecha_cargado: null,
                },
              ],
            }
          : m,
      ),
    );
    tocar();
  }

  function eliminarPieza(moduloIndice: number, piezaIndice: number) {
    const pieza = modulos[moduloIndice]?.piezas[piezaIndice];
    if (!pieza) return;
    if (!window.confirm(`¿Quitar la pieza "${pieza.nombre_pieza || 'sin nombre'}"?`)) return;

    setModulos((prev) =>
      prev.map((m, i) =>
        i === moduloIndice ? { ...m, piezas: m.piezas.filter((_, j) => j !== piezaIndice) } : m,
      ),
    );
    tocar();
  }

  /* ------------------------------ Derivados ------------------------------ */

  const vistaBultos = useMemo(() => {
    const numeroPorUid = new Map<string, number>();
    const mapa = new Map<number, BultoVista>();
    let secuencial = 1;

    for (const modulo of modulos) {
      for (const pieza of modulo.piezas) {
        const numero = sucio ? secuencial : pieza.numero_bulto || secuencial;
        secuencial += 1;
        numeroPorUid.set(pieza.uid, numero);

        let bulto = mapa.get(numero);
        if (!bulto) {
          bulto = {
            numero_bulto: numero,
            descripcion: '',
            cantidad_piezas: 0,
            cargado_en_flete: true,
            m2: 0,
            modulos: new Set<string>(),
          };
          mapa.set(numero, bulto);
        }

        bulto.cantidad_piezas += aNumero(pieza.cantidad);
        bulto.m2 += areaPieza(pieza);
        bulto.cargado_en_flete = bulto.cargado_en_flete && pieza.cargado_en_flete;
        bulto.modulos.add(
          `M${modulo.mueble_numero} · Mód. ${modulo.modulo_numero}${
            modulo.nombre_modulo ? ` — ${modulo.nombre_modulo}` : ''
          }`,
        );
      }
    }

    const bultos = [...mapa.values()]
      .sort((a, b) => a.numero_bulto - b.numero_bulto)
      .map((b) => ({ ...b, descripcion: [...b.modulos].join(' · ') }));

    return { numeroPorUid, bultos };
  }, [modulos, sucio]);

  const totales = useMemo(() => {
    let filas = 0;
    let unidades = 0;
    let m2 = 0;
    for (const modulo of modulos) {
      for (const pieza of modulo.piezas) {
        filas += 1;
        unidades += aNumero(pieza.cantidad);
        m2 += areaPieza(pieza);
      }
    }
    return { filas, unidades, m2 };
  }, [modulos]);

  const herrajesVisibles = useMemo(() => {
    const q = normalizar(busqueda);
    return herrajes
      .map((herraje, indice) => ({ herraje, indice }))
      .filter(({ herraje }) => {
        if (!q) return true;
        return (
          normalizar(herraje.herraje_nombre).includes(q) ||
          normalizar(herraje.codigo_sku).includes(q) ||
          normalizar(herraje.mueble_numero).includes(q)
        );
      });
  }, [herrajes, busqueda]);

  /* ------------------------------ Acciones ------------------------------- */

  function validar(): string[] {
    const errores: string[] = [];

    modulos.forEach((modulo, mi) => {
      if (!modulo.nombre_modulo.trim()) errores.push(`Módulo #${mi + 1}: falta el nombre.`);

      modulo.piezas.forEach((pieza, pi) => {
        const ref = `Módulo #${mi + 1}, pieza #${pi + 1}`;
        if (!pieza.nombre_pieza.trim()) errores.push(`${ref}: falta el nombre.`);
        if (!(aNumero(pieza.ancho_mm) > 0)) errores.push(`${ref}: ancho inválido.`);
        if (!(aNumero(pieza.profundidad_mm) > 0)) errores.push(`${ref}: profundidad inválida.`);
        if (!(aNumero(pieza.espesor_mm) > 0)) errores.push(`${ref}: espesor inválido.`);
        if (!pieza.tipo_placa.trim()) errores.push(`${ref}: falta el tipo de placa.`);
        if (!pieza.color_codigo.trim()) errores.push(`${ref}: falta color/código.`);
        if (aEntero(pieza.cantidad, 0) < 1) errores.push(`${ref}: cantidad inválida.`);
      });
    });

    herrajes.forEach((herraje, i) => {
      if (!herraje.herraje_nombre.trim()) errores.push(`Herraje #${i + 1}: falta el nombre.`);
      if (aEntero(herraje.cantidad, 0) < 1) errores.push(`Herraje #${i + 1}: cantidad inválida.`);
      if (aEntero(herraje.mueble_numero, 0) < 1) errores.push(`Herraje #${i + 1}: mueble inválido.`);
    });

    return errores;
  }

  async function guardarDespiece() {
    if (!puede || guardando) return;

    const errores = validar();
    if (errores.length) {
      setError(`Revisá el despiece antes de guardar. ${errores.slice(0, 3).join(' ')}`);
      setAviso(null);
      return;
    }

    if (
      modulos.length === 0 &&
      !window.confirm('El despiece quedará vacío (se borran módulos, piezas y bultos). ¿Guardar igual?')
    ) {
      return;
    }

    const payload = {
      modulos: modulos.map((modulo) => ({
        mueble_numero: Math.max(1, aEntero(modulo.mueble_numero, 1)),
        modulo_numero: Math.max(1, aEntero(modulo.modulo_numero, 1)),
        nombre_modulo: modulo.nombre_modulo.trim(),
        metros_lineales: Math.max(0, aNumero(modulo.metros_lineales)),
        posee_puertas_vidrio_rometal: modulo.posee_puertas_vidrio_rometal,
        cantidad_cajoneras: Math.max(0, aEntero(modulo.cantidad_cajoneras)),
        observaciones: modulo.observaciones.trim() || null,
        piezas: modulo.piezas.map((pieza) => ({
          tipo_pieza: pieza.tipo_pieza,
          nombre_pieza: pieza.nombre_pieza.trim(),
          cantidad: Math.max(1, aEntero(pieza.cantidad, 1)),
          ancho_mm: aNumero(pieza.ancho_mm),
          profundidad_mm: aNumero(pieza.profundidad_mm),
          espesor_mm: aNumero(pieza.espesor_mm),
          tipo_placa: pieza.tipo_placa.trim(),
          color_codigo: pieza.color_codigo.trim(),
          es_laqueado: pieza.es_laqueado,
          es_enchapado: pieza.es_enchapado,
          filos_cantidad: Math.max(0, aEntero(pieza.filos_cantidad)),
          filos_detalle: pieza.filos_detalle.trim() || null,
          observacion: pieza.observacion.trim() || null,
        })),
      })),
      herrajes: herrajes.map((herraje) => ({
        mueble_numero: Math.max(1, aEntero(herraje.mueble_numero, 1)),
        herraje_nombre: herraje.herraje_nombre.trim(),
        codigo_sku: herraje.codigo_sku.trim() || null,
        cantidad: Math.max(1, aEntero(herraje.cantidad, 1)),
        entregado_por_panol: herraje.entregado_por_panol,
        observaciones: herraje.observaciones.trim() || null,
      })),
    };

    setGuardando(true);
    setError(null);
    setAviso(null);

    try {
      const respuesta = await browserApi<DespieceOT>(`/api/ot/${data.ot.id}/despiece`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      setModulos(respuesta.modulos.map(desdeModulo));
      setHerrajes(respuesta.herrajes.map(desdeHerraje));
      setSucio(false);
      setAviso(
        `Despiece guardado: ${formatInteger(respuesta.resumen.piezas)} ${plural(
          respuesta.resumen.piezas,
          'pieza',
          'piezas',
        )} en ${formatInteger(respuesta.resumen.bultos)} ${plural(
          respuesta.resumen.bultos,
          'bulto',
          'bultos',
        )}.`,
      );
    } catch (err) {
      setError(mensajeDeError(err));
    } finally {
      setGuardando(false);
    }
  }

  async function alternarBulto(numero: number, cargado: boolean) {
    if (!puede || sucio || bultoPendiente !== null) return;

    setBultoPendiente(numero);
    setError(null);
    setAviso(null);

    try {
      const respuesta = await browserApi<BultoPatch>(
        `/api/ot/${data.ot.id}/despacho/bulto/${numero}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ cargado }),
        },
      );

      setModulos((prev) =>
        prev.map((modulo) => ({
          ...modulo,
          piezas: modulo.piezas.map((pieza) =>
            vistaBultos.numeroPorUid.get(pieza.uid) === numero
              ? {
                  ...pieza,
                  numero_bulto: numero,
                  cargado_en_flete: respuesta.cargado,
                  fecha_cargado: respuesta.fecha_cargado,
                }
              : pieza,
          ),
        })),
      );
      setAviso(`Bulto #${numero} ${respuesta.cargado ? 'marcado como cargado' : 'marcado como pendiente'}.`);
    } catch (err) {
      setError(mensajeDeError(err));
    } finally {
      setBultoPendiente(null);
    }
  }

  function agregarHerraje(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    const nombre = formHerraje.herraje_nombre.trim();
    const cantidad = aEntero(formHerraje.cantidad, 0);
    const mueble = aEntero(formHerraje.mueble_numero, 0);

    if (!nombre) {
      setError('El nombre del herraje es obligatorio.');
      return;
    }
    if (cantidad < 1) {
      setError('La cantidad del herraje debe ser un entero mayor a 0.');
      return;
    }
    if (mueble < 1) {
      setError('El N° de mueble debe ser un entero mayor a 0.');
      return;
    }

    setHerrajes((prev) => [
      ...prev,
      {
        uid: nuevoUid('h'),
        mueble_numero: String(mueble),
        herraje_nombre: nombre,
        codigo_sku: formHerraje.codigo_sku.trim(),
        cantidad: String(cantidad),
        observaciones: formHerraje.observaciones.trim(),
        entregado_por_panol: false,
      },
    ]);
    setFormHerraje(FORM_HERRAJE);
    tocar();
  }

  function eliminarHerraje(indice: number) {
    const herraje = herrajes[indice];
    if (!herraje) return;
    if (!window.confirm(`¿Quitar "${herraje.herraje_nombre}" de la lista?`)) return;
    setHerrajes((prev) => prev.filter((_, i) => i !== indice));
    tocar();
  }

  function alternarEntregaHerraje(indice: number, entregado: boolean) {
    setHerrajes((prev) =>
      prev.map((h, i) => (i === indice ? { ...h, entregado_por_panol: entregado } : h)),
    );
    tocar();
  }

  const urlImpresion = `/imprimir/ot/${data.ot.id}?auto=1`;
  const totalHerrajes = herrajes.reduce((s, h) => s + aEntero(h.cantidad), 0);

  return (
    <div className="space-y-4">
      {/* Barra de acciones */}
      <div className="sticky top-2 z-20 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-grafito/95 px-4 py-3 shadow-panel backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={sucio ? 'warning' : 'success'} dot>
            {sucio ? 'Cambios sin guardar' : 'Guardado'}
          </Badge>
          <span className="text-xs text-slate-400">
            {formatInteger(totales.filas)} {plural(totales.filas, 'fila', 'filas')} ·{' '}
            {formatInteger(totales.unidades)} {plural(totales.unidades, 'pieza', 'piezas')} ·{' '}
            {formatM2(totales.m2)}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link className="btn btn-ghost" href={urlImpresion} target="_blank" rel="noreferrer">
            🖨️ Imprimir Hoja de Ruta y Despiece
          </Link>
          <button
            type="button"
            className="btn btn-primary"
            onClick={guardarDespiece}
            disabled={!puede || guardando}
          >
            {guardando ? 'Guardando…' : 'Guardar despiece'}
          </button>
        </div>
      </div>

      {!puede ? (
        <p className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-xs leading-5 text-amber-100">
          Tu rol permite consultar e imprimir, pero no editar el despiece. Los cambios y el alta de OT
          requieren rol <strong>admin</strong> o <strong>encargado</strong>.
        </p>
      ) : null}

      {sucio ? (
        <p className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-xs leading-5 text-amber-100">
          Guardá el despiece para habilitar el control de bultos y para que la hoja impresa refleje
          estos cambios. La impresión siempre usa la última versión guardada.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="rounded-lg border border-cocinas/40 bg-cocinas/10 px-4 py-3 text-sm text-red-200">
          {error}
        </p>
      ) : null}

      {aviso ? (
        <p role="status" className="rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-200">
          {aviso}
        </p>
      ) : null}

      {/* Métricas en vivo */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Stat label="Módulos" value={formatInteger(modulos.length)} />
        <Stat label="Filas de piezas" value={formatInteger(totales.filas)} />
        <Stat
          label="Piezas"
          value={formatInteger(totales.unidades)}
          hint={(() => {
            const laqueadas = modulos.reduce(
              (s, m) => s + m.piezas.filter((p) => p.es_laqueado).length,
              0,
            );
            return `${formatInteger(laqueadas)} ${plural(laqueadas, 'fila laqueada', 'filas laqueadas')}`;
          })()}
        />
        <Stat label="Bultos" value={formatInteger(vistaBultos.bultos.length)} />
        <Stat label="Superficie" value={formatM2(totales.m2)} />
      </div>

      <nav
        className="scrollbar-thin flex gap-1 overflow-x-auto rounded-lg border border-white/10 bg-antracita/70 p-1.5"
        aria-label="Secciones de Oficina Técnica"
      >
        <a className="focus-ring shrink-0 rounded-md px-3 py-2 text-xs font-medium text-slate-300 hover:bg-white/5" href="#despiece">
          Paso 2 · Despiece y observaciones
        </a>
        <a className="focus-ring shrink-0 rounded-md px-3 py-2 text-xs font-medium text-slate-300 hover:bg-white/5" href="#panol">
          Paso 3 · Herrajes para pañol
        </a>
        <a className="focus-ring shrink-0 rounded-md px-3 py-2 text-xs font-medium text-slate-300 hover:bg-white/5" href="#despacho">
          Paso 4 · Control de bultos
        </a>
        <a className="focus-ring shrink-0 rounded-md px-3 py-2 text-xs font-medium text-cyan-200 hover:bg-white/5" href={urlImpresion} target="_blank" rel="noreferrer">
          🖨️ Hoja A4
        </a>
      </nav>

      {/* Paso 2: despiece */}
      <section id="despiece" className="scroll-mt-24 space-y-4">
        <Panel
          title="Paso 2 · Despiece y observaciones por pieza"
          description="Cargá módulos y piezas. La numeración de bultos es secuencial por OT y la asigna el servidor al guardar."
          actions={
            <button type="button" className="btn btn-ghost" onClick={agregarModulo} disabled={!puede}>
              + Agregar módulo
            </button>
          }
        >
          {modulos.length === 0 ? (
            <EmptyState
              title="Sin despiece cargado"
              description="Agregá el primer módulo para empezar a cargar piezas, medidas, filos y observaciones."
              className="border-0 bg-transparent"
              action={
                puede ? (
                  <button type="button" className="btn btn-primary" onClick={agregarModulo}>
                    + Agregar módulo
                  </button>
                ) : null
              }
            />
          ) : (
            <div className="space-y-4">
              {modulos.map((modulo, mi) => (
                <article key={modulo.uid} className="rounded-xl border border-white/10 bg-antracita/40">
                  <div className="grid gap-3 border-b border-white/10 p-4 sm:grid-cols-2 xl:grid-cols-6">
                    <label className="block">
                      <span className="label">N° mueble</span>
                      <input
                        className={`${CAMPO_TABLA_NUM} mt-1`}
                        type="number"
                        min={1}
                        step={1}
                        value={modulo.mueble_numero}
                        onChange={(e) => cambiarModulo(mi, { mueble_numero: e.target.value })}
                        disabled={!puede}
                        aria-label={`N° de mueble del módulo ${mi + 1}`}
                      />
                    </label>
                    <label className="block">
                      <span className="label">N° módulo</span>
                      <input
                        className={`${CAMPO_TABLA_NUM} mt-1`}
                        type="number"
                        min={1}
                        step={1}
                        value={modulo.modulo_numero}
                        onChange={(e) => cambiarModulo(mi, { modulo_numero: e.target.value })}
                        disabled={!puede}
                        aria-label={`N° de módulo ${mi + 1}`}
                      />
                    </label>
                    <label className="block xl:col-span-2">
                      <span className="label">Nombre del módulo</span>
                      <input
                        className={`${CAMPO_TABLA} mt-1`}
                        value={modulo.nombre_modulo}
                        onChange={(e) => cambiarModulo(mi, { nombre_modulo: e.target.value })}
                        placeholder="Ej. Vestidor Módulo Torre Cajones"
                        maxLength={150}
                        disabled={!puede}
                      />
                    </label>
                    <label className="block">
                      <span className="label">Metros lineales</span>
                      <input
                        className={`${CAMPO_TABLA_NUM} mt-1`}
                        type="number"
                        min={0}
                        step="0.01"
                        value={modulo.metros_lineales}
                        onChange={(e) => cambiarModulo(mi, { metros_lineales: e.target.value })}
                        disabled={!puede}
                      />
                    </label>
                    <label className="block">
                      <span className="label">Cajoneras</span>
                      <input
                        className={`${CAMPO_TABLA_NUM} mt-1`}
                        type="number"
                        min={0}
                        step={1}
                        value={modulo.cantidad_cajoneras}
                        onChange={(e) => cambiarModulo(mi, { cantidad_cajoneras: e.target.value })}
                        disabled={!puede}
                      />
                    </label>
                    <label className="flex items-center gap-2 pt-4 text-xs text-slate-300">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-white/20 bg-antracita text-cian focus:ring-cian/40"
                        checked={modulo.posee_puertas_vidrio_rometal}
                        onChange={(e) =>
                          cambiarModulo(mi, { posee_puertas_vidrio_rometal: e.target.checked })
                        }
                        disabled={!puede}
                      />
                      Puertas de vidrio Rometal
                    </label>
                    <label className="block sm:col-span-2 xl:col-span-5">
                      <span className="label">Observaciones del módulo</span>
                      <input
                        className={`${CAMPO_TABLA} mt-1`}
                        value={modulo.observaciones}
                        onChange={(e) => cambiarModulo(mi, { observaciones: e.target.value })}
                        placeholder="Opcional"
                        maxLength={1000}
                        disabled={!puede}
                      />
                    </label>
                    <div className="flex items-end justify-end">
                      <button
                        type="button"
                        className={BOTON_QUITAR}
                        onClick={() => eliminarModulo(mi)}
                        disabled={!puede}
                        title="Quitar módulo"
                        aria-label={`Quitar módulo ${mi + 1}`}
                      >
                        ✕
                      </button>
                    </div>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="data-table min-w-[1500px]">
                      <caption className="sr-only">
                        Piezas del mueble {modulo.mueble_numero}, módulo {modulo.modulo_numero}
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">Bulto</th>
                          <th scope="col">Tipo</th>
                          <th scope="col">Pieza</th>
                          <th scope="col">Cant.</th>
                          <th scope="col">Ancho mm</th>
                          <th scope="col">Prof. mm</th>
                          <th scope="col">Espesor</th>
                          <th scope="col">Placa</th>
                          <th scope="col">Color / código</th>
                          <th scope="col">Filos</th>
                          <th scope="col">Detalle filos</th>
                          <th scope="col">Laq.</th>
                          <th scope="col">Ench.</th>
                          <th scope="col">Observación</th>
                          <th scope="col">
                            <span className="sr-only">Acciones</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {modulo.piezas.length === 0 ? (
                          <tr>
                            <td colSpan={15} className="px-3 py-6 text-center text-xs text-slate-500">
                              Sin piezas. Usá “+ Agregar pieza” para empezar.
                            </td>
                          </tr>
                        ) : (
                          modulo.piezas.map((pieza, pi) => (
                            <tr key={pieza.uid}>
                              <td className="font-mono text-xs text-cian">
                                #{vistaBultos.numeroPorUid.get(pieza.uid) ?? '—'}
                              </td>
                              <td>
                                <select
                                  className={CAMPO_TABLA}
                                  value={pieza.tipo_pieza}
                                  onChange={(e) =>
                                    cambiarPieza(mi, pi, { tipo_pieza: e.target.value })
                                  }
                                  disabled={!puede}
                                  aria-label={`Tipo de la pieza ${pi + 1}`}
                                >
                                  {opcionesConValor(TIPOS_PIEZA, pieza.tipo_pieza).map((tipo) => (
                                    <option key={tipo} value={tipo}>
                                      {tipo}
                                    </option>
                                  ))}
                                </select>
                              </td>
                              <td>
                                <input
                                  className={CAMPO_TABLA}
                                  value={pieza.nombre_pieza}
                                  onChange={(e) =>
                                    cambiarPieza(mi, pi, { nombre_pieza: e.target.value })
                                  }
                                  placeholder="Lateral izquierdo"
                                  maxLength={100}
                                  disabled={!puede}
                                  aria-label={`Nombre de la pieza ${pi + 1}`}
                                />
                              </td>
                              <td>
                                <input
                                  className={`${CAMPO_TABLA_NUM} w-20`}
                                  type="number"
                                  min={1}
                                  step={1}
                                  value={pieza.cantidad}
                                  onChange={(e) => cambiarPieza(mi, pi, { cantidad: e.target.value })}
                                  disabled={!puede}
                                  aria-label={`Cantidad de la pieza ${pi + 1}`}
                                />
                              </td>
                              <td>
                                <input
                                  className={`${CAMPO_TABLA_NUM} w-24`}
                                  type="number"
                                  min={0}
                                  step="0.1"
                                  value={pieza.ancho_mm}
                                  onChange={(e) => cambiarPieza(mi, pi, { ancho_mm: e.target.value })}
                                  disabled={!puede}
                                  aria-label={`Ancho en milímetros de la pieza ${pi + 1}`}
                                />
                              </td>
                              <td>
                                <input
                                  className={`${CAMPO_TABLA_NUM} w-24`}
                                  type="number"
                                  min={0}
                                  step="0.1"
                                  value={pieza.profundidad_mm}
                                  onChange={(e) =>
                                    cambiarPieza(mi, pi, { profundidad_mm: e.target.value })
                                  }
                                  disabled={!puede}
                                  aria-label={`Profundidad en milímetros de la pieza ${pi + 1}`}
                                />
                              </td>
                              <td>
                                <select
                                  className={`${CAMPO_TABLA_NUM} w-24`}
                                  value={pieza.espesor_mm}
                                  onChange={(e) =>
                                    cambiarPieza(mi, pi, { espesor_mm: e.target.value })
                                  }
                                  disabled={!puede}
                                  aria-label={`Espesor de la pieza ${pi + 1}`}
                                >
                                  {opcionesConValor(ESPESORES, pieza.espesor_mm).map((espesor) => (
                                    <option key={espesor} value={espesor}>
                                      {espesor} mm
                                    </option>
                                  ))}
                                </select>
                              </td>
                              <td>
                                <select
                                  className={CAMPO_TABLA}
                                  value={pieza.tipo_placa}
                                  onChange={(e) =>
                                    cambiarPieza(mi, pi, { tipo_placa: e.target.value })
                                  }
                                  disabled={!puede}
                                  aria-label={`Tipo de placa de la pieza ${pi + 1}`}
                                >
                                  {opcionesConValor(TIPOS_PLACA, pieza.tipo_placa).map((placa) => (
                                    <option key={placa} value={placa}>
                                      {placa}
                                    </option>
                                  ))}
                                </select>
                              </td>
                              <td>
                                <input
                                  className={CAMPO_TABLA}
                                  value={pieza.color_codigo}
                                  onChange={(e) =>
                                    cambiarPieza(mi, pi, { color_codigo: e.target.value })
                                  }
                                  placeholder="Seda Giorno - 402"
                                  maxLength={100}
                                  disabled={!puede}
                                  aria-label={`Color o código de la pieza ${pi + 1}`}
                                />
                              </td>
                              <td>
                                <input
                                  className={`${CAMPO_TABLA_NUM} w-20`}
                                  type="number"
                                  min={0}
                                  step={1}
                                  value={pieza.filos_cantidad}
                                  onChange={(e) =>
                                    cambiarPieza(mi, pi, { filos_cantidad: e.target.value })
                                  }
                                  disabled={!puede}
                                  aria-label={`Cantidad de filos de la pieza ${pi + 1}`}
                                />
                              </td>
                              <td>
                                <input
                                  className={`${CAMPO_TABLA} min-w-[160px]`}
                                  value={pieza.filos_detalle}
                                  onChange={(e) =>
                                    cambiarPieza(mi, pi, { filos_detalle: e.target.value })
                                  }
                                  placeholder="ABS 1mm en 2 largos"
                                  maxLength={100}
                                  disabled={!puede}
                                  aria-label={`Detalle de filos de la pieza ${pi + 1}`}
                                />
                              </td>
                              <td className="text-center">
                                <input
                                  type="checkbox"
                                  className="h-4 w-4 rounded border-white/20 bg-antracita text-cian focus:ring-cian/40"
                                  checked={pieza.es_laqueado}
                                  onChange={(e) =>
                                    cambiarPieza(mi, pi, { es_laqueado: e.target.checked })
                                  }
                                  disabled={!puede}
                                  aria-label={`Laqueado de la pieza ${pi + 1}`}
                                />
                              </td>
                              <td className="text-center">
                                <input
                                  type="checkbox"
                                  className="h-4 w-4 rounded border-white/20 bg-antracita text-cian focus:ring-cian/40"
                                  checked={pieza.es_enchapado}
                                  onChange={(e) =>
                                    cambiarPieza(mi, pi, { es_enchapado: e.target.checked })
                                  }
                                  disabled={!puede}
                                  aria-label={`Enchapado de la pieza ${pi + 1}`}
                                />
                              </td>
                              <td>
                                <input
                                  className={`${CAMPO_TABLA} min-w-[190px]`}
                                  value={pieza.observacion}
                                  onChange={(e) =>
                                    cambiarPieza(mi, pi, { observacion: e.target.value })
                                  }
                                  placeholder="Con Led / Veta horizontal"
                                  maxLength={500}
                                  disabled={!puede}
                                  aria-label={`Observación de la pieza ${pi + 1}`}
                                />
                              </td>
                              <td>
                                <button
                                  type="button"
                                  className={BOTON_QUITAR}
                                  onClick={() => eliminarPieza(mi, pi)}
                                  disabled={!puede}
                                  title="Quitar pieza"
                                  aria-label={`Quitar pieza ${pi + 1}`}
                                >
                                  ✕
                                </button>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/10 px-4 py-3">
                    <button
                      type="button"
                      className="btn btn-ghost min-h-9 px-3 text-xs"
                      onClick={() => agregarPieza(mi)}
                      disabled={!puede}
                    >
                      + Agregar pieza
                    </button>
                    <span className="text-[11px] text-slate-500">
                      {formatInteger(modulo.piezas.length)}{' '}
                      {plural(modulo.piezas.length, 'fila', 'filas')} ·{' '}
                      {formatInteger(modulo.piezas.reduce((s, p) => s + aNumero(p.cantidad), 0))}{' '}
                      {plural(
                        modulo.piezas.reduce((s, p) => s + aNumero(p.cantidad), 0),
                        'unidad',
                        'unidades',
                      )}
                    </span>
                  </div>
                </article>
              ))}
            </div>
          )}
        </Panel>
      </section>

      {/* Paso 3: pañol */}
      <section id="panol" className="scroll-mt-24">
        <Panel
          title="Paso 3 · 🛠️ Lista de Herrajes Requeridos para Pañol"
          description="Cargá SKU, nombre y cantidad. El pañol usa esta lista para preparar y entregar los herrajes."
          actions={
            <Badge tone="cian">
              {formatInteger(herrajes.length)} {plural(herrajes.length, 'ítem', 'ítems')} ·{' '}
              {formatInteger(totalHerrajes)} u.
            </Badge>
          }
        >
          {puede ? (
            <form onSubmit={agregarHerraje} className="mb-4 rounded-lg border border-white/10 bg-antracita/40 p-4">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
                <label className="block">
                  <span className="label">N° mueble</span>
                  <input
                    className={`${CAMPO_TABLA_NUM} mt-1`}
                    type="number"
                    min={1}
                    step={1}
                    value={formHerraje.mueble_numero}
                    onChange={(e) =>
                      setFormHerraje((prev) => ({ ...prev, mueble_numero: e.target.value }))
                    }
                  />
                </label>
                <label className="block xl:col-span-2">
                  <span className="label">Herraje *</span>
                  <input
                    className={`${CAMPO_TABLA} mt-1`}
                    value={formHerraje.herraje_nombre}
                    onChange={(e) =>
                      setFormHerraje((prev) => ({ ...prev, herraje_nombre: e.target.value }))
                    }
                    placeholder="Bisagra cazoleta 35mm"
                    maxLength={150}
                  />
                </label>
                <label className="block">
                  <span className="label">Código SKU</span>
                  <input
                    className={`${CAMPO_TABLA} mt-1 font-mono uppercase`}
                    value={formHerraje.codigo_sku}
                    onChange={(e) =>
                      setFormHerraje((prev) => ({ ...prev, codigo_sku: e.target.value }))
                    }
                    placeholder="BIS-35-BL"
                    maxLength={50}
                  />
                </label>
                <label className="block">
                  <span className="label">Cantidad *</span>
                  <input
                    className={`${CAMPO_TABLA_NUM} mt-1`}
                    type="number"
                    min={1}
                    step={1}
                    value={formHerraje.cantidad}
                    onChange={(e) => setFormHerraje((prev) => ({ ...prev, cantidad: e.target.value }))}
                  />
                </label>
                <div className="flex items-end">
                  <button type="submit" className="btn btn-primary min-h-9 w-full px-3 text-xs">
                    + Agregar herraje
                  </button>
                </div>
                <label className="block sm:col-span-2 xl:col-span-5">
                  <span className="label">Observaciones</span>
                  <input
                    className={`${CAMPO_TABLA} mt-1`}
                    value={formHerraje.observaciones}
                    onChange={(e) =>
                      setFormHerraje((prev) => ({ ...prev, observaciones: e.target.value }))
                    }
                    placeholder="Opcional"
                    maxLength={500}
                  />
                </label>
              </div>
            </form>
          ) : null}

          <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <label className="block w-full sm:max-w-md">
              <span className="label">Buscar herraje</span>
              <input
                className={`${CAMPO_TABLA} mt-1`}
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                placeholder="Buscar por SKU, nombre o mueble…"
                type="search"
              />
            </label>
            <p className="text-[11px] text-slate-500">
              {formatInteger(herrajesVisibles.length)} de {formatInteger(herrajes.length)} ítem(s)
            </p>
          </div>

          {herrajes.length === 0 ? (
            <EmptyState
              title="Sin herrajes cargados"
              description="Agregá los herrajes que el pañol debe preparar para esta OT."
              className="border-0 bg-transparent"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table min-w-[900px]">
                <caption className="sr-only">Lista de herrajes requeridos para el pañol</caption>
                <thead>
                  <tr>
                    <th scope="col">Mueble</th>
                    <th scope="col">Herraje</th>
                    <th scope="col">SKU</th>
                    <th scope="col">Cantidad</th>
                    <th scope="col">Entregado por pañol</th>
                    <th scope="col">Observaciones</th>
                    <th scope="col">
                      <span className="sr-only">Acciones</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {herrajesVisibles.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-3 py-6 text-center text-xs text-slate-500">
                        Ningún herraje coincide con “{busqueda}”.
                      </td>
                    </tr>
                  ) : (
                    herrajesVisibles.map(({ herraje, indice }) => (
                      <tr key={herraje.uid}>
                        <td>
                          <input
                            className={`${CAMPO_TABLA_NUM} w-20`}
                            type="number"
                            min={1}
                            step={1}
                            value={herraje.mueble_numero}
                            onChange={(e) =>
                              setHerrajes((prev) =>
                                prev.map((h, i) =>
                                  i === indice ? { ...h, mueble_numero: e.target.value } : h,
                                ),
                              )
                            }
                            disabled={!puede}
                            aria-label={`Mueble del herraje ${indice + 1}`}
                          />
                        </td>
                        <td>
                          <input
                            className={CAMPO_TABLA}
                            value={herraje.herraje_nombre}
                            onChange={(e) =>
                              setHerrajes((prev) =>
                                prev.map((h, i) =>
                                  i === indice ? { ...h, herraje_nombre: e.target.value } : h,
                                ),
                              )
                            }
                            maxLength={150}
                            disabled={!puede}
                            aria-label={`Nombre del herraje ${indice + 1}`}
                          />
                        </td>
                        <td>
                          <input
                            className={`${CAMPO_TABLA} font-mono uppercase`}
                            value={herraje.codigo_sku}
                            onChange={(e) =>
                              setHerrajes((prev) =>
                                prev.map((h, i) =>
                                  i === indice ? { ...h, codigo_sku: e.target.value } : h,
                                ),
                              )
                            }
                            maxLength={50}
                            disabled={!puede}
                            aria-label={`SKU del herraje ${indice + 1}`}
                          />
                        </td>
                        <td>
                          <input
                            className={`${CAMPO_TABLA_NUM} w-24`}
                            type="number"
                            min={1}
                            step={1}
                            value={herraje.cantidad}
                            onChange={(e) =>
                              setHerrajes((prev) =>
                                prev.map((h, i) =>
                                  i === indice ? { ...h, cantidad: e.target.value } : h,
                                ),
                              )
                            }
                            disabled={!puede}
                            aria-label={`Cantidad del herraje ${indice + 1}`}
                          />
                        </td>
                        <td className="text-center">
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-white/20 bg-antracita text-cian focus:ring-cian/40"
                            checked={herraje.entregado_por_panol}
                            onChange={(e) => alternarEntregaHerraje(indice, e.target.checked)}
                            disabled={!puede}
                            aria-label={`Entregado por pañol: ${herraje.herraje_nombre}`}
                          />
                        </td>
                        <td>
                          <input
                            className={CAMPO_TABLA}
                            value={herraje.observaciones}
                            onChange={(e) =>
                              setHerrajes((prev) =>
                                prev.map((h, i) =>
                                  i === indice ? { ...h, observaciones: e.target.value } : h,
                                ),
                              )
                            }
                            maxLength={500}
                            disabled={!puede}
                            aria-label={`Observaciones del herraje ${indice + 1}`}
                          />
                        </td>
                        <td>
                          <button
                            type="button"
                            className={BOTON_QUITAR}
                            onClick={() => eliminarHerraje(indice)}
                            disabled={!puede}
                            title="Quitar herraje"
                            aria-label={`Quitar herraje ${indice + 1}`}
                          >
                            ✕
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}

          {sucio ? (
            <p className="mt-3 text-[11px] text-slate-500">
              Los cambios de la lista del pañol se persisten al guardar el despiece.
            </p>
          ) : null}
        </Panel>
      </section>

      {/* Paso 4: despacho */}
      <section id="despacho" className="scroll-mt-24">
        <Panel
          title="Paso 4 · 📦 Control de Bultos para Despacho"
          description="La numeración es secuencial por OT. Logística marca cada bulto al cargarlo en el camión."
          actions={<Badge tone={sucio ? 'warning' : 'success'}>{formatInteger(vistaBultos.bultos.length)} bulto(s)</Badge>}
        >
          {vistaBultos.bultos.length === 0 ? (
            <EmptyState
              title="Sin bultos"
              description="Los bultos se generan a partir de las piezas cargadas. Agregá piezas y guardá el despiece."
              className="border-0 bg-transparent"
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {vistaBultos.bultos.map((bulto) => (
                <label
                  key={bulto.numero_bulto}
                  className={`flex cursor-pointer items-start gap-3 rounded-lg border px-4 py-3 transition-colors ${
                    bulto.cargado_en_flete
                      ? 'border-emerald-400/30 bg-emerald-400/10'
                      : 'border-white/10 bg-white/[0.03]'
                  } ${sucio || !puede || bultoPendiente !== null ? 'cursor-not-allowed opacity-80' : 'hover:bg-white/[0.06]'}`}
                >
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 rounded border-white/20 bg-antracita text-cian focus:ring-cian/40"
                    checked={bulto.cargado_en_flete}
                    onChange={(e) => alternarBulto(bulto.numero_bulto, e.target.checked)}
                    disabled={!puede || sucio || bultoPendiente !== null}
                    aria-label={`Bulto ${bulto.numero_bulto} cargado en flete`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center justify-between gap-2">
                      <strong className="font-mono text-sm text-white">Bulto #{bulto.numero_bulto}</strong>
                      <Badge tone={bulto.cargado_en_flete ? 'success' : 'neutral'}>
                        {bultoPendiente === bulto.numero_bulto
                          ? 'Guardando…'
                          : bulto.cargado_en_flete
                            ? 'Cargado'
                            : 'Pendiente'}
                      </Badge>
                    </span>
                    <span className="mt-1 block text-xs text-slate-400">{bulto.descripcion || '—'}</span>
                    <span className="mt-1 block font-mono text-[11px] text-slate-500">
                      {formatInteger(bulto.cantidad_piezas)}{' '}
                      {plural(bulto.cantidad_piezas, 'pieza', 'piezas')} · {formatM2(bulto.m2)}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4">
            <p className="text-[11px] leading-5 text-slate-500">
              {sucio
                ? 'Guardá el despiece para habilitar el control de bultos: la numeración definitiva la asigna el servidor.'
                : 'El estado de carga se guarda al instante contra el API de despacho.'}
            </p>
            <Link className="btn btn-ghost" href={urlImpresion} target="_blank" rel="noreferrer">
              🖨️ Imprimir Hoja de Ruta y Despiece
            </Link>
          </div>
        </Panel>
      </section>
    </div>
  );
}
