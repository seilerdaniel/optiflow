import type { Metadata } from 'next';

import { TerminalFichaje } from '@/components/terminal/TerminalFichaje';

export const metadata: Metadata = { title: 'Terminal de planta' };
export const dynamic = 'force-dynamic';

interface TerminalPageProps {
  searchParams: Promise<{ ot?: string | string[] }>;
}

export default async function TerminalPage({ searchParams }: TerminalPageProps) {
  const params = await searchParams;
  const raw = Array.isArray(params.ot) ? params.ot[0] : params.ot;
  const trimmed = raw?.trim();
  const initialOt = trimmed && /^\d+$/.test(trimmed) ? Number(trimmed) : null;

  return <TerminalFichaje initialOt={initialOt} />;
}
