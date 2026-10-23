import type { Metadata } from 'next';
import Link from 'next/link';

import { Badge, type BadgeTone } from '@/components/Badge';
import { AuthRequiredPanel, ApiErrorPanel, EmptyState } from '@/components/EmptyState';
import { SectorsIcon } from '@/components/icons';
import { KpiCard } from '@/components/KpiCard';
import { PageHeader } from '@/components/PageHeader';
import { Panel } from '@/components/Panel';
import { formatInteger, plural } from '@/lib/format';
import { isAuthError, safeServerFetch } from '@/lib/api-server';
import { toneForLinea } from '@/lib/status';
import type { LineaArea, SectoresResponse, Sector } from '@/types/optiflow';

export const metadata: Metadata = { title: 'Sectores y flujos' };
export const dynamic = 'force-dynamic';

const AREA_ORDER: LineaArea[] = ['Placares', 'Cocinas', 'Compartido', 'General'];

function areaTone(area: LineaArea): BadgeTone {
  if (area === 'Placares' || area === 'Cocinas') return toneForLinea(area);
  return area === 'Compartido' ? 'cian' : 'neutral';
}

function groupSectors(sectores: Sector[]): Array<{ area: LineaArea; sectores: Sector[] }> {
  return AREA_ORDER.map((area) => ({
    area,
    sectores: sectores
      .filter((sector) => sector.linea_area === area)
      .sort((a, b) => a.orden_flujo - b.orden_flujo || a.id - b.id),
  })).filter((group) => group.sectores.length > 0);
}

export default async function SectoresPage() {
  const result = await safeServerFetch<SectoresResponse>('/api/sectores?todos=1');

  const header = (
    <PageHeader
      eyebrow="Maestros · Flujos"
      title="Sectores y flujos de producción"
      description="Orden de flujo por línea, sectores compartidos y claves especiales. El orden define los prerrequisitos del flujo (R6); la configuración se mantiene en el panel existente."
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

  const { sectores, total } = result.data;
  const activos = sectores.filter((sector) => sector.activo).length;
  const compartidos = sectores.filter((sector) => sector.es_compartido).length;
  const especiales = sectores.filter((sector) => sector.clave_especial).length;
  const groups = groupSectors(sectores);

  return (
    <>
      {header}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Sectores"
          value={formatInteger(total)}
          hint={`${formatInteger(activos)} activos · ${formatInteger(total - activos)} inactivos`}
          tone="neutral"
          icon={<SectorsIcon className="h-5 w-5" />}
        />
        <KpiCard label="Activos" value={formatInteger(activos)} hint="Aceptan etapas nuevas" tone="cian" />
        <KpiCard label="Compartidos" value={formatInteger(compartidos)} hint="Aplican a ambas líneas" tone="placares" />
        <KpiCard label="Claves especiales" value={formatInteger(especiales)} hint="Vidrio, lustre, herrería, especiales" tone="warning" />
      </div>

      {groups.length === 0 ? (
        <EmptyState
          title="No hay sectores configurados"
          description="El maestro de sectores está vacío. La configuración se realiza desde el panel de administración."
          className="mt-4"
        />
      ) : (
        <div className="mt-4 space-y-4">
          {groups.map((group) => (
            <Panel
              key={group.area}
              title={group.area}
              description={`${formatInteger(group.sectores.length)} ${plural(group.sectores.length, 'sector', 'sectores')} · orden de flujo`}
              actions={<Badge tone={areaTone(group.area)}>{group.area}</Badge>}
              bodyClassName="p-0"
            >
              <div className="overflow-x-auto">
                <table className="data-table min-w-[980px]">
                  <caption className="sr-only">Sectores del área {group.area}</caption>
                  <thead>
                    <tr>
                      <th scope="col">Orden</th>
                      <th scope="col">Sector</th>
                      <th scope="col">Nombre corto</th>
                      <th scope="col">Tipo</th>
                      <th scope="col">Operarios sugeridos</th>
                      <th scope="col">Etapas abiertas</th>
                      <th scope="col">OTs activas</th>
                      <th scope="col">Estado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.sectores.map((sector) => (
                      <tr key={sector.id}>
                        <td>
                          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/5 font-mono text-xs text-slate-300">
                            {sector.orden_flujo}
                          </span>
                        </td>
                        <td>
                          <p className="text-sm font-medium text-white">{sector.nombre_sector}</p>
                          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
                            ID {sector.id}
                          </p>
                        </td>
                        <td className="font-mono text-xs text-slate-400">{sector.nombre_corto}</td>
                        <td>
                          <div className="flex flex-wrap gap-1">
                            <Badge tone={areaTone(sector.linea_area)}>{sector.linea_area}</Badge>
                            {sector.es_compartido ? <Badge tone="cian">Compartido</Badge> : null}
                            {sector.clave_especial ? (
                              <Badge tone="warning">{sector.clave_especial}</Badge>
                            ) : null}
                          </div>
                        </td>
                        <td>
                          <span className="block max-w-[220px] truncate text-xs text-slate-400" title={sector.operarios_sugeridos ?? ''}>
                            {sector.operarios_sugeridos || '—'}
                          </span>
                        </td>
                        <td>
                          {(sector.etapas_abiertas ?? 0) > 0 ? (
                            <Badge tone="cian" dot>
                              {formatInteger(sector.etapas_abiertas)} abierta(s)
                            </Badge>
                          ) : (
                            <span className="font-mono text-sm text-slate-500">0</span>
                          )}
                        </td>
                        <td>
                          {sector.ordenes_activas && sector.ordenes_activas.length > 0 ? (
                            <span
                              className="block max-w-[220px] truncate font-mono text-xs text-slate-300"
                              title={sector.ordenes_activas.join(', ')}
                            >
                              {sector.ordenes_activas.join(', ')}
                            </span>
                          ) : (
                            <span className="text-xs text-slate-600">—</span>
                          )}
                        </td>
                        <td>
                          <Badge tone={sector.activo ? 'success' : 'muted'} dot>
                            {sector.activo ? 'Activo' : 'Inactivo'}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          ))}
        </div>
      )}

      <p className="mt-3 text-xs text-slate-500">
        Los sectores inactivos conservan su historial pero no aceptan etapas nuevas (R7). El orden de flujo se usa
        para validar prerrequisitos antes de iniciar una etapa (R6).
      </p>
    </>
  );
}
