import type { Metadata } from 'next';
import Link from 'next/link';

import { Badge } from '@/components/Badge';
import { AuthRequiredPanel, ApiErrorPanel, EmptyState } from '@/components/EmptyState';
import { QualityIcon } from '@/components/icons';
import { KpiCard } from '@/components/KpiCard';
import { PageHeader } from '@/components/PageHeader';
import { Panel } from '@/components/Panel';
import { ProgressBar } from '@/components/ProgressBar';
import { formatDateTime, formatInteger, formatPercent, plural } from '@/lib/format';
import { isAuthError, safeServerFetch } from '@/lib/api-server';
import { toneForEstadoNC } from '@/lib/status';
import type { EstadoNoConformidad, QMSResponse, TipoFalla } from '@/types/optiflow';

export const metadata: Metadata = { title: 'Calidad' };
export const dynamic = 'force-dynamic';

const ESTADOS: EstadoNoConformidad[] = ['Pendiente', 'En Reproceso', 'Resuelto', 'Descartado'];

const TIPOS_FALLA: TipoFalla[] = [
  'Rotura de placa / Astillado',
  'Error de veta',
  'Defecto de laca / Lustre',
  'Falla de mecanizado / Cota',
  'Error de plano',
  'Otro',
];

interface CalidadPageProps {
  searchParams: Promise<{
    estado?: string;
    tipo_falla?: string;
    desde?: string;
    hasta?: string;
  }>;
}

export default async function CalidadPage({ searchParams }: CalidadPageProps) {
  const params = await searchParams;

  const query = new URLSearchParams();
  if (params.estado) query.set('estado', params.estado);
  if (params.tipo_falla) query.set('tipo_falla', params.tipo_falla);
  if (params.desde) query.set('desde', params.desde);
  if (params.hasta) query.set('hasta', params.hasta);

  const queryString = query.toString();
  const result = await safeServerFetch<QMSResponse>(
    `/api/qms/no-conformidades${queryString ? `?${queryString}` : ''}`,
  );

  const header = (
    <PageHeader
      eyebrow="Control · Calidad"
      title="Registro QMS"
      description="No conformidades, reprocesos y First Time Through del mes. La lectura está disponible para planta y oficina técnica; el alta y la resolución siguen en el flujo existente."
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

  const { no_conformidades: ncs, resumen } = result.data;
  const hayFiltros = Boolean(params.estado || params.tipo_falla || params.desde || params.hasta);
  const maxTipo = resumen.por_tipo.reduce((max, item) => Math.max(max, item.cantidad), 0);

  return (
    <>
      {header}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="NC abiertas"
          value={formatInteger(resumen.abiertas)}
          hint={`${formatInteger(resumen.total_mes)} NC en el mes`}
          tone={resumen.abiertas > 0 ? 'warning' : 'neutral'}
          icon={<QualityIcon className="h-5 w-5" />}
        />
        <KpiCard label="Pendientes" value={formatInteger(resumen.pendientes)} hint="Sin acción correctiva aún" tone="warning" />
        <KpiCard label="En reproceso" value={formatInteger(resumen.en_reproceso)} hint="Con retrabajo en curso" tone="cocinas" />
        <KpiCard
          label="FTT del mes"
          value={formatPercent(resumen.ftt.porcentaje, 1)}
          hint={`${formatInteger(resumen.ftt.conformes)} de ${formatInteger(resumen.ftt.evaluadas)} OTs evaluadas`}
          tone={resumen.ftt.porcentaje !== null && resumen.ftt.porcentaje >= 90 ? 'cian' : 'neutral'}
        />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_1.6fr]">
        <Panel
          title="Fallas por tipo"
          description={`Período ${resumen.periodo} · ${resumen.desde} → ${resumen.hasta}`}
        >
          {resumen.por_tipo.length === 0 ? (
            <p className="text-sm text-slate-500">Sin no conformidades registradas en el período.</p>
          ) : (
            <div className="space-y-3">
              {resumen.por_tipo.map((item) => (
                <div key={item.tipo_falla}>
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <span className="truncate text-slate-300" title={item.tipo_falla}>
                      {item.tipo_falla}
                    </span>
                    <span className="font-mono text-slate-400">{formatInteger(item.cantidad)}</span>
                  </div>
                  <ProgressBar
                    value={maxTipo > 0 ? (item.cantidad / maxTipo) * 100 : 0}
                    tone={item.tipo_falla === resumen.tipo_mas_recurrente?.tipo_falla ? 'cocinas' : 'cian'}
                    className="mt-1.5"
                  />
                </div>
              ))}
              {resumen.tipo_mas_recurrente ? (
                <p className="rounded-lg border border-cocinas/20 bg-cocinas/5 px-3 py-2 text-xs text-red-100">
                  Falla más recurrente: <strong>{resumen.tipo_mas_recurrente.tipo_falla}</strong> (
                  {formatInteger(resumen.tipo_mas_recurrente.cantidad)}{' '}
                  {plural(resumen.tipo_mas_recurrente.cantidad, 'caso', 'casos')}).
                </p>
              ) : null}
            </div>
          )}
        </Panel>

        <Panel
          title="Resumen del mes"
          description="Indicadores calculados por el API de QMS."
        >
          <dl className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
              <dt className="label">Total del mes</dt>
              <dd className="mt-1 font-mono text-xl text-white">{formatInteger(resumen.total_mes)}</dd>
            </div>
            <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
              <dt className="label">Resueltas</dt>
              <dd className="mt-1 font-mono text-xl text-white">{formatInteger(resumen.resueltas_mes)}</dd>
            </div>
            <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
              <dt className="label">Descartadas</dt>
              <dd className="mt-1 font-mono text-xl text-white">{formatInteger(resumen.descartadas_mes)}</dd>
            </div>
            <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
              <dt className="label">Conformidad (FTT)</dt>
              <dd className="mt-1 font-mono text-xl text-white">{formatPercent(resumen.ftt.porcentaje, 1)}</dd>
            </div>
          </dl>
          <p className="mt-4 text-xs leading-5 text-slate-500">
            FTT = OTs que avanzaron sin una NC abierta en el período / OTs evaluadas. Las NC descartadas no
            penalizan el indicador.
          </p>
        </Panel>
      </div>

      <Panel
        title="Filtros"
        description="El resumen mensual se calcula con el período actual; los filtros aplican al listado."
        className="mt-4"
      >
        <form method="get" className="grid gap-3 md:grid-cols-2 xl:grid-cols-[1fr_1.3fr_1fr_1fr_auto]">
          <label className="block">
            <span className="label">Estado</span>
            <select name="estado" defaultValue={params.estado ?? ''} className="select mt-1.5">
              <option value="">Todos</option>
              {ESTADOS.map((estado) => (
                <option key={estado} value={estado}>
                  {estado}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="label">Tipo de falla</span>
            <select name="tipo_falla" defaultValue={params.tipo_falla ?? ''} className="select mt-1.5">
              <option value="">Todos los tipos</option>
              {TIPOS_FALLA.map((tipo) => (
                <option key={tipo} value={tipo}>
                  {tipo}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="label">Desde</span>
            <input type="date" name="desde" defaultValue={params.desde ?? ''} className="input mt-1.5" />
          </label>

          <label className="block">
            <span className="label">Hasta</span>
            <input type="date" name="hasta" defaultValue={params.hasta ?? ''} className="input mt-1.5" />
          </label>

          <div className="flex items-end gap-2">
            <button type="submit" className="btn btn-primary">
              Filtrar
            </button>
            <Link className="btn btn-ghost" href="/admin/calidad">
              Limpiar
            </Link>
          </div>
        </form>
      </Panel>

      <Panel
        title="No conformidades"
        description={`${formatInteger(ncs.length)} registro(s) en la vista`}
        className="mt-4"
        bodyClassName="p-0"
      >
        {ncs.length === 0 ? (
          <EmptyState
            title="Sin no conformidades"
            description={
              hayFiltros
                ? 'Ninguna NC coincide con los filtros aplicados.'
                : 'No hay no conformidades registradas en el período.'
            }
            className="border-0 bg-transparent"
            action={
              hayFiltros ? (
                <Link className="btn btn-ghost" href="/admin/calidad">
                  Limpiar filtros
                </Link>
              ) : null
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table min-w-[1120px]">
              <caption className="sr-only">No conformidades registradas</caption>
              <thead>
                <tr>
                  <th scope="col">OT / Cliente</th>
                  <th scope="col">Sector</th>
                  <th scope="col">Tipo de falla</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Reporta</th>
                  <th scope="col">Fecha</th>
                  <th scope="col">Acción correctiva</th>
                  <th scope="col">Evidencia</th>
                </tr>
              </thead>
              <tbody>
                {ncs.map((nc) => (
                  <tr key={nc.id}>
                    <td>
                      <p className="font-mono text-sm text-white">{nc.numero_ot ?? `OT #${nc.ot_id}`}</p>
                      <p className="max-w-[200px] truncate text-xs text-slate-500">{nc.cliente || 'Sin cliente'}</p>
                    </td>
                    <td>
                      <p className="text-sm text-slate-300">{nc.nombre_sector || `Sector #${nc.sector_id}`}</p>
                      {nc.linea_area ? (
                        <Badge
                          tone={nc.linea_area === 'Cocinas' ? 'cocinas' : nc.linea_area === 'Placares' ? 'placares' : 'neutral'}
                          className="mt-1"
                        >
                          {nc.linea_area}
                        </Badge>
                      ) : null}
                    </td>
                    <td>
                      <span className="block max-w-[220px] text-sm text-slate-200">{nc.tipo_falla}</span>
                      {nc.operario_responsable ? (
                        <p className="mt-0.5 max-w-[220px] truncate text-xs text-slate-500">
                          Responsable: {nc.operario_responsable}
                        </p>
                      ) : null}
                    </td>
                    <td>
                      <Badge tone={toneForEstadoNC(nc.estado)} dot>
                        {nc.estado}
                      </Badge>
                    </td>
                    <td className="max-w-[160px] truncate text-xs text-slate-400" title={nc.encargado_reporta}>
                      {nc.encargado_reporta}
                    </td>
                    <td className="font-mono text-xs text-slate-400">
                      {formatDateTime(nc.fecha_registro_local ?? nc.fecha_registro)}
                    </td>
                    <td>
                      <span
                        className="block max-w-[240px] truncate text-xs text-slate-400"
                        title={nc.accion_correctiva ?? ''}
                      >
                        {nc.accion_correctiva || '—'}
                      </span>
                    </td>
                    <td>
                      {nc.foto_url ? (
                        <a
                          className="text-xs font-medium text-cian hover:text-cyan-300"
                          href={nc.foto_url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Ver foto
                        </a>
                      ) : (
                        <span className="text-xs text-slate-600">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <p className="mt-3 text-xs text-slate-500">
        El alta de una NC pausa la etapa abierta y deja la OT en “Detenido” cuando corresponde. La resolución exige
        rol de gestión. Esa lógica permanece en el API y no se replica en Next.js.
      </p>
    </>
  );
}
