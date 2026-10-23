'use client';

import { useEffect } from 'react';
import Link from 'next/link';

/**
 * Barra de acciones de la hoja imprimible.
 *
 * El `document.body` recibe la clase `hoja-ruta-activa` mientras esta ruta está
 * montada: TODAS las reglas de impresión cuelgan de esa clase, así el CSS de la
 * hoja A4 no puede tocar el Dashboard ni la Terminal táctil. Con `?auto=1`
 * (el botón de Oficina Técnica) se abre el diálogo de impresión una sola vez.
 */
export function PrintToolbar({ otId }: { otId: number }) {
  useEffect(() => {
    document.body.classList.add('hoja-ruta-activa');

    const auto = new URLSearchParams(window.location.search).get('auto') === '1';
    const timer = auto ? window.setTimeout(() => window.print(), 450) : null;

    return () => {
      if (timer !== null) window.clearTimeout(timer);
      document.body.classList.remove('hoja-ruta-activa');
    };
  }, []);

  return (
    <div className="no-print mx-auto mb-4 flex w-full max-w-[210mm] flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-grafito/80 px-4 py-3">
      <div className="min-w-0">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-slate-400">Vista de impresión</p>
        <p className="text-sm text-white">Hoja de ruta y despiece · A4</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Link className="btn btn-ghost" href={`/admin/oficina-tecnica/despiece?ot=${otId}`}>
          Volver a Oficina Técnica
        </Link>
        <button type="button" className="btn btn-primary" onClick={() => window.print()}>
          🖨️ Imprimir hoja
        </button>
      </div>
    </div>
  );
}
