import type { ReactNode } from 'react';

export type KpiTone = 'neutral' | 'placares' | 'cocinas' | 'cian' | 'warning';

const TONE_BORDER: Record<KpiTone, string> = {
  neutral: 'border-white/10',
  placares: 'border-placares/40',
  cocinas: 'border-cocinas/40',
  cian: 'border-cian/40',
  warning: 'border-amber-400/40',
};

const TONE_ICON: Record<KpiTone, string> = {
  neutral: 'bg-white/5 text-slate-300',
  placares: 'bg-placares/15 text-blue-200',
  cocinas: 'bg-cocinas/15 text-red-200',
  cian: 'bg-cian/10 text-cyan-200',
  warning: 'bg-amber-400/10 text-amber-200',
};

export interface KpiCardProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: KpiTone;
  icon?: ReactNode;
}

export function KpiCard({ label, value, hint, tone = 'neutral', icon }: KpiCardProps) {
  return (
    <article className={`panel border-l-2 ${TONE_BORDER[tone]} p-5`}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="label">{label}</p>
          <p className="stat-value mt-2">{value}</p>
        </div>
        {icon ? (
          <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${TONE_ICON[tone]}`}>
            {icon}
          </span>
        ) : null}
      </div>
      {hint ? <div className="mt-3 text-xs text-slate-400">{hint}</div> : null}
    </article>
  );
}
