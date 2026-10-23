import type { BadgeTone } from '@/components/Badge';
import type { EstadoNoConformidad, EstadoOT, EstadoTPM, LineaOT } from '@/types/optiflow';

export function toneForEstadoOT(estado: EstadoOT): BadgeTone {
  switch (estado) {
    case 'En Producción':
      return 'cian';
    case 'Detenido':
      return 'danger';
    case 'Finalizado':
      return 'success';
    case 'En Cola':
    default:
      return 'neutral';
  }
}

export function toneForEstadoNC(estado: EstadoNoConformidad): BadgeTone {
  switch (estado) {
    case 'Pendiente':
      return 'warning';
    case 'En Reproceso':
      return 'danger';
    case 'Resuelto':
      return 'success';
    case 'Descartado':
    default:
      return 'muted';
  }
}

export function toneForEstadoTPM(estado: EstadoTPM): BadgeTone {
  switch (estado) {
    case 'critico':
      return 'danger';
    case 'advertencia':
      return 'warning';
    case 'ok':
    default:
      return 'success';
  }
}

export function toneForLinea(linea: LineaOT): BadgeTone {
  return linea === 'Cocinas' ? 'cocinas' : 'placares';
}

export function labelEstadoTPM(estado: EstadoTPM): string {
  switch (estado) {
    case 'critico':
      return 'Crítico';
    case 'advertencia':
      return 'Advertencia';
    case 'ok':
    default:
      return 'Al día';
  }
}
