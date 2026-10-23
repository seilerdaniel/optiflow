import type { DespiecePieza, DespieceOT } from '@/types/optiflow';
import { BrandMark } from '@/components/icons';
import { formatInteger, formatM2, formatNumber } from '@/lib/format';

export interface HojaRutaProps {
  data: DespieceOT;
  qrSvg: string;
  origin: string;
  generadoEn: string;
}

function Obs({ value }: { value?: string | null }) {
  const texto = String(value || '').trim();
  return texto ? (
    <span className="hoja-obs-texto">{texto}</span>
  ) : (
    <span className="hoja-vacio">—</span>
  );
}

function FilaPieza({ pieza }: { pieza: DespiecePieza }) {
  return (
    <tr>
      <td>
        <strong className="hoja-pieza-nombre">{pieza.nombre_pieza}</strong>
        <span className="hoja-pieza-tipo">{pieza.tipo_pieza}</span>
      </td>
      <td className="hoja-num">{formatInteger(pieza.cantidad)}</td>
      <td className="hoja-num">{formatNumber(pieza.ancho_mm, 1)} mm</td>
      <td className="hoja-num">{formatNumber(pieza.profundidad_mm, 1)} mm</td>
      <td className="hoja-num">{formatNumber(pieza.espesor_mm, 1)} mm</td>
      <td>
        {pieza.tipo_placa}
        <span className="hoja-pieza-tipo">{pieza.color_codigo}</span>
      </td>
      <td className="hoja-num">
        {pieza.filos_cantidad > 0 ? formatInteger(pieza.filos_cantidad) : '—'}
        {pieza.filos_detalle ? (
          <span className="hoja-pieza-tipo">{pieza.filos_detalle}</span>
        ) : null}
      </td>
      <td className="hoja-obs">
        <Obs value={pieza.observacion} />
      </td>
    </tr>
  );
}

export function HojaRuta({ data, qrSvg, origin, generadoEn }: HojaRutaProps) {
  const { ot, resumen } = data;
  const linea = ot.linea_area === 'Cocinas' ? 'cocinas' : 'placares';
  const modulos = Array.isArray(data.modulos) ? data.modulos : [];
  const herrajes = Array.isArray(data.herrajes) ? data.herrajes : [];
  const bultos = Array.isArray(data.bultos) ? data.bultos : [];

  return (
    <article className={`hoja-ruta hoja-ruta--${linea}`} aria-label={`Hoja de ruta de la OT ${ot.numero_ot}`}>
      <header className="hoja-cabecera">
        <div className="hoja-marca">
          <span className="hoja-escudo" aria-hidden="true">
            <BrandMark className="h-5 w-5" />
          </span>
          <div>
            <p className="hoja-eyebrow">De Otro Tiempo · OptiFlow</p>
            <h1 className="hoja-titulo-principal">Hoja de ruta y despiece</h1>
            <p className="hoja-subtitulo">Oficina Técnica · Línea {linea === 'cocinas' ? 'Cocinas' : 'Placares'}</p>
          </div>
        </div>
        <div className="hoja-qr">
          <div className="hoja-qr-caja" dangerouslySetInnerHTML={{ __html: qrSvg }} />
          <p className="hoja-qr-pie">
            Escaneá para abrir
            <br />
            la OT en la terminal
          </p>
        </div>
      </header>

      <div className="hoja-datos">
        <div className="hoja-dato">
          <span>N° de OT</span>
          <b>{ot.numero_ot}</b>
        </div>
        <div className="hoja-dato">
          <span>Cliente</span>
          <b>{ot.cliente}</b>
        </div>
        <div className="hoja-dato">
          <span>Modelo</span>
          <b>{ot.modelo || '—'}</b>
        </div>
        <div className="hoja-dato">
          <span>Línea / área</span>
          <b>{ot.linea_area}</b>
        </div>
        <div className="hoja-dato">
          <span>Entrega prometida</span>
          <b>{ot.fecha_prometida || 'Sin fecha'}</b>
        </div>
        <div className="hoja-dato">
          <span>Metros lineales</span>
          <b>{formatNumber(ot.metros_lineales, 2)} m</b>
        </div>
      </div>

      <div className="hoja-resumen">
        <div>
          <span>Módulos</span>
          <b>{formatInteger(resumen.modulos)}</b>
        </div>
        <div>
          <span>Filas de piezas</span>
          <b>{formatInteger(resumen.filas_piezas)}</b>
        </div>
        <div>
          <span>Piezas</span>
          <b>{formatInteger(resumen.piezas)}</b>
        </div>
        <div>
          <span>Bultos</span>
          <b>{formatInteger(resumen.bultos)}</b>
        </div>
        <div>
          <span>Superficie</span>
          <b>{formatM2(resumen.m2)}</b>
        </div>
        <div>
          <span>Herrajes</span>
          <b>
            {formatInteger(resumen.herrajes)} · {formatInteger(resumen.unidades_herrajes)} u.
          </b>
        </div>
      </div>

      <section className="hoja-bloque">
        <div className="hoja-bloque-titulo">
          <h2>Despiece de piezas</h2>
          <span>
            {formatInteger(modulos.length)} {modulos.length === 1 ? 'módulo' : 'módulos'}
          </span>
        </div>
        <table className="hoja-tabla hoja-tabla-piezas">
          <thead>
            <tr>
              <th scope="col">Pieza</th>
              <th scope="col" className="hoja-num">
                Cant.
              </th>
              <th scope="col" className="hoja-num">
                Ancho
              </th>
              <th scope="col" className="hoja-num">
                Prof.
              </th>
              <th scope="col" className="hoja-num">
                Esp.
              </th>
              <th scope="col">Placa / color</th>
              <th scope="col" className="hoja-num">
                Filos
              </th>
              <th scope="col">Observación</th>
            </tr>
          </thead>
          {modulos.length === 0 ? (
            <tbody>
              <tr>
                <td colSpan={8} className="hoja-vacio-centro">
                  La OT todavía no tiene piezas cargadas.
                </td>
              </tr>
            </tbody>
          ) : (
            modulos.map((modulo) => (
              <tbody key={modulo.id || `${modulo.mueble_numero}-${modulo.modulo_numero}`}>
                <tr className="hoja-subfila">
                  <td colSpan={8}>
                    <b>
                      M{modulo.mueble_numero} · Mód. {modulo.modulo_numero}
                    </b>{' '}
                    {modulo.nombre_modulo}
                    {modulo.observaciones ? <em> · {modulo.observaciones}</em> : null}
                  </td>
                </tr>
                {modulo.piezas.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="hoja-vacio-centro">
                      Sin piezas en este módulo.
                    </td>
                  </tr>
                ) : (
                  modulo.piezas.map((pieza) => <FilaPieza key={pieza.id} pieza={pieza} />)
                )}
              </tbody>
            ))
          )}
        </table>
      </section>

      <section className="hoja-bloque">
        <div className="hoja-bloque-titulo">
          <h2>🛠️ Lista de herrajes requeridos para pañol</h2>
          <span>
            {formatInteger(resumen.herrajes)} ítem(s) · {formatInteger(resumen.unidades_herrajes)} u.
          </span>
        </div>
        <table className="hoja-tabla hoja-tabla-herrajes">
          <thead>
            <tr>
              <th scope="col" className="hoja-num">
                Mueble
              </th>
              <th scope="col">Herraje</th>
              <th scope="col">SKU</th>
              <th scope="col" className="hoja-num">
                Cant.
              </th>
              <th scope="col" className="hoja-centro">
                Entregado
              </th>
              <th scope="col">Observaciones</th>
            </tr>
          </thead>
          <tbody>
            {herrajes.length === 0 ? (
              <tr>
                <td colSpan={6} className="hoja-vacio-centro">
                  Sin herrajes cargados.
                </td>
              </tr>
            ) : (
              herrajes.map((herraje) => (
                <tr key={herraje.id}>
                  <td className="hoja-num">M{herraje.mueble_numero}</td>
                  <td>{herraje.herraje_nombre}</td>
                  <td className="hoja-mono">{herraje.codigo_sku || '—'}</td>
                  <td className="hoja-num">{formatInteger(herraje.cantidad)}</td>
                  <td className="hoja-centro">
                    <span
                      className={`hoja-check${herraje.entregado_por_panol ? ' hoja-check--on' : ''}`}
                      aria-label={herraje.entregado_por_panol ? 'Entregado' : 'Pendiente'}
                    >
                      {herraje.entregado_por_panol ? '✓' : ''}
                    </span>
                  </td>
                  <td>
                    <Obs value={herraje.observaciones} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      <section className="hoja-bloque">
        <div className="hoja-bloque-titulo">
          <h2>📦 Control de bultos para despacho</h2>
          <span>{formatInteger(bultos.length)} bulto(s)</span>
        </div>
        <table className="hoja-tabla hoja-tabla-despacho">
          <thead>
            <tr>
              <th scope="col" className="hoja-num">
                Bulto N°
              </th>
              <th scope="col">Módulo / descripción</th>
              <th scope="col" className="hoja-num">
                Cantidad de piezas
              </th>
              <th scope="col" className="hoja-centro">
                Cargado en camión
              </th>
              <th scope="col" className="hoja-firma-col">
                Firma de logística
              </th>
            </tr>
          </thead>
          <tbody>
            {bultos.length === 0 ? (
              <tr>
                <td colSpan={5} className="hoja-vacio-centro">
                  Los bultos se generan al guardar el despiece.
                </td>
              </tr>
            ) : (
              bultos.map((bulto) => (
                <tr key={bulto.numero_bulto}>
                  <td className="hoja-num">
                    <b>#{bulto.numero_bulto}</b>
                  </td>
                  <td>{bulto.descripcion || bulto.modulos.join(' · ') || '—'}</td>
                  <td className="hoja-num">{formatInteger(bulto.cantidad_piezas)}</td>
                  <td className="hoja-centro">
                    <span
                      className={`hoja-check${bulto.cargado_en_flete ? ' hoja-check--on' : ''}`}
                      aria-label={bulto.cargado_en_flete ? 'Cargado' : 'Pendiente de carga'}
                    >
                      {bulto.cargado_en_flete ? '✓' : ''}
                    </span>
                  </td>
                  <td className="hoja-firma-col">
                    <span className="hoja-linea-firma" />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      <footer className="hoja-pie">
        <span>Generado: {generadoEn}</span>
        <span className="hoja-pie-origen">Origen del QR: {origin}/?ot={ot.numero_ot}</span>
        <span>OptiFlow · De Otro Tiempo</span>
      </footer>
    </article>
  );
}
