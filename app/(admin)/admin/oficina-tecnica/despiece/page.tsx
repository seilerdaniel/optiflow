import type { Metadata } from 'next';
import Link from 'next/link';

import { DespieceView } from '@/components/despiece/DespieceView';
import { AuthRequiredPanel, ApiErrorPanel, EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { Panel } from '@/components/Panel';
import { formatInteger, plural } from '@/lib/format';
import { isAuthError, safeServerFetch } from '@/lib/api-server';
import type { DespieceOT, OrdenesResponse, OrdenTrabajo } from '@/types/optiflow';

export const metadata: Metadata = { title: 'Oficina Técnica · Despiece' };
export const dynamic = 'force-dynamic';

interface DespiecePageProps {
  searchParams: Promise<{ ot?: string }>;
}

function sortOrders(orders: OrdenTrabajo[]): OrdenTrabajo[] {
  return [...orders].sort((a, b) => {
    const aFinalizada = a.estado_general === 'Finalizado' ? 1 : 0;
    const bFinalizada = b.estado_general === 'Finalizado' ? 1 : 0;
    if (aFinalizada !== bFinalizada) return aFinalizada - bFinalizada;
    return b.numero_ot.localeCompare(a.numero_ot, 'es', { numeric: true });
  });
}

function OtSelector({ ordenes, otId }: { ordenes: OrdenTrabajo[]; otId: number | null }) {
  return (
    <Panel
      title="Seleccionar OT"
      description={`${formatInteger(ordenes.length)} ${plural(ordenes.length, 'orden disponible', 'órdenes disponibles')}. El despiece se carga desde el API existente.`}
      actions={
        <Link className="text-xs font-medium text-cian hover:text-cyan-300" href="/admin/ordenes">
          Ver listado completo
        </Link>
      }
    >
      <form method="get" className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="block min-w-0 flex-1">
          <span className="label">Orden de trabajo</span>
          <select name="ot" defaultValue={otId ? String(otId) : ''} className="select mt-1.5">
            <option value="">Seleccioná una OT…</option>
            {ordenes.map((ot) => (
              <option key={ot.id} value={ot.id}>
                {ot.numero_ot} · {ot.cliente} · {ot.linea_area}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn btn-primary shrink-0">
          Cargar despiece
        </button>
      </form>
    </Panel>
  );
}

export default async function DespiecePage({ searchParams }: DespiecePageProps) {
  const params = await searchParams;
  const otParam = params.ot?.trim();
  const otId = otParam && /^\d+$/.test(otParam) ? Number(otParam) : null;
  const otInvalida = Boolean(otParam) && otId === null;

  const [ordenesResult, despieceResult] = await Promise.all([
    safeServerFetch<OrdenesResponse>('/api/ordenes'),
    otId ? safeServerFetch<DespieceOT>(`/api/ot/${otId}/despiece`) : Promise.resolve(null),
  ]);

  const header = (
    <PageHeader
      eyebrow="Oficina Técnica · Despiece"
      title="Despiece, bultos y pañol"
      description="Vista dedicada del despiece por módulo, el control de flete por bulto y la lista de herrajes del pañol. La edición sigue en el API existente hasta la Fase 2."
      actions={
        <>
          <Link className="btn btn-ghost" href="/admin/dashboard">
            Dashboard
          </Link>
          <Link className="btn btn-primary" href="/terminal">
            Terminal de planta
          </Link>
        </>
      }
    />
  );

  if (!ordenesResult.ok && isAuthError(ordenesResult)) {
    return (
      <>
        {header}
        <AuthRequiredPanel />
      </>
    );
  }

  if (!ordenesResult.ok) {
    return (
      <>
        {header}
        <ApiErrorPanel message={ordenesResult.error} status={ordenesResult.status} />
      </>
    );
  }

  const ordenes = sortOrders(ordenesResult.data.ordenes);

  if (otInvalida) {
    return (
      <>
        {header}
        <div className="space-y-4">
          <OtSelector ordenes={ordenes} otId={null} />
          <EmptyState
            tone="error"
            title="Identificador de OT inválido"
            description="El parámetro `ot` debe ser un número entero. Escaneá nuevamente el QR o elegí una OT del listado."
          />
        </div>
      </>
    );
  }

  if (despieceResult && !despieceResult.ok) {
    if (isAuthError(despieceResult)) {
      return (
        <>
          {header}
          <AuthRequiredPanel />
        </>
      );
    }

    return (
      <>
        {header}
        <div className="space-y-4">
          <OtSelector ordenes={ordenes} otId={otId} />
          <ApiErrorPanel message={despieceResult.error} status={despieceResult.status} />
        </div>
      </>
    );
  }

  if (!despieceResult) {
    return (
      <>
        {header}
        <div className="space-y-4">
          <OtSelector ordenes={ordenes} otId={null} />
          <EmptyState
            title="Seleccioná una OT para ver el despiece"
            description="El módulo muestra los módulos y piezas, los bultos con su estado de flete, la lista de herrajes del pañol y el resumen de placas."
          />
        </div>
      </>
    );
  }

  return (
    <>
      {header}
      <div className="mb-4">
        <OtSelector ordenes={ordenes} otId={otId} />
      </div>
      <DespieceView data={despieceResult.data} />
    </>
  );
}
