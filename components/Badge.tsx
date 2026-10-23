import type { ReactNode } from 'react';

export type BadgeTone =
  | 'neutral'
  | 'muted'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger'
  | 'placares'
  | 'cocinas'
  | 'cian';

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'border-white/15 bg-white/5 text-slate-300',
  muted: 'border-white/10 bg-transparent text-slate-500',
  info: 'border-placares/40 bg-placares/15 text-blue-200',
  success: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200',
  warning: 'border-amber-400/30 bg-amber-400/10 text-amber-200',
  danger: 'border-cocinas/40 bg-cocinas/15 text-red-200',
  placares: 'border-placares/40 bg-placares/15 text-blue-200',
  cocinas: 'border-cocinas/40 bg-cocinas/15 text-red-200',
  cian: 'border-cian/40 bg-cian/10 text-cyan-200',
};

export interface BadgeProps {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
  /** Punto de estado a la izquierda, útil en tablas. */
  dot?: boolean;
}

export function Badge({ children, tone = 'neutral', className = '', dot = false }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] ${TONE_CLASSES[tone]} ${className}`}
    >
      {dot ? <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}
