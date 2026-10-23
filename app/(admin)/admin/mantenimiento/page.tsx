import type { Metadata } from 'next';
import Link from 'next/link';

import { Badge } from '@/components/Badge';
import { AuthRequiredPanel, ApiErrorPanel, EmptyState } from '@/components/EmptyState';
import { MaintenanceIcon } from '@/components/icons';
import { KpiCard } from '@/components/KpiCard';
import { PageHeader } from '@/components/PageHeader';
import { Panel } from '@/components/Panel';
import { ProgressBar } from '@/components/ProgressBar';
import { formatDateTime, formatHours, formatInteger, formatNumber, plural } from '@/lib/format';
import { isAuthError, safeServerFetch } from '@/lib/api-server';
import { labelEstadoTPM, toneForEstadoTPM } from '@/lib/status';
import type { EstadoTPM, TPMResponse } from '@/types/optiflow';

export const metadata: Metadata = { title: 'Mantenimiento' };
export const dynamic = 'force-dynamic';

function usageTone(estado: EstadoTPM) {
  if (estado === 'critico') return 'danger' as const;
  if (estado === 'advertencia') return 'warning' as const;
  return 'success' as const;
}

export default async function MantenimientoPage() {
  const result = await safeServerFetch<TPMResponse>('/api/tpm');

  const header = (
    <PageHeader
      eyebrow="Control · Mantenimiento"
      title="Mantenimiento preventivo (TPM)"
      description="Service por horas netas de uso real. El acumulado se reinicia al registrar un mantenimiento y las alertas se calculan contra el intervalo objetivo."
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

  const { maquinas, historial, resumen } = result.data;
  const activas = maquinas.filter((maquina) => maquina.activo);

  return (
    <>
      {header}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Máquinas TPM"
          value={formatInteger(resumen.total)}
          hint={`${formatInteger(resumen.inactivas)} inactiva(s)`}
          tone="neutral"
          icon={<MaintenanceIcon className="h-5 w-5" />}
        />
        <KpiCard label="Al día" value={formatInteger(resumen.ok)} hint="Dentro del intervalo objetivo" tone="cian" />
        <KpiCard label="Advertencias" value={formatInteger(resumen.advertencia)} hint="Cerca del vencimiento" tone={resumen.advertencia > 0 ? 'warning' : 'neutral'} />
        <KpiCard label="Críticas" value={formatInteger(resumen.critico)} hint="Service vencido" tone={resumen.critico > 0 ? 'cocinas' : 'neutral'} />
      </div>

      <Panel
        title="Estado de máquinas"
        description={`${formatInteger(activas.length)} ${plural(activas.length, 'máquina activa', 'máquinas activas')} · horas netas de uso por sector`}
        className="mt-4"
        bodyClassName="p-0"
      >
        {maquinas.length === 0 ? (
          <EmptyState
            title="No hay máquinas TPM configuradas"
            description="El TPM se configura por sector y máquina desde el panel de administración."
            className="border-0 bg-transparent"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table min-w-[1180px]">
              <caption className="sr-only">Máquinas y estado de mantenimiento preventivo</caption>
              <thead>
                <tr>
                  <th scope="col">Máquina</th>
                  <th scope="col">Sector / Línea</th>
                  <th scope="col">Tarea</th>
                  <th scope="col">Objetivo</th>
                  <th scope="col">Desde último service</th>
                  <th scope="col">Restantes</th>
                  <th scope="col">Uso</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Activa</th>
                </tr>
              </thead>
              <tbody>
                {maquinas.map((maquina) => (
                  <tr key={maquina.id}>
                    <td>
                      <p className="text-sm font-medium text-white">{maquina.nombre_maquina}</p>
                      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
                        ID {maquina.id}
                      </p>
                    </td>
                    <td>
                      <p className="text-sm text-slate-300">{maquina.nombre_sector || `Sector #${maquina.sector_id}`}</p>
                      {maquina.linea_area ? (
                        <Badge
                          tone={maquina.linea_area === 'Cocinas' ? 'cocinas' : maquina.linea_area === 'Placares' ? 'placares' : 'neutral'}
                          className="mt-1"
                        >
                          {maquina.linea_area}
                        </Badge>
                      ) : null}
                    </td>
                    <td>
                      <span className="block max-w-[240px] truncate text-sm text-slate-300" title={maquina.tarea_mantenimiento}>
                        {maquina.tarea_mantenimiento}
                      </span>
                    </td>
                    <td className="font-mono text-sm text-slate-300">{formatHours(maquina.intervalo_horas_target)}</td>
                    <td className="font-mono text-sm text-slate-300">
                      {formatHours(maquina.horas_desde_ultimo_mantenimiento)}
                    </td>
                    <td className="font-mono text-sm text-slate-300">{formatHours(maquina.horas_restantes)}</td>
                    <td className="w-48">
                      <div className="flex items-center gap-2">
                        <ProgressBar value={maquina.pct_uso} tone={usageTone(maquina.estado)} className="w-24" />
                        <span className="font-mono text-xs text-slate-400">{formatNumber(maquina.pct_uso, 1)}%</span>
                      </div>
                    </td>
                    <td>
                      <Badge tone={toneForEstadoTPM(maquina.estado)} dot>
                        {labelEstadoTPM(maquina.estado)}
                      </Badge>
                    </td>
                    <td>
                      <Badge tone={maquina.activo ? 'success' : 'muted'} dot>
                        {maquina.activo ? 'Sí' : 'No'}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        title="Historial de mantenimientos"
        description="Últimos 500 registros; se muestran los 20 más recientes."
        className="mt-4"
        bodyClassName="p-0"
      >
        {historial.length === 0 ? (
          <EmptyState
            title="Sin mantenimientos registrados"
            description="Cuando se registre un service, aparece acá con la hora acumulada al momento del mantenimiento."
            className="border-0 bg-transparent"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table min-w-[980px]">
              <caption className="sr-only">Historial de mantenimientos</caption>
              <thead>
                <tr>
                  <th scope="col">Máquina</th>
                  <th scope="col">Sector</th>
                  <th scope="col">Técnico</th>
                  <th scope="col">Fecha</th>
                  <th scope="col">Horas al service</th>
                  <th scope="col">Observaciones</th>
                </tr>
              </thead>
              <tbody>
                {historial.slice(0, 20).map((item) => (
                  <tr key={item.id}>
                    <td>
                      <p className="text-sm text-white">{item.nombre_maquina || `Máquina #${item.maquina_tpm_id}`}</p>
                      <p className="max-w-[220px] truncate text-xs text-slate-500">{item.tarea_mantenimiento || '—'}</p>
                    </td>
                    <td className="text-sm text-slate-300">{item.nombre_sector || '—'}</td>
                    <td className="text-sm text-slate-300">{item.tecnico_operario}</td>
                    <td className="font-mono text-xs text-slate-400">{formatDateTime(item.fecha_hora)}</td>
                    <td className="font-mono text-sm text-slate-300">{formatHours(item.horas_acumuladas_al_service)}</td>
                    <td>
                      <span className="block max-w-[280px] truncate text-xs text-slate-400" title={item.observaciones ?? ''}>
                        {item.observaciones || '—'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <p className="mt-3 text-xs text-slate-500">
        El acumulado usa exclusivamente etapas finalizadas del sector (horas netas, sin pausas). Un service vuelve a
        fotografiar el acumulado vigente; no se edita manualmente el contador.
      </p>
    </>
  );
}
