import type { ReactNode } from 'react';

import { AlertIcon, BrandMark, LoginIcon } from '@/components/icons';

export type EmptyTone = 'empty' | 'auth' | 'error';

const TONE_STYLES: Record<EmptyTone, { icon: string; ring: string }> = {
  empty: { icon: 'bg-white/5 text-slate-300', ring: 'border-white/10' },
  auth: { icon: 'bg-cian/10 text-cyan-200', ring: 'border-cian/30' },
  error: { icon: 'bg-cocinas/15 text-red-200', ring: 'border-cocinas/30' },
};

export interface EmptyStateProps {
  title: string;
  description: string;
  action?: ReactNode;
  icon?: ReactNode;
  tone?: EmptyTone;
  className?: string;
}

export function EmptyState({
  title,
  description,
  action,
  icon,
  tone = 'empty',
  className = '',
}: EmptyStateProps) {
  const styles = TONE_STYLES[tone];
  const fallbackIcon =
    tone === 'auth' ? (
      <LoginIcon className="h-6 w-6" />
    ) : tone === 'error' ? (
      <AlertIcon className="h-6 w-6" />
    ) : (
      <BrandMark className="h-6 w-6" />
    );

  return (
    <div
      className={`flex flex-col items-center justify-center rounded-xl border border-dashed ${styles.ring} bg-white/[0.02] px-6 py-12 text-center ${className}`}
    >
      <span className={`flex h-12 w-12 items-center justify-center rounded-xl ${styles.icon}`}>
        {icon ?? fallbackIcon}
      </span>
      <h2 className="mt-4 text-base font-semibold text-white">{title}</h2>
      <p className="mt-2 max-w-xl text-sm leading-6 text-slate-400">{description}</p>
      {action ? <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}

export function AuthRequiredPanel({
  message = 'Iniciá sesión para consultar la información de planta. El API conserva las cookies y las reglas de acceso existentes.',
}: {
  message?: string;
}) {
  return (
    <EmptyState
      tone="auth"
      title="Sesión requerida"
      description={message}
      action={
        <a className="btn btn-primary" href="/login.html">
          <LoginIcon className="h-4 w-4" />
          Iniciar sesión
        </a>
      }
    />
  );
}

export function ApiErrorPanel({
  message,
  status,
}: {
  message: string;
  status: number | null;
}) {
  const hint =
    status === 0
      ? 'En desarrollo, `npm run dev` levanta el API en el puerto 3000 y Next.js en el 3001.'
      : `Estado HTTP: ${status ?? 'desconocido'}. Podés recargar la página o revisar el log del servidor.`;

  return (
    <EmptyState
      tone="error"
      title="No se pudo cargar la información"
      description={`${message} ${hint}`}
      action={
        <a className="btn btn-ghost" href="">
          Recargar
        </a>
      }
    />
  );
}
