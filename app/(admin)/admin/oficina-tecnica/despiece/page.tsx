import type { Metadata } from 'next';
import Link from 'next/link';

import { DespieceEditor } from '@/components/despiece/DespieceEditor';
import { NuevaOTForm } from '@/components/despiece/NuevaOTForm';
import { AuthRequiredPanel, ApiErrorPanel, EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { Panel } from '@/components/Panel';
import { formatInteger, plural } from '@/lib/format';
import { isAuthError, safeServerFetch } from '@/lib/api-server';
import type {
  DespieceOT,
  OrdenesResponse,
  OrdenTrabajo,
  UsuarioActualResponse,
} from '@/types/optiflow';

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
      description={`${formatInteger(ordenes.length)} ${plural(ordenes.length, 'orden disponible', 'órdenes disponibles')}. Elegí la OT para cargar el despiece, los herrajes del pañol y el control de bultos.`}
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

  const [ordenesResult, despieceResult, usuarioResult] = await Promise.all([
    safeServerFetch<OrdenesResponse>('/api/ordenes'),
    otId ? safeServerFetch<DespieceOT>(`/api/ot/${otId}/despiece`) : Promise.resolve(null),
    safeServerFetch<UsuarioActualResponse>('/api/auth/usuario'),
  ]);

  const rol = usuarioResult.ok ? usuarioResult.data.usuario?.rol : null;
  const puedeGestionar = rol === 'admin' || rol === 'encargado';

  const header = (
    <PageHeader
      eyebrow="Oficina Técnica · Despiece"
      title="Creación de OT, despiece y hoja de ruta"
      description="Alta de la OT, grilla de piezas con observaciones, lista de herrajes para el pañol, control de bultos para logística y hoja A4 imprimible con QR."
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
  const formAlta = puedeGestionar ? <NuevaOTForm abrir={!otId} /> : null;

  if (otInvalida) {
    return (
      <>
        {header}
        <div className="space-y-4">
          {formAlta}
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
          {formAlta}
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
          {formAlta}
          <OtSelector ordenes={ordenes} otId={null} />
          <EmptyState
            title="Seleccioná una OT para cargar el despiece"
            description="El flujo continúa con la grilla de piezas y observaciones, la lista de herrajes del pañol, el control de bultos para logística y la hoja A4 con QR."
          />
        </div>
      </>
    );
  }

  return (
    <>
      {header}
      <div className="mb-4 space-y-4">
        {formAlta}
        <OtSelector ordenes={ordenes} otId={otId} />
      </div>
      <DespieceEditor
        key={despieceResult.data.ot.id}
        data={despieceResult.data}
        puedeGestionar={puedeGestionar}
      />
    </>
  );
}
