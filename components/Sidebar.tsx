'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

import { BrandMark, CloseIcon, MenuIcon, TerminalIcon } from '@/components/icons';
import { isNavItemActive, navSections } from '@/lib/navigation';

export function Sidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Cerrar el drawer al navegar.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Cerrar con Escape y bloquear el scroll del fondo sólo en mobile.
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    const media = window.matchMedia('(max-width: 767px)');
    const previousOverflow = document.body.style.overflow;
    if (media.matches) document.body.style.overflow = 'hidden';

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  return (
    <>
      {/* Barra superior mobile */}
      <header className="fixed inset-x-0 top-0 z-40 flex h-16 items-center gap-3 border-b border-white/10 bg-antracita/95 px-4 backdrop-blur md:hidden">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="touch-target focus-ring -ml-2 flex items-center justify-center rounded-lg text-slate-200 hover:bg-white/5"
          aria-label="Abrir navegación"
          aria-expanded={open}
          aria-controls="admin-sidebar"
        >
          <MenuIcon className="h-6 w-6" />
        </button>

        <Link href="/admin/dashboard" className="focus-ring flex min-w-0 items-center gap-2.5 rounded-lg">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-cian/30 bg-cian/10 text-cian">
            <BrandMark className="h-5 w-5" />
          </span>
          <span className="truncate text-sm font-semibold tracking-tight text-white">OptiFlow</span>
        </Link>

        <Link
          href="/terminal"
          className="focus-ring ml-auto flex h-11 w-11 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-200 hover:bg-white/10"
          aria-label="Ir a la terminal de planta"
          title="Terminal de planta"
        >
          <TerminalIcon className="h-5 w-5" />
        </Link>
      </header>

      {/* Overlay del drawer */}
      {open ? (
        <div className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm md:hidden">
          <button
            type="button"
            className="absolute inset-0 h-full w-full cursor-default"
            onClick={() => setOpen(false)}
            aria-label="Cerrar menú"
          />
        </div>
      ) : null}

      <aside
        id="admin-sidebar"
        className={`fixed inset-y-0 left-0 z-50 flex w-[280px] flex-col border-r border-white/10 bg-antracita/95 backdrop-blur transition-transform duration-200 ease-out md:w-16 md:translate-x-0 lg:w-[260px] ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
        aria-label="Navegación administrativa"
      >
        {/* Marca */}
        <div className="flex h-16 shrink-0 items-center gap-3 border-b border-white/10 px-4 md:justify-center md:px-0 lg:justify-start lg:px-5">
          <Link
            href="/admin/dashboard"
            className="focus-ring flex min-w-0 items-center gap-3 rounded-lg"
            title="OptiFlow · Dashboard"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-cian/30 bg-cian/10 text-cian">
              <BrandMark className="h-5 w-5" />
            </span>
            <span className="min-w-0 block md:hidden lg:block">
              <span className="block truncate text-sm font-semibold tracking-tight text-white">
                OptiFlow
              </span>
              <span className="block truncate font-mono text-[10px] uppercase tracking-[0.16em] text-slate-500">
                De Otro Tiempo
              </span>
            </span>
          </Link>

          <button
            type="button"
            onClick={() => setOpen(false)}
            className="focus-ring ml-auto flex h-11 w-11 items-center justify-center rounded-lg text-slate-300 hover:bg-white/5 md:hidden"
            aria-label="Cerrar navegación"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        {/* Navegación */}
        <nav className="scrollbar-thin flex-1 overflow-y-auto px-3 py-4" aria-label="Secciones">
          {navSections.map((section, sectionIndex) => (
            <div key={section.title} className={sectionIndex > 0 ? 'mt-5' : ''}>
              <p className="block px-3 pb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500 md:hidden lg:block">
                {section.title}
              </p>
              <ul className="space-y-1">
                {section.items.map((item) => {
                  const active = isNavItemActive(pathname, item);
                  const Icon = item.icon;

                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        title={item.label}
                        aria-current={active ? 'page' : undefined}
                        className={`group relative flex min-h-12 items-center gap-3 rounded-lg px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cian focus-visible:ring-offset-2 focus-visible:ring-offset-antracita md:justify-center md:px-0 lg:justify-start lg:px-3 ${
                          active
                            ? 'bg-placares/20 text-white'
                            : 'text-slate-400 hover:bg-white/5 hover:text-slate-100'
                        }`}
                      >
                        <span
                          className={`absolute left-0 h-6 w-0.5 rounded-full bg-cian transition-opacity ${
                            active ? 'opacity-100' : 'opacity-0'
                          }`}
                          aria-hidden="true"
                        />
                        <Icon
                          className={`h-5 w-5 shrink-0 transition-colors ${
                            active ? 'text-cian' : 'text-slate-500 group-hover:text-slate-300'
                          }`}
                        />
                        <span className="min-w-0 block truncate md:hidden lg:block">
                          {item.label}
                        </span>
                        {item.externalShell ? (
                          <span className="ml-auto hidden font-mono text-[9px] uppercase tracking-[0.14em] text-slate-500 lg:block">
                            Planta
                          </span>
                        ) : null}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        {/* Pie */}
        <div className="shrink-0 border-t border-white/10 p-3">
          <div className="flex items-center gap-2 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2.5 md:justify-center md:px-0 lg:justify-start lg:px-3">
            <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
              <span className="absolute inline-flex h-full w-full rounded-full bg-cian opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-cian" />
            </span>
            <span className="min-w-0 block md:hidden lg:block">
              <span className="block truncate text-[11px] font-medium text-slate-300">Planta conectada</span>
              <span className="block truncate font-mono text-[9px] uppercase tracking-[0.14em] text-slate-500">
                v7.0 · Fase 1
              </span>
            </span>
          </div>
        </div>
      </aside>
    </>
  );
}
