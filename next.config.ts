import type { NextConfig } from 'next';

/**
 * Origen del API legado (Express/Postgres).
 *
 * Fase 1: Next.js es la capa de presentación y el servidor Node sigue siendo
 * la fuente de verdad de las reglas de negocio (R1-R22, horas-hombre, 409 de
 * sesión activa, auto-cierre de OTs y metas). El rewrite mantiene las cookies
 * de sesión en el mismo origen del navegador.
 *
 * En producción, `OPTIFLOW_API_ORIGIN` debe apuntar al API desplegado.
 */
const apiOrigin = process.env.OPTIFLOW_API_ORIGIN ?? 'http://127.0.0.1:3000';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${apiOrigin}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
