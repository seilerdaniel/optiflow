import type { ReactNode } from 'react';

import { Sidebar } from '@/components/Sidebar';

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen">
      <Sidebar />
      <div className="md:pl-16 lg:pl-[260px]">
        <main className="mx-auto w-full max-w-[1600px] px-4 pb-16 pt-20 sm:px-6 md:pt-8 lg:px-8">
          {children}
        </main>
        <footer className="mx-auto w-full max-w-[1600px] px-4 pb-8 text-center font-mono text-[10px] uppercase tracking-[0.16em] text-slate-600 sm:px-6 lg:px-8">
          OptiFlow · De Otro Tiempo · Fase 1 Next.js
        </footer>
      </div>
    </div>
  );
}
