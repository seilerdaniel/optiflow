import type { Metadata } from 'next';
import Link from 'next/link';

import { Badge } from '@/components/Badge';
import { AuthRequiredPanel, ApiErrorPanel, EmptyState } from '@/components/EmptyState';
import { ClockIcon, DashboardIcon, DespieceIcon, OrdersIcon, TerminalIcon } from '@/components/icons';
import { KpiCard } from '@/components/KpiCard';
import { PageHeader } from '@/components/PageHeader';
import { Panel } from '@/components/Panel';
import { ProgressBar, type ProgressTone } from '@/components/ProgressBar';
import { formatDate, formatInteger, formatMetres, formatNumber, formatPercent, monthLabel, plural } from '@/lib/format';
import {
  isAuthError,
  safeServerFetch,
} from '@/lib/api-server';
import { toneForEstadoOT, toneForLinea } from '@/lib/status';
import type { EstadoPlanta, MetricasObjetivo, OrdenesResponse, OrdenTrabajo } from '@/types/optiflow';

export const metadata: Metadata = { title: 'Dashboard' };
export const dynamic = 'force-dynamic';

function goalTone(percentage: number | null): ProgressTone {
  if (percentage === null) return 'cian';
  if (percentage >= 100) return 'success';
  if (percentage >= 70) return 'cian';
  if (percentage >= 40) return 'warning';
  return 'danger';
}

function currentSector(ot: OrdenTrabajo): string {
  return ot.sector_actual?.nombre_corto || ot.sector_actual?.nombre_sector || 'Sin etapa activa';
}

export default async function DashboardPage() {
  const [objetivoResult, estadoResult, ordenesResult] = await Promise.all([
    safeServerFetch<MetricasObjetivo>('/api/metricas/objetivo-corte'),
    safeServerFetch<EstadoPlanta>('/api/estado'),
    safeServerFetch<OrdenesResponse>('/api/ordenes'),
  ]);

  const results = [objetivoResult, estadoResult, ordenesResult];
  const firstFailure = results.find((result) => !result.ok);

  const header = (
    <PageHeader
      eyebrow="Planta · Vista general"
      title="Dashboard de producción"
      description="Metas de corte, OTs en piso y etapas abiertas. Los indicadores se calculan en el API existente; esta vista sólo los presenta."
      actions={
        <>
          <Link className="btn btn-ghost" href="/admin/ordenes">
            <OrdersIcon className="h-4 w-4" />
            Ver OTs
          </Link>
          <Link className="btn btn-primary" href="/terminal">
            <TerminalIcon className="h-4 w-4" />
            Abrir terminal
          </Link>
        </>
      }
    />
  );

  if (firstFailure && isAuthError(firstFailure)) {
    return (
      <>
        {header}
        <AuthRequiredPanel />
      </>
    );
  }

  if (firstFailure && results.every((result) => !result.ok)) {
    return (
      <>
        {header}
        <ApiErrorPanel message={firstFailure.error} status={firstFailure.status} />
      </>
    );
  }

  const objetivo = objetivoResult.ok ? objetivoResult.data : null;
  const estado = estadoResult.ok ? estadoResult.data : null;
  const ordenes = ordenesResult.ok ? ordenesResult.data.ordenes : [];

  const activas = ordenes.filter((ot) => ot.estado_general !== 'Finalizado');
  const detenidas = activas.filter((ot) => ot.estado_general === 'Detenido');
  const metrosActivos = activas.reduce((total, ot) => total + ot.metros_lineales, 0);
  const etapasAbiertas = estado?.etapas_abiertas ?? [];
  const sectoresConActividad = estado?.actividad_sectores.length ?? 0;
  const metaTotal = objetivo?.meta.totales ?? 0;
  const cortados = objetivo?.cortados ?? 0;

  return (
    <>
      {header}

      {firstFailure && !isAuthError(firstFailure) ? (
        <div className="mb-4 rounded-lg border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
          Algunos datos no se pudieron cargar: {firstFailure.error}
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="OTs activas"
          value={formatInteger(activas.length)}
          hint={
            detenidas.length > 0 ? (
              <span className="text-red-200">{detenidas.length} detenida(s) en piso</span>
            ) : (
              `${formatInteger(ordenes.length)} OTs en el listado`
            )
          }
          tone={detenidas.length > 0 ? 'warning' : 'cian'}
          icon={<OrdersIcon className="h-5 w-5" />}
        />
        <KpiCard
          label="Metros en piso"
          value={formatNumber(metrosActivos, 2)}
          hint="Suma de metros lineales de OTs no finalizadas"
          tone="placares"
          icon={<DespieceIcon className="h-5 w-5" />}
        />
        <KpiCard
          label="Cumplimiento de meta"
          value={formatPercent(objetivo?.porcentaje ?? null)}
          hint={
            objetivo
              ? `${formatMetres(cortados)} de ${formatMetres(metaTotal)}`
              : 'Sin datos de metas'
          }
          tone={(objetivo?.porcentaje ?? 0) >= 100 ? 'cian' : 'neutral'}
          icon={<DashboardIcon className="h-5 w-5" />}
        />
        <KpiCard
          label="Etapas abiertas"
          value={formatInteger(etapasAbiertas.length)}
          hint={`${formatInteger(sectoresConActividad)} ${plural(sectoresConActividad, 'sector con actividad', 'sectores con actividad')}`}
          tone="neutral"
          icon={<ClockIcon className="h-5 w-5" />}
        />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1.35fr_1fr]">
        <Panel
          title="Meta de corte del mes"
          description={
            objetivo
              ? `${monthLabel(objetivo.periodo)} · ${objetivo.es_mes_en_curso ? 'mes en curso' : 'período histórico'}`
              : 'Sin período disponible'
          }
          actions={
            objetivo ? (
              <Badge tone={objetivo.meta_configurada ? 'success' : 'warning'} dot>
                {objetivo.meta_configurada ? 'Meta configurada' : 'Sin configurar'}
              </Badge>
            ) : null
          }
        >
          {objetivo ? (
            <div className="space-y-6">
              <div>
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <p className="stat-value">
                      {formatNumber(cortados, 2)}
                      <span className="ml-1 text-base font-normal text-slate-500">
                        / {formatNumber(metaTotal, 2)} m
                      </span>
                    </p>
                    <p className="mt-1 text-xs text-slate-400">
                      {formatPercent(objetivo.porcentaje)} de la meta · {formatInteger(objetivo.ots_contadas)} OTs contadas
                    </p>
                  </div>
                  <p className="font-mono text-sm text-slate-300">
                    {objetivo.dias.restantes} día(s) restantes
                  </p>
                </div>
                <ProgressBar
                  value={objetivo.porcentaje}
                  tone={goalTone(objetivo.porcentaje)}
                  className="mt-4"
                />
              </div>

              <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
                  <dt className="label">Ritmo diario</dt>
                  <dd className="mt-1 whitespace-nowrap font-mono text-base text-white xl:text-lg">{formatNumber(objetivo.ritmo_diario, 2)} m</dd>
                </div>
                <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
                  <dt className="label">Ritmo necesario</dt>
                  <dd className="mt-1 whitespace-nowrap font-mono text-base text-white xl:text-lg">{formatNumber(objetivo.ritmo_necesario, 2)} m</dd>
                </div>
                <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
                  <dt className="label">Proyección de cierre</dt>
                  <dd className="mt-1 whitespace-nowrap font-mono text-base text-white xl:text-lg">{formatNumber(objetivo.proyeccion_cierre, 2)} m</dd>
                </div>
                <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
                  <dt className="label">Diferencia vs. meta</dt>
                  <dd
                    className={`mt-1 whitespace-nowrap font-mono text-base xl:text-lg ${
                      objetivo.diferencia_proyeccion !== null && objetivo.diferencia_proyeccion >= 0
                        ? 'text-emerald-300'
                        : 'text-red-300'
                    }`}
                  >
                    {objetivo.diferencia_proyeccion === null
                      ? '—'
                      : `${objetivo.diferencia_proyeccion >= 0 ? '+' : ''}${formatNumber(objetivo.diferencia_proyeccion, 2)} m`}
                  </dd>
                </div>
              </dl>

              <div className="grid gap-3 sm:grid-cols-2">
                {objetivo.por_linea.map((linea) => (
                  <div key={linea.linea} className="rounded-lg border border-white/5 bg-white/[0.02] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <Badge tone={toneForLinea(linea.linea)}>{linea.linea}</Badge>
                      <span className="font-mono text-xs text-slate-300">
                        {formatPercent(linea.porcentaje)}
                      </span>
                    </div>
                    <p className="mt-3 font-mono text-xl text-white">
                      {formatNumber(linea.cortados, 2)}
                      <span className="ml-1 text-sm font-normal text-slate-500">
                        / {formatNumber(linea.meta, 2)} m
                      </span>
                    </p>
                    <ProgressBar
                      value={linea.porcentaje}
                      tone={linea.linea === 'Cocinas' ? 'cocinas' : 'placares'}
                      className="mt-3"
                    />
                  </div>
                ))}
              </div>

              {!objetivo.meta_configurada ? (
                <p className="rounded-lg border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-xs text-amber-100">
                  El período no tiene meta configurada. Los porcentajes y la proyección quedan en blanco para no
                  mostrar objetivos inventados.
                </p>
              ) : null}
            </div>
          ) : (
            <EmptyState
              title="Sin datos de metas"
              description="El endpoint de metas no devolvió información. Verificá la conexión con el API."
            />
          )}
        </Panel>

        <Panel
          title="Piso ahora"
          description={`${formatInteger(etapasAbiertas.length)} ${plural(etapasAbiertas.length, 'etapa abierta', 'etapas abiertas')}`}
          actions={
            <Link className="text-xs font-medium text-cian hover:text-cyan-300" href="/terminal">
              Ir a terminal
            </Link>
          }
        >
          {etapasAbiertas.length === 0 ? (
            <EmptyState
              title="Sin etapas abiertas"
              description="No hay fichajes activos en este momento. La terminal refleja el estado en vivo del piso."
              className="border-0 bg-transparent"
            />
          ) : (
            <>
              <ul className="divide-y divide-white/5">
              {etapasAbiertas.slice(0, 6).map((etapa) => (
                <li key={etapa.id} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-white">
                      {etapa.numero_ot ?? `OT #${etapa.ot_id}`}
                      <span className="ml-2 font-mono text-[11px] text-slate-500">
                        {etapa.nombre_sector ?? `Sector #${etapa.sector_id}`}
                      </span>
                    </p>
                    <p className="mt-0.5 truncate text-xs text-slate-400">
                      {etapa.operario_nombre}
                      {etapa.estado_etapa === 'Pausado' ? ' · pausada' : ''}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="font-mono text-sm text-white">
                      {formatInteger(etapa.minutos_transcurridos ?? 0)} min
                    </p>
                    <Badge tone={etapa.estado_etapa === 'Pausado' ? 'warning' : 'cian'} className="mt-1">
                      {etapa.estado_etapa}
                    </Badge>
                  </div>
                </li>
              ))}
            </ul>

              {sectoresConActividad > 0 ? (
                <div className="mt-4 border-t border-white/10 pt-4">
                  <p className="label">Sectores con actividad</p>
                  <ul className="mt-2 space-y-1.5">
                    {estado?.actividad_sectores.map((actividad) => (
                      <li key={actividad.sector_id} className="flex items-center justify-between gap-3 text-xs">
                        <span className="truncate text-slate-300">{actividad.nombre_sector}</span>
                        <span className="shrink-0 font-mono text-slate-400">
                          {formatInteger(actividad.abiertas)} · {actividad.ordenes_activas.join(', ')}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          )}
        </Panel>
      </div>

      <Panel
        title="OTs en curso"
        description="Avance por sectores requeridos de cada línea."
        className="mt-4"
        bodyClassName="p-0"
        actions={
          <Link className="text-xs font-medium text-cian hover:text-cyan-300" href="/admin/ordenes">
            Ver todas
          </Link>
        }
      >
        <div className="overflow-x-auto">
          <table className="data-table min-w-[880px]">
            <caption className="sr-only">Órdenes de trabajo activas con su avance</caption>
            <thead>
              <tr>
                <th scope="col">OT</th>
                <th scope="col">Cliente / Modelo</th>
                <th scope="col">Línea</th>
                <th scope="col">Avance</th>
                <th scope="col">Sector actual</th>
                <th scope="col">Entrega</th>
                <th scope="col">Estado</th>
              </tr>
            </thead>
            <tbody>
              {activas.slice(0, 8).map((ot) => {
                const progreso = ot.progreso?.porcentaje ?? 0;
                return (
                  <tr key={ot.id}>
                    <td>
                      <Link
                        className="font-mono text-sm font-medium text-cian hover:text-cyan-300"
                        href={`/admin/oficina-tecnica/despiece?ot=${ot.id}`}
                      >
                        {ot.numero_ot}
                      </Link>
                      {(ot.alertas_abiertas ?? 0) > 0 ? (
                        <Badge tone="danger" className="ml-2">
                          {ot.alertas_abiertas} NC
                        </Badge>
                      ) : null}
                    </td>
                    <td>
                      <p className="max-w-[220px] truncate text-sm text-white">{ot.cliente}</p>
                      <p className="max-w-[220px] truncate text-xs text-slate-500">{ot.modelo || 'Sin modelo'}</p>
                    </td>
                    <td>
                      <Badge tone={toneForLinea(ot.linea_area)}>{ot.linea_area}</Badge>
                    </td>
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
                    </td>
                    <td className="font-mono text-xs text-slate-400">{formatDate(ot.fecha_prometida)}</td>
                    <td>
                      <Badge tone={toneForEstadoOT(ot.estado_general)} dot>
                        {ot.estado_general}
                      </Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {activas.length === 0 ? (
          <EmptyState
            title="No hay OTs activas"
            description="Cuando se carguen órdenes de trabajo, acá vas a ver su avance y el sector actual."
            className="border-0 bg-transparent"
          />
        ) : null}
      </Panel>

      <p className="mt-4 text-right font-mono text-[10px] uppercase tracking-[0.14em] text-slate-600">
        Datos: API OptiFlow · {objetivo ? `generado ${formatDate(objetivo.generado_en)}` : 'sin período'}
      </p>
    </>
  );
}
