'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useRouter } from 'next/navigation';

import { Badge } from '@/components/Badge';
import { Panel } from '@/components/Panel';
import { browserApi, isApiError } from '@/lib/api';
import type { CrearOTPayload, LineaOT, OrdenTrabajo } from '@/types/optiflow';

interface FormOT {
  numero_ot: string;
  cliente: string;
  modelo: string;
  linea_area: LineaOT;
  metros_lineales: string;
  fecha_prometida: string;
  requiere_vidrio: boolean;
  requiere_lustre: boolean;
  requiere_herreria: boolean;
  requiere_especiales: boolean;
}

const FORM_INICIAL: FormOT = {
  numero_ot: '',
  cliente: '',
  modelo: '',
  linea_area: 'Placares',
  metros_lineales: '',
  fecha_prometida: '',
  requiere_vidrio: false,
  requiere_lustre: false,
  requiere_herreria: false,
  requiere_especiales: false,
};

function mensajeDeError(error: unknown): string {
  if (isApiError(error)) {
    const detalle = error.detail;
    if (typeof detalle === 'string' && detalle.trim()) return `${error.message} ${detalle}`;
    return error.message;
  }
  return 'No se pudo crear la OT. Revisá la conexión con el API.';
}

/**
 * Paso 1 del flujo de Oficina Técnica: alta de la OT.
 *
 * La creación sigue ocurriendo en el API Node/PostgreSQL (`POST /api/ordenes`),
 * que valida número único, línea y metros lineales. Al crearla, la página
 * navega a `?ot=<id>` para cargar el despiece en el Paso 2.
 */
export function NuevaOTForm({ abrir }: { abrir: boolean }) {
  const router = useRouter();
  const [form, setForm] = useState<FormOT>(FORM_INICIAL);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function cambiar(cambios: Partial<FormOT>) {
    setForm((prev) => ({ ...prev, ...cambios }));
    setError(null);
  }

  function cambiarCheck(
    campo: 'requiere_vidrio' | 'requiere_lustre' | 'requiere_herreria' | 'requiere_especiales',
    valor: boolean,
  ) {
    setForm((prev) => ({ ...prev, [campo]: valor }));
    setError(null);
  }

  async function crear(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    const numeroOT = form.numero_ot.trim().toUpperCase();
    const cliente = form.cliente.trim();
    const metros = Number(form.metros_lineales.replace(',', '.'));

    if (!numeroOT) {
      setError('El número de OT es obligatorio.');
      return;
    }
    if (!cliente) {
      setError('El cliente es obligatorio.');
      return;
    }
    if (!Number.isFinite(metros) || metros < 0) {
      setError('Los metros lineales deben ser un número mayor o igual a 0.');
      return;
    }

    const payload: CrearOTPayload = {
      numero_ot: numeroOT,
      cliente,
      modelo: form.modelo.trim() || null,
      linea_area: form.linea_area,
      metros_lineales: metros,
      fecha_prometida: form.fecha_prometida || null,
      requiere_vidrio: form.requiere_vidrio,
      requiere_lustre: form.requiere_lustre,
      requiere_herreria: form.requiere_herreria,
      requiere_especiales: form.requiere_especiales,
    };

    setBusy(true);
    setError(null);
    try {
      const ot = await browserApi<OrdenTrabajo>('/api/ordenes', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setForm(FORM_INICIAL);
      router.push(`/admin/oficina-tecnica/despiece?ot=${ot.id}`);
    } catch (err) {
      setError(mensajeDeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Paso 1 · Crear orden de trabajo"
      description="El alta de la OT abre el flujo: después cargás el despiece, la lista del pañol y el control de despacho."
      actions={<Badge tone="cian">Inicio del flujo</Badge>}
    >
      <details open={abrir} className="group">
        <summary className="focus-ring flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.03] px-4 py-3 text-sm font-medium text-slate-200 hover:bg-white/[0.06]">
          <span>Datos de la nueva OT</span>
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-500 group-open:hidden">
            Abrir
          </span>
          <span className="hidden font-mono text-[10px] uppercase tracking-[0.16em] text-slate-500 group-open:inline">
            Cerrar
          </span>
        </summary>

        <form onSubmit={crear} className="mt-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="block">
              <span className="label">N° de OT *</span>
              <input
                className="input mt-1.5 font-mono uppercase"
                value={form.numero_ot}
                onChange={(e) => cambiar({ numero_ot: e.target.value })}
                placeholder="OT-2026-001"
                maxLength={40}
                required
                autoComplete="off"
              />
            </label>

            <label className="block">
              <span className="label">Cliente *</span>
              <input
                className="input mt-1.5"
                value={form.cliente}
                onChange={(e) => cambiar({ cliente: e.target.value })}
                placeholder="Nombre del cliente"
                maxLength={120}
                required
                autoComplete="off"
              />
            </label>

            <label className="block">
              <span className="label">Modelo</span>
              <input
                className="input mt-1.5"
                value={form.modelo}
                onChange={(e) => cambiar({ modelo: e.target.value })}
                placeholder="Ej. Vestidor Giorno"
                maxLength={80}
                autoComplete="off"
              />
            </label>

            <label className="block">
              <span className="label">Línea / área *</span>
              <select
                className="select mt-1.5"
                value={form.linea_area}
                onChange={(e) => cambiar({ linea_area: e.target.value as LineaOT })}
              >
                <option value="Placares">Placares</option>
                <option value="Cocinas">Cocinas</option>
              </select>
            </label>

            <label className="block">
              <span className="label">Metros lineales *</span>
              <input
                className="input mt-1.5 font-mono"
                type="number"
                min={0}
                step="0.01"
                value={form.metros_lineales}
                onChange={(e) => cambiar({ metros_lineales: e.target.value })}
                placeholder="0,00"
                required
              />
            </label>

            <label className="block">
              <span className="label">Fecha prometida</span>
              <input
                className="input mt-1.5 font-mono"
                type="date"
                value={form.fecha_prometida}
                onChange={(e) => cambiar({ fecha_prometida: e.target.value })}
              />
            </label>
          </div>

          <fieldset className="flex flex-wrap gap-x-5 gap-y-2 rounded-lg border border-white/10 bg-antracita/40 px-4 py-3">
            <legend className="sr-only">Requerimientos especiales</legend>
            {(
              [
                ['requiere_vidrio', 'Vidrio'],
                ['requiere_lustre', 'Lustre'],
                ['requiere_herreria', 'Herrajes'],
                ['requiere_especiales', 'Especiales'],
              ] as const
            ).map(([campo, etiqueta]) => (
              <label key={campo} className="flex items-center gap-2 text-sm text-slate-300">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-white/20 bg-antracita text-cian focus:ring-cian/40"
                  checked={form[campo]}
                  onChange={(e) => cambiarCheck(campo, e.target.checked)}
                />
                {etiqueta}
              </label>
            ))}
          </fieldset>

          {error ? (
            <p role="alert" className="rounded-lg border border-cocinas/40 bg-cocinas/10 px-4 py-3 text-sm text-red-200">
              {error}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-slate-500">
              El número de OT lo valida el API: si ya existe, la operación se rechaza con el detalle.
            </p>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Creando OT…' : 'Crear OT y cargar despiece'}
            </button>
          </div>
        </form>
      </details>
    </Panel>
  );
}
