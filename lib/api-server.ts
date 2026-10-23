import { cookies } from 'next/headers';

import { ApiError, requestJson } from '@/lib/api';
import type {
  DespieceOT,
  EstadoPlanta,
  MaterialCatalogoResponse,
  MetricasObjetivo,
  OperariosResponse,
  OrdenesResponse,
  QMSResponse,
  SectoresResponse,
  TPMResponse,
} from '@/types/optiflow';

/**
 * Origen absoluto del API legado, sólo accesible desde el servidor.
 * En desarrollo: `npm run dev:api` escucha en 127.0.0.1:3000.
 */
const API_ORIGIN = process.env.OPTIFLOW_API_ORIGIN ?? 'http://127.0.0.1:3000';

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status: number | null; detail: unknown };

/**
 * Server-side fetch con reenvío de la cookie de sesión.
 *
 * Las reglas de negocio (incluido el 409 de sesión activa) las sigue
 * resolviendo el API Node/PostgreSQL. Next.js sólo presenta el resultado.
 */
export async function serverFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const cookieHeader = (await cookies()).toString();
  const normalized = path.startsWith('/') ? path : `/${path}`;

  return requestJson<T>(`${API_ORIGIN}${normalized}`, {
    ...init,
    cache: 'no-store',
    headers: {
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
      ...init.headers,
    },
  });
}

export async function safeServerFetch<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  try {
    return { ok: true, data: await serverFetch<T>(path, init) };
  } catch (error) {
    if (error instanceof ApiError) {
      return {
        ok: false,
        error: error.message,
        status: error.status,
        detail: error.detail,
      };
    }

    return {
      ok: false,
      error: 'Error inesperado al consultar el API.',
      status: null,
      detail: error,
    };
  }
}

export function isAuthError(result: ApiResult<unknown>): boolean {
  return !result.ok && result.status === 401;
}

export function isConnectionError(result: ApiResult<unknown>): boolean {
  return !result.ok && result.status === 0;
}

/* ------------------------------------------------------------------ */
/* Lecturas tipadas                                                    */
/* ------------------------------------------------------------------ */

export function getObjetivoCorte(periodo?: string): Promise<MetricasObjetivo> {
  const query = periodo ? `?periodo=${encodeURIComponent(periodo)}` : '';
  return serverFetch<MetricasObjetivo>(`/api/metricas/objetivo-corte${query}`);
}

export function getEstadoPlanta(): Promise<EstadoPlanta> {
  return serverFetch<EstadoPlanta>('/api/estado');
}

export function getOrdenes(query = ''): Promise<OrdenesResponse> {
  return serverFetch<OrdenesResponse>(`/api/ordenes${query}`);
}

export function getSectores(todos = false): Promise<SectoresResponse> {
  return serverFetch<SectoresResponse>(`/api/sectores${todos ? '?todos=1' : ''}`);
}

export function getOperarios(todos = true): Promise<OperariosResponse> {
  return serverFetch<OperariosResponse>(`/api/operarios${todos ? '?todos=1' : ''}`);
}

export function getMaterialesCatalogo(query = ''): Promise<MaterialCatalogoResponse> {
  return serverFetch<MaterialCatalogoResponse>(`/api/materiales/catalogo${query}`);
}

export function getQMS(query = ''): Promise<QMSResponse> {
  return serverFetch<QMSResponse>(`/api/qms/no-conformidades${query}`);
}

export function getTPM(): Promise<TPMResponse> {
  return serverFetch<TPMResponse>('/api/tpm');
}

export function getDespiece(otId: number): Promise<DespieceOT> {
  return serverFetch<DespieceOT>(`/api/ot/${otId}/despiece`);
}
