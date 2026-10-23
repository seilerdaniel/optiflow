import type { Metadata } from 'next';
import Link from 'next/link';

import { Badge } from '@/components/Badge';
import { AuthRequiredPanel, ApiErrorPanel, EmptyState } from '@/components/EmptyState';
import { OrdersIcon, TerminalIcon } from '@/components/icons';
import { KpiCard } from '@/components/KpiCard';
import { PageHeader } from '@/components/PageHeader';
import { Panel } from '@/components/Panel';
import { ProgressBar } from '@/components/ProgressBar';
import { formatDate, formatInteger, formatMetres, formatNumber, plural } from '@/lib/format';
import { isAuthError, safeServerFetch } from '@/lib/api-server';
import { toneForEstadoOT, toneForLinea } from '@/lib/status';
import type { EstadoOT, OrdenesResponse, OrdenTrabajo } from '@/types/optiflow';

export const metadata: Metadata = { title: 'Órdenes de trabajo' };
export const dynamic = 'force-dynamic';

interface OrdenesPageProps {
  searchParams: Promise<{
    estado?: string;
    linea?: string;
    q?: string;
  }>;
}

const ESTADOS: EstadoOT[] = ['En Cola', 'En Producción', 'Detenido', 'Finalizado'];

function currentSector(ot: OrdenTrabajo): string {
  return ot.sector_actual?.nombre_corto || ot.sector_actual?.nombre_sector || 'Sin etapa activa';
}

export default async function OrdenesPage({ searchParams }: OrdenesPageProps) {
  const params = await searchParams;

  const query = new URLSearchParams();
  if (params.estado) query.set('estado', params.estado);
  if (params.linea) query.set('linea_area', params.linea);
  if (params.q) query.set('q', params.q);

  const queryString = query.toString();
  const result = await safeServerFetch<OrdenesResponse>(
    `/api/ordenes${queryString ? `?${queryString}` : ''}`,
  );

  const header = (
    <PageHeader
      eyebrow="Planta · Órdenes"
      title="Órdenes de trabajo"
      description="Listado de OTs con su avance por sectores, sector actual y alertas de calidad. La hoja de ruta completa se abre desde el despiece."
      actions={
        <>
          <Link className="btn btn-ghost" href="/admin/dashboard">
            Volver al dashboard
          </Link>
          <Link className="btn btn-primary" href="/terminal">
            <TerminalIcon className="h-4 w-4" />
            Terminal
          </Link>
        </>
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

  const { ordenes, total } = result.data;
  const enCola = ordenes.filter((ot) => ot.estado_general === 'En Cola').length;
  const enProduccion = ordenes.filter((ot) => ot.estado_general === 'En Producción').length;
  const detenidas = ordenes.filter((ot) => ot.estado_general === 'Detenido').length;
  const hayFiltros = Boolean(params.estado || params.linea || params.q);

  return (
    <>
      {header}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label={hayFiltros ? 'Resultados filtrados' : 'OTs totales'}
          value={formatInteger(total)}
          hint={hayFiltros ? 'Filtros aplicados sobre el listado' : 'Todas las OTs del sistema'}
          tone="neutral"
          icon={<OrdersIcon className="h-5 w-5" />}
        />
        <KpiCard label="En cola" value={formatInteger(enCola)} hint="Esperando iniciar el flujo" tone="neutral" />
        <KpiCard label="En producción" value={formatInteger(enProduccion)} hint="Con actividad en piso" tone="cian" />
        <KpiCard label="Detenidas" value={formatInteger(detenidas)} hint="Con no conformidad o pausa" tone={detenidas > 0 ? 'warning' : 'neutral'} />
      </div>

      <Panel
        title="Filtros"
        description="El API aplica los filtros sobre las OTs y devuelve el avance ya calculado."
        className="mt-4"
      >
        <form method="get" className="grid gap-3 md:grid-cols-[1fr_1fr_1.4fr_auto]">
          <label className="block">
            <span className="label">Estado</span>
            <select name="estado" defaultValue={params.estado ?? ''} className="select mt-1.5">
              <option value="">Todos los estados</option>
              {ESTADOS.map((estado) => (
                <option key={estado} value={estado}>
                  {estado}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="label">Línea</span>
            <select name="linea" defaultValue={params.linea ?? ''} className="select mt-1.5">
              <option value="">Todas las líneas</option>
              <option value="Placares">Placares</option>
              <option value="Cocinas">Cocinas</option>
            </select>
          </label>

          <label className="block">
            <span className="label">Buscar</span>
            <input
              type="search"
              name="q"
              defaultValue={params.q ?? ''}
              placeholder="N° de OT, cliente o modelo"
              className="input mt-1.5"
            />
          </label>

          <div className="flex items-end gap-2">
            <button type="submit" className="btn btn-primary">
              Filtrar
            </button>
            <Link className="btn btn-ghost" href="/admin/ordenes">
              Limpiar
            </Link>
          </div>
        </form>
      </Panel>

      <Panel
        title="Listado de OTs"
        description={`${formatInteger(ordenes.length)} ${plural(ordenes.length, 'orden', 'órdenes')} · ${formatNumber(ordenes.reduce((sum, ot) => sum + ot.metros_lineales, 0), 2)} m lineales`}
        className="mt-4"
        bodyClassName="p-0"
      >
        {ordenes.length === 0 ? (
          <EmptyState
            title="No hay OTs para mostrar"
            description={
              hayFiltros
                ? 'Ninguna orden coincide con los filtros aplicados. Probá limpiando los filtros.'
                : 'Todavía no hay órdenes de trabajo cargadas en el sistema.'
            }
            className="border-0 bg-transparent"
            action={
              hayFiltros ? (
                <Link className="btn btn-ghost" href="/admin/ordenes">
                  Limpiar filtros
                </Link>
              ) : null
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table min-w-[1000px]">
              <caption className="sr-only">Órdenes de trabajo y su avance</caption>
              <thead>
                <tr>
                  <th scope="col">OT</th>
                  <th scope="col">Cliente / Modelo</th>
                  <th scope="col">Línea</th>
                  <th scope="col">Metros</th>
                  <th scope="col">Avance</th>
                  <th scope="col">Sector actual</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Entrega</th>

                </tr>
              </thead>
              <tbody>
                {ordenes.map((ot) => {
                  const progreso = ot.progreso?.porcentaje ?? 0;
                  return (
                    <tr key={ot.id}>
                      <td className="whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <Link
                            className="font-mono text-sm font-medium text-cian hover:text-cyan-300"
                            href={`/admin/oficina-tecnica/despiece?ot=${ot.id}`}
                          >
                            {ot.numero_ot}
                          </Link>
                          {(ot.alertas_abiertas ?? 0) > 0 ? (
                            <Badge tone="danger">{ot.alertas_abiertas} NC</Badge>
                          ) : null}
                          {ot.estado_general !== 'Finalizado' ? (
                            <Link
                              className="text-slate-500 hover:text-cian"
                              href={`/terminal?ot=${ot.id}`}
                              aria-label={`Abrir terminal para ${ot.numero_ot}`}
                              title="Abrir en terminal"
                            >
                              <TerminalIcon className="h-4 w-4" />
                            </Link>
                          ) : null}
                        </div>
                      </td>
                      <td>
                        <p className="max-w-[200px] truncate text-sm text-white">{ot.cliente}</p>
                        <p className="max-w-[200px] truncate text-xs text-slate-500">{ot.modelo || 'Sin modelo'}</p>
                      </td>
                      <td>
                        <Badge tone={toneForLinea(ot.linea_area)}>{ot.linea_area}</Badge>
                      </td>
                      <td className="font-mono text-sm text-slate-300">{formatMetres(ot.metros_lineales)}</td>
                      <td className="w-44">
                        <div className="flex items-center gap-2">
                          <ProgressBar
                            value={progreso}
                            tone={ot.linea_area === 'Cocinas' ? 'cocinas' : 'placares'}
                            className="w-24"
                          />
                          <span className="font-mono text-xs text-slate-400">
                            {ot.progreso?.sectores_finalizados ?? 0}/{ot.progreso?.sectores_requeridos ?? 0}
                          </span>
                        </div>
                      </td>
                      <td>
                        <span className="text-sm text-slate-300">{currentSector(ot)}</span>
                        {ot.etapa_activa?.operario_nombre ? (
                          <p className="text-xs text-slate-500">{ot.etapa_activa.operario_nombre}</p>
                        ) : null}
                      </td>
                      <td>
                        <Badge tone={toneForEstadoOT(ot.estado_general)} dot>
                          {ot.estado_general}
                        </Badge>
                      </td>
                      <td className="whitespace-nowrap font-mono text-xs text-slate-400">{formatDate(ot.fecha_prometida)}</td>

                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
