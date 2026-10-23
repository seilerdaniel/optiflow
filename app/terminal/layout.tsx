import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Terminal de planta',
  description: 'Terminal táctil de fichado de etapas de producción.',
};

export default function TerminalLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-screen">{children}</div>;
}
