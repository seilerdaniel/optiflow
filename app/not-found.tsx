import Link from 'next/link';

import { BrandMark } from '@/components/icons';

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-16">
      <div className="panel w-full max-w-lg p-8 text-center">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-cian/30 bg-cian/10 text-cian">
          <BrandMark className="h-7 w-7" />
        </span>
        <p className="mt-5 font-mono text-[11px] uppercase tracking-[0.2em] text-cian">Error 404</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-white">Página no encontrada</h1>
        <p className="mt-2 text-sm leading-6 text-slate-400">
          La ruta que buscás no existe en esta fase de la migración. Las pantallas disponibles son el dashboard, las
          OTs, Oficina Técnica, los maestros, calidad, mantenimiento y la terminal.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Link className="btn btn-primary" href="/admin/dashboard">
            Ir al dashboard
          </Link>
          <Link className="btn btn-ghost" href="/terminal">
            Ir a la terminal
          </Link>
        </div>
      </div>
    </main>
  );
}
