import type { ComponentType, SVGProps } from 'react';

import {
  DashboardIcon,
  DespieceIcon,
  MaintenanceIcon,
  MaterialsIcon,
  OperatorsIcon,
  OrdersIcon,
  QualityIcon,
  SectorsIcon,
  TerminalIcon,
} from '@/components/icons';

export interface NavItem {
  href: string;
  label: string;
  description: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** El enlace vive fuera del shell administrativo. */
  externalShell?: boolean;
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

export const navSections: NavSection[] = [
  {
    title: 'Planta',
    items: [
      {
        href: '/admin/dashboard',
        label: 'Dashboard',
        description: 'KPIs, metas de corte y estado del piso.',
        icon: DashboardIcon,
      },
      {
        href: '/admin/ordenes',
        label: 'Órdenes de trabajo',
        description: 'Listado de OTs, avance y hojas de ruta.',
        icon: OrdersIcon,
      },
      {
        href: '/admin/oficina-tecnica/despiece',
        label: 'Oficina Técnica',
        description: 'Despiece, bultos y pañol de herrajes.',
        icon: DespieceIcon,
      },
      {
        href: '/terminal',
        label: 'Terminal de planta',
        description: 'Fichado táctil de etapas.',
        icon: TerminalIcon,
        externalShell: true,
      },
    ],
  },
  {
    title: 'Maestros',
    items: [
      {
        href: '/admin/materiales',
        label: 'Materiales',
        description: 'Catálogo de placas por espesor y color.',
        icon: MaterialsIcon,
      },
      {
        href: '/admin/operarios',
        label: 'Operarios',
        description: 'Maestro de personal y actividad.',
        icon: OperatorsIcon,
      },
      {
        href: '/admin/sectores',
        label: 'Sectores y flujos',
        description: 'Orden de producción por línea.',
        icon: SectorsIcon,
      },
    ],
  },
  {
    title: 'Control',
    items: [
      {
        href: '/admin/calidad',
        label: 'Calidad',
        description: 'No conformidades, reprocesos y FTT.',
        icon: QualityIcon,
      },
      {
        href: '/admin/mantenimiento',
        label: 'Mantenimiento',
        description: 'TPM por horas netas de uso.',
        icon: MaintenanceIcon,
      },
    ],
  },
];

export function isNavItemActive(pathname: string, item: NavItem): boolean {
  if (item.href === '/admin/dashboard') {
    return pathname === '/admin' || pathname === '/admin/dashboard';
  }
  if (item.href === '/terminal') {
    return pathname === '/terminal';
  }
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}
