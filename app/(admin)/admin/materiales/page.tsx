import type { Metadata } from 'next';
import Link from 'next/link';

import { AuthRequiredPanel, ApiErrorPanel, EmptyState } from '@/components/EmptyState';
import { MaterialsIcon } from '@/components/icons';
import { KpiCard } from '@/components/KpiCard';
import { PageHeader } from '@/components/PageHeader';
import { Panel } from '@/components/Panel';
import { ProgressBar, type ProgressTone } from '@/components/ProgressBar';
import { formatDate, formatInteger, formatNumber, formatPercent, plural } from '@/lib/format';
import { isAuthError, safeServerFetch } from '@/lib/api-server';
import type { MaterialCatalogoResponse } from '@/types/optiflow';

export const metadata: Metadata = { title: 'Materiales' };
export const dynamic = 'force-dynamic';

interface MaterialesPageProps {
  searchParams: Promise<{
    espesor?: string;
    familia?: string;
    buscar?: string;
  }>;
}

function consumptionTone(pct: number): ProgressTone {
  if (pct >= 90) return 'danger';
  if (pct >= 60) return 'warning';
  return 'cian';
}

export default async function MaterialesPage({ searchParams }: MaterialesPageProps) {
  const params = await searchParams;

  const query = new URLSearchParams();
  if (params.espesor) query.set('espesor', params.espesor);
  if (params.familia) query.set('familia', params.familia);
  if (params.buscar) query.set('buscar', params.buscar);

  const queryString = query.toString();
  const result = await safeServerFetch<MaterialCatalogoResponse>(
    `/api/materiales/catalogo${queryString ? `?${queryString}` : ''}`,
  );

  const header = (
    <PageHeader
      eyebrow="Maestros · Materiales"
      title="Catálogo de placas"
      description="Materiales reconstruidos desde las OT: familia, espesor, color y consumo de placas. El catálogo no es un maestro independiente; se deriva de `ot_materiales`."
      actions={
        <Link className="btn btn-ghost" href="/admin/dashboard">
          Volver al dashboard
        </Link>
      }
    />
  );

  if (!result.ok && isAuthError(result)) {
    return (
      <>
        {header}
        <AuthRequiredPanel />
      </>
    );
  }

  if (!result.ok) {
    return (
      <>
        {header}
        <ApiErrorPanel message={result.error} status={result.status} />
      </>
    );
  }

  const { catalogo, espesores_disponibles: espesores, resumen_familias: familias, total, nota } = result.data;
  const requeridas = catalogo.reduce((sum, item) => sum + item.placas_requeridas, 0);
  const consumidas = catalogo.reduce((sum, item) => sum + item.placas_consumidas, 0);
  const restantes = catalogo.reduce((sum, item) => sum + item.placas_restantes, 0);
  const hayFiltros = Boolean(params.espesor || params.familia || params.buscar);

  return (
    <>
      {header}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Materiales"
          value={formatInteger(total)}
          hint={hayFiltros ? 'Resultado con filtros' : 'Materiales distintos en el catálogo'}
          tone="neutral"
          icon={<MaterialsIcon className="h-5 w-5" />}
        />
        <KpiCard label="Placas requeridas" value={formatNumber(requeridas, 2)} hint="Suma de cantidades pedidas" tone="placares" />
        <KpiCard label="Placas consumidas" value={formatNumber(consumidas, 2)} hint="Consumo registrado por OT" tone="cian" />
        <KpiCard label="Placas restantes" value={formatNumber(restantes, 2)} hint="Diferencia requerida - consumida" tone={restantes > 0 ? 'warning' : 'neutral'} />
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {familias.map((familia) => {
          const pct = familia.requeridas > 0 ? (familia.consumidas / familia.requeridas) * 100 : 0;
          return (
            <div key={familia.familia} className="panel p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-white">{familia.familia}</p>
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
                  {formatInteger(familia.materiales)} mat.
                </span>
              </div>
              <p className="mt-2 font-mono text-sm text-slate-300">
                {formatNumber(familia.consumidas, 2)} / {formatNumber(familia.requeridas, 2)} placas
              </p>
              <ProgressBar value={pct} tone={consumptionTone(pct)} className="mt-2" />
            </div>
          );
        })}
      </div>

      <Panel
        title="Filtros del catálogo"
        description="El espesor se deriva del nombre del material; la búsqueda no distingue mayúsculas."
        className="mt-4"
      >
        <form method="get" className="grid gap-3 md:grid-cols-[1fr_1fr_1.4fr_auto]">
          <label className="block">
            <span className="label">Espesor</span>
            <select name="espesor" defaultValue={params.espesor ?? ''} className="select mt-1.5">
              <option value="">Todos los espesores</option>
              {espesores.map((espesor) => (
                <option key={espesor} value={espesor}>
                  {formatNumber(espesor, 2)} mm
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="label">Familia</span>
            <select name="familia" defaultValue={params.familia ?? ''} className="select mt-1.5">
              <option value="">Todas las familias</option>
              {familias.map((familia) => (
                <option key={familia.familia} value={familia.familia}>
                  {familia.familia}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="label">Buscar material</span>
            <input
              type="search"
              name="buscar"
              defaultValue={params.buscar ?? ''}
              placeholder="Ej. Melamina blanca"
              className="input mt-1.5"
            />
          </label>

          <div className="flex items-end gap-2">
            <button type="submit" className="btn btn-primary">
              Filtrar
            </button>
            <Link className="btn btn-ghost" href="/admin/materiales">
              Limpiar
            </Link>
          </div>
        </form>
      </Panel>

      <Panel
        title="Catálogo de placas"
        description={`${formatInteger(catalogo.length)} ${plural(catalogo.length, 'material en la vista', 'materiales en la vista')}`}
        className="mt-4"
        bodyClassName="p-0"
      >
        {catalogo.length === 0 ? (
          <EmptyState
            title="No hay materiales para mostrar"
            description={
              hayFiltros
                ? 'Ningún material coincide con los filtros. Probá limpiando los filtros.'
                : 'Todavía no hay materiales asociados a órdenes de trabajo.'
            }
            className="border-0 bg-transparent"
            action={
              hayFiltros ? (
                <Link className="btn btn-ghost" href="/admin/materiales">
                  Limpiar filtros
                </Link>
              ) : null
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table min-w-[1040px]">
              <caption className="sr-only">Catálogo de placas y consumo</caption>
              <thead>
                <tr>
                  <th scope="col">Material</th>
                  <th scope="col">Familia</th>
                  <th scope="col">Espesor</th>
                  <th scope="col">Requeridas</th>
                  <th scope="col">Consumidas</th>
                  <th scope="col">Restantes</th>
                  <th scope="col">Consumo</th>
                  <th scope="col">OTs</th>
                  <th scope="col">Última fecha</th>
                </tr>
              </thead>
              <tbody>
                {catalogo.map((item) => (
                  <tr key={item.material_nombre}>
                    <td className="max-w-[280px]">
                      <p className="truncate text-sm text-white" title={item.material_nombre}>
                        {item.material_nombre}
                      </p>
                    </td>
                    <td className="text-sm text-slate-300">{item.familia}</td>
                    <td className="font-mono text-sm text-slate-300">
                      {item.espesor_mm === null ? '—' : `${formatNumber(item.espesor_mm, 2)} mm`}
                    </td>
                    <td className="font-mono text-sm text-slate-300">{formatNumber(item.placas_requeridas, 2)}</td>
                    <td className="font-mono text-sm text-slate-300">{formatNumber(item.placas_consumidas, 2)}</td>
                    <td className="font-mono text-sm text-slate-300">{formatNumber(item.placas_restantes, 2)}</td>
                    <td className="w-44">
                      <div className="flex items-center gap-2">
                        <ProgressBar value={item.pct_consumo} tone={consumptionTone(item.pct_consumo)} className="w-24" />
                        <span className="font-mono text-xs text-slate-400">{formatPercent(item.pct_consumo)}</span>
                      </div>
                    </td>
                    <td className="font-mono text-sm text-slate-300">{formatInteger(item.ots_usan)}</td>
                    <td className="font-mono text-xs text-slate-400">{formatDate(item.ultima_fecha)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <p className="mt-3 text-xs text-slate-500">{nota}</p>
    </>
  );
}
