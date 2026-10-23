import type { Metadata } from 'next';
import Link from 'next/link';

import { Badge } from '@/components/Badge';
import { AuthRequiredPanel, ApiErrorPanel, EmptyState } from '@/components/EmptyState';
import { OperatorsIcon } from '@/components/icons';
import { KpiCard } from '@/components/KpiCard';
import { PageHeader } from '@/components/PageHeader';
import { Panel } from '@/components/Panel';
import { formatDate, formatDateTime, formatInteger, plural } from '@/lib/format';
import { isAuthError, safeServerFetch } from '@/lib/api-server';
import type { OperariosResponse } from '@/types/optiflow';

export const metadata: Metadata = { title: 'Operarios' };
export const dynamic = 'force-dynamic';

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0))
    .join('')
    .toUpperCase();
}

export default async function OperariosPage() {
  const result = await safeServerFetch<OperariosResponse>('/api/operarios?todos=1');

  const header = (
    <PageHeader
      eyebrow="Maestros · Personal"
      title="Maestro de operarios"
      description="Nómina de planta con estado, etapas históricas y actividad abierta. El alta y la edición se mantienen en el panel de administración existente."
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

  const operarios = result.data.operarios;
  const activos = operarios.filter((op) => op.activo).length;
  const inactivos = operarios.length - activos;
  const conEtapas = operarios.filter((op) => (op.etapas_abiertas ?? 0) > 0).length;
  const etapasAbiertas = operarios.reduce((sum, op) => sum + (op.etapas_abiertas ?? 0), 0);

  return (
    <>
      {header}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Operarios"
          value={formatInteger(operarios.length)}
          hint={`${formatInteger(activos)} ${plural(activos, 'activo', 'activos')} · ${formatInteger(inactivos)} ${plural(inactivos, 'inactivo', 'inactivos')}`}
          tone="neutral"
          icon={<OperatorsIcon className="h-5 w-5" />}
        />
        <KpiCard label="Activos" value={formatInteger(activos)} hint="Pueden iniciar etapas" tone="cian" />
        <KpiCard
          label="Con etapas abiertas"
          value={formatInteger(conEtapas)}
          hint={`${formatInteger(etapasAbiertas)} ${plural(etapasAbiertas, 'etapa en curso', 'etapas en curso')}`}
          tone={conEtapas > 0 ? 'warning' : 'neutral'}
        />
        <KpiCard label="Inactivos" value={formatInteger(inactivos)} hint="Conservan su historial" tone="neutral" />
      </div>

      <Panel
        title="Nómina de planta"
        description={`${formatInteger(operarios.length)} ${plural(operarios.length, 'operario en el maestro', 'operarios en el maestro')}`}
        className="mt-4"
        bodyClassName="p-0"
      >
        {operarios.length === 0 ? (
          <EmptyState
            title="No hay operarios cargados"
            description="El maestro de personal está vacío. El alta se realiza desde el panel de administración."
            className="border-0 bg-transparent"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table min-w-[900px]">
              <caption className="sr-only">Maestro de operarios</caption>
              <thead>
                <tr>
                  <th scope="col">Operario</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Etapas históricas</th>
                  <th scope="col">Etapas abiertas</th>
                  <th scope="col">Última actividad</th>
                  <th scope="col">Alta</th>
                </tr>
              </thead>
              <tbody>
                {operarios.map((operario) => (
                  <tr key={operario.id}>
                    <td>
                      <div className="flex items-center gap-3">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/5 font-mono text-xs font-semibold text-slate-300">
                          {initials(operario.nombre)}
                        </span>
                        <div className="min-w-0">
                          <p className="truncate text-sm text-white">{operario.nombre}</p>
                          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
                            ID {operario.id}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td>
                      <Badge tone={operario.activo ? 'success' : 'muted'} dot>
                        {operario.activo ? 'Activo' : 'Inactivo'}
                      </Badge>
                    </td>
                    <td className="font-mono text-sm text-slate-300">{formatInteger(operario.etapas ?? 0)}</td>
                    <td>
                      {(operario.etapas_abiertas ?? 0) > 0 ? (
                        <Badge tone="cian">{formatInteger(operario.etapas_abiertas)} abierta(s)</Badge>
                      ) : (
                        <span className="font-mono text-sm text-slate-500">0</span>
                      )}
                    </td>
                    <td className="font-mono text-xs text-slate-400">{formatDateTime(operario.ultima_actividad)}</td>
                    <td className="font-mono text-xs text-slate-400">{formatDate(operario.fecha_creacion)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
