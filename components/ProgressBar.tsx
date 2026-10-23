import { clampPercent, formatPercent } from '@/lib/format';

export type ProgressTone = 'cian' | 'placares' | 'cocinas' | 'success' | 'warning' | 'danger';

const TONE_CLASSES: Record<ProgressTone, string> = {
  cian: 'bg-cian',
  placares: 'bg-placares',
  cocinas: 'bg-cocinas',
  success: 'bg-emerald-400',
  warning: 'bg-amber-400',
  danger: 'bg-cocinas',
};

export interface ProgressBarProps {
  /** Porcentaje ya calculado (0-100). */
  value: number | null | undefined;
  tone?: ProgressTone;
  label?: string;
  showValue?: boolean;
  className?: string;
}

export function ProgressBar({
  value,
  tone = 'cian',
  label,
  showValue = false,
  className = '',
}: ProgressBarProps) {
  const safeValue = clampPercent(value);

  return (
    <div className={className}>
      {label || showValue ? (
        <div className="mb-1.5 flex items-center justify-between gap-3 text-xs text-slate-400">
          {label ? <span>{label}</span> : <span />}
          {showValue ? <span className="font-mono text-slate-300">{formatPercent(value)}</span> : null}
        </div>
      ) : null}
      <div
        className="h-2 overflow-hidden rounded-full bg-white/10"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(safeValue)}
        aria-label={label ?? 'Progreso'}
      >
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${TONE_CLASSES[tone]}`}
          style={{ width: `${safeValue}%` }}
        />
      </div>
    </div>
  );
}
