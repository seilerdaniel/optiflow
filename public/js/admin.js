'use strict';

/* ============================================================
   OPTIFLOW - Panel de Administración de OTs (Pantalla 2)
   Oficina técnica / Encargado de planta
   ============================================================ */

const S = {
  meta: null,
  ordenes: [],
  activas: [],
  sectores: [],
  metricas: null,
  operarios: [],
  usuarios: [],
  usuario: null,   // sesión vigente
  registrosExport: null, // export de registros (standby + gráfico de ciclo)
  materiales: null,      // catálogo dinámico de placas
  compartidos: null,     // etapas en talleres compartidos
  tpm: null,             // mantenimiento preventivo: máquinas + historial
  objetivo: null,        // meta del MES consultado (última respuesta válida)
  objetivoPeriodo: null, // mes elegido en el selector; null = mes en curso
  periodosBase: null,    // mes a partir del cual se armó el desplegable
  objetivosAnio: null,   // comparativo anual de metas (12 meses)
  anioObjetivos: null,   // año elegido en el selector anual
};

const $ = (id) => document.getElementById(id);

document.addEventListener('DOMContentLoaded', async () => {
  // Auditoría V-1: el panel de administración exige sesión (el servidor ya
  // redirige /admin sin sesión; esto cubre el caso de sesión vencida).
  try {
    const s = await API.sesion();
    if (!s || !s.usuario) { location.href = '/login.html?siguiente=/admin'; return; }
    S.usuario = s.usuario;
  } catch {
    location.href = '/login.html?siguiente=/admin';
    return;
  }
  pintarSesion(S.usuario);

  await iniciarBarraSuperior();
  ligarEventos();

  try {
    const [meta, sectores] = await Promise.all([
      API.get('/api/meta'),
      API.get('/api/sectores?todos=1'),
    ]);
    S.meta = meta;
    poblarSelectsLinea();
    S.sectores = sectores.sectores;
    poblarFiltroSectorSeguimiento();
    pintarTablaSectores();
    await cargarOrdenes();
    await Promise.all([cargarActivas(), cargarMetricas(), cargarOperarios()]);
    // Paneles dedicados: catálogo de placas, talleres compartidos y TPM.
    await Promise.all([cargarMateriales(), cargarCompartidos(), cargarTPM()]);
    // Comparativo anual de metas (tiene try/catch propio: si falla, el resto
    // del panel sigue funcionando).
    await cargarObjetivosAnio();
    if (S.usuario.rol === 'admin') {
      $('panel-usuarios').hidden = false;
      await cargarUsuarios();
    }
  } catch (e) {
    manejarError(e, 'Carga inicial');
  }

  setInterval(cargarActivas, 4000);
  setInterval(actualizarCronometros, 500);
  setInterval(cargarOrdenes, 30000); // mantiene sincronizada la tabla con la planta
  setInterval(cargarMetricas, 30000);
  setInterval(cargarSectores, 60000); // refleja cambios de sectores hechos en otra sesión
  setInterval(cargarTPM, 60000);      // las horas netas avanzan con el fichado de planta
});

/* ------------------------------------------------------------------ */
/* Sesión (V-1)                                                        */
/* ------------------------------------------------------------------ */

function pintarSesion(u) {
  const chip = $('sesion-chip');
  if (chip) { chip.hidden = false; chip.textContent = `👤 ${u.nombre} (${u.rol})`; }
  // Perfil del pie del sidebar (nombre + rol + cerrar sesión).
  if (window.Sidebar) Sidebar.pintarSesion(u);
  const salir = $('sesion-salir');
  if (salir) {
    salir.hidden = false;
    salir.onclick = async (ev) => {
      ev.preventDefault();
      try { await API.logout(); } catch { /* noop */ }
      location.href = '/login.html';
    };
  }
}

function ligarEventos() {
  $('form-ot').addEventListener('submit', guardarOT);
  $('form-ot').addEventListener('reset', () => {
    setTimeout(() => {
      document.querySelectorAll('#checks-especiales .check').forEach((c) => c.classList.remove('marcado'));
      limpiarMaterialesForm();
    }, 0);
  });

  $('btn-agregar-material').addEventListener('click', () => agregarFilaMaterial());
  limpiarMaterialesForm(); // fila inicial vacía

  document.querySelectorAll('#checks-especiales input').forEach((cb) => {
    cb.addEventListener('change', () => {
      cb.closest('.check').classList.toggle('marcado', cb.checked);
    });
  });

  $('filtro-ot').addEventListener('input', pintarTabla);
  $('filtro-estado').addEventListener('change', pintarTabla);
  // Filtro rápido de línea (enlazado desde el sidebar: Placares/Cocinas/compartidos)
  $('filtro-linea').addEventListener('change', () => { sincronizarLineaEnURL(); pintarTabla(); });
  aplicarLineaDesdeURL(); // ?linea= llegado del sidebar
  $('filtro-sector-seg').addEventListener('change', pintarSeguimiento);
  $('filtro-avance').addEventListener('change', pintarSeguimiento);

  $('btn-agregar-operario').addEventListener('click', agregarOperario);
  $('op-nombre').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') agregarOperario(); });
  $('op-filtro-inactivos').addEventListener('change', pintarTablaOperarios);

  // Usuarios del sistema (sólo rol admin ve el panel; el endpoint también valida).
  $('btn-agregar-usuario').addEventListener('click', agregarUsuario);
  ['usu-login', 'usu-nombre', 'usu-password'].forEach((id) => {
    $(id).addEventListener('keydown', (ev) => { if (ev.key === 'Enter') agregarUsuario(); });
  });

  $('btn-agregar-sector').addEventListener('click', agregarSector);
  $('sec-nombre').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') agregarSector(); });
  $('sec-operarios').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') agregarSector(); });
  $('sec-filtro-inactivos').addEventListener('change', pintarTablaSectores);
  $('sec-compartido').addEventListener('change', (ev) => {
    ev.target.closest('.check').classList.toggle('marcado', ev.target.checked);
  });

  document.querySelectorAll('[data-cerrar]').forEach((b) => {
    b.addEventListener('click', () => Modal.cerrar(b.getAttribute('data-cerrar')));
  });

  // Filtros del dashboard de analítica.
  $('filtro-linea-grafico').addEventListener('change', pintarGraficoCiclo);

  // Filtros del panel de Materiales / Placas.
  ['mat-filtro-nombre', 'mat-filtro-espesor', 'mat-filtro-familia'].forEach((id) => {
    $(id).addEventListener(id === 'mat-filtro-nombre' ? 'input' : 'change', pintarTablaMateriales);
  });

  // Filtros del panel de Talleres Compartidos.
  ['comp-filtro-sector', 'comp-filtro-linea'].forEach((id) => {
    $(id).addEventListener('change', pintarTablaCompartidos);
  });

  // Mantenimiento Preventivo (TPM): altas/configuración y registro de services.
  $('btn-tpm-nueva').addEventListener('click', () => abrirConfigTPM(null));
  $('form-tpm-service').addEventListener('submit', guardarServiceTPM);
  $('form-tpm-config').addEventListener('submit', guardarConfigTPM);
  $('tpm-config-activo').addEventListener('change', (ev) => {
    ev.target.closest('.check').classList.toggle('marcado', ev.target.checked);
  });

  // Objetivo mensual de corte: ajuste de metas. El endpoint exige rol de
  // gestión (admin/encargado), así que a un operario ni siquiera se le ofrece
  // el botón: ahorrar un 403 que sólo confundiría.
  $('btn-meta-corte').addEventListener('click', abrirAjusteMetaCorte);
  $('form-meta-corte').addEventListener('submit', guardarMetaCorte);
  if (S.usuario && !['admin', 'encargado'].includes(S.usuario.rol)) {
    $('btn-meta-corte').hidden = true;
  }

  // Selector de período: el desplegable y las flechas son dos formas de
  // llegar al mismo sitio, así que comparten la misma función de cambio.
  $('selectPeriodoObjetivo').addEventListener('change', (ev) => {
    S.objetivoPeriodo = ev.target.value;
    cargarObjetivoCorte();
  });
  $('btnPeriodoAnterior').addEventListener('click', () => moverPeriodoObjetivo(1));
  $('btnPeriodoSiguiente').addEventListener('click', () => moverPeriodoObjetivo(-1));

  // Comparativo anual: el selector de año recarga SOLO ese panel.
  $('selectAnioObjetivos').addEventListener('change', (ev) => {
    S.anioObjetivos = Number(ev.target.value) || null;
    cargarObjetivosAnio(S.anioObjetivos);
  });

  // Buscador global (Ctrl/⌘ + K): se liga al final para que todo el estado
  // del panel (S.ordenes, S.meta…) ya esté disponible.
  CommandPalette.ligar();
}

/* ------------------------------------------------------------------ */
/* Dashboard de métricas (Fase 2 - Paso B)                             */
/* ------------------------------------------------------------------ */

function poblarFiltroSectorSeguimiento() {
  const sel = $('filtro-sector-seg');
  const previo = sel.value;
  sel.innerHTML = '';
  sel.append(h('option', { value: '', text: 'Todos los sectores' }));
  // S.sectores trae el catálogo completo (?todos=1); el filtro sólo muestra activos.
  for (const s of S.sectores.filter((x) => x.activo)) {
    sel.append(h('option', {
      value: String(s.id),
      text: `${s.nombre_sector}${s.es_compartido ? ' (compartido)' : ''}`,
    }));
  }
  if (previo) sel.value = previo;
}

async function cargarMetricas() {
  try {
    // El export de registros alimenta el standby y el gráfico de ciclo por
    // sector. Se pide una sola vez y se reutiliza en los refrescos.
    if (!S.registrosExport) {
      try {
        const exp = await API.get('/api/export/registros?limite=20000');
        S.registrosExport = exp.registros || [];
      } catch { S.registrosExport = []; }
    }

    const m = await API.get('/api/metricas');
    S.metricas = m;
    pintarKPIs(m);
    pintarGraficoCiclo();
    pintarCargaSectores(m);
    pintarPausas(m);
    // Objetivo de corte: carga PROPIA y con try/catch interno, para que un
    // fallo suyo (o un endpoint que todavía no exista) no deje en "—" el
    // Lead Time ni el FTT del dashboard.
    await cargarObjetivoCorte();
    $('kpi-actualizado').textContent = `Actualizado ${FORMATO.hora(m.generado_en)} · período ${FORMATO.fecha(m.periodo.desde)} → ${FORMATO.fecha(m.periodo.hasta)}`;
  } catch (e) {
    manejarError(e, 'Cargar métricas');
  }
}

function pintarKPIs(m) {
  // 1) Lead time promedio
  $('kpi-leadtime').textContent = m.lead_time.promedio_minutos === null ? '—' : m.lead_time.promedio_legible;
  $('kpi-leadtime-sub').textContent = m.lead_time.ots_medidas
    ? `Promedio de ${m.lead_time.ots_medidas} OT(s) medidas`
    : 'Sin OTs medidas en el período';

  // 2) FTT
  $('kpi-ftt').textContent = m.ftt.porcentaje === null ? '—' : `${m.ftt.porcentaje}%`;
  $('kpi-ftt-sub').textContent = m.ftt.evaluadas
    ? `${m.ftt.conformes} de ${m.ftt.evaluadas} OT(s) sin reproceso`
    : 'Sin OTs avanzadas en el período';

  // 3 y 4) Standby y Riesgo salen del export de registros + la lista de OTs.
  pintarStandbyYRiesgo();
  pintarGraficoCausas(m);

  $('cuello-dia').textContent = m.cuello_botella
    ? `🚧 ${m.cuello_botella.nombre_corto || m.cuello_botella.nombre_sector}`
    : 'Sin carga hoy';
  $('kpi-cuello-sub-top').textContent = m.periodo.dia_cuello_botella
    ? `Cuello de botella del ${FORMATO.fecha(m.periodo.dia_cuello_botella)}`
    : '';
}

/** OTs en riesgo: vencidas (fecha prometida pasada) o detenidas. */
function calcularRiesgo() {
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  return S.ordenes.filter((ot) => {
    if (ot.estado_general === 'Finalizado') return false;
    const vencida = ot.fecha_prometida
      && new Date(ot.fecha_prometida + 'T00:00:00') < hoy;
    return vencida || ot.estado_general === 'Detenido';
  });
}

/**
 * Standby entre sectores: tiempo muerto entre el cierre de una etapa y el
 * arranque de la siguiente dentro de la MISMA OT (el traspaso entre sectores).
 * Se calcula sobre el export de registros ordenado por OT + inicio.
 */
function calcularStandby(registros) {
  const porOT = new Map();
  for (const r of registros) {
    // El JSON del export expone los campos crudos (sin sufijo `_utc`: ese
    // renombrado es sólo del CSV para Power BI).
    if (!r.fecha_hora_inicio) continue;
    if (!porOT.has(r.numero_ot)) porOT.set(r.numero_ot, []);
    porOT.get(r.numero_ot).push(r);
  }

  let totalMin = 0;
  let traspasos = 0;
  let otsConTraspaso = 0;

  for (const lista of porOT.values()) {
    lista.sort((a, b) => Date.parse(a.fecha_hora_inicio) - Date.parse(b.fecha_hora_inicio));
    let minutoOT = 0;
    for (let i = 0; i < lista.length - 1; i += 1) {
      const fin = lista[i].fecha_hora_fin;
      const sigInicio = lista[i + 1].fecha_hora_inicio;
      if (!fin || !sigInicio) continue; // etapa abierta: no se mide el traspaso
      const gap = (Date.parse(sigInicio) - Date.parse(fin)) / 60000;
      if (gap > 0 && gap <= 1440) { // tope de 24 h: ignora pausas de fin de semana
        minutoOT += gap;
        traspasos += 1;
      }
    }
    if (minutoOT > 0) { totalMin += minutoOT; otsConTraspaso += 1; }
  }

  return {
    total_minutos: totalMin,
    traspasos,
    ots_con_traspaso: otsConTraspaso,
    promedio_minutos: otsConTraspaso ? Math.round(totalMin / otsConTraspaso) : null,
  };
}

function pintarStandbyYRiesgo() {
  const riesgo = calcularRiesgo();
  const tarjRiesgo = $('kpi-riesgo').closest('.kpi-ind');
  $('kpi-riesgo').textContent = String(riesgo.length);
  const vencidas = riesgo.filter((o) => o.fecha_prometida
    && new Date(o.fecha_prometida + 'T00:00:00') < new Date().setHours(0, 0, 0, 0)).length;
  $('kpi-riesgo-sub').textContent = riesgo.length
    ? `${vencidas} vencida(s) · ${riesgo.length - vencidas} detenida(s)`
    : 'Ninguna OT vencida ni detenida';
  tarjRiesgo.classList.toggle('acento-alerta', riesgo.length > 0);
  tarjRiesgo.classList.toggle('acento-proceso', riesgo.length === 0);

  if (!S.registrosExport) {
    $('kpi-standby').textContent = '…';
    return;
  }
  const st = calcularStandby(S.registrosExport);
  $('kpi-standby').textContent = st.promedio_minutos === null ? '—' : FORMATO.duracion(st.promedio_minutos);
  $('kpi-standby-sub').textContent = st.traspasos
    ? `${st.traspasos} traspaso(s) en ${st.ots_con_traspaso} OT(s)`
    : 'Sin traspasos medidos en el período';
}

/* ---------------------- Gráficos (Chart.js) ---------------------- */

/** Paleta del sistema de diseño industrial, leída de las variables CSS. */
function paletaIndustrial() {
  const css = getComputedStyle(document.documentElement);
  const v = (n, fallback) => (css.getPropertyValue(n) || fallback).trim();
  return {
    placares: v('--linea-placares', '#1D63B8'),
    cocinas: v('--linea-cocinas', '#C82333'),
    compartidos: v('--linea-compartidos', '#6F42C1'),
    proceso: v('--estado-proceso', '#28A745'),
    pausa: v('--estado-pausa', '#FFC107'),
    alerta: v('--estado-alerta', '#DC3545'),
    borde: v('--border-color', '#3F4248'),
    texto: v('--texto-dim', '#9AA1AC'),
    tarjeta: v('--bg-card', '#232529'),
  };
}

const GRAFICOS = { ciclo: null, causas: null, avance: null, objetivosAnio: null };

/** Tiempo de ciclo promedio por sector, filtrable por línea. */
function pintarGraficoCiclo() {
  if (typeof Chart === 'undefined' || !S.registrosExport) return;
  const linea = $('filtro-linea-grafico').value;
  const filas = S.registrosExport.filter((r) =>
    r.estado_etapa === 'Finalizado'
    && r.duracion_minutos !== null && r.duracion_minutos > 0
    && (!linea || r.linea_ot === linea));

  const porSector = new Map();
  for (const r of filas) {
    const clave = r.nombre_sector || '—';
    if (!porSector.has(clave)) porSector.set(clave, { suma: 0, n: 0 });
    const s = porSector.get(clave);
    s.suma += Number(r.duracion_minutos);
    s.n += 1;
  }

  const orden = [...porSector.entries()]
    .map(([sector, s]) => ({ sector, prom: Math.round((s.suma / s.n) * 10) / 10, n: s.n }))
    .sort((a, b) => b.prom - a.prom);

  const p = paletaIndustrial();
  const colorLinea = linea === 'Cocinas' ? p.cocinas : p.placares;

  const datos = {
    labels: orden.map((o) => o.sector),
    datasets: [{
      label: 'Minutos promedio por etapa',
      data: orden.map((o) => o.prom),
      backgroundColor: orden.map((o, i) => (i === 0 ? p.pausa : colorLinea)),
      borderRadius: 6,
      maxBarThickness: 46,
    }],
  };

  const opciones = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          afterLabel: (ctx) => `${orden[ctx.dataIndex].n} etapa(s) cerrada(s)`,
        },
      },
    },
    scales: {
      x: { ticks: { color: p.texto, maxRotation: 60, minRotation: 45, font: { size: 10 } }, grid: { display: false } },
      y: { ticks: { color: p.texto }, grid: { color: p.borde }, title: { display: true, text: 'min', color: p.texto } },
    },
  };

  if (GRAFICOS.ciclo) { GRAFICOS.ciclo.data = datos; GRAFICOS.ciclo.update(); return; }
  GRAFICOS.ciclo = new Chart($('grafico-ciclo'), { type: 'bar', data: datos, options: opciones });
}

/** Causa raíz de pausas y reprocesos (dona) sobre el catálogo real. */
function pintarGraficoCausas(m) {
  if (typeof Chart === 'undefined') return;
  const lista = (m.pausas_por_motivo || []).filter((p) => p.frecuencia > 0);
  const p = paletaIndustrial();
  // Paleta CATEGÓRICA: no reutiliza los acentos de línea porque éstos codifican
  // Placares/Cocinas, no categorías. Aquí hace falta que ningún par se confunda:
  // por eso el rojo de `--estado-alerta` y el de `--linea-cocinas` (que en la
  // rueda son casi el mismo tono) no conviven; el hue 200 (cian) separa ambos.
  const colores = [
    p.alerta,      // rojo
    p.pausa,       // amarillo
    p.compartidos, // púrpura
    '#22B8CF',     // cian — el único hue sin contraparte en la paleta de estados
    p.placares,    // azul
    p.proceso,     // verde
  ];

  const datos = {
    labels: lista.map((x) => x.motivo),
    datasets: [{
      data: lista.map((x) => x.frecuencia),
      backgroundColor: lista.map((_, i) => colores[i % colores.length]),
      borderColor: p.tarjeta,
      borderWidth: 3,
      hoverOffset: 10,
    }],
  };

  const opciones = {
    responsive: true,
    maintainAspectRatio: false,
    cutout: '58%',
    plugins: {
      legend: { position: 'bottom', labels: { color: p.texto, boxWidth: 12, padding: 10, font: { size: 11 } } },
      tooltip: {
        callbacks: {
          label: (ctx) => {
            const x = lista[ctx.dataIndex];
            const total = lista.reduce((a, b) => a + b.frecuencia, 0);
            const pct = total ? Math.round((x.frecuencia / total) * 100) : 0;
            return ` ${x.motivo}: ${x.frecuencia} (${pct}%) · ${x.horas_perdidas} h`;
          },
        },
      },
    },
  };

  if (GRAFICOS.causas) { GRAFICOS.causas.data = datos; GRAFICOS.causas.update(); return; }
  GRAFICOS.causas = new Chart($('grafico-causas'), { type: 'doughnut', data: datos, options: opciones });
}

/* ------------- Objetivo mensual de CORTE (metros lineales) ------------- */

/** Metros por día con formato de planta: '41,9 m/día'. */
function metrosDia(v) {
  return `${Number(v || 0).toLocaleString('es-AR', { maximumFractionDigits: 1 })} m/día`;
}

/* --- Selector de período: mes en curso + los 12 anteriores ------------ */

/** Meses cortos del desplegable (sin dependencias: todo es JS nativo). */
const MESES_CORTOS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun',
  'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

/** Meses largos, para los textos de la tarjeta y del modal. */
const MESES_LARGOS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

/**
 * Los `n + 1` períodos que arrancan en `desde` ('YYYY-MM') y retroceden uno
 * por vuelta.
 *
 * Se hace aritmética sobre el string y NO con `new Date()` del navegador: la
 * ventana tiene que ser la del MES DE PLANTA que devuelve el servidor, no la
 * del reloj de quien abre la pantalla (y menos en el borde de mes, justo
 * cuando el dato importa). Con `desde='2026-10'` y n=12 da 13 opciones.
 */
function ultimosPeriodos(desde, n) {
  const anio0 = Number(desde.slice(0, 4));
  const mes0 = Number(desde.slice(5, 7));
  const salida = [];
  for (let i = 0; i <= n; i += 1) {
    const bruto = mes0 - i;
    const anio = anio0 + Math.floor((bruto - 1) / 12);
    const mes = (((bruto - 1) % 12) + 12) % 12 + 1;
    salida.push(`${anio}-${String(mes).padStart(2, '0')}`);
  }
  return salida;
}

/** '2026-10' -> 'Oct 2026' (y 'Oct 2026 · en curso' cuando corresponde). */
function etiquetaPeriodo(p, periodoVigente) {
  const nombre = MESES_CORTOS[Number(p.slice(5, 7)) - 1] || p.slice(5, 7);
  const marca = periodoVigente && p === periodoVigente ? ' · en curso' : '';
  return `${nombre} ${p.slice(0, 4)}${marca}`;
}

/** '2026-10' -> 'Octubre 2026'. */
function etiquetaPeriodoLargo(p) {
  return `${MESES_LARGOS[Number(p.slice(5, 7)) - 1] || p.slice(5, 7)} ${p.slice(0, 4)}`;
}

/**
 * Llena el desplegable con el mes en curso + los 12 anteriores.
 *
 * Se construye UNA sola vez, a partir de la primera respuesta, que siempre es
 * el mes en curso (el arranque pide sin parámetro). Reconstruirlo en cada
 * refresco de 30 s devolvería el selector a su valor inicial cada medio
 * minuto y tiraría la selección que el usuario estuviera mirando.
 *
 * La única excepción es un CAMBIO DE MES durante la sesión: ahí sí se vuelve
 * a armar para que aparezca el mes nuevo.
 */
function pintarSelectorPeriodo(d) {
  const sel = $('selectPeriodoObjetivo');
  if (!sel || !d || !d.periodo) return;

  const cambioDeMes = d.es_mes_en_curso === true && d.periodo !== S.periodosBase;
  if (S.periodosBase && !cambioDeMes) {
    // La lista ya existe: sólo se reafirma el valor elegido si sigue dentro
    // de la ventana, para que un refresco no mueva la selección.
    const vigente = S.objetivoPeriodo || d.periodo;
    if ([...sel.options].some((o) => o.value === vigente)) sel.value = vigente;
    return;
  }

  const periodos = ultimosPeriodos(d.periodo, 12);
  S.periodosBase = d.periodo;
  sel.innerHTML = '';
  for (const p of periodos) {
    sel.append(h('option', { value: p, text: etiquetaPeriodo(p, d.periodo) }));
  }

  // Si la ventana dejó afuera al mes elegido (se superó el año de historial),
  // se vuelve al mes en curso: hay que dejar el value del <select> y
  // `S.objetivoPeriodo` DÍCENTES, o el siguiente refresco pediría un período
  // que el desplegable ni siquiera ofrece.
  const elegido = S.objetivoPeriodo && periodos.includes(S.objetivoPeriodo)
    ? S.objetivoPeriodo
    : d.periodo;
  if (elegido !== S.objetivoPeriodo) S.objetivoPeriodo = null;
  sel.value = elegido;
}

/** `paso` > 0 retrocede (‹, meses anteriores); `paso` < 0 avanza (›). */
function moverPeriodoObjetivo(paso) {
  const sel = $('selectPeriodoObjetivo');
  if (!sel || sel.options.length === 0) return;
  const i = [...sel.options].findIndex((o) => o.value === sel.value);
  const destino = i + paso;
  if (destino < 0 || destino >= sel.options.length) return;
  S.objetivoPeriodo = sel.options[destino].value;
  sel.value = S.objetivoPeriodo;
  cargarObjetivoCorte();
}

/** Deshabilita la flecha que ya no tiene adónde ir. */
function actualizarFlechasPeriodo() {
  const sel = $('selectPeriodoObjetivo');
  if (!sel || sel.options.length === 0) return;
  const i = [...sel.options].findIndex((o) => o.value === sel.value);
  $('btnPeriodoAnterior').disabled = i < 0 || i >= sel.options.length - 1;
  $('btnPeriodoSiguiente').disabled = i <= 0;
}

/**
 * Carga meta + avance del PERÍODO consultado (mes en curso por defecto).
 *
 * Está AISLADA del resto del dashboard: tiene su propio try/catch y sólo
 * avisa por consola. Si el endpoint falla, el Lead Time, el FTT y los
 * gráficos de ciclo/causas ya quedaron pintados arriba, y el reintento llega
 * solo con el timer de 30 s de `cargarMetricas`.
 */
async function cargarObjetivoCorte() {
  try {
    // Sin selección explícita se pide el mes en curso SIN parámetro: es
    // literalmente la misma petición de la ronda anterior, así la carga por
    // defecto no depende del reloj del navegador ni de ningún estado previo.
    const ruta = S.objetivoPeriodo
      ? `/api/metricas/objetivo-corte?periodo=${encodeURIComponent(S.objetivoPeriodo)}`
      : '/api/metricas/objetivo-corte';
    const d = await API.get(ruta);
    S.objetivo = d;
    pintarSelectorPeriodo(d);
    pintarObjetivoCorte(d);
    pintarGraficoAvance(d);
    actualizarFlechasPeriodo();
  } catch (e) {
    console.warn('Objetivo de corte no disponible:', e.message);
  }
}

/**
 * Estado del período consultado. El selector permite ver tres situaciones
 * distintas y la tarjeta tiene que decir la verdad en cada una:
 *
 *  · en curso -> todavía se puede PROYECTAR el cierre;
 *  · cerrado  -> ya no hay proyección, hay un RESULTADO;
 *  · sin meta -> no hay nada que comparar, sólo metros cortados.
 */
function estadoPeriodo(d) {
  const configurada = d.meta_configurada !== false;
  const enCurso = d.es_mes_en_curso === true;
  // Un mes cerrado siempre tiene todos los días transcurridos; cero sólo
  // puede ser un período que todavía no empezó.
  const futuro = !enCurso && !!d.dias && d.dias.transcurridos === 0;
  return { configurada, enCurso, futuro, cerrado: !enCurso && !futuro };
}

/** Chip de estado bajo el selector. */
function pintarEstadoPeriodo(d, est) {
  const el = $('corte-estado');
  if (!el) return;
  el.classList.remove('ok', 'faltante', 'aviso');

  if (est.futuro) { el.textContent = 'Periodo futuro · aún sin datos'; return; }
  if (!est.configurada) {
    el.textContent = '⚠ Sin meta configurada para este mes';
    el.classList.add('aviso');
    return;
  }
  if (est.enCurso) { el.textContent = 'Mes en curso · en seguimiento'; return; }

  const cumplida = d.cortados >= d.meta.totales;
  el.textContent = cumplida ? 'Mes cerrado · ✔ meta cumplida' : 'Mes cerrado · meta no alcanzada';
  el.classList.add(cumplida ? 'ok' : 'faltante');
}

/**
 * Línea de proyección / resultado. Es el texto que más cambia según el mes:
 * en uno abierto se predice, en uno cerrado se informa, y sin meta sólo se
 * declara el dato.
 */
function textoProyeccion(d, est) {
  const metros = FORMATO.metros;
  const ritmo = metrosDia(d.ritmo_diario);

  if (est.futuro) return 'Periodo futuro · aún no hay metros que proyectar.';

  if (!est.configurada) {
    return est.enCurso
      ? `Sin meta configurada · ${metros(d.cortados)} cortados · ritmo ${ritmo}`
        + ' · cargala con ⚙️ Ajustar Meta Mensual'
      : `Sin meta configurada · ${metros(d.cortados)} cortados · promedio ${ritmo}`;
  }

  if (est.enCurso) {
    const dif = d.diferencia_proyeccion;
    const contraMeta = (dif === null || dif === undefined) ? ''
      : ` · ${Number(dif) >= 0 ? '+' : '−'}${metros(Math.abs(Number(dif)))} frente a la meta`;
    return `Proyección de cierre a fin de mes: ${metros(d.proyeccion_cierre)}`
      + contraMeta
      + ` · ritmo actual ${ritmo}`;
  }

  if (est.cerrado) {
    const cumplida = d.cortados >= d.meta.totales;
    const veredicto = cumplida
      ? `✔ superó la meta en ${metros(d.cortados - d.meta.totales)}`
      : `faltaron ${metros(d.meta.totales - d.cortados)}`;
    return `Resultado final del mes: ${metros(d.cortados)} · ${veredicto}`
      + ` · promedio ${ritmo}`;
  }

  return '';
}

/** Nota bajo el gráfico: días, ritmo e ideal cuando hay meta. */
function textoNotaGrafico(d, est) {
  const ritmo = metrosDia(d.ritmo_diario);
  const ideal = est.configurada && d.dias.totales > 0
    ? ` · ideal ${metrosDia(d.meta.totales / d.dias.totales)}`
    : '';

  if (est.futuro) return 'Periodo futuro: todavía no hay metros que graficar.';

  if (est.cerrado) {
    return `${etiquetaPeriodoLargo(d.periodo)} cerrado · ${d.dias.totales} días`
      + ` · promedio ${ritmo}${ideal}`;
  }

  if (!est.configurada) {
    return `${d.dias.transcurridos} de ${d.dias.totales} días · ritmo ${ritmo}`;
  }

  const cumplida = d.cortados >= d.meta.totales;
  return cumplida
    ? `✔ Meta cumplida con ${d.dias.transcurridos} de ${d.dias.totales} días · ${ritmo}`
    : `${d.dias.transcurridos} de ${d.dias.totales} días · ritmo ${ritmo}`
      + (d.dias.restantes > 0 && d.ritmo_necesario > 0
        ? ` · hacen falta ${metrosDia(d.ritmo_necesario)} el resto del mes`
        : '');
}

/** Tarjeta: avance, desglose por línea y proyección/resultado del período. */
function pintarObjetivoCorte(d) {
  if (!d || !d.meta) return;

  const est = estadoPeriodo(d);
  pintarEstadoPeriodo(d, est);
  $('meta-corte-periodo').textContent = etiquetaPeriodoLargo(d.periodo);

  $('corte-cortados').textContent = FORMATO.metros(d.cortados);
  $('corte-meta').textContent = est.configurada
    ? `/ ${FORMATO.metros(d.meta.totales)} meta del mes`
    : '/ sin meta configurada';

  const pct = (d.porcentaje === null || d.porcentaje === undefined) ? null : Number(d.porcentaje);
  $('corte-pct').textContent = pct === null ? '—' : `${pct}%`;

  // La barra es una magnitud acotada 0..100: lo que se pasa del 100 % se
  // dibuja llena y en verde, para que "meta superada" se lea de un vistazo
  // en lugar de ver una barra con el texto 132 % desbordado. Sin meta no hay
  // porcentaje y la barra queda en cero, sin señal falsa de avance.
  const llenado = pct === null ? 0 : Math.max(0, Math.min(100, pct));
  const fill = $('corte-barra-fill');
  fill.style.width = `${llenado}%`;
  fill.classList.toggle('completo', pct !== null && pct >= 100);
  $('corte-barra').setAttribute('aria-valuenow', String(Math.round(llenado)));

  for (const l of (d.por_linea || [])) {
    const idTxt = l.linea === 'Placares' ? 'corte-placares' : 'corte-cocinas';
    $(idTxt).textContent = est.configurada && l.meta > 0
      ? `${FORMATO.metros(l.cortados)} / ${FORMATO.metros(l.meta)}`
      : `${FORMATO.metros(l.cortados)} / —`;
    const p = l.meta > 0 ? Math.max(0, Math.min(100, (l.cortados / l.meta) * 100)) : 0;
    $(`${idTxt}-fill`).style.width = `${p}%`;
  }

  $('corte-proyeccion').textContent = textoProyeccion(d, est);
  $('nota-corte').textContent = textoNotaGrafico(d, est);
}

/**
 * Gráfico mixto: barras por DÍA contra la tendencia ideal, más las dos
 * rectas ACUMULADAS sobre un segundo eje.
 *
 * Hacen falta dos ejes porque las magnitudes no conviven: un día puede ser
 * 60 m mientras el acumulado va en 700. Sin el eje derecho, las barras
 * quedarían aplastadas contra el cero y el gráfico no diría nada.
 *
 * Las dos rectas IDEALES sólo se grafican si el mes tiene meta (`ideal` viene
 * en null cuando `meta_configurada` es false): en un mes histórico sin
 * objetivo trazar una línea en cero sería presentar un falso objetivo real.
 */
function pintarGraficoAvance(d) {
  if (typeof Chart === 'undefined' || !d || !Array.isArray(d.serie)) return;
  const p = paletaIndustrial();
  const cian = '#22B8CF';

  const hayIdeal = d.serie.some((x) => x.ideal !== null && x.ideal !== undefined);

  // Se arma en orden de leyenda (mismo orden visual que la versión original)
  // y con `order` decreciente para que las barras queden debajo de las líneas.
  const datasets = [
    {
      type: 'bar',
      label: 'Metros del día',
      data: d.serie.map((x) => x.metros),
      backgroundColor: cian,
      borderRadius: 4,
      maxBarThickness: 26,
      order: 3,
    },
  ];
  if (hayIdeal) {
    datasets.push({
      type: 'line',
      label: 'Ideal diario',
      data: d.serie.map((x) => x.ideal),
      borderColor: p.texto,
      borderDash: [6, 5],
      borderWidth: 1.5,
      pointRadius: 0,
      tension: 0,
      fill: false,
      order: 2,
    });
  }
  datasets.push({
    type: 'line',
    label: 'Acumulado',
    data: d.serie.map((x) => x.acumulado),
    borderColor: p.placares,
    borderWidth: 2,
    pointRadius: 0,
    tension: 0.25,
    fill: false,
    yAxisID: 'y2',
    order: 1,
  });
  if (hayIdeal) {
    datasets.push({
      type: 'line',
      label: 'Acumulado ideal',
      data: d.serie.map((x) => x.ideal_acumulado),
      borderColor: p.proceso,
      borderDash: [3, 4],
      borderWidth: 1.5,
      pointRadius: 0,
      tension: 0,
      fill: false,
      yAxisID: 'y2',
      order: 0,
    });
  }

  const datos = {
    labels: d.serie.map((x) => `${x.fecha.slice(8)}/${x.fecha.slice(5, 7)}`),
    datasets,
  };

  const opciones = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        position: 'bottom',
        labels: { color: p.texto, boxWidth: 12, padding: 10, font: { size: 11 } },
      },
      tooltip: {
        callbacks: { label: (c) => ` ${c.dataset.label}: ${FORMATO.metros(c.parsed.y)}` },
      },
    },
    scales: {
      x: {
        ticks: { color: p.texto, maxRotation: 60, minRotation: 45, font: { size: 9 } },
        grid: { display: false },
      },
      y: {
        position: 'left',
        ticks: { color: p.texto },
        grid: { color: p.borde },
        title: { display: true, text: 'm / día', color: p.texto },
      },
      y2: {
        position: 'right',
        ticks: { color: p.texto },
        grid: { drawOnChartArea: false },
        title: { display: true, text: 'm acumulados', color: p.texto },
      },
    },
  };

  if (GRAFICOS.avance) { GRAFICOS.avance.data = datos; GRAFICOS.avance.update(); return; }
  GRAFICOS.avance = new Chart($('grafico-avance'), { type: 'bar', data: datos, options: opciones });
}

/**
 * Abre el modal de ajuste para el PERÍODO que se está mirando, ya precargado
 * con las metas vigentes de ese mes.
 */
function abrirAjusteMetaCorte() {
  const d = S.objetivo;
  if (!d) { Avisos.aviso('Todavía no se cargó el período a configurar.'); return; }

  const configurada = d.meta_configurada !== false;
  $('meta-corte-periodo').textContent = etiquetaPeriodoLargo(d.periodo);
  $('meta-corte-nota').textContent = configurada
    ? 'Si se deja un campo vacío, conserva el valor actual.'
    : 'Este mes todavía no tiene registro de meta: se creará con lo que guardes'
      + ' y los campos vacíos tomarán el valor por defecto del esquema.';

  // Con meta vigente se precargan los valores. Sin meta se dejan VACÍOS, para
  // que los placeholders (1200 / 800 / 400) funcionen como guía de carga y
  // nadie "guarde" por accidente un cero que no es ninguna meta.
  $('meta-corte-total').value = configurada ? d.meta.totales : '';
  $('meta-corte-placares').value = configurada ? d.meta.placares : '';
  $('meta-corte-cocinas').value = configurada ? d.meta.cocinas : '';
  // Metas complementarias: vacías si el mes no las tiene configuradas.
  $('meta-corte-unidades').value = configurada && d.meta.unidades != null ? d.meta.unidades : '';
  $('meta-corte-monto').value = configurada && d.meta.monto != null ? d.meta.monto : '';
  $('meta-corte-categoria').value = d.categoria_o_area || '';

  Modal.abrir('modal-meta-corte');
}

/**
 * Guarda las metas del período seleccionado.
 *
 * `periodo` viaja SIEMPRE en el cuerpo: sin él el servidor cae en el mes en
 * curso, y se pisaría la meta de hoy al querer guardar la de un mes que se
 * está revisando. El UPDATE del backend filtra exactamente por ese período,
 * así que un mes nunca toca a otro.
 *
 * Un campo vacío viaja como '' y el servidor lo trata como "no enviado":
 * conserva el valor actual (o el del esquema, si el mes se acaba de crear).
 */
async function guardarMetaCorte(ev) {
  ev.preventDefault();

  const periodo = S.objetivo && S.objetivo.periodo;
  if (!periodo) { Avisos.aviso('No hay período seleccionado para guardar.'); return; }

  const cuerpo = {
    periodo,
    meta_metros_totales: $('meta-corte-total').value,
    meta_metros_placares: $('meta-corte-placares').value,
    meta_metros_cocinas: $('meta-corte-cocinas').value,
    // Campos OPCIONALES: vacío = conservar / no configurar.
    meta_unidades_totales: $('meta-corte-unidades').value,
    meta_monto_total: $('meta-corte-monto').value,
    categoria_o_area: $('meta-corte-categoria').value,
  };
  const btn = $('meta-corte-guardar');
  btn.disabled = true;
  try {
    const r = await API.post('/api/metricas/objetivo-corte', cuerpo);
    Avisos.ok('✔ Meta mensual de corte actualizada.',
      `${etiquetaPeriodoLargo(r.periodo)} · ${FORMATO.metros(r.meta.totales)} en total`);
    Modal.cerrar('modal-meta-corte');
    // Sigue mirando el mismo mes: si se guardó un período histórico, el
    // refresco debe volver sobre ÉL y no saltar al mes en curso.
    await cargarObjetivoCorte();
    // El comparativo anual cambió: se refresca el año del período guardado.
    await cargarObjetivosAnio(Number(periodo.slice(0, 4)));
  } catch (e) {
    manejarError(e, 'Guardar meta de corte');
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* Metas por período: comparativo anual (12 meses)                     */
/* ------------------------------------------------------------------ */

/** Monto en pesos con separador de miles (2 decimales como máximo). */
function formatoMonto(v) {
  if (v === null || v === undefined || v === '') return '—';
  return Number(v).toLocaleString('es-AR', {
    style: 'currency',
    currency: 'ARS',
    maximumFractionDigits: 2,
  });
}

/** Carga el comparativo anual. `anio` null = año en curso. */
async function cargarObjetivosAnio(anio) {
  if (!$('panel-objetivos-anio')) return;
  try {
    const q = anio ? `?anio=${encodeURIComponent(anio)}` : '';
    const d = await API.get(`/api/metricas/objetivos-anio${q}`);
    S.objetivosAnio = d;
    S.anioObjetivos = d.anio;
    pintarSelectorAnio(d);
    pintarGraficoObjetivosAnio(d);
    pintarTablaObjetivosAnio(d);
  } catch (e) {
    console.warn('Objetivos por período no disponibles:', e.message);
    const nota = $('nota-objetivos-anio');
    if (nota) nota.textContent = 'No se pudo cargar el comparativo anual.';
  }
}

/** Llena el selector de año sin perder la selección en cada refresco. */
function pintarSelectorAnio(d) {
  const sel = $('selectAnioObjetivos');
  if (!sel || !d) return;
  const anios = (Array.isArray(d.anios) && d.anios.length ? d.anios : [d.anio]).map(Number);
  const firma = anios.join(',');
  if (sel.dataset.firma !== firma) {
    sel.innerHTML = '';
    for (const a of anios) sel.append(h('option', { value: String(a), text: String(a) }));
    sel.dataset.firma = firma;
  }
  sel.value = String(d.anio);
}

/** Barras meta/real + línea de % de cumplimiento (eje derecho). */
function pintarGraficoObjetivosAnio(d) {
  if (typeof Chart === 'undefined' || !d || !Array.isArray(d.meses)) return;
  const lienzo = $('grafico-objetivos-anio');
  if (!lienzo) return;

  const p = paletaIndustrial();
  const datos = {
    labels: d.meses.map((m) => MESES_CORTOS[m.mes - 1] || m.periodo.slice(5)),
    datasets: [
      {
        type: 'bar',
        label: 'Meta (m)',
        data: d.meses.map((m) => (m.meta_configurada ? m.meta.metros : null)),
        backgroundColor: 'rgba(29, 99, 184, .30)',
        borderColor: p.placares,
        borderWidth: 1,
        borderRadius: 4,
        order: 2,
      },
      {
        type: 'bar',
        label: 'Real (m)',
        data: d.meses.map((m) => m.real.metros),
        backgroundColor: 'rgba(34, 184, 207, .85)',
        borderColor: '#0f7f93',
        borderWidth: 1,
        borderRadius: 4,
        order: 1,
      },
      {
        type: 'line',
        label: '% cumplimiento',
        data: d.meses.map((m) => m.porcentaje),
        borderColor: p.proceso,
        backgroundColor: 'transparent',
        borderWidth: 2,
        pointRadius: 2,
        pointHoverRadius: 4,
        tension: 0.25,
        spanGaps: false,
        yAxisID: 'y2',
        order: 0,
      },
    ],
  };

  const opciones = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        position: 'bottom',
        labels: { color: p.texto, boxWidth: 12, padding: 12, font: { size: 11 } },
      },
      tooltip: {
        callbacks: {
          label: (c) => (c.dataset.yAxisID === 'y2'
            ? ` ${c.dataset.label}: ${c.parsed.y === null ? '—' : `${c.parsed.y}%`}`
            : ` ${c.dataset.label}: ${FORMATO.metros(c.parsed.y)}`),
        },
      },
    },
    scales: {
      x: { ticks: { color: p.texto }, grid: { display: false } },
      y: {
        position: 'left',
        beginAtZero: true,
        ticks: { color: p.texto },
        grid: { color: p.borde },
        title: { display: true, text: 'metros', color: p.texto },
      },
      y2: {
        position: 'right',
        beginAtZero: true,
        suggestedMax: 120,
        ticks: { color: p.texto, callback: (v) => `${v}%` },
        grid: { drawOnChartArea: false },
        title: { display: true, text: '% cumplimiento', color: p.texto },
      },
    },
  };

  if (GRAFICOS.objetivosAnio) {
    GRAFICOS.objetivosAnio.data = datos;
    GRAFICOS.objetivosAnio.options = opciones;
    GRAFICOS.objetivosAnio.update();
    return;
  }
  GRAFICOS.objetivosAnio = new Chart(lienzo, { type: 'bar', data: datos, options: opciones });
}

/** Tabla de 12 meses + fila de totales. */
function pintarTablaObjetivosAnio(d) {
  const tabla = $('tabla-objetivos-anio');
  const tbody = tabla && tabla.tBodies[0];
  if (!tbody || !d || !Array.isArray(d.meses)) return;

  const chipPct = (pct) => {
    const clase = pct === null || pct === undefined
      ? 'chip chip-gris'
      : pct >= 100 ? 'chip chip-verde'
        : pct >= 75 ? 'chip chip-azul'
          : 'chip chip-amarillo';
    return h('span', {
      class: clase,
      text: pct === null || pct === undefined ? '—' : `${pct}%`,
    });
  };

  tbody.innerHTML = '';
  const filas = d.meses.map((m) => h('tr', {},
    h('td', {}, h('b', { text: MESES_CORTOS[m.mes - 1] || m.periodo.slice(5) }),
      ' ', h('span', { class: 'texto-suave', text: m.periodo.slice(0, 4) })),
    h('td', { class: 'num', text: m.meta_configurada ? FORMATO.metros(m.meta.metros) : '—' }),
    h('td', { class: 'num', text: FORMATO.metros(m.real.metros) }),
    h('td', { class: 'num' }, chipPct(m.porcentaje)),
    h('td', { class: 'num', text: String(m.real.ots) }),
    h('td', { class: 'num', text: m.meta.unidades === null ? '—' : String(m.meta.unidades) }),
    h('td', { class: 'num', text: m.meta.monto === null ? '—' : formatoMonto(m.meta.monto) }),
    h('td', { text: m.categoria_o_area || '—' })));

  const t = d.totales || {};
  filas.push(h('tr', { class: 'fila-total' },
    h('td', {}, h('b', { text: 'Total del año' })),
    h('td', { class: 'num', text: t.meta_metros === null ? '—' : FORMATO.metros(t.meta_metros) }),
    h('td', { class: 'num', text: FORMATO.metros(t.real_metros) }),
    h('td', { class: 'num' }, chipPct(t.porcentaje)),
    h('td', { class: 'num', text: String(t.real_ots || 0) }),
    h('td', { class: 'num', text: t.meta_unidades === null ? '—' : String(t.meta_unidades) }),
    h('td', { class: 'num', text: t.meta_monto === null ? '—' : formatoMonto(t.meta_monto) }),
    h('td', { text: '—' })));

  tbody.append(...filas);
  estamparEtiquetas(tabla);

  const configurados = d.meses.filter((m) => m.meta_configurada).length;
  const nota = $('nota-objetivos-anio');
  if (nota) {
    nota.textContent = `Año ${d.anio} · ${configurados} de 12 meses con meta configurada`
      + ` · real acumulado ${FORMATO.metros(t.real_metros)}`
      + (t.porcentaje === null ? '.' : ` (${t.porcentaje}% del objetivo anual).`);
  }
}

/* ------------------------------------------------------------------ */
/* Etiquetas de columna para el layout de tarjetas (móvil)             */
/* ------------------------------------------------------------------ */
/**
 * Estampa data-label en cada <td> a partir del <thead>, para que la
 * conversión tarjetas-apiladas de app.css pueda mostrar el nombre de
 * columna. Se llama después de repintar cualquier tabla: así añadir una
 * columna no exige tocar el CSS ni este helper.
 */
function estamparEtiquetas(idTabla) {
  const tabla = typeof idTabla === 'string' ? $(idTabla) : idTabla;
  if (!tabla || !tabla.tHead) return;
  const cabeceras = [...tabla.tHead.rows[0].cells].map((th) => th.textContent.trim());
  for (const fila of tabla.tBodies[0] ? tabla.tBodies[0].rows : []) {
    [...fila.cells].forEach((td, i) => {
      if (cabeceras[i]) td.setAttribute('data-label', cabeceras[i]);
    });
  }
}

/* ------------------------------------------------------------------ */
/* Panel dedicado: Materiales / Placas                                 */
/* ------------------------------------------------------------------ */

/** Clasifica una fila del catálogo para pintar su chip de estado. */
function chipEstadoConsumo(m) {
  if (m.pct_consumo >= 100) return 'chip chip-verde';
  if (m.pct_consumo >= 60) return 'chip chip-azul';
  if (m.pct_consumo > 0) return 'chip chip-amarillo';
  return 'chip chip-gris';
}

async function cargarMateriales() {
  try {
    const d = await API.get('/api/materiales/catalogo');
    S.materiales = d;
    poblarFiltroEspesor(d);
    pintarResumenMateriales(d);
    pintarTablaMateriales();
  } catch (e) {
    manejarError(e, 'Cargar catálogo de materiales');
  }
}

function poblarFiltroEspesor(d) {
  const sel = $('mat-filtro-espesor');
  const previo = sel.value;
  sel.innerHTML = '';
  sel.append(h('option', { value: '', text: 'Todos los espesores' }));
  for (const mm of d.espesores_disponibles) {
    sel.append(h('option', { value: String(mm), text: `${mm} mm` }));
  }
  sel.append(h('option', { value: 'n/d', text: 'Sin espesor (n/d)' }));
  if (previo) sel.value = previo;
}

function pintarResumenMateriales(d) {
  const cont = $('materiales-resumen');
  cont.innerHTML = '';
  const tarjeta = (titulo, valor, sub, acento) => h('div', { class: `kpi-ind ${acento}` },
    h('div', { class: 'kpi-titulo', text: titulo }),
    h('div', { class: 'kpi-valor', text: valor }),
    h('div', { class: 'kpi-sub', text: sub }));

  const totalReq = d.resumen_familias.reduce((a, f) => a + f.requeridas, 0);
  const totalCons = d.resumen_familias.reduce((a, f) => a + f.consumidas, 0);
  const pct = totalReq > 0 ? Math.round((totalCons / totalReq) * 100) : 0;

  cont.append(tarjeta('Placas requeridas', String(Math.round(totalReq)),
    `${d.total} material(es) en catálogo`, 'acento-placares'));
  cont.append(tarjeta('Placas consumidas', String(Math.round(totalCons)),
    `${pct}% del requerido`, 'acento-proceso'));
  cont.append(tarjeta('Espesores activos', String(d.espesores_disponibles.length),
    'Distintos espesores en uso', 'acento-compartidos'));

  // Una tarjeta por familia de placa (Melamina / MDF / Fibroplus). Rota sobre
  // los acentos de LÍNEA (identidad), no sobre los de estado: `acento-pausa`
  // significa "standby" en este sistema de diseño y una familia de placa no
  // es un estado de proceso.
  const acentosFamilia = ['acento-placares', 'acento-cocinas', 'acento-compartidos'];
  d.resumen_familias.slice(0, 4).forEach((f, i) => {
    cont.append(tarjeta(f.familia, String(f.materiales),
      `${Math.round(f.requeridas)} placas`, acentosFamilia[i % acentosFamilia.length]));
  });
}

function pintarTablaMateriales() {
  const d = S.materiales;
  if (!d) return;
  const q = FORMATO.normalizar($('mat-filtro-nombre').value.trim());
  const espesor = $('mat-filtro-espesor').value;
  const familia = $('mat-filtro-familia').value;
  const cuerpo = $('cuerpo-materiales');
  cuerpo.innerHTML = '';

  const filas = d.catalogo.filter((m) => {
    if (familia && m.familia !== familia) return false;
    if (espesor === 'n/d' && m.espesor_mm !== null) return false;
    if (espesor && espesor !== 'n/d' && String(m.espesor_mm) !== espesor) return false;
    if (q && !FORMATO.normalizar(m.material_nombre).includes(q)) return false;
    return true;
  });

  $('mat-resumen').textContent = `${filas.length} de ${d.total} materiales`;
  $('chip-materiales').textContent = String(d.total);

  if (!filas.length) {
    cuerpo.append(h('tr', {}, h('td', { colspan: '8', class: 'vacio', text: 'Sin materiales que coincidan.' })));
    estamparEtiquetas('tabla-materiales');
    return;
  }

  for (const m of filas) {
    cuerpo.append(h('tr', {},
      h('td', {}, h('b', { text: m.material_nombre })),
      h('td', { text: m.familia }),
      h('td', { class: 'num', text: m.espesor_mm === null ? 'n/d' : `${m.espesor_mm} mm` }),
      h('td', { class: 'num', text: m.placas_requeridas.toFixed(1) }),
      h('td', { class: 'num', text: m.placas_consumidas.toFixed(1) }),
      h('td', { class: 'num', text: `${m.pct_consumo}%` }),
      h('td', { class: 'num', text: String(m.ots_usan) }),
      h('td', {}, h('span', { class: chipEstadoConsumo(m), text: m.pct_consumo >= 100 ? 'Completo' : 'En curso' }))
    ));
  }
  estamparEtiquetas('tabla-materiales');
}

/* ------------------------------------------------------------------ */
/* Panel dedicado: Talleres Compartidos                                */
/* ------------------------------------------------------------------ */

async function cargarCompartidos() {
  try {
    if (!S.registrosExport) {
      const exp = await API.get('/api/export/registros?limite=20000');
      S.registrosExport = exp.registros || [];
    }
    // Talleres compartidos: los sectores cuya `linea_area` es 'Compartido'
    // (Lustre, Herrería, Vidrio, Especiales). NO se filtra por `es_compartido`:
    // ese flag es más amplio y en el maestro lo comparten sectores del flujo
    // propio de Placares (Cajoneras, Herrajes, Control de Calidad, Embalaje),
    // lo que mezclaría talleres dedicados con los realmente compartidos.
    S.compartidos = S.registrosExport.filter((r) => r.linea_area === 'Compartido');
    poblarFiltroSectorCompartido();
    pintarResumenCompartidos();
    pintarTablaCompartidos();
    // El gráfico de ciclo también depende del export: ya puede dibujarse.
    pintarGraficoCiclo();
    pintarStandbyYRiesgo();
  } catch (e) {
    manejarError(e, 'Cargar talleres compartidos');
  }
}

function poblarFiltroSectorCompartido() {
  const sel = $('comp-filtro-sector');
  const previo = sel.value;
  const sectores = [...new Set((S.compartidos || []).map((r) => r.nombre_sector))].sort();
  sel.innerHTML = '';
  sel.append(h('option', { value: '', text: 'Todos los talleres' }));
  for (const s of sectores) sel.append(h('option', { value: s, text: s }));
  if (previo) sel.value = previo;
}

function pintarResumenCompartidos() {
  const cont = $('compartidos-resumen');
  cont.innerHTML = '';
  const filas = S.compartidos || [];

  const cerradas = filas.filter((r) => r.estado_etapa === 'Finalizado');
  const abiertas = filas.filter((r) => r.estado_etapa !== 'Finalizado');
  const minutos = cerradas.reduce((a, r) => a + Number(r.duracion_minutos || 0), 0);
  const ots = new Set(filas.map((r) => r.numero_ot)).size;

  const tarjeta = (titulo, valor, sub, acento) => h('div', { class: `kpi-ind ${acento}` },
    h('div', { class: 'kpi-titulo', text: titulo }),
    h('div', { class: 'kpi-valor', text: valor }),
    h('div', { class: 'kpi-sub', text: sub }));

  cont.append(tarjeta('OTs que pasan por compartidos', String(ots),
    'Demandan talleres de ambas líneas', 'acento-compartidos'));
  cont.append(tarjeta('Horas en taller', FORMATO.duracion(Math.round(minutos)),
    `${cerradas.length} etapa(s) cerrada(s)`, 'acento-placares'));
  cont.append(tarjeta('Etapas abiertas', String(abiertas.length),
    'En curso o pausadas ahora', abiertas.length ? 'acento-pausa' : 'acento-proceso'));

  const talleres = new Set(filas.map((r) => r.nombre_sector));
  cont.append(tarjeta('Talleres activos', String(talleres.size),
    [...talleres].join(' · ') || 'Sin actividad', 'acento-compartidos'));
}

function pintarTablaCompartidos() {
  if (!S.compartidos) return;
  const sector = $('comp-filtro-sector').value;
  const linea = $('comp-filtro-linea').value;
  const cuerpo = $('cuerpo-compartidos');
  cuerpo.innerHTML = '';

  const filas = S.compartidos
    .filter((r) => {
      if (sector && r.nombre_sector !== sector) return false;
      if (linea && r.linea_ot !== linea) return false;
      return true;
    })
    .sort((a, b) => Date.parse(b.fecha_hora_inicio || 0) - Date.parse(a.fecha_hora_inicio || 0))
    .slice(0, 300);

  $('comp-resumen').textContent = `${filas.length} etapa(s) en talleres compartidos`;
  $('chip-compartidos').textContent = String(new Set((S.compartidos || []).map((r) => r.numero_ot)).size);

  if (!filas.length) {
    cuerpo.append(h('tr', {}, h('td', { colspan: '7', class: 'vacio', text: 'Sin etapas en talleres compartidos.' })));
    estamparEtiquetas('tabla-compartidos');
    return;
  }

  for (const r of filas) {
    const abierta = r.estado_etapa !== 'Finalizado';
    const chip = abierta
      ? (r.estado_etapa === 'Pausado' ? 'chip chip-amarillo' : 'chip chip-verde')
      : 'chip chip-gris';
    cuerpo.append(h('tr', {},
      h('td', {}, h('b', { text: r.nombre_sector })),
      h('td', {}, h('span', {
        class: `chip ${r.linea_ot === 'Cocinas' ? 'chip-rojo' : 'chip-azul'}`,
        text: r.linea_ot || '—',
      })),
      h('td', {}, h('span', { class: 'mono', text: r.numero_ot })),
      h('td', { text: r.cliente || '—' }),
      h('td', { text: r.estado_etapa }),
      h('td', { class: 'num', text: r.duracion_minutos === null ? 'En curso' : FORMATO.duracion(r.duracion_minutos) }),
      h('td', {}, h('span', { class: chip, text: r.estado_etapa }))
    ));
  }
  estamparEtiquetas('tabla-compartidos');
}

function pintarCargaSectores(m) {
  const cont = $('carga-sectores');
  cont.innerHTML = '';
  const filas = m.sectores_carga_hoy;
  if (!filas.length) {
    cont.append(h('div', { class: 'vacio', text: 'Sin actividad registrada hoy.' }));
    return;
  }
  const max = Math.max(...filas.map((f) => f.horas_total), 0.01);
  filas.forEach((f, i) => {
    cont.append(h('div', { class: `carga-fila ${i === 0 && f.horas_total > 0 ? 'top' : ''}` },
      h('span', { class: 'carga-nombre', text: f.nombre_corto || f.nombre_sector }),
      h('div', { class: 'carga-barra' },
        h('span', { style: `width:${Math.round((f.horas_total / max) * 100)}%` })),
      h('span', { class: 'carga-valor num', text: `${f.horas_total} h` })
    ));
  });
}

function pintarPausas(m) {
  const cuerpo = $('cuerpo-pausas');
  cuerpo.innerHTML = '';
  $('nota-pausas').textContent =
    `Período ${FORMATO.fecha(m.periodo.desde)} → ${FORMATO.fecha(m.periodo.hasta)}.` +
    (m._nota_historica ? ` ${m._nota_historica}` : '');

  if (!m.pausas_por_motivo.length) {
    cuerpo.append(h('tr', {}, h('td', { colspan: '3', class: 'vacio', text: 'Sin pausas registradas.' })));
    return;
  }
  for (const p of m.pausas_por_motivo) {
    cuerpo.append(h('tr', {},
      h('td', { text: p.motivo }),
      h('td', { class: 'num', text: String(p.frecuencia) }),
      h('td', { class: 'num', text: `${p.horas_perdidas} h` })
    ));
  }
  estamparEtiquetas(cuerpo.closest('table'));
}

/* ------------------------------------------------------------------ */
/* Seguimiento por sector / avance (Fase 2)                            */
/* ------------------------------------------------------------------ */

function pintarSeguimiento() {
  const sectorId = Number($('filtro-sector-seg').value) || null;
  const avance = $('filtro-avance').value;
  const cuerpo = $('cuerpo-seguimiento');
  cuerpo.innerHTML = '';

  const filas = S.ordenes.filter((ot) => {
    if (sectorId && !(ot.sectores_requeridos || []).includes(sectorId)) return false;
    const p = ot.progreso.porcentaje;
    if (avance === 'sin-iniciar' && p !== 0) return false;
    if (avance === 'en-curso' && !(p > 0 && p < 100)) return false;
    if (avance === 'completado' && p !== 100) return false;
    return true;
  });

  $('resumen-seguimiento').textContent = `${filas.length} de ${S.ordenes.length} OTs`;

  if (!filas.length) {
    cuerpo.append(h('tr', {}, h('td', { colspan: '7', class: 'vacio', text: 'No hay OTs que coincidan con el filtro.' })));
    return;
  }

  for (const ot of filas) {
    const etapa = ot.etapa_activa;
    const fila = h('tr', { style: 'cursor:pointer;', onclick: () => verDetalle(ot.id) },
      h('td', {}, h('b', { text: ot.numero_ot })),
      h('td', { text: ot.cliente }),
      h('td', {}, h('span', { class: `chip ${chipEstado(ot.estado_general)}`, text: ot.estado_general })),
      h('td', {}, etapa
        ? h('span', {}, h('span', { class: 'chip chip-verde', text: etapa.nombre_corto || etapa.nombre_sector }),
          ' ', h('span', { class: 'texto-suave', text: etapa.operario_nombre }))
        : h('span', { class: 'texto-suave', text: '—' })),
      h('td', {},
        h('div', { class: 'texto-suave', text: `${ot.progreso.sectores_finalizados}/${ot.progreso.sectores_requeridos}` }),
        h('div', { class: 'barra-progreso', style: 'width:90px;' }, h('span', { style: `width:${ot.progreso.porcentaje}%` }))),
      h('td', { class: 'num', text: FORMATO.duracion(ot.minutos_acumulados) }),
      h('td', {}, chipsRequisitos(ot))
    );
    cuerpo.append(fila);
  }
  estamparEtiquetas('tabla-seguimiento');
}

/** Chip de estado reutilizable (igual que el Terminal). */
function chipEstado(estado) {
  if (estado === 'En Producción') return 'chip-verde';
  if (estado === 'Detenido') return 'chip-amarillo';
  if (estado === 'Finalizado') return 'chip-gris';
  return 'chip-azul';
}

/* ------------------------------------------------------------------ */
/* Alta de OT                                                          */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Materiales / placas por OT (Fase 3)                                 */
/* ------------------------------------------------------------------ */

/** Crea una fila editable de material dentro del formulario de alta. */
function filaMaterial(mat) {
  const m = mat || {};
  const nombre = h('input', {
    type: 'text', class: 'mat-nombre', placeholder: 'MDF 18mm', maxlength: '140',
    autocomplete: 'off', value: m.material_nombre || '',
  });
  const cantidad = h('input', {
    type: 'text', class: 'mat-cantidad', placeholder: '12', inputmode: 'decimal',
    autocomplete: 'off', value: m.cantidad_placas !== undefined ? String(m.cantidad_placas) : '',
  });
  const obs = h('input', {
    type: 'text', class: 'mat-obs', placeholder: 'Observación (opcional)', maxlength: '300',
    autocomplete: 'off', value: m.observaciones || '',
  });
  const btnQuitar = h('button', {
    type: 'button', class: 'btn btn-chico btn-peligro', text: '✕', title: 'Quitar material',
    onclick: (ev) => ev.currentTarget.closest('.fila-material').remove(),
  });
  return h('div', { class: 'fila-material fila-flex', style: 'gap:8px; margin-top:6px;' },
    nombre, cantidad, obs, btnQuitar);
}

function agregarFilaMaterial(mat) {
  const fila = filaMaterial(mat);
  $('materiales-filas').append(fila);
  return fila;
}

/** Lee y valida las filas de materiales; devuelve lista lista para el payload. */
function recolectarMateriales() {
  const filas = [];
  let n = 0;
  document.querySelectorAll('#materiales-filas .fila-material').forEach((fila) => {
    n += 1;
    const nombre = fila.querySelector('.mat-nombre').value.trim();
    const cantidadRaw = fila.querySelector('.mat-cantidad').value.trim();
    const obs = fila.querySelector('.mat-obs').value.trim();
    if (!nombre && !cantidadRaw) return; // fila vacía: se ignora
    if (!nombre) throw new Error(`Material #${n}: falta el nombre.`);
    if (!cantidadRaw) throw new Error(`Material "${nombre}": falta la cantidad de placas.`);
    const cantidad = Number(cantidadRaw.replace(',', '.'));
    if (!Number.isFinite(cantidad) || cantidad <= 0) {
      throw new Error(`Material "${nombre}": la cantidad de placas debe ser un número mayor a cero.`);
    }
    filas.push({ material_nombre: nombre, cantidad_placas: cantidad, observaciones: obs || null });
  });
  return filas;
}

function limpiarMaterialesForm() {
  $('materiales-filas').innerHTML = '';
  agregarFilaMaterial();
}

async function guardarOT(ev) {
  ev.preventDefault();

  const payload = {
    numero_ot: $('ot-numero').value,
    cliente: $('ot-cliente').value,
    modelo: $('ot-modelo').value,
    linea_area: $('ot-linea').value,
    metros_lineales: $('ot-metros').value,
    fecha_prometida: $('ot-prometida').value,
    requiere_vidrio: false,
    requiere_lustre: false,
    requiere_herreria: false,
    requiere_especiales: false,
  };
  document.querySelectorAll('#checks-especiales input').forEach((cb) => {
    payload[cb.value] = cb.checked;
  });

  if (!payload.numero_ot.trim() || !payload.cliente.trim()) {
    Avisos.aviso('Complete al menos el Número de OT y el Cliente.');
    return;
  }

  let materiales;
  try {
    materiales = recolectarMateriales();
  } catch (e) {
    Avisos.aviso(e.message);
    return;
  }
  if (materiales.length) payload.materiales = materiales;

  try {
    const r = await API.post('/api/ordenes', payload);
    Avisos.ok(`✔ OT ${r.numero_ot} creada`,
      materiales.length ? `${r.cliente} · ${materiales.length} material(es)` : `${r.cliente} · ${FORMATO.metros(r.metros_lineales)}`);
    $('form-ot').reset();
    limpiarMaterialesForm();
    await cargarOrdenes();
  } catch (e) {
    manejarError(e, 'Alta de OT');
  }
}

/* ------------------------------------------------------------------ */
/* Tabla de OTs                                                        */
/* ------------------------------------------------------------------ */

async function cargarOrdenes() {
  try {
    const r = await API.get('/api/ordenes');
    S.ordenes = r.ordenes;
    pintarTabla();
    pintarSeguimiento();
  } catch (e) {
    manejarError(e, 'Cargar OTs');
  }
}

function chipsRequisitos(ot) {
  const defs = [
    ['requiere_vidrio', 'Vidrio', 'chip-azul', '🪟'],
    ['requiere_lustre', 'Lustre', 'chip-amarillo', '✨'],
    ['requiere_herreria', 'Herrería', 'chip-gris', '🔩'],
    ['requiere_especiales', 'Especiales', 'chip-rojo', '🛠'],
  ];
  const activos = defs.filter(([k]) => ot[k]);
  if (!activos.length) return h('span', { class: 'texto-suave', text: '—' });
  return activos.map(([, nombre, clase, icono]) => h('span', { class: `chip ${clase}`, text: `${icono} ${nombre}` }));
}

/* ------------------------------------------------------------------ */
/* Filtro rápido de línea (?linea=Placares | Cocinas | compartidos)    */
/* Enlazado desde el sidebar: azul = Placares, rojo = Cocinas.         */
/* ------------------------------------------------------------------ */

/** Valores admitidos por #filtro-linea (los mismos que usa el sidebar). */
const LINEAS_FILTRO = ['Placares', 'Cocinas', 'compartidos'];

/** ¿La OT requiere algún sector compartido (Lustre/Herrería/Vidrio/Especiales)? */
function requiereCompartidos(ot) {
  return !!(ot.requiere_vidrio || ot.requiere_lustre
    || ot.requiere_herreria || ot.requiere_especiales);
}

/**
 * Lee ?linea= de la URL (viene del sidebar) y lo refleja en el select.
 * Ej.: /admin?linea=Placares#panel-ots → lista sólo la línea Placares.
 */
function aplicarLineaDesdeURL() {
  const v = new URLSearchParams(location.search).get('linea') || '';
  const sel = $('filtro-linea');
  if (sel) sel.value = LINEAS_FILTRO.includes(v) ? v : '';
}

/** Mantiene la URL en espejo del select (link compartible con la planta). */
function sincronizarLineaEnURL() {
  if (!history.replaceState) return;
  const v = $('filtro-linea').value;
  const u = new URL(location.href);
  if (v) u.searchParams.set('linea', v); else u.searchParams.delete('linea');
  history.replaceState(null, '', u);
}

function pintarTabla() {
  const q = FORMATO.normalizar($('filtro-ot').value.trim());
  const estado = $('filtro-estado').value;
  const linea = $('filtro-linea').value;
  const cuerpo = $('cuerpo-ots');
  cuerpo.innerHTML = '';

  const filas = S.ordenes.filter((ot) => {
    if (estado && ot.estado_general !== estado) return false;
    if (linea === 'compartidos' && !requiereCompartidos(ot)) return false;
    if (linea && linea !== 'compartidos' && (ot.linea_area || 'Placares') !== linea) return false;
    if (!q) return true;
    return FORMATO.normalizar(ot.numero_ot).includes(q)
      || FORMATO.normalizar(ot.cliente).includes(q)
      || FORMATO.normalizar(ot.modelo || '').includes(q);
  });

  $('resumen-ot').textContent = `${filas.length} de ${S.ordenes.length} OTs`;

  if (!filas.length) {
    cuerpo.append(h('tr', {}, h('td', { colspan: '10', class: 'vacio', text: 'No hay OTs que coincidan con el filtro.' })));
    return;
  }

  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);

  for (const ot of filas) {
    const vencida = ot.fecha_prometida
      && new Date(ot.fecha_prometida + 'T00:00:00') < hoy
      && ot.estado_general !== 'Finalizado';

    const select = h('select', { class: 'estado-select' });
    for (const e of (S.meta ? S.meta.estados_ot : ['En Cola', 'En Producción', 'Detenido', 'Finalizado'])) {
      select.append(h('option', { value: e, text: e, selected: e === ot.estado_general }));
    }
    select.addEventListener('change', async () => {
      try {
        await API.put(`/api/ordenes/${ot.id}`, { estado_general: select.value });
        Avisos.ok(`${ot.numero_ot} → ${select.value}`);
        await cargarOrdenes();
      } catch (err) {
        manejarError(err, 'Cambiar estado');
        select.value = ot.estado_general;
      }
    });

    cuerpo.append(h('tr', {},
      h('td', {}, h('b', { text: ot.numero_ot }),
        h('div', { style: 'margin-top:4px;' },
          h('span', { class: `chip ${CHIP_LINEA[ot.linea_area] || 'chip-gris'}`, text: ot.linea_area || 'Placares' })),
        ot.etapa_activa
          ? h('div', {}, h('span', { class: 'chip chip-verde', text: '▶ EN CURSO' })) : null),
      h('td', { text: ot.cliente }),
      h('td', { text: ot.modelo || '—' }),
      h('td', { class: 'num', text: FORMATO.metros(ot.metros_lineales) }),
      h('td', {},
        h('span', { class: vencida ? 'chip chip-rojo' : '', text: ot.fecha_prometida ? FORMATO.fecha(ot.fecha_prometida) : '—' })),
      h('td', {}, chipsRequisitos(ot)),
      h('td', {}, select),
      h('td', {},
        h('div', { class: 'texto-suave', text: `${ot.progreso.sectores_finalizados}/${ot.progreso.sectores_requeridos} sectores` }),
        h('div', { class: 'barra-progreso', style: 'width:110px;' },
          h('span', { style: `width:${ot.progreso.porcentaje}%` }))),
      h('td', { class: 'num', text: FORMATO.duracion(ot.minutos_acumulados) }),
      h('td', {},
        h('div', { class: 'fila-acciones' },
          h('button', { class: 'btn btn-chico', type: 'button', text: '👁 Ver', onclick: () => verDetalle(ot.id) }),
          h('button', { class: 'btn btn-chico btn-peligro', type: 'button', text: '🗑', title: 'Eliminar OT', onclick: () => eliminarOT(ot) })))
    ));
  }
  estamparEtiquetas('tabla-ots');
}

async function eliminarOT(ot) {
  const seguro = window.confirm(
    `¿Eliminar la ${ot.numero_ot} (${ot.cliente})?\n\n` +
    'Se borrarán también sus registros de tiempo. Esta acción no se puede deshacer.'
  );
  if (!seguro) return;
  try {
    const r = await API.del(`/api/ordenes/${ot.id}`);
    Avisos.aviso(`OT ${r.numero_ot} eliminada`, `${r.registros_eliminados} registros de tiempo borrados`);
    await cargarOrdenes();
  } catch (e) {
    manejarError(e, 'Eliminar OT');
  }
}

/* ------------------------------------------------------------------ */
/* Detalle de OT                                                       */
/* ------------------------------------------------------------------ */

/**
 * Tira del flujo de trabajo de la OT (Fase 2): sectores requeridos en
 * orden, con estado visual. Los sectores COMPARTIDOS requeridos se
 * resaltan como hito especial (borde dorado + insignia).
 */
function construirFlujoOT(ot) {
  const finalizados = new Set((ot.progreso && ot.progreso.finalizados_ids) || []);
  const requeridos = (ot.sectores_requeridos || []);
  const activoId = ot.etapa_activa ? ot.etapa_activa.sector_id : null;
  const bloqueados = ot.sectores_bloqueados || {};
  const ordenados = S.sectores
    .filter((s) => requeridos.includes(s.id))
    // Orden del flujo de la línea de la OT (el id ya no es la secuencia:
    // Placares y Cocinas conviven en la misma tabla).
    .sort((a, b) => {
      const linea = ot.linea_area || 'Placares';
      const propia = ((a.linea_area || '') === linea ? 0 : 1) - ((b.linea_area || '') === linea ? 0 : 1);
      return propia || (Number(a.orden_flujo) - Number(b.orden_flujo)) || (a.id - b.id);
    });

  const tira = h('div', { class: 'flujo-ot' });
  ordenados.forEach((s, i) => {
    if (i > 0) tira.append(h('span', { class: 'flujo-flecha', text: '→' }));
    const esCompartido = !!s.es_compartido || !!s.clave_especial;
    const clases = ['flujo-nodo'];
    if (esCompartido) clases.push('compartido');
    if (finalizados.has(s.id)) clases.push('ok');
    if (activoId === s.id) clases.push('activo');
    if (bloqueados[s.id]) clases.push('bloqueado');
    tira.append(h('span', {
      class: clases.join(' '),
      title: bloqueados[s.id] || s.nombre_sector,
    },
      h('span', { class: 'flujo-nombre', text: s.nombre_corto || s.nombre_sector }),
      esCompartido ? h('span', { class: 'flujo-insignia', text: 'COMPARTIDO' }) : null,
      finalizados.has(s.id) ? h('span', { class: 'flujo-estado', text: '✔' }) : null,
      bloqueados[s.id] ? h('span', { class: 'flujo-estado', text: '🔒' }) : null
    ));
  });
  return h('div', {},
    h('h3', { class: 'titulo-seccion', style: 'font-size:.9rem; margin-top:16px;', text: 'FLUJO DE TRABAJO' }),
    h('p', { class: 'texto-suave', style: 'margin:2px 0 8px;', text: 'Los sectores compartidos aparecen destacados en dorado: son hitos que consumen capacidad de otros sectores de la fábrica.' }),
    tira
  );
}

async function verDetalle(id) {
  Modal.abrir('modal-detalle');
  $('detalle-titulo').textContent = 'Cargando…';
  $('detalle-cuerpo').innerHTML = '';
  $('detalle-csv').setAttribute('href', `/api/export/registros.csv?ot_id=${id}`);

  try {
    const ot = await API.get(`/api/ordenes/${id}`);
    $('detalle-titulo').textContent = `${ot.numero_ot} · ${ot.cliente}`;

    const checks = h('div', { class: 'checks' },
      [['requiere_vidrio', '🪟 Vidrio'], ['requiere_lustre', '✨ Lustre'],
        ['requiere_herreria', '🔩 Herrería'], ['requiere_especiales', '🛠 Especiales']]
        .map(([k, texto]) => {
          const cb = h('input', { type: 'checkbox' });
          cb.checked = !!ot[k];
          cb.dataset.campo = k;
          const label = h('label', { class: `check ${cb.checked ? 'marcado' : ''}` }, cb, texto);
          cb.addEventListener('change', () => label.classList.toggle('marcado', cb.checked));
          return label;
        }));

    const selLineaDetalle = h('select', {
      id: 'detalle-linea',
      style: 'min-height:42px;padding:8px 12px;border:2px solid var(--borde);border-radius:10px;',
    },
      lineasOT().map((l) => h('option', { value: l, text: l, selected: l === (ot.linea_area || 'Placares') })));

    const bloqueChecks = h('div', {},
      h('h3', { class: 'titulo-seccion', style: 'font-size:.9rem;', text: 'FLUJO Y SECTORES ESPECIALES' }),
      h('div', { class: 'fila-flex', style: 'margin-bottom:10px; gap:8px;' },
        h('label', { class: 'campo', style: 'flex:0 0 auto;' },
          h('span', { text: 'Línea / área' }),
          selLineaDetalle),
        h('p', { class: 'texto-suave', style: 'flex:1 1 220px;font-size:.78rem;margin:0;',
          text: 'Define qué sectores debe recorrer la OT. Sólo se puede cambiar mientras no haya etapas finalizadas.' })),
      checks,
      h('div', { class: 'fila-flex', style: 'margin-top:10px;' },
        h('button', {
          class: 'btn btn-primario', type: 'button', text: '💾 Guardar requisitos',
          onclick: async () => {
            const payload = { linea_area: selLineaDetalle.value };
            bloqueChecks.querySelectorAll('input[type=checkbox]').forEach((cb) => {
              payload[cb.dataset.campo] = cb.checked;
            });
            try {
              await API.put(`/api/ordenes/${id}`, payload);
              Avisos.ok('Requisitos actualizados', 'Los sectores se habilitarán en el Terminal.');
              await cargarOrdenes();
              verDetalle(id);
            } catch (e) { manejarError(e, 'Guardar requisitos'); }
          },
        })));

    // --- Materiales / placas: requeridas vs consumidas (Fase 3) ---
    const mats = ot.materiales || [];
    const rm = ot.resumen_materiales || { lineas: 0, placas_requeridas: 0, placas_consumidas: 0, placas_restantes: 0, porcentaje_consumo: 0 };

    const filaMaterialDetalle = (m) => {
      const inpConsumo = h('input', {
        type: 'text', inputmode: 'decimal', style: 'width:64px; text-align:right;',
        value: String(m.cantidad_consumida).replace('.', ','), title: 'Placas consumidas',
      });
      const btnGuardar = h('button', {
        class: 'btn btn-chico', type: 'button', text: '💾', title: 'Guardar consumo',
        onclick: async () => {
          try {
            await API.put(`/api/ordenes/${id}/materiales/${m.id}`, { cantidad_consumida: inpConsumo.value });
            Avisos.ok(`Consumo de "${m.material_nombre}" actualizado.`);
            await cargarOrdenes();
            verDetalle(id);
          } catch (e) { manejarError(e, 'Actualizar consumo'); }
        },
      });
      const completo = m.cantidad_consumida >= m.cantidad_placas;
      return h('tr', {},
        h('td', { text: m.material_nombre }),
        h('td', { class: 'num', text: String(m.cantidad_placas) }),
        h('td', { class: 'num' }, inpConsumo, ' ', btnGuardar),
        h('td', { class: 'num', text: String(m.placas_restantes) }),
        h('td', {}, h('span', { class: `chip ${completo ? 'chip-verde' : 'chip-amarillo'}`, text: completo ? 'Completo' : 'En curso' })),
        h('td', { text: m.observaciones || '—' }));
    };

    const tablaMateriales = h('div', { class: 'tabla-envoltura' },
      h('table', { class: 'tabla' },
        h('thead', {}, h('tr', {},
          h('th', { text: 'Material' }), h('th', { class: 'num', text: 'Placas requeridas' }),
          h('th', { class: 'num', text: 'Consumidas' }), h('th', { class: 'num', text: 'Restantes' }),
          h('th', { text: 'Estado' }), h('th', { text: 'Observaciones' }))),
        h('tbody', {},
          mats.length
            ? mats.map(filaMaterialDetalle)
            : [h('tr', {}, h('td', { colspan: '6', class: 'vacio', text: 'Sin materiales cargados para esta OT.' }))])));

    const bloqueMateriales = h('div', {},
      h('h3', { class: 'titulo-seccion', style: 'font-size:.9rem; margin-top:16px;', text: 'MATERIALES / PLACAS' }),
      h('p', { class: 'texto-suave', style: 'margin:2px 0 8px;' },
        `Requeridas: ${rm.placas_requeridas} · Consumidas: ${rm.placas_consumidas} · Restantes: ${rm.placas_restantes} · Consumo: ${rm.porcentaje_consumo}%`),
      h('div', { class: 'barra-progreso', style: 'margin-bottom:8px;' }, h('span', { style: `width:${Math.min(100, rm.porcentaje_consumo)}%` })),
      tablaMateriales,
      h('p', { class: 'texto-suave', style: 'margin-top:6px; font-size:.8rem;', text: 'Actualice el consumo a medida que se corten las placas. El total se recalcula al guardar.' }));

    const registros = (ot.registros || []);
    const tabla = h('div', { class: 'tabla-envoltura' },
      h('table', { class: 'tabla' },
        h('thead', {}, h('tr', {},
          h('th', { text: 'Sector' }), h('th', { text: 'Operario' }),
          h('th', { text: 'Inicio' }), h('th', { text: 'Fin' }),
          h('th', { class: 'num', text: 'Duración' }), h('th', { class: 'num', text: 'Horas hombre' }),
          h('th', { text: 'Estado' }),
          h('th', { text: 'Motivo / Observación' }))),
        h('tbody', {},
          registros.length
            ? registros.map((g) => h('tr', {},
              h('td', { text: g.nombre_sector }),
              h('td', { text: g.operario_nombre }),
              h('td', { text: FORMATO.fechaHora(g.fecha_hora_inicio) }),
              h('td', { text: g.fecha_hora_fin ? FORMATO.fechaHora(g.fecha_hora_fin) : '—' }),
              h('td', { class: 'num', text: g.estado_etapa === 'Finalizado' ? FORMATO.duracion(g.duracion_minutos) : 'En curso…' }),
              h('td', { class: 'num', text: g.horas_hombre != null ? `${Number(g.horas_hombre).toLocaleString('es-AR', { maximumFractionDigits: 2 })} h.h.` : '—' }),
              h('td', {}, h('span', {
                class: `chip ${g.estado_etapa === 'Finalizado' ? 'chip-gris' : g.estado_etapa === 'Pausado' ? 'chip-amarillo' : 'chip-verde'}`,
                text: g.estado_etapa,
              })),
              h('td', { text: [g.motivo_pausa, g.observacion].filter(Boolean).join(' · ') || '—' })))
            : [h('tr', {}, h('td', { colspan: '8', class: 'vacio', text: 'Sin registros de tiempo.' }))])));

    // QR compacto junto al N° de OT y al cliente: al escanearlo desde un
    // móvil/tablet abre ESTA OT en la Terminal de Fichado.
    const qrLienzo = h('div', { class: 'ot-qr-lienzo' });
    if (window.QR) {
      QR.pintar(qrLienzo, QR.payloadOT(ot), {
        px: 104,
        quiet: 3,
        color: '#0f2f4f',
        label: `QR de la OT ${ot.numero_ot} de ${ot.cliente}`,
      });
    }
    const bloqueQR = h('div', { class: 'ot-qr-bloque' },
      h('div', { class: 'ot-qr-datos' },
        h('div', { class: 'ot-qr-ot', text: ot.numero_ot }),
        h('div', { class: 'ot-qr-cliente', text: ot.cliente }),
        h('div', { class: 'ot-qr-hint', text: 'Escaneá para abrir esta OT en la Terminal.' })),
      qrLienzo);

    $('detalle-cuerpo').innerHTML = '';
    $('detalle-cuerpo').append(
      bloqueQR,
      h('div', { class: 'resumen-modal' },
        h('div', {}, 'Estado: ', h('b', { text: ot.estado_general }),
          ' · Línea: ', h('b', { text: ot.linea_area || 'Placares' }),
          ' · Modelo: ', h('b', { text: ot.modelo || '—' }),
          ' · Metros: ', h('b', { text: FORMATO.metros(ot.metros_lineales) })),
        h('div', {}, 'Fecha prometida: ', h('b', { text: ot.fecha_prometida ? FORMATO.fecha(ot.fecha_prometida) : '—' })),
        h('div', {}, 'Progreso: ', h('b', { text: `${ot.progreso.sectores_finalizados} de ${ot.progreso.sectores_requeridos} sectores` }),
          ' · Tiempo acumulado: ', h('b', { text: FORMATO.duracion(ot.minutos_acumulados) })),
        h('div', { class: 'barra-progreso' }, h('span', { style: `width:${ot.progreso.porcentaje}%` }))
      ),
      bloqueChecks,
      bloqueMateriales,
      construirFlujoOT(ot),
      h('h3', { class: 'titulo-seccion', style: 'font-size:.9rem; margin-top:16px;', text: 'REGISTROS DE TIEMPOS' }),
      tabla
    );

    // Hoja de Ruta imprimible (Fase 7): guarda la OT y liga el botón.
    S.detalleActual = ot;
    $('detalle-hoja-ruta').onclick = () => imprimirHojaRuta(ot);
  } catch (e) {
    manejarError(e, 'Detalle OT');
    Modal.cerrar('modal-detalle');
  }
}

/* ------------------------------------------------------------------ */
/* Hoja de Ruta imprimible (Fase 7)                                     */
/* ------------------------------------------------------------------ */
/**
 * Genera una hoja A4 optimizada para imprimir y abre el diálogo de impresión.
 * Encabezado y borde AZULES si la OT es de Placares, ROJOS si es de Cocinas.
 * Incluye un QR grande que apunta a `/?ot=<numero>` para que el encargado
 * escanee con la tablet y la terminal quede lista para fichar.
 */
function imprimirHojaRuta(ot) {
  const linea = ot.linea_area || 'Placares';
  const esCocinas = linea === 'Cocinas';
  const claseLinea = esCocinas ? 'cocinas' : 'placares';

  // URL que el QR encodea: la terminal con la OT precargada (ver TAREA 5).
  const urlTerminal = `${window.location.origin}/?ot=${encodeURIComponent(ot.numero_ot)}`;
  // QR NATIVO: sin servicios externos ni librerías de terceros.
  // El SVG lo genera public/js/qr.js y sale nítido también en la impresión.
  const qrLienzo = h('div', { class: 'hoja-qr' });
  if (window.QR) {
    QR.pintar(qrLienzo, urlTerminal, {
      quiet: 2,
      color: '#0f2f4f',
      label: `QR de ${ot.numero_ot}`,
    });
  }

  // Materiales / placas.
  const mats = ot.materiales || [];
  const filasMateriales = mats.length
    ? mats.map((m) => h('tr', {},
      h('td', { text: m.material_nombre }),
      h('td', { class: 'num', text: String(m.cantidad_placas) }),
      h('td', { text: m.observaciones || '' })))
    : [h('tr', {}, h('td', { colspan: '3', class: 'vacio', text: 'Sin materiales cargados.' }))];

  // Sectores del flujo (para la grilla de firmas vacía).
  const requeridos = ot.sectores_requeridos || [];
  const sectoresFlujo = S.sectores
    .filter((s) => requeridos.includes(s.id))
    .sort((a, b) => {
      const propia = ((a.linea_area || '') === linea ? 0 : 1) - ((b.linea_area || '') === linea ? 0 : 1);
      return propia || (Number(a.orden_flujo) - Number(b.orden_flujo)) || (a.id - b.id);
    });
  const filasFirmas = sectoresFlujo.map((s) => h('tr', {},
    h('td', { text: s.nombre_sector }),
    h('td', {}), h('td', {}), h('td', {}), h('td', { class: 'celda-firma' })));

  const hoja = h('div', { class: `hoja-ruta ${claseLinea}` },
    h('div', { class: 'hoja-cabecera' },
      h('div', { class: 'hoja-marca' },
        h('div', { class: 'hoja-escudo', text: 'OF' }),
        h('div', {},
          h('h1', { text: 'HOJA DE RUTA' }),
          h('p', { text: 'Optiflow · De Otro Tiempo · Control de Trazabilidad' }))),
      h('div', { class: 'hoja-linea', text: linea.toUpperCase() })),

    h('div', { class: 'hoja-qr-bloque' },
      qrLienzo,
      h('div', { class: 'hoja-qr-texto' },
        h('b', { text: ot.numero_ot }),
        h('p', { text: 'Escaneé con la tablet para abrir esta OT en la Terminal de Fichado.' }),
        h('p', { class: 'hoja-url', text: urlTerminal }))),

    h('div', { class: 'hoja-datos' },
      h('div', { class: 'hoja-dato' }, h('span', { text: 'N° de OT' }), h('b', { text: ot.numero_ot })),
      h('div', { class: 'hoja-dato' }, h('span', { text: 'Cliente' }), h('b', { text: ot.cliente })),
      h('div', { class: 'hoja-dato' }, h('span', { text: 'Modelo' }), h('b', { text: ot.modelo || '—' })),
      h('div', { class: 'hoja-dato' }, h('span', { text: 'Metros' }), h('b', { text: FORMATO.metros(ot.metros_lineales) })),
      h('div', { class: 'hoja-dato' }, h('span', { text: 'Línea' }), h('b', { text: linea })),
      h('div', { class: 'hoja-dato' }, h('span', { text: 'Fecha prometida' }), h('b', { text: ot.fecha_prometida ? FORMATO.fecha(ot.fecha_prometida) : '—' }))),

    h('h2', { class: 'hoja-titulo', text: 'Materiales / Placas' }),
    h('table', { class: 'hoja-tabla' },
      h('thead', {}, h('tr', {},
        h('th', { text: 'Material' }), h('th', { class: 'num', text: 'Placas' }), h('th', { text: 'Observaciones' }))),
      h('tbody', {}, filasMateriales)),

    h('h2', { class: 'hoja-titulo', text: 'Recorrido y Firmas' }),
    h('p', { class: 'hoja-nota', text: 'El operario firma al iniciar y al finalizar cada etapa.' }),
    h('table', { class: 'hoja-tabla hoja-firmas' },
      h('thead', {}, h('tr', {},
        h('th', { text: 'Sector' }), h('th', { text: 'Operario' }),
        h('th', { text: 'Inicio' }), h('th', { text: 'Fin' }), h('th', { text: 'Firma' }))),
      h('tbody', {}, filasFirmas)),

    h('div', { class: 'hoja-pie' },
      h('span', { text: `Impreso: ${FORMATO.fechaHora(new Date().toISOString())}` }),
      h('span', { text: `Origen: ${window.location.origin}` }))
  );

  // Monta la hoja en un contenedor sólo-impresión y dispara la impresión.
  let capa = $('capa-impresion');
  if (!capa) {
    capa = h('div', { id: 'capa-impresion' });
    document.body.append(capa);
  }
  capa.innerHTML = '';
  capa.append(hoja);
  document.body.classList.add('imprimiendo');

  const limpiar = () => {
    document.body.classList.remove('imprimiendo');
    if (capa) capa.innerHTML = '';
    window.removeEventListener('afterprint', limpiar);
  };
  window.addEventListener('afterprint', limpiar);

  // afterprint no se dispara en todos los navegadores móviles: fallback.
  setTimeout(() => window.print(), 50);
}

/* ------------------------------------------------------------------ */
/* Etapas activas (planta en vivo)                                     */
/* ------------------------------------------------------------------ */

async function cargarActivas() {
  try {
    const r = await API.get('/api/estado');
    S.activas = r.etapas_abiertas;
    const lista = $('lista-activas');
    lista.innerHTML = '';
    $('chip-activas').textContent = String(S.activas.length);

    if (!S.activas.length) {
      lista.append(h('li', { class: 'vacio', text: 'No hay etapas en curso en la planta.' }));
      return;
    }
    for (const e of S.activas) {
      const pausado = e.estado_etapa === 'Pausado';
      lista.append(h('li', {},
        h('span', { class: `chip ${pausado ? 'chip-amarillo' : 'chip-verde'}`, text: pausado ? 'PAUSA' : 'EN CURSO' }),
        h('span', { class: 'et-sector', text: e.numero_ot }),
        h('span', { class: 'texto-suave', text: `${e.nombre_sector} · ${e.operario_nombre}` }),
        h('span', { class: 'et-ops' },
          h('b', { 'data-crono-etapa': e.id, text: '00:00:00' }))
      ));
    }
    actualizarCronometros();
  } catch (e) {
    console.error('Activas', e);
  }
}

function actualizarCronometros() {
  document.querySelectorAll('[data-crono-etapa]').forEach((el) => {
    const id = Number(el.getAttribute('data-crono-etapa'));
    const e = S.activas.find((x) => x.id === id);
    if (e) el.textContent = FORMATO.cronometro(minutosDeEtapa(e, RelojServidor.ahora()));
  });
}

/* ------------------------------------------------------------------ */
/* Gestión de Operarios (maestro, Fase 4)                              */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Sectores y Flujos (maestro de áreas de trabajo, Fase 5)             */
/* ------------------------------------------------------------------ */

async function cargarSectores() {
  try {
    const r = await API.get('/api/sectores?todos=1');
    S.sectores = r.sectores || [];
    $('chip-sectores').textContent = String(S.sectores.filter((s) => s.activo).length);
    poblarFiltroSectorSeguimiento();
    pintarTablaSectores();
  } catch (e) {
    manejarError(e, 'Cargar sectores');
  }
}

const CHIP_LINEA = {
  Placares: 'chip-azul', Cocinas: 'chip-amarillo', Compartido: 'chip-verde', General: 'chip-gris',
};

/** Líneas de área disponibles para un SECTOR (debe coincidir con db.LINEAS_AREA). */
function lineasSector() {
  return (S.meta && S.meta.lineas_area) || ['Placares', 'Cocinas', 'Compartido', 'General'];
}

/** Líneas que puede tener una OT (debe coincidir con db.LINEAS_OT). */
function lineasOT() {
  return (S.meta && S.meta.lineas_ot) || ['Placares', 'Cocinas'];
}

const ETIQUETA_LINEA = {
  Placares: '📦 Placares', Cocinas: '🍳 Cocinas',
  Compartido: '🤝 Compartido', General: '🌐 General',
};

/** Rellena los <select> de línea desde /api/meta (una sola fuente de verdad). */
function poblarSelectsLinea() {
  const llenar = (sel, lineas) => {
    if (!sel) return;
    const previo = sel.value;
    sel.innerHTML = '';
    for (const l of lineas) {
      sel.append(h('option', { value: l, text: ETIQUETA_LINEA[l] || l, selected: l === previo }));
    }
    if (previo && !lineas.includes(previo) && lineas.length) sel.value = lineas[0];
  };
  llenar($('ot-linea'), lineasOT());
  llenar($('sec-linea'), lineasSector());
}

function pintarTablaSectores() {
  const conInactivos = $('sec-filtro-inactivos').checked;
  const cuerpo = $('cuerpo-sectores');
  cuerpo.innerHTML = '';

  const filas = S.sectores.filter((s) => conInactivos || s.activo);

  if (!filas.length) {
    cuerpo.append(h('tr', {},
      h('td', { colspan: '7', class: 'vacio', text: 'No hay sectores en esta línea.' })));
    return;
  }

  for (const s of filas) {
    cuerpo.append(h('tr', { 'data-sec-id': String(s.id) },
      h('td', { class: 'num', text: String(s.id) }),
      h('td', {},
        h('b', { text: s.nombre_sector }),
        s.nombre_corto && s.nombre_corto !== s.nombre_sector
          ? h('div', { class: 'texto-suave', style: 'font-size:.75rem;', text: s.nombre_corto })
          : null,
        s.clave_especial
          ? h('span', { class: 'chip chip-gris', style: 'margin-left:6px;', text: `Especial (${s.clave_especial})` })
          : null),
      h('td', {},
        h('span', { class: `chip ${CHIP_LINEA[s.linea_area] || 'chip-gris'}`, text: s.linea_area }),
        s.es_compartido
          ? h('span', { class: 'chip chip-gris', style: 'margin-left:6px;', text: 'Compartido' })
          : null),
      h('td', { text: s.operarios_sugeridos || '—' }),
      h('td', { class: 'num', text: String(s.orden_flujo) }),
      h('td', {}, h('span', {
        class: `chip ${s.activo ? 'chip-verde' : 'chip-gris'}`,
        text: s.activo ? (s.etapas_abiertas > 0 ? `● ${s.etapas_abiertas} en curso` : 'Activo') : 'Inactivo',
      })),
      h('td', {},
        h('div', { class: 'fila-acciones' },
          h('button', {
            class: 'btn btn-chico', type: 'button', text: '✏️ Editar',
            title: 'Cambiar nombre, línea, orden o estado',
            onclick: () => editarSector(s),
          }),
          h('button', {
            class: s.activo ? 'btn btn-chico btn-peligro' : 'btn btn-chico',
            type: 'button',
            text: s.activo ? '⏸ Desactivar' : '▶ Activar',
            title: s.activo ? 'Lo oculta de la planta e impide fichar en él' : 'Vuelve a estar disponible en la Terminal',
            onclick: () => cambiarEstadoSector(s),
          })))
    ));
  }
  estamparEtiquetas('tabla-sectores');
}

async function agregarSector() {
  const input = $('sec-nombre');
  const nombre = input.value.trim();
  if (!nombre) { Avisos.aviso('Escriba el nombre del sector.'); return; }

  const payload = {
    nombre_sector: nombre,
    linea_area: $('sec-linea').value,
    es_compartido: $('sec-compartido').checked,
    operarios_sugeridos: $('sec-operarios').value.trim() || null,
  };

  try {
    const r = await API.post('/api/sectores', payload);
    Avisos.ok(`✔ Sector "${r.nombre_sector}" agregado`,
      `Línea ${r.linea_area} · posición ${r.orden_flujo} del flujo.`);
    input.value = '';
    $('sec-operarios').value = '';
    $('sec-compartido').checked = false;
    $('sec-compartido').closest('.check').classList.remove('marcado');
    await cargarSectores();
  } catch (e) {
    manejarError(e, 'Alta de sector');
  }
}

/** Edición en línea de la fila: reemplaza las celdas por inputs y botones. */
async function editarSector(s) {
  const cuerpo = $('cuerpo-sectores');
  const fila = [...cuerpo.rows].find((r) => r.getAttribute('data-sec-id') === String(s.id));
  if (!fila || fila.classList.contains('editando')) return;
  fila.classList.add('editando');

  const ancho = 'width:100%;min-width:150px;padding:6px 8px;border:1px solid var(--borde);border-radius:8px;';
  const inpNombre = h('input', { type: 'text', value: s.nombre_sector, maxlength: '80', style: ancho, autocomplete: 'off' });
  const selLinea = h('select', { style: 'padding:6px 8px;border:1px solid var(--borde);border-radius:8px;' },
    lineasSector().map((l) => h('option', { value: l, text: l, selected: l === s.linea_area })));
  const inpOps = h('input', {
    type: 'text', value: s.operarios_sugeridos || '', maxlength: '300',
    placeholder: 'Joel, Tiago', style: ancho, autocomplete: 'off',
  });
  const inpOrden = h('input', {
    type: 'number', min: '0', step: '1', value: String(s.orden_flujo),
    style: 'width:76px;padding:6px 8px;border:1px solid var(--borde);border-radius:8px;text-align:center;',
  });
  const cbComp = h('input', { type: 'checkbox' });
  const cbActivo = h('input', { type: 'checkbox' });
  cbComp.checked = !!s.es_compartido;
  cbActivo.checked = !!s.activo;

  const celda = (i) => { fila.cells[i].innerHTML = ''; return fila.cells[i]; };
  celda(1).append(inpNombre);
  celda(2).append(selLinea, h('label', { class: 'check', style: 'margin-left:6px;min-height:auto;padding:4px 8px;' },
    cbComp, ' Compartido'));
  celda(3).append(inpOps);
  celda(4).append(inpOrden);
  celda(5).append(cbActivo, h('span', { class: 'texto-suave', style: 'margin-left:6px;font-size:.8rem;', text: 'Activo' }));

  const btnGuardar = h('button', {
    class: 'btn btn-primario btn-chico', type: 'button', text: '💾 Guardar',
    onclick: async () => {
      const orden = inpOrden.value.trim();
      if (Number(orden) < 0 || (orden !== '' && !Number.isInteger(Number(orden)))) {
        Avisos.aviso('El orden de flujo debe ser un entero mayor o igual a 0.'); return;
      }
      try {
        await API.put(`/api/sectores/${s.id}`, {
          nombre_sector: inpNombre.value.trim(),
          linea_area: selLinea.value,
          es_compartido: cbComp.checked,
          orden_flujo: orden,
          operarios_sugeridos: inpOps.value.trim(),
          activo: cbActivo.checked,
        });
        Avisos.ok('✔ Sector actualizado', `${inpNombre.value.trim()} · ${selLinea.value}`);
        await cargarSectores();
        await cargarOrdenes(); // el progreso del flujo depende del orden
      } catch (e) {
        manejarError(e, 'Actualizar sector');
      }
    },
  });
  const btnCancelar = h('button', {
    class: 'btn btn-chico', type: 'button', text: '✕ Cancelar',
    onclick: () => pintarTablaSectores(),
  });

  celda(6).append(h('div', { class: 'fila-acciones' }, btnGuardar, btnCancelar));
  inpNombre.focus();
  inpNombre.select();
}

async function cambiarEstadoSector(s) {
  const accion = s.activo ? 'desactivar' : 'activar';
  const seguro = window.confirm(
    `¿${s.activo ? 'Desactivar' : 'activar'} el sector "${s.nombre_sector}"?\n\n` +
    (s.activo
      ? 'Desaparece de la Terminal e impide iniciar etapas nuevas. Las etapas abiertas se pueden cerrar y el historial se conserva.'
      : 'Vuelve a estar disponible en la Terminal para la línea ' + s.linea_area + '.')
  );
  if (!seguro) return;

  try {
    await API.put(`/api/sectores/${s.id}`, { activo: !s.activo });
    Avisos.ok(`✔ Sector ${accion}do`, s.nombre_sector);
    await cargarSectores();
    await cargarOrdenes();
  } catch (e) {
    manejarError(e, 'Cambiar estado de sector');
  }
}

async function cargarOperarios() {
  try {
    const r = await API.get('/api/operarios?todos=1');
    S.operarios = r.operarios || [];
    $('chip-operarios').textContent = String(S.operarios.filter((o) => o.activo).length);
    pintarTablaOperarios();
  } catch (e) {
    manejarError(e, 'Cargar operarios');
  }
}

function pintarTablaOperarios() {
  const conInactivos = $('op-filtro-inactivos').checked;
  const cuerpo = $('cuerpo-operarios');
  cuerpo.innerHTML = '';

  const filas = S.operarios.filter((o) => conInactivos || o.activo);

  if (!filas.length) {
    cuerpo.append(h('tr', {}, h('td', { colspan: '6', class: 'vacio', text: 'No hay operarios registrados.' })));
    return;
  }

  for (const op of filas) {
    const etapaAbierta = op.etapas_abiertas > 0;

    const btnEditar = h('button', {
      class: 'btn btn-chico', type: 'button', text: '✏️ Editar', title: 'Renombrar operario',
      onclick: () => editarOperario(op),
    });

    const btnEstado = h('button', {
      class: op.activo ? 'btn btn-chico btn-peligro' : 'btn btn-chico',
      type: 'button',
      text: op.activo ? '⏸ Desactivar' : '▶ Activar',
      title: op.activo ? 'Impide que inicie nuevas etapas' : 'Permite que inicie etapas',
      onclick: () => cambiarEstadoOperario(op),
    });

    cuerpo.append(h('tr', {},
      h('td', { class: 'num', text: String(op.id) }),
      h('td', {}, h('b', { text: op.nombre })),
      h('td', { class: 'num', text: String(op.etapas) }),
      h('td', { text: op.ultima_actividad ? FORMATO.fechaHora(op.ultima_actividad) : '—' }),
      h('td', {}, h('span', {
        class: `chip ${op.activo ? (etapaAbierta ? 'chip-verde' : 'chip-azul') : 'chip-gris'}`,
        text: op.activo ? (etapaAbierta ? '● En etapa' : 'Activo') : 'Inactivo',
      })),
      h('td', {},
        h('div', { class: 'fila-acciones' }, btnEditar, btnEstado))
    ));
  }
  estamparEtiquetas('tabla-operarios');
}

async function agregarOperario() {
  const input = $('op-nombre');
  const nombre = input.value.trim();
  if (!nombre) { Avisos.aviso('Escriba el nombre del operario.'); return; }

  try {
    await API.post('/api/operarios', { nombre });
    Avisos.ok(`✔ Operario "${nombre}" registrado`);
    input.value = '';
    await cargarOperarios();
  } catch (e) {
    manejarError(e, 'Alta de operario');
  }
}

async function editarOperario(op) {
  const nombre = window.prompt(`Nuevo nombre para "${op.nombre}":`, op.nombre);
  if (nombre === null) return; // cancelado
  const limpio = nombre.trim();
  if (!limpio || limpio === op.nombre) return;

  try {
    const r = await API.put(`/api/operarios/${op.id}`, { nombre: limpio });
    const msg = r.registros_actualizados > 0
      ? `${r.registros_actualizados} registro(s) de tiempo actualizados con el nuevo nombre.`
      : 'Nombre actualizado.';
    Avisos.ok(`✔ Operario renombrado a "${limpio}"`, msg);
    await cargarOperarios();
    await cargarOrdenes(); // por si había etapas activas con el nombre viejo
  } catch (e) {
    manejarError(e, 'Renombrar operario');
  }
}

async function cambiarEstadoOperario(op) {
  const accion = op.activo ? 'desactivar' : 'activar';
  if (op.activo && op.etapas_abiertas > 0) {
    Avisos.aviso(`No se puede desactivar: ${op.nombre} tiene ${op.etapas_abiertas} etapa(s) abierta(s). Finalícelas primero.`);
    return;
  }
  const seguro = window.confirm(
    `¿${op.activo ? 'Desactivar' : 'Activar'} al operario "${op.nombre}"?\n\n` +
    (op.activo
      ? 'No podrá iniciar nuevas etapas desde la Terminal. Su historial se conserva.'
      : 'Podrá iniciar etapas nuevamente.')
  );
  if (!seguro) return;

  try {
    await API.put(`/api/operarios/${op.id}`, { activo: !op.activo });
    Avisos.ok(`✔ Operario ${accion}do`, op.nombre);
    await cargarOperarios();
  } catch (e) {
    manejarError(e, 'Cambiar estado de operario');
  }
}

/* ------------------------------------------------------------------ */
/* Usuarios del sistema (credenciales, auditoría V-1) — sólo admin     */
/* ------------------------------------------------------------------ */

const ETIQUETAS_ROL = { admin: '🛡 Administrador', encargado: '📋 Encargado', operario: '👷 Operario' };

async function cargarUsuarios() {
  try {
    const r = await API.get('/api/usuarios');
    S.usuarios = r.usuarios;
    pintarTablaUsuarios();
  } catch (e) {
    manejarError(e, 'Carga de usuarios');
  }
}

function pintarTablaUsuarios() {
  const cuerpo = $('cuerpo-usuarios');
  $('chip-usuarios').textContent = String(S.usuarios.length);
  cuerpo.innerHTML = '';

  if (!S.usuarios.length) {
    cuerpo.append(h('tr', {}, h('td', { class: 'vacio', colspan: '8', text: 'Sin usuarios cargados.' })));
    return;
  }

  for (const u of S.usuarios) {
    const esYo = S.usuario && u.id === S.usuario.id;
    const acciones = h('td', { class: 'acciones-tabla' },
      h('button', {
        class: 'btn btn-chico', type: 'button',
        onclick: () => cambiarClaveUsuario(u),
      }, '🔑 Cambiar clave'),
      h('button', {
        class: 'btn btn-chico', type: 'button',
        onclick: () => cambiarWhatsAppUsuario(u),
      }, '📱 WhatsApp'),
      h('button', {
        class: 'btn btn-chico', type: 'button',
        onclick: () => cambiarEstadoUsuario(u),
      }, u.activo ? '⏸ Desactivar' : '▶ Activar'),
      esYo ? h('span', { class: 'texto-suave', text: '(usted)' }) : null
    );

    cuerpo.append(h('tr', {},
      h('td', { text: String(u.id) }),
      h('td', {}, h('b', { text: u.usuario })),
      h('td', { text: u.nombre }),
      h('td', { text: ETIQUETAS_ROL[u.rol] || u.rol }),
      h('td', {}, u.telefono_whatsapp
        ? h('a', {
            href: `https://wa.me/${u.telefono_whatsapp}`, target: '_blank', rel: 'noopener',
            text: `📱 ${u.telefono_whatsapp}`, 'aria-label': `WhatsApp de ${u.nombre}`,
          })
        : h('span', { class: 'texto-suave', text: '—' })),
      h('td', { text: u.ultimo_acceso ? FORMATO.fechaHora(u.ultimo_acceso) : '—' }),
      h('td', {}, h('span', { class: `chip ${u.activo ? 'chip-verde' : 'chip-rojo'}`, text: u.activo ? 'Activo' : 'Inactivo' })),
      acciones
    ));
  }
  estamparEtiquetas('tabla-usuarios');
}

async function agregarUsuario() {
  const usuario = $('usu-login').value.trim().toLowerCase();
  const nombre = $('usu-nombre').value.trim();
  const password = $('usu-password').value;
  const telefono_whatsapp = $('usu-whatsapp').value.trim();
  const rol = $('usu-rol').value;

  if (!usuario || !nombre || !password) {
    Avisos.aviso('Complete usuario, nombre visible y contraseña para crear el acceso.');
    return;
  }
  if (password.length < 6) {
    Avisos.aviso('La contraseña debe tener al menos 6 caracteres.');
    return;
  }
  if (telefono_whatsapp && !/^\+?[\d\s().-]{8,24}$/.test(telefono_whatsapp)) {
    Avisos.aviso('El WhatsApp debe ser un número internacional, ej.: 5491123456789.');
    return;
  }

  try {
    await API.post('/api/usuarios', { usuario, nombre, password, rol, telefono_whatsapp });
    Avisos.ok(`✔ Usuario "${usuario}" creado`, `Ya puede usar la Terminal de fichado.`);
    $('usu-login').value = '';
    $('usu-nombre').value = '';
    $('usu-password').value = '';
    $('usu-whatsapp').value = '';
    await cargarUsuarios();
  } catch (e) {
    manejarError(e, 'Crear usuario');
  }
}

/**
 * Editar el WhatsApp de un encargado (maestro de teléfonos).
 * Usa el mismo `prompt` que "Cambiar clave": es la única edición puntual que
 * queda y así funciona igual de bien en escritorio y en las tarjetas móviles
 * de esta tabla, sin meter un modal más que mantener.
 */
async function cambiarWhatsAppUsuario(u) {
  const actual = u.telefono_whatsapp || '';
  const entrada = window.prompt(
    `WhatsApp de "${u.usuario}" — ${u.nombre}\n\n` +
    'Formato internacional SIN signo ni espacios.\n' +
    'Ej.: 5491123456789\n' +
    'Deje vacío para quitar el número.',
    actual
  );
  if (entrada === null) return; // cancelado

  const limpio = entrada.trim();
  if (limpio && !/^\+?[\d\s().-]{8,24}$/.test(limpio)) {
    Avisos.aviso('El número debe ser internacional (8 a 15 dígitos), ej.: 5491123456789.');
    return;
  }

  try {
    await API.put(`/api/usuarios/${u.id}`, { telefono_whatsapp: limpio });
    Avisos.ok('✔ WhatsApp actualizado', limpio ? `+${limpio.replace(/^\+/, '')}` : 'número eliminado');
    await cargarUsuarios();
  } catch (e) {
    manejarError(e, 'Actualizar WhatsApp');
  }
}

async function cambiarClaveUsuario(u) {
  const password = window.prompt(`Nueva contraseña para "${u.usuario}" (mínimo 6 caracteres):`);
  if (password === null) return; // cancelado
  if (password.trim().length < 6) {
    Avisos.aviso('La contraseña debe tener al menos 6 caracteres.');
    return;
  }
  try {
    await API.put(`/api/usuarios/${u.id}`, { password });
    Avisos.ok('✔ Contraseña actualizada', u.usuario);
  } catch (e) {
    manejarError(e, 'Cambiar contraseña');
  }
}

async function cambiarEstadoUsuario(u) {
  const accion = u.activo ? 'desactivar' : 'activar';
  const seguro = window.confirm(
    `¿${u.activo ? 'Desactivar' : 'Activar'} el usuario "${u.usuario}"?\n\n` +
    (u.activo
      ? 'Dejará de poder ingresar a la Terminal y al panel.'
      : 'Volverá a poder ingresar con su contraseña.')
  );
  if (!seguro) return;

  try {
    await API.put(`/api/usuarios/${u.id}`, { activo: !u.activo });
    Avisos.ok(`✔ Usuario ${accion}do`, u.usuario);
    await cargarUsuarios();
  } catch (e) {
    manejarError(e, 'Cambiar estado de usuario');
  }
}

/* ------------------------------------------------------------------ */
/* Panel dedicado: Mantenimiento Preventivo (TPM)                      */
/* ------------------------------------------------------------------ */

/** Etiquetas visibles del estado de uso (mismos umbrales que el backend). */
const ETIQUETA_TPM = { ok: 'OK', advertencia: 'PRÓXIMO', critico: 'VENCIDO' };

/** Horas netas con formato estable de la UI: "123,5 hs". */
function hsTPM(v) {
  return `${Number(v || 0).toLocaleString('es-AR', { maximumFractionDigits: 1 })} hs`;
}

function chipEstadoTPM(estado) {
  if (estado === 'critico') return 'chip chip-rojo';
  if (estado === 'advertencia') return 'chip chip-amarillo';
  return 'chip chip-verde';
}

async function cargarTPM() {
  try {
    S.tpm = await API.get('/api/tpm');
    pintarTPM();
    pintarHistorialTPM();
  } catch (e) {
    manejarError(e, 'Cargar mantenimiento TPM');
  }
}

function pintarTPM() {
  const grid = $('tpm-grid');
  if (!S.tpm || !grid) return;

  const maqs = S.tpm.maquinas || [];
  const r = S.tpm.resumen || {};

  const chip = $('chip-tpm');
  chip.textContent = String(maqs.length);
  chip.className = maqs.some((m) => m.activo && m.estado === 'critico')
    ? 'chip chip-rojo'
    : (maqs.some((m) => m.activo && m.estado === 'advertencia') ? 'chip chip-amarillo' : 'chip chip-gris');

  $('tpm-resumen').textContent = maqs.length
    ? `${r.ok || 0} OK · ${r.advertencia || 0} PRÓXIMO · ${r.critico || 0} VENCIDO · ${r.inactivas || 0} inactiva(s)`
    : 'Sin máquinas cargadas';

  grid.innerHTML = '';
  if (!maqs.length) {
    grid.append(h('div', {
      class: 'vacio',
      text: 'Todavía no hay máquinas TPM. Presione "➕ Nueva máquina TPM" para dar de alta la primera.',
    }));
    return;
  }
  for (const m of maqs) grid.append(cartaTPM(m));
}

function cartaTPM(m) {
  const pct = Math.max(0, Math.min(100, Number(m.pct_uso || 0)));
  const exceso = Number(m.horas_desde_ultimo_mantenimiento || 0) - Number(m.intervalo_horas_target || 0);
  const colorBarra = m.estado === 'critico'
    ? 'var(--estado-alerta, #DC3545)'
    : (m.estado === 'advertencia' ? 'var(--estado-pausa, #FFC107)' : 'var(--estado-proceso, #28A745)');

  return h('article', { class: `tpm-carta tpm-${m.estado}${m.activo ? '' : ' tpm-inactiva'}` },
    h('header', { class: 'tpm-cab' },
      h('div', { class: 'tpm-titulos' },
        h('h3', { class: 'tpm-nombre', text: m.nombre_maquina }),
        h('span', { class: 'tpm-sector', text: `${m.linea_area || ''} · ${m.nombre_sector || ''}` })
      ),
      h('span', { class: chipEstadoTPM(m.estado), text: m.activo ? ETIQUETA_TPM[m.estado] : 'INACTIVA' })
    ),

    h('p', { class: 'tpm-tarea' },
      h('span', { class: 'tpm-tarea-ico', 'aria-hidden': 'true', text: '🛠️' }),
      h('span', { text: m.tarea_mantenimiento })
    ),

    h('div', { class: 'tpm-barra-envoltura' },
      h('div', {
        class: 'tpm-barra', role: 'progressbar',
        'aria-valuemin': '0',
        'aria-valuemax': String(m.intervalo_horas_target),
        'aria-valuenow': String(m.horas_desde_ultimo_mantenimiento),
        'aria-label': `Uso de horas netas de ${m.nombre_maquina}`,
      }, h('span', { style: `width:${pct}%; background:${colorBarra};` }))
    ),

    h('div', { class: 'tpm-numeros' },
      h('span', { class: 'tpm-horas' },
        h('b', { text: hsTPM(m.horas_desde_ultimo_mantenimiento) }),
        h('span', { class: 'tpm-horas-de', text: ` / ${hsTPM(m.intervalo_horas_target)}` })
      ),
      h('span', {
        class: 'tpm-pct',
        text: `${Number(m.pct_uso || 0).toLocaleString('es-AR', { maximumFractionDigits: 0 })} %`,
      })
    ),

    h('div', { class: 'tpm-datos' },
      h('span', { text: `Acumulado histórico: ${hsTPM(m.horas_acumuladas_sector)}` }),
      exceso > 0
        ? h('span', { class: 'tpm-vencidas', text: `Vencida hace ${hsTPM(exceso)}` })
        : h('span', { text: `Faltan ${hsTPM(-exceso)} para el vencimiento` })
    ),

    h('footer', { class: 'tpm-acciones' },
      h('button', {
        class: 'btn btn-primario tpm-btn', type: 'button',
        'aria-label': `Registrar service de ${m.nombre_maquina}`,
        onclick: () => abrirServiceTPM(m),
      }, '🛠️ Registrar Service'),
      h('button', {
        class: 'btn tpm-btn', type: 'button',
        'aria-label': `Configurar ${m.nombre_maquina}`,
        onclick: () => abrirConfigTPM(m),
      }, '⚙️ Configurar')
    )
  );
}

function pintarHistorialTPM() {
  const cuerpo = $('cuerpo-tpm-historial');
  if (!cuerpo) return;

  const filas = (S.tpm && S.tpm.historial) || [];
  cuerpo.innerHTML = '';

  if (!filas.length) {
    cuerpo.append(h('tr', {},
      h('td', { colspan: '6', class: 'vacio', text: 'Sin services registrados todavía.' })));
    estamparEtiquetas('tabla-tpm-historial');
    return;
  }

  for (const x of filas) {
    cuerpo.append(h('tr', {},
      h('td', { text: FORMATO.fechaHora(x.fecha_hora) }),
      h('td', { text: x.nombre_maquina || `#${x.maquina_tpm_id}` }),
      h('td', { text: x.nombre_sector || '—' }),
      h('td', { text: x.tecnico_operario }),
      h('td', { class: 'num', text: hsTPM(x.horas_acumuladas_al_service) }),
      h('td', { text: x.observaciones || '—' })
    ));
  }
  estamparEtiquetas('tabla-tpm-historial');
}

/* ---------------- Modal: registrar service ------------------------- */

function abrirServiceTPM(m) {
  $('tpm-service-id').value = String(m.id);
  $('tpm-service-titulo').textContent = `🛠️ Registrar service · ${m.nombre_maquina}`;
  $('tpm-service-resumen').textContent =
    `${m.nombre_sector || ''} — ${m.tarea_mantenimiento}\n` +
    `Lleva ${hsTPM(m.horas_desde_ultimo_mantenimiento)} de ${hsTPM(m.intervalo_horas_target)} ` +
    `(${ETIQUETA_TPM[m.estado]}). Al confirmar el contador vuelve a 0.`;
  $('tpm-service-tecnico').value = '';
  $('tpm-service-obs').value = '';
  Modal.abrir('modal-tpm-service');
  setTimeout(() => $('tpm-service-tecnico').focus(), 60);
}

async function guardarServiceTPM(ev) {
  ev.preventDefault();
  const id = Number($('tpm-service-id').value);
  const tecnico = $('tpm-service-tecnico').value.trim();
  const observaciones = $('tpm-service-obs').value.trim();

  if (!tecnico) {
    Avisos.error('Indique el técnico / operario responsable del service.');
    $('tpm-service-tecnico').focus();
    return;
  }

  const btn = $('tpm-service-guardar');
  btn.disabled = true;
  try {
    const r = await API.post('/api/tpm/mantenimiento', {
      maquina_tpm_id: id,
      tecnico_operario: tecnico,
      observaciones: observaciones || undefined,
    });
    Avisos.ok('Service registrado. Contador de horas reiniciado.',
      `Horas acumuladas al service: ${hsTPM(r.horas_acumuladas_al_service)}`);
    Modal.cerrar('modal-tpm-service');
    await cargarTPM();
  } catch (e) {
    manejarError(e, 'Registrar service TPM');
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- Modal: configurar máquina ------------------------ */

function abrirConfigTPM(m) {
  const sel = $('tpm-config-sector');
  if (!sel.options.length) {
    const sectores = S.sectores.filter((s) => s.activo !== false);
    for (const s of sectores) {
      sel.append(h('option', {
        value: String(s.id),
        text: `${s.linea_area || ''} · ${s.nombre_sector}`,
      }));
    }
  }

  $('tpm-config-id').value = m ? String(m.id) : '';
  $('tpm-config-titulo').textContent = m ? `⚙️ ${m.nombre_maquina}` : '⚙️ Nueva máquina TPM';
  if (m) sel.value = String(m.sector_id);
  $('tpm-config-nombre').value = m ? m.nombre_maquina : '';
  $('tpm-config-tarea').value = m ? m.tarea_mantenimiento : '';
  $('tpm-config-intervalo').value = m ? String(m.intervalo_horas_target) : '100';
  $('tpm-config-base').value = m ? String(m.horas_ultimo_mantenimiento) : '';

  const activo = $('tpm-config-activo');
  activo.checked = m ? !!m.activo : true;
  activo.closest('.check').classList.toggle('marcado', activo.checked);

  Modal.abrir('modal-tpm-config');
}

async function guardarConfigTPM(ev) {
  ev.preventDefault();
  const id = $('tpm-config-id').value;
  const cuerpo = {
    sector_id: Number($('tpm-config-sector').value),
    nombre_maquina: $('tpm-config-nombre').value.trim(),
    tarea_mantenimiento: $('tpm-config-tarea').value.trim(),
    intervalo_horas_target: Number($('tpm-config-intervalo').value),
    activo: $('tpm-config-activo').checked,
  };

  // El baseline sólo se envía si el usuario lo completó: vacío = 0 en alta
  // y "conservar el vigente" en edición (regla T del backend).
  const base = $('tpm-config-base').value.trim();
  if (base !== '') cuerpo.horas_ultimo_mantenimiento = Number(base);

  if (!cuerpo.nombre_maquina) { Avisos.error('Indique el nombre de la máquina.'); return; }
  if (!cuerpo.tarea_mantenimiento) { Avisos.error('Indique la tarea preventiva requerida.'); return; }
  if (!(cuerpo.intervalo_horas_target > 0)) { Avisos.error('El intervalo debe ser mayor a 0 horas.'); return; }
  if (id) cuerpo.id = Number(id);

  const btn = $('tpm-config-guardar');
  btn.disabled = true;
  try {
    await API.post('/api/tpm/configurar', cuerpo);
    Avisos.ok(id ? 'Máquina TPM actualizada.' : 'Máquina TPM dada de alta.', cuerpo.nombre_maquina);
    Modal.cerrar('modal-tpm-config');
    await cargarTPM();
  } catch (e) {
    manejarError(e, 'Configurar máquina TPM');
  } finally {
    btn.disabled = false;
  }
}

/* ============================================================
   BUSCADOR GLOBAL / COMMAND PALETTE  (Ctrl o ⌘ + K)
   ------------------------------------------------------------
   Busca entre las OTs YA cargadas en memoria (S.ordenes), sin
   tocar la red: la planta tiene wifi intermitente y el resultado
   debe ser instantáneo. Al elegir una OT abre su detalle
   (verDetalle) y baja el scroll hasta el panel de OTs.
   ============================================================ */

const CommandPalette = {
  indice: 0,          // fila resaltada dentro de `resultados`
  resultados: [],
  _ligado: false,

  /** Atajo global + eventos del input. Idempotente (se llama desde ligarEventos). */
  ligar() {
    if (this._ligado) return;
    const input = $('cp-input');
    if (!input) return;          // no es el panel de admin
    this._ligado = true;

    // Ctrl/⌘ + K. `preventDefault` evita que el navegador abra su propia
    // barra de búsqueda (Firefox: Ctrl+K) o la paleta del sistema.
    document.addEventListener('keydown', (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'k' || ev.key === 'K')) {
        ev.preventDefault();
        this.abierto() ? this.cerrar() : this.abrir();
        return;
      }
      if (ev.key === 'Escape' && this.abierto()) {
        // Se maneja acá y no sólo en el handler global de api.js para poder
        // limpiar el estado (input + resultados) además de ocultar el modal.
        ev.preventDefault();
        this.cerrar();
      }
    });

    input.addEventListener('input', () => this.buscar(input.value));

    // Flechas + Enter dentro del input.
    input.addEventListener('keydown', (ev) => {
      if (!this.abierto()) return;
      if (ev.key === 'ArrowDown') { ev.preventDefault(); this.mover(1); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); this.mover(-1); }
      else if (ev.key === 'Enter') { ev.preventDefault(); this.elegir(this.indice); }
    });

    // Clic en el fondo (afuera de la caja) = cerrar.
    $('command-palette').addEventListener('click', (ev) => {
      if (ev.target === $('command-palette')) this.cerrar();
    });
  },

  abierto() {
    const m = $('command-palette');
    return !!m && m.classList.contains('abierto');
  },

  abrir() {
    const m = $('command-palette');
    if (!m) return;
    m.classList.add('abierto');
    const input = $('cp-input');
    input.value = '';
    this.indice = 0;
    this.buscar('');
    // Enfoca en el siguiente ciclo para que el modal ya esté pintado.
    requestAnimationFrame(() => input.focus());
  },

  cerrar() {
    const m = $('command-palette');
    if (!m) return;
    m.classList.remove('abierto');
    const input = $('cp-input');
    if (input) { input.value = ''; input.blur(); }
    this.resultados = [];
    this.pintar();
  },

  /**
   * Filtra en memoria por número de OT, cliente o modelo (sin acentos ni
   * mayúsculas). Con consulta vacía muestra las primeras OTs de la lista,
   * que es lo que el usuario quiere ver al pulsar Ctrl+K "a ciegas".
   */
  buscar(texto) {
    const q = FORMATO.normalizar(String(texto || '').trim());
    const base = Array.isArray(S.ordenes) ? S.ordenes : [];

    if (!q) {
      this.resultados = base.slice(0, 8);
    } else {
      this.resultados = base.filter((ot) => (
        FORMATO.normalizar(ot.numero_ot).includes(q)
        || FORMATO.normalizar(ot.cliente).includes(q)
        || FORMATO.normalizar(ot.modelo || '').includes(q)
      )).slice(0, 12);
    }
    this.indice = 0;
    this.pintar();
  },

  mover(paso) {
    if (!this.resultados.length) return;
    this.indice = (this.indice + paso + this.resultados.length) % this.resultados.length;
    this.pintar();
    const fila = $('cp-lista').querySelector(`[data-i="${this.indice}"]`);
    if (fila) fila.scrollIntoView({ block: 'nearest' });
  },

  /** Abre el detalle de la OT elegida y la lleva al foco del panel. */
  elegir(i) {
    const ot = this.resultados[i];
    if (!ot) return;
    this.cerrar();
    verDetalle(ot.id);
    // "Redirige la vista": el panel es de scroll único, así que basta con
    // asegurar que la tabla de OTs quede visible (el detalle se abre encima).
    const panel = $('panel-ots');
    if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },

  pintar() {
    const lista = $('cp-lista');
    const input = $('cp-input');
    if (!lista) return;
    lista.innerHTML = '';
    if (input) input.setAttribute('aria-expanded', this.resultados.length ? 'true' : 'false');

    if (!this.resultados.length) {
      lista.append(h('li', { class: 'cp-vacio', text: 'Sin coincidencias.' }));
      return;
    }

    this.resultados.forEach((ot, i) => {
      const fila = h('li', {
        class: 'cp-item',
        role: 'option',
        'data-i': i,
        'aria-selected': i === this.indice ? 'true' : 'false',
      },
      h('span', { class: 'cp-num', text: ot.numero_ot }),
      h('span', { class: 'cp-desc' },
        h('span', { class: 'cp-cliente', text: ot.cliente }),
        h('span', { class: 'cp-meta', text: [ot.modelo, ot.linea_area || 'Placares'].filter(Boolean).join(' · ') }))
      );
      // mouseenter cambia la selección; click la confirma.
      fila.addEventListener('mouseenter', () => { this.indice = i; this.pintar(); });
      fila.addEventListener('click', () => this.elegir(i));
      lista.append(fila);
    });
  },
};
