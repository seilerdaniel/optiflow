import type { ReactNode } from 'react';
import Link from 'next/link';

import { Badge } from '@/components/Badge';
import { EmptyState } from '@/components/EmptyState';
import { Panel } from '@/components/Panel';
import { formatDate, formatInteger, formatM2, formatMetres, formatNumber, plural } from '@/lib/format';
import { toneForEstadoOT, toneForLinea } from '@/lib/status';
import type { DespieceOT } from '@/types/optiflow';

function SummaryStat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="panel border-l-2 border-white/10 p-4">
      <p className="label">{label}</p>
      <p className="mt-1 font-mono text-2xl font-semibold text-white">{value}</p>
      {hint ? <p className="mt-1 text-[11px] text-slate-500">{hint}</p> : null}
    </div>
  );
}

const SECTIONS = [
  { id: 'piezas', label: 'Piezas por módulo' },
  { id: 'bultos', label: 'Bultos y flete' },
  { id: 'panol', label: 'Pañol de herrajes' },
  { id: 'placas', label: 'Resumen de placas' },
] as const;

export function DespieceView({ data }: { data: DespieceOT }) {
  const { ot, resumen } = data;

  return (
    <div className="space-y-4">
      <Panel
        title={`OT ${ot.numero_ot}`}
        description={`${ot.cliente}${ot.modelo ? ` · ${ot.modelo}` : ''} · ${formatMetres(ot.metros_lineales)} lineales`}
        actions={
          <>
            <Badge tone={toneForLinea(ot.linea_area)}>{ot.linea_area}</Badge>
            <Badge tone={toneForEstadoOT(ot.estado_general)} dot>
              {ot.estado_general}
            </Badge>
            <Link className="btn btn-primary" href={`/terminal?ot=${ot.id}`}>
              Abrir terminal
            </Link>
          </>
        }
      >
        <dl className="grid gap-3 sm:grid-cols-3">
          <div>
            <dt className="label">Cliente</dt>
            <dd className="mt-1 text-sm text-white">{ot.cliente}</dd>
          </div>
          <div>
            <dt className="label">Modelo</dt>
            <dd className="mt-1 text-sm text-white">{ot.modelo || 'Sin modelo'}</dd>
          </div>
          <div>
            <dt className="label">Entrega prometida</dt>
            <dd className="mt-1 font-mono text-sm text-white">{formatDate(ot.fecha_prometida)}</dd>
          </div>
        </dl>
      </Panel>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <SummaryStat label="Módulos" value={formatInteger(resumen.modulos)} />
        <SummaryStat label="Filas de piezas" value={formatInteger(resumen.filas_piezas)} />
        <SummaryStat label="Piezas" value={formatInteger(resumen.piezas)} hint={`${formatInteger(resumen.laqueadas)} laqueadas`} />
        <SummaryStat label="Bultos" value={formatInteger(resumen.bultos)} />
        <SummaryStat label="Superficie" value={formatM2(resumen.m2)} />
        <SummaryStat
          label="Herrajes"
          value={formatInteger(resumen.herrajes)}
          hint={`${formatInteger(resumen.unidades_herrajes)} unidades`}
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
        <span>
          Entrega prometida: <strong className="font-mono text-slate-200">{formatDate(ot.fecha_prometida)}</strong>
        </span>
        <span>
          Requiere lustre: <strong className="text-slate-200">{ot.requiere_lustre ? 'Sí' : 'No'}</strong>
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-slate-600">
          Fase 1 · lectura
        </span>
      </div>

      <p className="rounded-lg border border-cian/20 bg-cian/5 px-4 py-3 text-xs leading-5 text-cyan-100">
        Esta vista es de lectura. La edición del despiece, el estado de flete y la entrega del pañol siguen usando
        los endpoints existentes del API (`POST /api/ot/:id/despiece`, `PATCH /api/ot/:id/despacho/bulto/:n` y
        `PATCH /api/ot/:id/herrajes/:hid/entrega`). La grilla editable se conecta en la Fase 2.
      </p>

      <nav
        className="scrollbar-thin sticky top-16 z-10 -mx-1 flex gap-1 overflow-x-auto rounded-lg border border-white/10 bg-antracita/90 p-1.5 backdrop-blur md:top-2"
        aria-label="Secciones del despiece"
      >
        {SECTIONS.map((section) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            className="focus-ring shrink-0 rounded-md px-3 py-2 text-xs font-medium text-slate-400 hover:bg-white/5 hover:text-white"
          >
            {section.label}
          </a>
        ))}
      </nav>

      <section id="piezas" className="scroll-mt-28 space-y-4">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-white">Piezas por módulo</h2>
            <p className="mt-0.5 text-xs text-slate-400">
              El número de bulto lo asigna el servidor de forma secuencial por OT.
            </p>
          </div>
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
            {formatInteger(data.modulos.length)} {plural(data.modulos.length, 'módulo', 'módulos')}
          </span>
        </div>

        {data.modulos.length === 0 ? (
          <EmptyState
            title="Sin despiece cargado"
            description="Esta OT todavía no tiene módulos ni piezas. La carga se hace desde Oficina Técnica en el panel de administración."
          />
        ) : (
          data.modulos.map((modulo) => (
            <Panel
              key={modulo.id}
              title={`M${modulo.mueble_numero} · Mód. ${modulo.modulo_numero} · ${modulo.nombre_modulo}`}
              description={`${formatMetres(modulo.metros_lineales)} · ${formatInteger(modulo.piezas.length)} ${plural(modulo.piezas.length, 'fila de piezas', 'filas de piezas')}`}
              actions={
                <>
                  {modulo.posee_puertas_vidrio_rometal ? (
                    <Badge tone="cian">Vidrio Rometal</Badge>
                  ) : null}
                  {modulo.cantidad_cajoneras > 0 ? (
                    <Badge tone="neutral">
                      {formatInteger(modulo.cantidad_cajoneras)}{' '}
                      {plural(modulo.cantidad_cajoneras, 'cajonera', 'cajoneras')}
                    </Badge>
                  ) : null}
                </>
              }
              bodyClassName="p-0"
            >
              {modulo.observaciones ? (
                <p className="border-b border-white/5 px-5 py-3 text-xs text-slate-400">{modulo.observaciones}</p>
              ) : null}

              {modulo.piezas.length === 0 ? (
                <p className="px-5 py-6 text-sm text-slate-500">El módulo no tiene piezas cargadas.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="data-table min-w-[960px]">
                    <caption className="sr-only">
                      Piezas del mueble {modulo.mueble_numero}, módulo {modulo.modulo_numero}
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Bulto</th>
                        <th scope="col">Pieza</th>
                        <th scope="col">Medidas (mm)</th>
                        <th scope="col">Material</th>
                        <th scope="col">Terminación</th>
                        <th scope="col">Flete</th>
                      </tr>
                    </thead>
                    <tbody>
                      {modulo.piezas.map((pieza) => (
                        <tr key={pieza.id}>
                          <td className="font-mono text-sm text-cian">#{pieza.numero_bulto}</td>
                          <td>
                            <p className="text-sm text-white">{pieza.nombre_pieza}</p>
                            <p className="text-xs text-slate-500">
                              {pieza.tipo_pieza} · cant. {formatInteger(pieza.cantidad)}
                            </p>
                          </td>
                          <td className="whitespace-nowrap font-mono text-xs text-slate-300">
                            {formatNumber(pieza.ancho_mm, 1)} × {formatNumber(pieza.profundidad_mm, 1)} ×{' '}
                            {formatNumber(pieza.espesor_mm, 1)}
                          </td>
                          <td>
                            <p className="text-sm text-slate-200">{pieza.tipo_placa}</p>
                            <p className="text-xs text-slate-500">{pieza.color_codigo}</p>
                          </td>
                          <td>
                            <div className="flex flex-wrap gap-1">
                              {pieza.es_laqueado ? <Badge tone="warning">Laqueado</Badge> : null}
                              {pieza.es_enchapado ? <Badge tone="info">Enchapado</Badge> : null}
                              {pieza.filos_cantidad > 0 ? (
                                <Badge tone="neutral">Filos: {pieza.filos_cantidad}</Badge>
                              ) : null}
                              {!pieza.es_laqueado && !pieza.es_enchapado && pieza.filos_cantidad === 0 ? (
                                <span className="text-xs text-slate-600">—</span>
                              ) : null}
                            </div>
                            {pieza.filos_detalle ? (
                              <p className="mt-1 max-w-[220px] truncate text-[11px] text-slate-500" title={pieza.filos_detalle}>
                                {pieza.filos_detalle}
                              </p>
                            ) : null}
                          </td>
                          <td>
                            <Badge tone={pieza.cargado_en_flete ? 'success' : 'neutral'}>
                              {pieza.cargado_en_flete ? 'Cargado' : 'Pendiente'}
                            </Badge>
                            {pieza.fecha_cargado ? (
                              <p className="mt-1 text-[11px] text-slate-500">{formatDate(pieza.fecha_cargado)}</p>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          ))
        )}
      </section>

      <section id="bultos" className="scroll-mt-28">
        <Panel
          title="Bultos y control de flete"
          description="Un bulto se considera cargado cuando todas sus piezas lo están."
          bodyClassName="p-0"
        >
          {data.bultos.length === 0 ? (
            <EmptyState
              title="Sin bultos"
              description="Los bultos se generan a partir de las piezas del despiece."
              className="border-0 bg-transparent"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table min-w-[760px]">
                <caption className="sr-only">Resumen de bultos de la OT</caption>
                <thead>
                  <tr>
                    <th scope="col">Bulto</th>
                    <th scope="col">Filas</th>
                    <th scope="col">Unidades</th>
                    <th scope="col">Superficie</th>
                    <th scope="col">Módulos</th>
                    <th scope="col">Estado</th>
                    <th scope="col">Fecha de carga</th>
                  </tr>
                </thead>
                <tbody>
                  {data.bultos.map((bulto) => (
                    <tr key={bulto.numero_bulto}>
                      <td className="font-mono text-sm text-cian">#{bulto.numero_bulto}</td>
                      <td className="font-mono text-sm text-slate-300">{formatInteger(bulto.filas)}</td>
                      <td className="font-mono text-sm text-slate-300">{formatInteger(bulto.unidades)}</td>
                      <td className="font-mono text-sm text-slate-300">{formatM2(bulto.m2)}</td>
                      <td>
                        <span
                          className="block max-w-[280px] truncate text-xs text-slate-400"
                          title={bulto.modulos.join(' · ')}
                        >
                          {bulto.modulos.join(' · ') || '—'}
                        </span>
                      </td>
                      <td>
                        <Badge tone={bulto.cargado ? 'success' : 'neutral'} dot>
                          {bulto.cargado ? 'Cargado' : 'Pendiente'}
                        </Badge>
                      </td>
                      <td className="font-mono text-xs text-slate-400">{formatDate(bulto.fecha_cargado)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </section>

      <section id="panol" className="scroll-mt-28">
        <Panel
          title="Pañol de herrajes"
          description="Lista de herrajes por mueble y estado de entrega del pañol."
          bodyClassName="p-0"
        >
          {data.herrajes.length === 0 ? (
            <EmptyState
              title="Sin herrajes cargados"
              description="La OT no tiene una lista de herrajes asociada. Se carga junto con el despiece."
              className="border-0 bg-transparent"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table min-w-[820px]">
                <caption className="sr-only">Lista de herrajes de la OT</caption>
                <thead>
                  <tr>
                    <th scope="col">Mueble</th>
                    <th scope="col">Herraje</th>
                    <th scope="col">SKU</th>
                    <th scope="col">Cantidad</th>
                    <th scope="col">Pañol</th>
                    <th scope="col">Observaciones</th>
                  </tr>
                </thead>
                <tbody>
                  {data.herrajes.map((herraje) => (
                    <tr key={herraje.id}>
                      <td className="font-mono text-sm text-slate-300">M{herraje.mueble_numero}</td>
                      <td className="text-sm text-white">{herraje.herraje_nombre}</td>
                      <td className="font-mono text-xs text-slate-400">{herraje.codigo_sku || '—'}</td>
                      <td className="font-mono text-sm text-slate-300">{formatInteger(herraje.cantidad)}</td>
                      <td>
                        <Badge tone={herraje.entregado_por_panol ? 'success' : 'warning'} dot>
                          {herraje.entregado_por_panol ? 'Entregado' : 'Pendiente'}
                        </Badge>
                      </td>
                      <td>
                        <span className="block max-w-[280px] truncate text-xs text-slate-400" title={herraje.observaciones ?? ''}>
                          {herraje.observaciones || '—'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </section>

      <section id="placas" className="scroll-mt-28">
        <Panel
          title="Resumen de placas"
          description="Agrupado por sustrato, espesor y color. La superficie incluye la cantidad de piezas."
          bodyClassName="p-0"
        >
          {data.resumen_placas.length === 0 ? (
            <EmptyState
              title="Sin placas para resumir"
              description="El resumen se calcula a partir de las piezas cargadas."
              className="border-0 bg-transparent"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table min-w-[760px]">
                <caption className="sr-only">Resumen de placas del despiece</caption>
                <thead>
                  <tr>
                    <th scope="col">Tipo de placa</th>
                    <th scope="col">Espesor</th>
                    <th scope="col">Color</th>
                    <th scope="col">Filas</th>
                    <th scope="col">Piezas</th>
                    <th scope="col">Laqueadas</th>
                    <th scope="col">Superficie</th>
                  </tr>
                </thead>
                <tbody>
                  {data.resumen_placas.map((placa) => (
                    <tr key={`${placa.tipo_placa}-${placa.espesor_mm}-${placa.color_codigo}`}>
                      <td className="text-sm text-white">{placa.tipo_placa}</td>
                      <td className="font-mono text-sm text-slate-300">{formatNumber(placa.espesor_mm, 2)} mm</td>
                      <td className="text-sm text-slate-300">{placa.color_codigo}</td>
                      <td className="font-mono text-sm text-slate-300">{formatInteger(placa.filas)}</td>
                      <td className="font-mono text-sm text-slate-300">{formatInteger(placa.piezas)}</td>
                      <td className="font-mono text-sm text-slate-300">{formatInteger(placa.laqueadas)}</td>
                      <td className="font-mono text-sm text-slate-300">{formatM2(placa.m2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </section>
    </div>
  );
}
