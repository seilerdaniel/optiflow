import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';

import { HojaRuta } from '@/components/despiece/HojaRuta';
import { PrintToolbar } from '@/components/despiece/PrintToolbar';
import { isAuthError, safeServerFetch } from '@/lib/api-server';
import { qrSvg, qrUrlOT } from '@/lib/qr';
import type { DespieceOT } from '@/types/optiflow';

export const metadata: Metadata = {
  title: 'Hoja de ruta y despiece',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

interface HojaRutaPageProps {
  params: Promise<{ id: string }>;
}

function formatearFechaHora(fecha: Date): string {
  try {
    return new Intl.DateTimeFormat('es-AR', {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone: 'America/Argentina/Buenos_Aires',
    }).format(fecha);
  } catch {
    return fecha.toISOString();
  }
}

async function origenDelPedido(): Promise<string> {
  const configurado = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configurado) return configurado.replace(/\/$/, '');

  const h = await headers();
  const host = h.get('x-forwarded-host') || h.get('host') || 'localhost:3001';
  const proto = (h.get('x-forwarded-proto') || 'http').split(',')[0].trim();
  return `${proto}://${host}`;
}

export default async function HojaRutaPage({ params }: HojaRutaPageProps) {
  const { id } = await params;
  const otId = /^\d+$/.test(id) ? Number(id) : null;

  if (otId === null) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col items-center justify-center gap-4 px-6 text-center">
        <h1 className="text-lg font-semibold text-white">Identificador de OT inválido</h1>
        <p className="text-sm text-slate-400">La hoja de ruta necesita un id numérico de orden de trabajo.</p>
        <Link className="btn btn-primary" href="/admin/oficina-tecnica/despiece">
          Volver a Oficina Técnica
        </Link>
      </main>
    );
  }

  const [result, origin] = await Promise.all([
    safeServerFetch<DespieceOT>(`/api/ot/${otId}/despiece`),
    origenDelPedido(),
  ]);

  if (!result.ok) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col items-center justify-center gap-4 px-6 text-center">
        <h1 className="text-lg font-semibold text-white">
          {isAuthError(result) ? 'Sesión requerida' : 'No se pudo generar la hoja'}
        </h1>
        <p className="text-sm text-slate-400">{result.error}</p>
        <Link
          className="btn btn-primary"
          href={isAuthError(result) ? '/login.html' : `/admin/oficina-tecnica/despiece?ot=${otId}`}
        >
          {isAuthError(result) ? 'Iniciar sesión' : 'Volver a Oficina Técnica'}
        </Link>
      </main>
    );
  }

  const data = result.data;
  const urlQR = qrUrlOT(origin, data.ot.numero_ot);
  let svg = '';
  try {
    svg = qrSvg(urlQR, { px: 112, quiet: 2, label: `OT ${data.ot.numero_ot}` });
  } catch {
    svg = '';
  }

  return (
    <div className="hoja-ruta-pagina">
      <PrintToolbar otId={otId} />
      <HojaRuta
        data={data}
        qrSvg={svg}
        origin={origin}
        generadoEn={formatearFechaHora(new Date())}
      />
    </div>
  );
}
