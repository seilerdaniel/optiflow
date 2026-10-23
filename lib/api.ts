/**
 * Cliente HTTP compartido por Server Components y Client Components.
 *
 * - En el navegador se usan rutas relativas (`/api/...`). El rewrite de
 *   `next.config.ts` las envía al API legado conservando la cookie de sesión.
 * - En el servidor, `lib/api-server.ts` arma la URL absoluta y reenvía la
 *   cookie del request original.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly detail: unknown;

  constructor(message: string, status: number, detail: unknown = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

/**
 * El API devuelve 409 cuando una regla de negocio impide la operación:
 * sesión activa (R1), sector ocupado (R2), OT finalizada (R5), flujo
 * incompleto (R6), sector desactivado (R7), línea incorrecta (R8), etc.
 * La UI debe mostrar el mensaje y la acción sugerida, nunca reintentar sola.
 */
export class SessionConflictError extends ApiError {
  constructor(message: string, detail: unknown = null) {
    super(message, 409, detail);
    this.name = 'SessionConflictError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorMessage(payload: unknown, status: number): string {
  if (isRecord(payload) && typeof payload.error === 'string' && payload.error.trim()) {
    return payload.error;
  }
  return `El API respondió con estado ${status}.`;
}

export async function requestJson<T>(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<T> {
  let response: Response;

  try {
    response = await fetch(input, {
      ...init,
      cache: init.cache ?? 'no-store',
      headers: {
        Accept: 'application/json',
        ...(typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch (error) {
    throw new ApiError(
      'No se pudo conectar con el API de OptiFlow. Verificá que el servidor legado esté en ejecución.',
      0,
      error,
    );
  }

  const text = await response.text();
  let payload: unknown = null;

  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = text;
    }
  }

  if (response.status === 409) {
    throw new SessionConflictError(
      errorMessage(payload, response.status),
      isRecord(payload) && 'detalle' in payload ? payload.detalle : payload,
    );
  }

  if (!response.ok) {
    const detail = isRecord(payload) && 'detalle' in payload ? payload.detalle : null;
    throw new ApiError(errorMessage(payload, response.status), response.status, detail);
  }

  return payload as T;
}

/** Fetch del navegador: same-origin a través del rewrite de Next.js. */
export function browserApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  return requestJson<T>(path, {
    ...init,
    credentials: 'include',
  });
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}
