import { redirect } from 'next/navigation';

/**
 * La raíz histórica de OptiFlow es la terminal de fichado. Se conserva ese
 * destino para que los accesos directos y el QR de planta sigan funcionando.
 */
export default function RootPage() {
  redirect('/terminal');
}
