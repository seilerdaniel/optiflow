'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { Badge } from '@/components/Badge';
import { ApiErrorPanel, AuthRequiredPanel, EmptyState } from '@/components/EmptyState';
import { BrandMark, ClockIcon, TerminalIcon } from '@/components/icons';
import { ApiError, browserApi } from '@/lib/api';
import { formatDateTime, formatInteger, plural } from '@/lib/format';
import type {
  EstadoPlanta,
  IniciarEtapaResponse,
  Operario,
  OperariosResponse,
  OrdenesResponse,
  OrdenTrabajo,
  RegistroTiempo,
  SectoresResponse,
  Sector,
} from '@/types/optiflow';

type LoadState = 'loading' | 'ready' | 'auth' | 'error';

type Feedback = {
  tone: 'success' | 'error' | 'warning';
  title: string;
  message: string;
  detail?: string;
};

const AREA_ORDER = ['Placares', 'Cocinas', 'Compartido', 'General'] as const;

function detailAction(detail: unknown): string | undefined {
  if (typeof detail !== 'object' || detail === null) return undefined;
  const record = detail as Record<string, unknown>;

  if (typeof record.accion === 'string' && record.accion.trim()) {
    return record.accion;
  }

  if (Array.isArray(record.sectores_faltantes)) {
    const names = record.sectores_faltantes
      .map((item) => {
        if (typeof item === 'object' && item !== null && 'nombre_sector' in item) {
          const name = (item as { nombre_sector?: unknown }).nombre_sector;
          return typeof name === 'string' ? name : null;
        }
        return null;
      })
      .filter((name): name is string => Boolean(name));

    if (names.length) return `Antes deben finalizar: ${names.join(', ')}.`;
  }

  return undefined;
}

function sortOrders(orders: OrdenTrabajo[]): OrdenTrabajo[] {
  return [...orders].sort((a, b) => a.numero_ot.localeCompare(b.numero_ot, 'es', { numeric: true }));
}

function sortSectors(sectors: Sector[]): Sector[] {
  return [...sectors].sort((a, b) => a.orden_flujo - b.orden_flujo || a.id - b.id);
}

export function TerminalFichaje({ initialOt }: { initialOt: number | null }) {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [loadError, setLoadError] = useState('');
  const [loadStatus, setLoadStatus] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [ordenes, setOrdenes] = useState<OrdenTrabajo[]>([]);
  const [sectores, setSectores] = useState<Sector[]>([]);
  const [operarios, setOperarios] = useState<Operario[]>([]);
  const [estado, setEstado] = useState<EstadoPlanta | null>(null);

  const [selectedOt, setSelectedOt] = useState(initialOt ? String(initialOt) : '');
  const [selectedSector, setSelectedSector] = useState('');
  const [operarioNombre, setOperarioNombre] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [finalizingId, setFinalizingId] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    if (initialOt) setSelectedOt(String(initialOt));
  }, [initialOt]);

  useEffect(() => {
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      setLoadState('loading');
      setLoadError('');
      setLoadStatus(null);

      const [ordersResult, sectorsResult, operatorsResult, stateResult] = await Promise.allSettled([
        browserApi<OrdenesResponse>('/api/ordenes'),
        browserApi<SectoresResponse>('/api/sectores'),
        browserApi<OperariosResponse>('/api/operarios'),
        browserApi<EstadoPlanta>('/api/estado'),
      ]);

      if (cancelled) return;

      const allResults = [ordersResult, sectorsResult, operatorsResult, stateResult];
      const authFailure = allResults.some(
        (result) =>
          result.status === 'rejected' &&
          result.reason instanceof ApiError &&
          result.reason.status === 401,
      );

      if (authFailure) {
        setLoadState('auth');
        return;
      }

      const failure = allResults.find((result) => result.status === 'rejected');
      if (failure && failure.status === 'rejected') {
        const reason = failure.reason;
        setLoadError(reason instanceof Error ? reason.message : 'No se pudo conectar con el API.');
        setLoadStatus(reason instanceof ApiError ? reason.status : null);
        setLoadState('error');
        return;
      }

      if (
        ordersResult.status !== 'fulfilled' ||
        sectorsResult.status !== 'fulfilled' ||
        operatorsResult.status !== 'fulfilled' ||
        stateResult.status !== 'fulfilled'
      ) {
        setLoadError('El API devolvió una respuesta incompleta.');
        setLoadState('error');
        return;
      }

      setOrdenes(ordersResult.value.ordenes);
      setSectores(sectorsResult.value.sectores);
      setOperarios(operatorsResult.value.operarios);
      setEstado(stateResult.value);
      setOperarioNombre((current) => {
        if (current) return current;
        const saved = window.localStorage.getItem('optiflow.operario');
        return saved ?? '';
      });
      setLoadState('ready');
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const activeOrders = useMemo(
    () => sortOrders(ordenes.filter((ot) => ot.estado_general !== 'Finalizado')),
    [ordenes],
  );

  const activeSectors = useMemo(() => sortSectors(sectores.filter((sector) => sector.activo)), [sectores]);

  const activeOperarios = useMemo(
    () =>
      [...operarios]
        .filter((operario) => operario.activo)
        .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')),
    [operarios],
  );

  const selectedOrder = activeOrders.find((ot) => String(ot.id) === selectedOt) ?? null;
  const scannedOrderMissing = Boolean(initialOt) && !activeOrders.some((ot) => ot.id === initialOt);

  const applicableSectors = useMemo(() => {
    if (!selectedOrder) return activeSectors;
    return activeSectors.filter(
      (sector) =>
        sector.linea_area === selectedOrder.linea_area ||
        sector.linea_area === 'Compartido' ||
        sector.linea_area === 'General',
    );
  }, [activeSectors, selectedOrder]);

  const openStages = estado?.etapas_abiertas ?? [];
  const clock = now
    ? new Intl.DateTimeFormat('es-AR', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone: 'America/Argentina/Buenos_Aires',
      }).format(now)
    : '--:--:--';

  async function handleStart(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFeedback(null);

    if (!selectedOt || !selectedSector || !operarioNombre.trim()) {
      setFeedback({
        tone: 'warning',
        title: 'Faltan datos',
        message: 'Seleccioná la OT, el sector y el operario antes de iniciar la etapa.',
      });
      return;
    }

    setSubmitting(true);

    try {
      const response = await browserApi<IniciarEtapaResponse>('/api/registros', {
        method: 'POST',
        body: JSON.stringify({
          ot_id: Number(selectedOt),
          sector_id: Number(selectedSector),
          operario_nombre: operarioNombre.trim(),
        }),
      });

      window.localStorage.setItem('optiflow.operario', operarioNombre.trim());
      setFeedback({
        tone: 'success',
        title: 'Etapa iniciada',
        message: `${response.registro.numero_ot ?? 'OT'} · ${response.registro.nombre_sector ?? 'Sector'} · ${response.registro.operario_nombre}`,
      });
      setSelectedSector('');
      setReloadKey((key) => key + 1);
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null;
      setFeedback({
        tone: 'error',
        title: apiError?.status === 409 ? 'La etapa no se puede iniciar' : 'Error al iniciar la etapa',
        message: apiError?.message ?? 'Ocurrió un error inesperado al iniciar la etapa.',
        detail: detailAction(apiError?.detail),
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleFinalize(registro: RegistroTiempo): Promise<void> {
    const label = `${registro.numero_ot ?? `OT #${registro.ot_id}`} · ${registro.nombre_sector ?? `Sector #${registro.sector_id}`}`;
    if (!window.confirm(`¿Finalizar la etapa de ${label}?`)) return;

    setFeedback(null);
    setFinalizingId(registro.id);

    try {
      await browserApi<{ registro: RegistroTiempo }>(`/api/registros/${registro.id}/finalizar`, {
        method: 'POST',
        body: JSON.stringify({}),
      });

      setFeedback({
        tone: 'success',
        title: 'Etapa finalizada',
        message: `${label} · ${registro.operario_nombre}`,
      });
      setReloadKey((key) => key + 1);
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null;
      setFeedback({
        tone: 'error',
        title: apiError?.status === 409 ? 'La etapa ya cambió de estado' : 'Error al finalizar la etapa',
        message: apiError?.message ?? 'Ocurrió un error inesperado al finalizar la etapa.',
        detail: detailAction(apiError?.detail),
      });
      if (apiError?.status === 409) setReloadKey((key) => key + 1);
    } finally {
      setFinalizingId(null);
    }
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b border-white/10 bg-antracita/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[1500px] flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-cian/30 bg-cian/10 text-cian">
              <BrandMark className="h-6 w-6" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold tracking-tight text-white">Terminal de planta</p>
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-500">
                OptiFlow · De Otro Tiempo
              </p>
            </div>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-right">
              <p className="font-mono text-lg font-semibold tabular-nums text-white sm:text-xl">{clock}</p>
              <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-slate-500">Hora de planta</p>
            </div>
            <Link
              className="focus-ring flex h-11 items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 text-xs font-medium text-slate-200 hover:bg-white/10"
              href="/admin/dashboard"
            >
              <TerminalIcon className="h-4 w-4" />
              <span className="hidden sm:inline">Administración</span>
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1500px] flex-1 px-4 py-5 sm:px-6">
        {loadState === 'loading' ? (
          <div className="panel animate-pulse p-8">
            <div className="h-4 w-40 rounded bg-white/10" />
            <div className="mt-4 h-14 rounded-lg bg-white/5" />
            <div className="mt-3 h-14 rounded-lg bg-white/5" />
            <p className="mt-4 text-sm text-slate-500">Conectando con el API de planta…</p>
          </div>
        ) : null}

        {loadState === 'auth' ? (
          <AuthRequiredPanel message="La terminal necesita una sesión válida. Iniciá sesión y volvé a esta pantalla para fichar etapas." />
        ) : null}

        {loadState === 'error' ? (
          <ApiErrorPanel message={loadError} status={loadStatus} />
        ) : null}

        {loadState === 'ready' ? (
          <>
            {feedback ? (
              <div
                role="status"
                aria-live="polite"
                className={`mb-4 rounded-xl border px-4 py-3 text-sm ${
                  feedback.tone === 'success'
                    ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-100'
                    : feedback.tone === 'warning'
                      ? 'border-amber-400/30 bg-amber-400/10 text-amber-100'
                      : 'border-cocinas/40 bg-cocinas/10 text-red-100'
                }`}
              >
                <p className="font-semibold">{feedback.title}</p>
                <p className="mt-1">{feedback.message}</p>
                {feedback.detail ? <p className="mt-1 text-xs opacity-80">{feedback.detail}</p> : null}
              </div>
            ) : null}

            {scannedOrderMissing ? (
              <div className="mb-4 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
                La OT escaneada (#{initialOt}) no figura entre las OTs activas. Podés intentar el fichaje igual: el
                API validará su estado y devolverá el motivo si no corresponde.
              </div>
            ) : null}

            <div className="grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
              <section className="panel overflow-hidden">
                <div className="panel-header">
                  <div>
                    <h1 className="text-lg font-semibold text-white">Iniciar etapa</h1>
                    <p className="mt-0.5 text-xs text-slate-400">
                      Tocá una OT, un sector y el operario. El API valida R1-R22 antes de abrir la etapa.
                    </p>
                  </div>
                  <Badge tone="cian" dot>
                    Táctil · 56 px
                  </Badge>
                </div>

                <form className="space-y-4 p-5" onSubmit={handleStart}>
                  <label className="block">
                    <span className="label">Orden de trabajo</span>
                    <select
                      value={selectedOt}
                      onChange={(event) => {
                        setSelectedOt(event.target.value);
                        setSelectedSector('');
                      }}
                      className="select touch-target mt-1.5 text-base"
                    >
                      <option value="">Seleccioná una OT…</option>
                      {activeOrders.map((ot) => (
                        <option key={ot.id} value={ot.id}>
                          {ot.numero_ot} · {ot.cliente} · {ot.linea_area}
                        </option>
                      ))}
                      {scannedOrderMissing && initialOt ? (
                        <option value={initialOt}>OT #{initialOt} (no listada)</option>
                      ) : null}
                    </select>
                  </label>

                  <label className="block">
                    <span className="label">Sector</span>
                    <select
                      value={selectedSector}
                      onChange={(event) => setSelectedSector(event.target.value)}
                      className="select touch-target mt-1.5 text-base"
                      disabled={applicableSectors.length === 0}
                    >
                      <option value="">Seleccioná un sector…</option>
                      {AREA_ORDER.map((area) => {
                        const list = applicableSectors.filter((sector) => sector.linea_area === area);
                        if (list.length === 0) return null;
                        return (
                          <optgroup key={area} label={area}>
                            {list.map((sector) => (
                              <option key={sector.id} value={sector.id}>
                                {sector.nombre_sector}
                                {sector.es_compartido ? ' · compartido' : ''}
                              </option>
                            ))}
                          </optgroup>
                        );
                      })}
                    </select>
                    {selectedOrder ? (
                      <span className="mt-1 block text-[11px] text-slate-500">
                        Filtrado para la línea {selectedOrder.linea_area}. El API valida el flujo y los
                        prerrequisitos.
                      </span>
                    ) : null}
                  </label>

                  <label className="block">
                    <span className="label">Operario</span>
                    <input
                      type="text"
                      value={operarioNombre}
                      onChange={(event) => setOperarioNombre(event.target.value)}
                      list="operarios-terminal"
                      placeholder="Nombre del operario"
                      autoComplete="off"
                      className="input touch-target mt-1.5 text-base"
                    />
                    <datalist id="operarios-terminal">
                      {activeOperarios.map((operario) => (
                        <option key={operario.id} value={operario.nombre} />
                      ))}
                    </datalist>
                    <span className="mt-1 block text-[11px] text-slate-500">
                      Si el nombre no está en el maestro, el API lo registra automáticamente como activo (O2).
                    </span>
                  </label>

                  <button
                    type="submit"
                    disabled={submitting || applicableSectors.length === 0}
                    className="btn btn-primary touch-target w-full text-base"
                  >
                    <ClockIcon className="h-5 w-5" />
                    {submitting ? 'Iniciando…' : 'Iniciar etapa'}
                  </button>

                  <p className="text-[11px] leading-5 text-slate-500">
                    Reglas que aplica el API: una sola etapa abierta por OT/sector (R1), sector no compartido libre
                    (R2), operario activo (O3), OT no finalizada (R5), flujo completo (R6), sector activo (R7) y
                    línea correcta (R8). Un conflicto devuelve 409 con la acción sugerida.
                  </p>
                </form>
              </section>

              <section className="panel overflow-hidden">
                <div className="panel-header">
                  <div>
                    <h2 className="text-lg font-semibold text-white">Etapas abiertas</h2>
                    <p className="mt-0.5 text-xs text-slate-400">
                      {formatInteger(openStages.length)}{' '}
                      {plural(
                        openStages.length,
                        'etapa fichada en planta',
                        'etapas fichadas en planta',
                      )}
                      .
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setReloadKey((key) => key + 1)}
                    className="btn btn-ghost touch-target px-3 text-xs"
                    aria-label="Actualizar etapas abiertas"
                  >
                    Actualizar
                  </button>
                </div>

                <div className="p-4">
                  {openStages.length === 0 ? (
                    <EmptyState
                      title="No hay etapas abiertas"
                      description="Cuando un operario inicie una etapa, aparece acá para poder finalizarla."
                      className="border-0 bg-transparent"
                    />
                  ) : (
                    <ul className="space-y-3">
                      {openStages.map((registro) => (
                        <li
                          key={registro.id}
                          className="rounded-xl border border-white/10 bg-white/[0.03] p-4"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="truncate text-base font-semibold text-white">
                                {registro.numero_ot ?? `OT #${registro.ot_id}`}
                              </p>
                              <p className="mt-0.5 truncate text-sm text-slate-300">
                                {registro.nombre_sector ?? `Sector #${registro.sector_id}`} ·{' '}
                                {registro.operario_nombre}
                              </p>
                              <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.14em] text-slate-500">
                                Inicio{' '}
                                {formatDateTime(registro.fecha_hora_inicio_local ?? registro.fecha_hora_inicio)}
                              </p>
                            </div>
                            <div className="text-right">
                              <p className="font-mono text-2xl font-semibold tabular-nums text-white">
                                {formatInteger(registro.minutos_transcurridos ?? 0)}
                                <span className="ml-1 text-xs font-normal text-slate-500">min</span>
                              </p>
                              <Badge
                                tone={registro.estado_etapa === 'Pausado' ? 'warning' : 'cian'}
                                className="mt-1"
                                dot
                              >
                                {registro.estado_etapa}
                              </Badge>
                            </div>
                          </div>

                          <button
                            type="button"
                            onClick={() => void handleFinalize(registro)}
                            disabled={finalizingId === registro.id}
                            className="btn btn-danger touch-target mt-3 w-full text-sm"
                          >
                            {finalizingId === registro.id ? 'Finalizando…' : 'Finalizar etapa'}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                  <p className="mt-4 text-[11px] leading-5 text-slate-500">
                    La pausa con motivo y la reanudación se conectan en la Fase 2. Finalizar una etapa pausada ya
                    está soportado por el API y descuenta el tiempo pausado.
                  </p>
                </div>
              </section>
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3 text-xs text-slate-500">
              <span>
                {activeOrders.length} {plural(activeOrders.length, 'OT activa', 'OT activas')} ·{' '}
                {activeSectors.length} {plural(activeSectors.length, 'sector activo', 'sectores activos')} ·{' '}
                {activeOperarios.length}{' '}
                {plural(activeOperarios.length, 'operario en el maestro', 'operarios en el maestro')}
              </span>
              <Link className="font-medium text-cian hover:text-cyan-300" href="/admin/dashboard">
                Ir al dashboard administrativo
              </Link>
            </div>
          </>
        ) : null}
      </main>

      <footer className="border-t border-white/10 px-4 py-4 text-center font-mono text-[10px] uppercase tracking-[0.16em] text-slate-600">
        OptiFlow · Terminal de fichado · Fase 1
      </footer>
    </div>
  );
}
