'use strict';

/* ============================================================
   OPTIFLOW - Terminal de Fichado Rápido (Pantalla 1)
   Operarios / Encargados de sector - tablets de planta
   ============================================================ */

const S = {
  meta: null,
  sectores: [],
  ordenes: [],
  ot: null,
  sectorId: null,
  operario: '',
  operarios: [],         // nómina del maestro (activos)
  estado: null,          // respuesta de /api/estado
  registros: [],         // últimos registros de la OT seleccionada
  refrescos: 0,
  escaneo: false,        // true cuando la OT llegó por QR (?ot=…) y el busq. está bloqueado
};

/** Etiquetas visibles de las líneas de área. */
const ETIQUETAS_LINEA = {
  Placares: '📦 Placares',
  Cocinas: '🍳 Cocinas',
  Compartido: '🤝 Talleres compartidos',
  General: '🌐 General',
};

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ */
/* Arranque                                                            */
/* ------------------------------------------------------------------ */

let arranqueListo = false;

document.addEventListener('DOMContentLoaded', async () => {
  await iniciarBarraSuperior();
  ligarEventos();

  // Auditoría V-1: la terminal exige sesión para FICHAR (el modal es
  // bloqueante: sin usuario y contraseña no se puede operar la planta).
  API.onSinSesion = () => abrirLogin(null);
  let sesion = null;
  try { sesion = await API.sesion(); } catch { sesion = null; }

  if (!sesion || !sesion.usuario) {
    abrirLogin(async () => { await arrancar(); });
    return;
  }
  pintarSesion(sesion.usuario);
  await arrancar();
});

async function arrancar() {
  if (arranqueListo) return;
  arranqueListo = true;

  try {
    const [meta, sectores, ordenes, operarios] = await Promise.all([
      API.get('/api/meta'),
      API.get('/api/sectores'),
      API.get('/api/ordenes'),
      API.get('/api/operarios'),
    ]);
    S.meta = meta;
    S.sectores = sectores.sectores;
    S.ordenes = ordenes.ordenes;
    pintarOperarios(operarios.operarios);
  } catch (e) {
    manejarError(e, 'Carga inicial');
  }

  construirSectores();
  construirMotivosPausa();
  renderizarTodo();
  await refrescar();

  // Modo escaneo QR (Fase 7): ?ot=1710 precarga y bloquea la OT.
  await aplicarEscaneoQR();

  setInterval(refrescar, 3000);   // estado en vivo
  setInterval(tick, 250);         // cronómetro
  setInterval(refrescarSectores, 30000); // maestro de sectores (altas/bajas del Admin)
}

/* ------------------------------------------------------------------ */
/* Sesión (login bloqueante de planta)                                 */
/* ------------------------------------------------------------------ */

function pintarSesion(u) {
  const chip = $('sesion-chip');
  if (chip) { chip.hidden = false; chip.textContent = `👤 ${u.nombre}`; }
  // Perfil del pie del sidebar (nombre + rol + cerrar sesión).
  if (window.Sidebar) Sidebar.pintarSesion(u);
  const salir = $('sesion-salir');
  if (salir) {
    salir.hidden = false;
    salir.onclick = async (ev) => {
      ev.preventDefault();
      try { await API.logout(); } catch { /* noop */ }
      location.reload();
    };
  }
}

/**
 * Muestra el modal de login (bloqueante). `trasEntrar` se ejecuta después de
 * autenticarse con éxito (p. ej. completar la carga inicial de la terminal).
 */
function abrirLogin(trasEntrar) {
  const err = $('login-error');
  if (err) err.textContent = '';
  const pass = $('login-password');
  if (pass) pass.value = '';
  Modal.abrir('modal-login');
  const usuario = $('login-usuario');
  if (usuario) usuario.focus();

  const btn = $('btn-login');
  if (!btn || btn.dataset.listo === '1') return;
  btn.dataset.listo = '1';

  const intentar = async () => {
    if (btn.disabled) return;
    if (err) err.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Verificando…';
    try {
      const r = await API.login(($('login-usuario').value || '').trim(), $('login-password').value);
      Modal.cerrar('modal-login');
      pintarSesion(r.usuario);
      Avisos.ok(`Bienvenido/a, ${r.usuario.nombre}`, 'Ya puede fichar etapas.');
      if (trasEntrar) await trasEntrar();
      else await refrescar();
    } catch (e) {
      if (err) err.textContent = e.message || 'No se pudo iniciar sesión.';
      if (pass) { pass.value = ''; pass.focus(); }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Entrar';
    }
  };

  btn.addEventListener('click', intentar);
  ['login-usuario', 'login-password'].forEach((id) => {
    const campo = $(id);
    if (campo) campo.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') intentar(); });
  });
}

function ligarEventos() {
  const buscador = $('buscador-ot');
  buscador.addEventListener('input', pintarResultadosOT);
  buscador.addEventListener('focus', pintarResultadosOT);
  buscador.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      const primero = $('resultados-ot').querySelector('.resultado-ot');
      if (primero) { ev.preventDefault(); primero.click(); }
    }
    if (ev.key === 'Escape') $('resultados-ot').classList.remove('abierto');
  });
  document.addEventListener('click', (ev) => {
    if (!ev.target.closest('.buscador-ot')) $('resultados-ot').classList.remove('abierto');
  });

  $('operario').addEventListener('input', (ev) => {
    S.operario = ev.target.value;
    renderBotones();
    actualizarPistaOperario();
  });

  $('btn-iniciar').addEventListener('click', accionIniciar);
  $('btn-pausar').addEventListener('click', () => {
    const etapa = etapaDelSector();
    if (etapa) abrirModalPausa(etapa);
  });
  $('btn-reanudar').addEventListener('click', () => {
    const etapa = etapaDelSector();
    if (etapa) accionReanudar(etapa.id);
  });
  $('btn-finalizar').addEventListener('click', () => {
    const etapa = etapaDelSector();
    if (etapa) abrirModalFinalizar(etapa);
  });

  document.querySelectorAll('[data-cerrar]').forEach((b) => {
    b.addEventListener('click', () => Modal.cerrar(b.getAttribute('data-cerrar')));
  });
  $('btn-confirmar-pausa').addEventListener('click', confirmarPausa);
  $('btn-confirmar-finalizar').addEventListener('click', confirmarFinalizar);
}

/* ------------------------------------------------------------------ */
/* Selector de OT                                                      */
/* ------------------------------------------------------------------ */

function pintarResultadosOT() {
  const cont = $('resultados-ot');
  const q = FORMATO.normalizar($('buscador-ot').value.trim());
  cont.innerHTML = '';

  const encontradas = S.ordenes
    .filter((ot) => (ot.estado_general === 'Finalizado' ? q.length > 0 : true))
    .filter((ot) => !q || FORMATO.normalizar(ot.numero_ot).includes(q)
      || FORMATO.normalizar(ot.cliente).includes(q)
      || FORMATO.normalizar(ot.modelo || '').includes(q))
    .slice(0, 10);

  if (!encontradas.length) {
    cont.append(h('div', { class: 'resultado-vacio', text: 'No se encontraron OTs con ese criterio.' }));
  } else {
    for (const ot of encontradas) {
      cont.append(h('button', {
        class: 'resultado-ot', type: 'button',
        onclick: () => seleccionarOT(ot),
      },
        h('span', {},
          h('span', { class: 'num', text: ot.numero_ot }),
          h('span', { class: 'cli', text: ` · ${ot.cliente}` })
        ),
        h('span', { class: `chip ${chipEstado(ot.estado_general)}`, text: ot.estado_general })
      ));
    }
  }
  cont.classList.add('abierto');
}

function seleccionarOT(ot) {
  S.ot = ot;
  $('buscador-ot').value = `${ot.numero_ot} - ${ot.cliente}`;
  $('resultados-ot').classList.remove('abierto');

  // Si el sector elegido es especial y esta OT no lo requiere, se limpia.
  // Igual si pertenece a otra línea (R8).
  if (S.sectorId) {
    const sector = S.sectores.find((s) => s.id === S.sectorId);
    if (sector && (
      (sector.clave_especial && !ot[`requiere_${sector.clave_especial}`]) ||
      !sectorAplicaALinea(sector, ot.linea_area || 'Placares')
    )) {
      S.sectorId = null;
    }
  }

  construirSectores(); // reagrupa y destaca la línea de la OT elegida
  renderizarTodo();
  cargarRegistros();
  refrescar();
}

function cambiarOT() {
  S.ot = null;
  S.registros = [];
  S.escaneo = false;
  liberarBuscador();
  ocultarBannerEscaneo();
  $('buscador-ot').value = '';
  $('buscador-ot').focus();
  construirSectores(); // sin OT no se destaca ninguna línea
  renderizarTodo();
  cargarRegistros();
  refrescar();
}

function chipEstado(estado) {
  if (estado === 'En Producción') return 'chip-verde';
  if (estado === 'Detenido') return 'chip-amarillo';
  if (estado === 'Finalizado') return 'chip-gris';
  return 'chip-azul';
}

/* ------------------------------------------------------------------ */
/* Modo escaneo QR (?ot=…) — Fase 7                                     */
/* ------------------------------------------------------------------ */
/**
 * La Hoja de Ruta (Administración → Detalle OT → Imprimir) lleva un QR que
 * apunta a `/?ot=<número>`. Al escanearlo con la tablet, la terminal:
 *   1. selecciona esa OT sola,
 *   2. bloquea el buscador (no se puede cambiar de OT desde el teclado),
 *   3. destaca la LÍNEA (Placares azul / Cocinas rojo),
 *   4. queda lista para que el encargado elija el Sector y pulse
 *      "Iniciar etapa" (verde).
 * El botón "✕ Cambiar OT" de la ficha libera el modo escaneo.
 */
function otDesdeParametro() {
  try {
    return new URLSearchParams(window.location.search).get('ot');
  } catch {
    return null;
  }
}

/** Normaliza "OT-1710", "1710" o "1710 " para comparar sin importar formato. */
function normalizarNumeroOT(t) {
  return String(t || '').trim().toUpperCase().replace(/^OT[-\s]*/, '');
}

async function aplicarEscaneoQR() {
  const numero = otDesdeParametro();
  if (!numero) return;

  const buscado = normalizarNumeroOT(numero);
  const ot = S.ordenes.find((o) => normalizarNumeroOT(o.numero_ot) === buscado);

  if (!ot) {
    mostrarBannerEscaneo(`No se encontró la OT «${numero}». Verifique el número o elija la OT a mano.`, 'error');
    return;
  }

  S.escaneo = true;
  bloquearBuscador();
  mostrarBannerEscaneo(`OT ${ot.numero_ot} cargada por QR · Línea ${ot.linea_area || 'Placares'}. Elija el Sector y pulse «Iniciar etapa».`, 'ok');
  seleccionarOT(ot);
}

function bloquearBuscador() {
  const inp = $('buscador-ot');
  inp.value = '';
  inp.placeholder = '🔒 OT cargada por QR — use «✕ Cambiar OT» para cambiar';
  inp.disabled = true;
  inp.classList.add('bloqueado-qr');
}

function liberarBuscador() {
  const inp = $('buscador-ot');
  inp.disabled = false;
  inp.placeholder = '🔍  Buscar por N° de OT o cliente…';
  inp.classList.remove('bloqueado-qr');
}

function mostrarBannerEscaneo(texto, tipo) {
  let b = $('banner-escaneo');
  if (!b) {
    b = h('div', { id: 'banner-escaneo', class: 'banner-escaneo', role: 'status' });
    // Se inserta justo antes de la sección 1 (Selector de OT).
    const seccion = $('ficha-ot') ? $('ficha-ot').closest('section') : null;
    if (seccion && seccion.parentNode) seccion.parentNode.insertBefore(b, seccion);
    else document.querySelector('main').prepend(b);
  }
  b.className = `banner-escaneo ${tipo === 'error' ? 'error' : 'ok'}`;
  b.innerHTML = '';
  b.append(
    h('span', { class: 'banner-escaneo-icono', text: tipo === 'error' ? '⚠️' : '📲' }),
    h('span', { class: 'banner-escaneo-texto', text: texto }),
    h('button', {
      class: 'btn btn-chico', type: 'button', text: '✕ Cambiar OT',
      onclick: cambiarOT,
    })
  );
}

function ocultarBannerEscaneo() {
  const b = $('banner-escaneo');
  if (b) b.remove();
}

/* ------------------------------------------------------------------ */
/* Ficha de la OT                                                      */
/* ------------------------------------------------------------------ */

function pintarFichaOT() {
  const cont = $('ficha-ot');
  cont.innerHTML = '';
  const ot = S.ot;
  $('chip-ot').textContent = ot ? ot.numero_ot : 'Sin seleccionar';
  $('chip-ot').className = `chip ${ot ? chipEstado(ot.estado_general) : 'chip-gris'}`;

  if (!ot) {
    cont.append(h('div', { class: 'vacio', text: 'Toque el buscador y elija la orden de trabajo.' }));
    return;
  }

  const chips = h('div', { class: 'ficha-ot-chips' },
    h('span', { class: `chip ${chipEstado(ot.estado_general)}`, text: ot.estado_general }),
    h('span', { class: 'chip chip-gris', text: `⭐ ${ot.modelo || 'Sin modelo'}` }),
    h('span', { class: 'chip chip-gris', text: `📏 ${FORMATO.metros(ot.metros_lineales)}` }),
    ot.fecha_prometida
      ? h('span', { class: new Date(ot.fecha_prometida) < new Date(new Date().toDateString()) && ot.estado_general !== 'Finalizado' ? 'chip chip-rojo' : 'chip chip-azul',
        text: `📅 Prometida: ${FORMATO.fecha(ot.fecha_prometida)}` })
      : null
  );

  const especiales = [
    ['requiere_vidrio', 'Puertas de Vidrio', 'chip-azul'],
    ['requiere_lustre', 'Lustre', 'chip-amarillo'],
    ['requiere_herreria', 'Herrería', 'chip-gris'],
    ['requiere_especiales', 'Especiales', 'chip-rojo'],
  ].filter(([clave]) => ot[clave]);

  cont.append(h('div', { class: 'ficha-ot' },
    h('div', { class: 'ficha-ot-top' },
      h('span', { class: 'ficha-ot-num', text: ot.numero_ot }),
      h('span', { class: 'ficha-ot-cli', text: ot.cliente }),
      h('span', { class: 'espaciador' }),
      h('button', { class: 'btn btn-chico', type: 'button', onclick: cambiarOT, text: '✕ Cambiar OT' })
    ),
    chips,
    especiales.length
      ? h('div', { class: 'ficha-ot-chips' },
        h('span', { class: 'texto-suave', text: 'Sectores especiales requeridos:' }),
        especiales.map(([, nombre, clase]) => h('span', { class: `chip ${clase}`, text: `✔ ${nombre}` })))
      : h('div', { class: 'ficha-ot-chips' },
        h('span', { class: 'texto-suave', text: 'Sin sectores especiales requeridos.' })),
    h('div', { class: 'ficha-ot-datos' },
      h('span', {}, 'Progreso: ', h('b', { text: `${ot.progreso.sectores_finalizados}/${ot.progreso.sectores_requeridos} sectores` })),
      h('span', {}, 'Tiempo registrado: ', h('b', { text: FORMATO.duracion(ot.minutos_acumulados) }))
    ),
    h('div', { class: 'barra-progreso' }, h('span', { style: `width:${ot.progreso.porcentaje}%` }))
  ));
}

/* ------------------------------------------------------------------ */
/* Sectores                                                            */
/* ------------------------------------------------------------------ */

/**
 * ¿Aplica el sector a la línea de la OT? Misma regla que el backend (R8):
 * la propia línea, más los sectores Compartido/General.
 */
function sectorAplicaALinea(s, linea) {
  const l = s.linea_area || 'General';
  return l === linea || l === 'Compartido' || l === 'General';
}

function construirSectores() {
  const grid = $('grid-sectores');
  grid.innerHTML = '';
  const lineaOT = S.ot ? (S.ot.linea_area || 'Placares') : null;

  // Agrupa por línea: el operario ve su flujo primero y se destaca lo que
  // corresponde a la OT seleccionada (Placares y Cocinas no se mezclan).
  const grupos = new Map();
  for (const s of S.sectores) {
    const k = s.linea_area || 'General';
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(s);
  }

  for (const [linea, items] of grupos) {
    const esMia = !!lineaOT && linea === lineaOT;

    grid.append(h('div', { class: `cabecera-sector${esMia ? ' cabecera-propia' : ''}` },
      h('span', { class: 'cabecera-sector-titulo', text: ETIQUETAS_LINEA[linea] || linea }),
      esMia
        ? h('span', { class: 'chip chip-azul', text: 'Tu línea' })
        : (lineaOT ? h('span', { class: 'texto-suave', text: 'Otra línea' }) : null)
    ));

    for (const s of items) {
      grid.append(h('button', {
        class: 'sector', type: 'button', 'data-sector': s.id,
        title: s.nombre_sector,
        onclick: () => seleccionarSector(s.id),
      },
        h('span', { class: 'badge', hidden: true }),
        h('span', { class: 'nombre-sector', text: s.nombre_corto || s.nombre_sector }),
        h('span', { class: 'mini', text: s.es_compartido ? 'Sector compartido' : 'Sector único' }),
        s.operarios_sugeridos
          ? h('span', { class: 'etiqueta-operarios', text: `👤 ${s.operarios_sugeridos}` })
          : null,
        s.clave_especial ? h('span', { class: 'etiqueta-requerido', text: 'Especial' }) : null
      ));
    }
  }
}

/**
 * Recarga el maestro de sectores para que altas, bajas o renombres hechos en
 * Administración lleguen a la tablet de planta sin recargarla. Sólo reconstruye
 * la grilla si el catálogo realmente cambió (evita parpadeos).
 */
async function refrescarSectores() {
  try {
    const r = await API.get('/api/sectores');
    const nuevos = r.sectores || [];
    const firma = (x) => x.map((s) =>
      `${s.id}:${s.nombre_sector}:${s.linea_area}:${s.activo ? 1 : 0}:${s.operarios_sugeridos || ''}`).join('|');
    if (firma(nuevos) === firma(S.sectores)) return;

    S.sectores = nuevos;
    if (S.sectorId && !nuevos.some((s) => s.id === S.sectorId)) S.sectorId = null;
    construirSectores();
    renderizarTodo();
  } catch (e) {
    console.error('Sectores', e);
  }
}

function seleccionarSector(id) {
  S.sectorId = id;
  renderizarTodo();
}

function pintarSectores() {
  const ot = S.ot;
  const abiertasPorSector = new Map();
  for (const a of (S.estado ? S.estado.actividad_sectores : [])) {
    abiertasPorSector.set(a.sector_id, a);
  }
  const mias = new Set(
    (S.estado ? S.estado.etapas_abiertas : [])
      .filter((e) => ot && e.ot_id === ot.id)
      .map((e) => e.sector_id)
  );

  document.querySelectorAll('#grid-sectores .sector').forEach((btn) => {
    const id = Number(btn.getAttribute('data-sector'));
    const s = S.sectores.find((x) => x.id === id);
    if (!s) return;
    const noRequerido = !!(ot && s.clave_especial && !ot[`requiere_${s.clave_especial}`]);
    // Regla R8 del backend: un sector sólo se ficha en una OT de su línea.
    const otraLinea = !!(ot && !sectorAplicaALinea(s, ot.linea_area || 'Placares'));
    const motivoBloqueo = ot && (ot.sectores_bloqueados || {})[id];
    const bloqueado = !noRequerido && !otraLinea && !!motivoBloqueo;

    btn.classList.toggle('seleccionado', S.sectorId === id);
    btn.classList.toggle('ocupado', abiertasPorSector.has(id) && !mias.has(id));
    btn.classList.toggle('mi-etapa', mias.has(id));
    btn.classList.toggle('bloqueado', bloqueado);
    btn.classList.toggle('sector-ajeno', otraLinea);
    btn.disabled = noRequerido || otraLinea || bloqueado;
    if (motivoBloqueo) btn.setAttribute('title', motivoBloqueo);
    else btn.setAttribute('title', s.nombre_sector);

    const badge = btn.querySelector('.badge');
    const info = abiertasPorSector.get(id);
    if (mias.has(id)) {
      badge.hidden = false;
      badge.className = 'badge mio';
      badge.textContent = 'MI ETAPA';
    } else if (info) {
      badge.hidden = false;
      badge.className = 'badge';
      badge.textContent = `${info.abiertas} EN CURSO`;
    } else {
      badge.hidden = true;
    }

    const mini = btn.querySelector('.mini');
    if (noRequerido) {
      mini.textContent = 'No requerido en esta OT';
      btn.setAttribute('aria-disabled', 'true');
    } else if (otraLinea) {
      mini.textContent = 'Sector de otra línea';
      btn.setAttribute('aria-disabled', 'true');
    } else if (bloqueado) {
      mini.textContent = motivoBloqueo;
      btn.setAttribute('aria-disabled', 'true');
    } else {
      mini.textContent = s.es_compartido ? 'Sector compartido' : 'Sector único';
      btn.removeAttribute('aria-disabled');
    }
  });

  const sector = S.sectores.find((s) => s.id === S.sectorId);
  $('chip-sector').textContent = sector ? (sector.nombre_corto || sector.nombre_sector) : 'Sin seleccionar';
  $('chip-sector').className = `chip ${sector ? 'chip-azul' : 'chip-gris'}`;
}

/* ------------------------------------------------------------------ */
/* Estado en vivo + cronómetro                                         */
/* ------------------------------------------------------------------ */

function etapaDelSector() {
  if (!S.ot || !S.sectorId || !S.estado) return null;
  return S.estado.etapas_abiertas.find(
    (e) => e.ot_id === S.ot.id && e.sector_id === S.sectorId
  ) || null;
}

function pintarEstadoVivo() {
  const cont = $('estado-vivo');
  const etapa = etapaDelSector();
  cont.classList.remove('activo', 'pausado', 'sin-seleccion', 'advertencia', 'excedido');

  if (!S.ot) {
    cont.classList.add('sin-seleccion');
    cont.innerHTML = '';
    cont.append(
      h('div', { class: 'estado-nombre', text: 'Sin etapa seleccionada' }),
      h('div', { class: 'cronometro', text: '00:00:00' }),
      h('div', { class: 'detalle', text: 'Elija la OT y el sector para ver el cronómetro.' })
    );
    $('chip-estado').textContent = '—';
    $('chip-estado').className = 'chip chip-gris';
    return;
  }

  if (!etapa) {
    cont.classList.add('sin-seleccion');
    cont.innerHTML = '';
    const sector = S.sectores.find((s) => s.id === S.sectorId);
    const umbral = sector ? umbralDeSector(sector) : null;
    cont.append(
      h('div', { class: 'estado-nombre', text: S.sectorId ? 'Sin etapa en este sector' : 'Elija un sector' }),
      h('div', { class: 'cronometro', id: 'crono', text: '00:00:00' }),
      h('div', { class: 'detalle' },
        S.sectorId
          ? 'Listo para iniciar: presione el botón verde.'
          : 'Toque un sector para comenzar a fichar.',
        umbral ? h('div', { class: 'texto-suave', style: 'margin-top:6px;', text: `⏱ Límite de referencia: ${FORMATO.duracion(umbral)} por etapa.` }) : null
      )
    );
    $('chip-estado').textContent = 'Sin etapa';
    $('chip-estado').className = 'chip chip-gris';
    return;
  }

  const pausado = etapa.estado_etapa === 'Pausado';
  cont.classList.add(pausado ? 'pausado' : 'activo');
  cont.innerHTML = '';
  cont.append(
    h('div', { class: 'estado-nombre', text: pausado ? 'Etapa pausada' : 'Etapa en proceso' }),
    h('div', { class: 'cronometro', id: 'crono', text: '00:00:00' }),
    h('div', { class: 'detalle' },
      h('b', { text: etapa.numero_ot || S.ot.numero_ot }), ' · ',
      h('b', { text: etapa.nombre_sector || '' }), h('br'),
      'Operario: ', h('b', { text: etapa.operario_nombre }), h('br'),
      'Inicio: ', h('b', { text: FORMATO.hora(etapa.fecha_hora_inicio) }),
      pausado && etapa.motivo_pausa ? h('span', {}, h('br'), 'Motivo: ', h('b', { text: etapa.motivo_pausa })) : null
    ),
    h('div', { class: 'aviso-tiempo', id: 'aviso-tiempo', hidden: true })
  );

  $('chip-estado').textContent = pausado ? 'PAUSADO' : 'EN PROCESO';
  $('chip-estado').className = `chip ${pausado ? 'chip-amarillo' : 'chip-verde'}`;
  aplicarUmbralTiempo();
}

/** Minutos de umbral para un sector (meta del servidor; defecto 240). */
function umbralDeSector(sector) {
  const u = S.meta && S.meta.umbrales_minutos;
  if (!u || !sector) return u ? u.defecto : null;
  return u.por_sector[sector.nombre_sector] || u.defecto;
}

/**
 * Fase 2 - Alertas de tiempo excedido: la tarjeta del cronómetro pulsa en
 * amarillo al 75% del umbral y en rojo al superarlo.
 */
function aplicarUmbralTiempo() {
  const cont = $('estado-vivo');
  const aviso = $('aviso-tiempo');
  const etapa = etapaDelSector();
  if (!cont || !aviso || !etapa || etapa.estado_etapa !== 'En Proceso') return;

  const sector = S.sectores.find((s) => s.id === etapa.sector_id);
  const umbral = umbralDeSector(sector || {});
  if (!umbral) return;

  const minutos = minutosDeEtapa(etapa, RelojServidor.ahora());
  cont.classList.remove('advertencia', 'excedido');

  if (minutos >= umbral) {
    cont.classList.add('excedido');
    aviso.hidden = false;
    aviso.textContent = `⚠ TIEMPO EXCEDIDO: supera el límite de ${FORMATO.duracion(umbral)} en ${(etapa.nombre_sector || '')}. Avise al encargado.`;
  } else if (minutos >= umbral * 0.75) {
    cont.classList.add('advertencia');
    aviso.hidden = false;
    aviso.textContent = `⏱ Atención: quedan ${FORMATO.duracion(umbral - minutos)} del límite de ${FORMATO.duracion(umbral)}.`;
  }
}

function tick() {
  const crono = document.getElementById('crono');
  if (!crono) return;
  const etapa = etapaDelSector();
  if (!etapa) return;
  crono.textContent = FORMATO.cronometro(minutosDeEtapa(etapa, RelojServidor.ahora()));
  aplicarUmbralTiempo();

  // Actualiza también los cronómetros de la lista lateral.
  document.querySelectorAll('[data-crono-etapa]').forEach((el) => {
    const id = Number(el.getAttribute('data-crono-etapa'));
    const e = (S.estado ? S.estado.etapas_abiertas : []).find((x) => x.id === id);
    if (e) el.textContent = FORMATO.cronometro(minutosDeEtapa(e, RelojServidor.ahora()));
  });
}

function pintarListaEtapas() {
  const bloque = $('etapas-ot-bloque');
  const lista = $('lista-etapas-abiertas');
  lista.innerHTML = '';
  const abiertas = (S.estado ? S.estado.etapas_abiertas : [])
    .filter((e) => S.ot && e.ot_id === S.ot.id);

  if (!S.ot || !abiertas.length) {
    bloque.hidden = true;
    return;
  }
  bloque.hidden = false;

  for (const e of abiertas) {
    const pausado = e.estado_etapa === 'Pausado';
    const sector = S.sectores.find((s) => s.id === e.sector_id);
    const umbral = umbralDeSector(sector || {});
    const excede = !pausado && umbral && minutosDeEtapa(e, RelojServidor.ahora()) >= umbral;
    lista.append(h('li', {},
      h('span', { class: `chip ${pausado ? 'chip-amarillo' : 'chip-verde'}`, text: pausado ? 'PAUSA' : 'CURSO' }),
      excede ? h('span', { class: 'chip chip-rojo', text: '⚠ EXCEDE' }) : null,
      h('span', { class: 'et-sector', text: e.nombre_sector || '' }),
      h('span', { class: 'texto-suave', text: e.operario_nombre }),
      h('span', { class: 'et-ops' },
        h('span', { 'data-crono-etapa': e.id, class: 'texto-suave', text: '00:00:00' }),
        pausado
          ? h('button', { class: 'btn btn-chico', type: 'button', onclick: () => accionReanudar(e.id), text: '⏵ Reanudar' })
          : h('button', { class: 'btn btn-chico', type: 'button', onclick: () => abrirModalPausa(e), text: '⏸ Pausar' }),
        h('button', { class: 'btn btn-chico btn-peligro', type: 'button', onclick: () => abrirModalFinalizar(e), text: '■ Fin' })
      )
    ));
  }
}

/* ------------------------------------------------------------------ */
/* Operario                                                            */
/* ------------------------------------------------------------------ */

function pintarOperarios(operarios) {
  const dl = $('lista-operarios');
  dl.innerHTML = '';
  const ultimo = $('bloque-ultimo-operario');
  ultimo.innerHTML = '';
  S.operarios = operarios || [];
  if (!S.operarios.length) return;

  for (const o of S.operarios.slice(0, 40)) {
    dl.append(h('option', { value: o.nombre, text: `${o.etapas} etapas · última ${FORMATO.fecha(o.ultima_actividad)}` }));
  }

  ultimo.append(
    h('span', { class: 'campo', style: 'display:block; margin-bottom:6px;' },
      h('span', { text: 'Tocar para usar un operario reciente' })),
    h('div', { class: 'fila-flex' },
      S.operarios.slice(0, 5).map((o) => h('button', {
        class: 'btn btn-chico', type: 'button',
        onclick: () => {
          S.operario = o.nombre;
          $('operario').value = o.nombre;
          renderBotones();
          actualizarPistaOperario();
        },
        text: o.nombre
      })))
  );
  actualizarPistaOperario();
}

/**
 * Fase 4: pista bajo el campo de operario.
 * Si el nombre tipeado NO está en el maestro, avisa que se registrará solo
 * al iniciar la etapa (auto-guardado transparente del backend).
 */
function actualizarPistaOperario() {
  const p = $('pista-operario');
  if (!p) return;
  const nombre = (S.operario || '').trim();
  if (!nombre) { p.style.display = 'none'; p.textContent = ''; return; }

  const normalizado = FORMATO.normalizar(nombre);
  const coincide = S.operarios.some((o) => FORMATO.normalizar(o.nombre) === normalizado);
  if (coincide) {
    p.style.display = 'none';
    p.textContent = '';
  } else {
    p.style.display = 'block';
    p.textContent = '🆕 Nombre nuevo: se registrará automáticamente como operario al iniciar la etapa.';
  }
}

/* ------------------------------------------------------------------ */
/* Botones de acción                                                   */
/* ------------------------------------------------------------------ */

function renderBotones() {
  const etapa = etapaDelSector();
  const hayOT = !!S.ot;
  const haySector = !!S.sectorId;
  const operarioOk = S.operario.trim().length > 0;
  const enProceso = etapa && etapa.estado_etapa === 'En Proceso';
  const pausado = etapa && etapa.estado_etapa === 'Pausado';

  $('btn-iniciar').disabled = !(hayOT && haySector && operarioOk && !etapa);
  $('btn-pausar').disabled = !enProceso;
  $('btn-reanudar').disabled = !pausado;
  $('btn-finalizar').disabled = !etapa;

  const msg = $('mensaje-accion');
  if (!hayOT) msg.textContent = '① Primero seleccione la orden de trabajo.';
  else if (!haySector) msg.textContent = '② Ahora toque el sector donde se realiza el trabajo.';
  else if (!operarioOk && !etapa) msg.textContent = '③ Escriba el nombre del operario responsable.';
  else if (enProceso) msg.textContent = '✔ Etapa en curso. Puede pausarla o finalizarla cuando termine.';
  else if (pausado) msg.textContent = '⏸ Etapa pausada: reanúdela o finalícela.';
  else if (etapa) msg.textContent = '';
  else msg.textContent = '✔ Todo listo: presione INICIAR ETAPA.';
}

/* ------------------------------------------------------------------ */
/* Acciones                                                            */
/* ------------------------------------------------------------------ */

async function accionIniciar() {
  if (!$('btn-iniciar').disabled) {
    $('btn-iniciar').disabled = true;
    try {
      const r = await API.post('/api/registros', {
        ot_id: S.ot.id,
        sector_id: S.sectorId,
        operario_nombre: S.operario.trim(),
      });
      Avisos.ok('✔ Etapa iniciada',
        `${r.registro.numero_ot} · ${r.registro.nombre_sector} · ${r.registro.operario_nombre}`);
      await Promise.all([refrescar(), cargarRegistros()]);
      actualizarFichaOT();
    } catch (e) {
      manejarError(e, 'Iniciar etapa');
      await refrescar();
    } finally {
      renderBotones();
    }
  }
}

function abrirModalPausa(etapa) {
  const resumen = $('resumen-pausa');
  resumen.innerHTML = '';
  resumen.append(
    h('div', {}, 'OT: ', h('b', { text: `${etapa.numero_ot || S.ot.numero_ot} · ${etapa.nombre_sector || ''}` })),
    h('div', {}, 'Operario: ', h('b', { text: etapa.operario_nombre })),
    h('div', { class: 'grande', id: 'cronto-pausa', text: FORMATO.cronometro(minutosDeEtapa(etapa, RelojServidor.ahora())) }),
    h('div', { class: 'texto-suave', text: `Inicio: ${FORMATO.hora(etapa.fecha_hora_inicio)}` })
  );
  $('obs-pausa').value = '';
  document.querySelectorAll('#motivos-pausa input').forEach((i) => { i.checked = false; });
  document.querySelectorAll('#motivos-pausa .motivo').forEach((l) => l.classList.remove('marcado'));
  // Fase 2: la confirmación queda bloqueada hasta elegir un motivo obligatorio.
  $('btn-confirmar-pausa').disabled = true;
  const pista = $('pista-pausa');
  if (pista) pista.textContent = 'Seleccione un motivo para habilitar la confirmación.';
  $('btn-confirmar-pausa').dataset.etapa = etapa.id;
  Modal.abrir('modal-pausa');
}

function construirMotivosPausa() {
  const cont = $('motivos-pausa');
  cont.innerHTML = '';
  const motivos = (S.meta && S.meta.motivos_pausa) || [
    'Falta de herrajes', 'Error de plano', 'Ajuste de herramienta', 'Rotura de placa', 'Otro',
  ];
  for (const m of motivos) {
    cont.append(h('label', { class: 'motivo' },
      h('input', { type: 'radio', name: 'motivo-pausa', value: m }),
      h('span', { text: m })
    ));
  }
  cont.querySelectorAll('input').forEach((i) => {
    i.addEventListener('change', () => {
      cont.querySelectorAll('.motivo').forEach((l) => l.classList.toggle('marcado', i.checked && l.contains(i)));
      // Habilita la confirmación sólo con un motivo elegido.
      $('btn-confirmar-pausa').disabled = false;
      const pista = $('pista-pausa');
      if (pista) pista.textContent = '';
    });
  });
}

async function confirmarPausa() {
  const elegido = document.querySelector('#motivos-pausa input:checked');
  if (!elegido) {
    Avisos.aviso('Seleccione el motivo de la pausa');
    return;
  }
  const id = Number($('btn-confirmar-pausa').dataset.etapa);
  $('btn-confirmar-pausa').disabled = true;
  try {
    const r = await API.post(`/api/registros/${id}/pausar`, {
      motivo_pausa: elegido.value,
      observacion: $('obs-pausa').value,
    });
    Modal.cerrar('modal-pausa');
    Avisos.aviso('⏸ Etapa pausada', `Motivo: ${r.registro.motivo_pausa}`);
    await Promise.all([refrescar(), cargarRegistros()]);
  } catch (e) {
    manejarError(e, 'Pausar etapa');
  } finally {
    $('btn-confirmar-pausa').disabled = false;
  }
}

async function accionReanudar(id) {
  try {
    const r = await API.post(`/api/registros/${id}/reanudar`, {});
    Avisos.ok('⏵ Etapa reanudada', `${r.registro.numero_ot} · ${r.registro.nombre_sector}`);
    await Promise.all([refrescar(), cargarRegistros()]);
  } catch (e) {
    manejarError(e, 'Reanudar etapa');
  }
}

function abrirModalFinalizar(etapa) {
  const resumen = $('resumen-finalizar');
  resumen.innerHTML = '';
  const minutos = minutosDeEtapa(etapa, RelojServidor.ahora());
  resumen.append(
    h('div', {}, 'OT: ', h('b', { text: `${etapa.numero_ot || S.ot.numero_ot} · ${etapa.nombre_sector || ''}` })),
    h('div', {}, 'Operario: ', h('b', { text: etapa.operario_nombre })),
    h('div', { class: 'texto-suave', text: `Inicio: ${FORMATO.fechaHora(etapa.fecha_hora_inicio)}` }),
    h('div', {}, 'Duración a registrar: '),
    h('div', { class: 'grande', text: `${FORMATO.cronometro(minutos)}  (${FORMATO.duracion(minutos)})` })
  );
  $('obs-finalizar').value = '';
  $('btn-confirmar-finalizar').disabled = false;
  $('btn-confirmar-finalizar').dataset.etapa = etapa.id;
  Modal.abrir('modal-finalizar');
}

async function confirmarFinalizar() {
  const id = Number($('btn-confirmar-finalizar').dataset.etapa);
  $('btn-confirmar-finalizar').disabled = true;
  try {
    const r = await API.post(`/api/registros/${id}/finalizar`, { observacion: $('obs-finalizar').value });
    Modal.cerrar('modal-finalizar');
    Avisos.ok('✔ Etapa finalizada',
      `${r.registro.numero_ot} · ${r.registro.nombre_sector} · Duración: ${FORMATO.duracion(r.registro.duracion_minutos)}`);
    await Promise.all([refrescar(), cargarRegistros()]);
    await actualizarFichaOT();
  } catch (e) {
    manejarError(e, 'Finalizar etapa');
  } finally {
    $('btn-confirmar-finalizar').disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* Refresco                                                            */
/* ------------------------------------------------------------------ */

async function refrescar() {
  if (!S.ot) {
    S.estado = { etapas_abiertas: [], actividad_sectores: [] };
    pintarSectores();
    pintarEstadoVivo();
    pintarListaEtapas();
    renderBotones();
    return;
  }
  try {
    S.estado = await API.get(`/api/estado?ot_id=${S.ot.id}`);
    S.refrescos += 1;
    if (S.refrescos % 5 === 0) cargarRegistros();
  } catch (e) {
    console.error('Refresco', e);
    return;
  }
  pintarSectores();
  pintarEstadoVivo();
  pintarListaEtapas();
  renderBotones();
}

async function cargarRegistros() {
  const tbody = $('cuerpo-registros');
  if (!S.ot) {
    tbody.innerHTML = '';
    tbody.append(h('tr', {}, h('td', { colspan: '7', class: 'vacio', text: 'Seleccione una OT para ver sus registros.' })));
    return;
  }
  try {
    const r = await API.get(`/api/registros?ot_id=${S.ot.id}&limit=15`);
    S.registros = r.registros;
    tbody.innerHTML = '';
    if (!r.registros.length) {
      tbody.append(h('tr', {}, h('td', { colspan: '7', class: 'vacio', text: 'Esta OT todavía no tiene registros de tiempo.' })));
      return;
    }
    for (const g of r.registros) {
      const chip = g.estado_etapa === 'Finalizado' ? 'chip-gris'
        : g.estado_etapa === 'Pausado' ? 'chip-amarillo' : 'chip-verde';
      // data-label alimenta la conversión a tarjetas apiladas en móvil
      // (ver app.css: .tabla tbody td::before { content: attr(data-label) }).
      tbody.append(h('tr', {},
        h('td', { 'data-label': 'Sector', text: g.nombre_sector }),
        h('td', { 'data-label': 'Operario', text: g.operario_nombre }),
        h('td', { 'data-label': 'Inicio', text: FORMATO.hora(g.fecha_hora_inicio) }),
        h('td', { 'data-label': 'Fin', text: g.fecha_hora_fin ? FORMATO.hora(g.fecha_hora_fin) : '—' }),
        h('td', { 'data-label': 'Duración', class: 'num', text: g.estado_etapa === 'Finalizado' ? FORMATO.duracion(g.duracion_minutos) : 'En curso…' }),
        h('td', { 'data-label': 'Estado' }, h('span', { class: `chip ${chip}`, text: g.estado_etapa })),
        h('td', { 'data-label': 'Motivo / Observación', text: [g.motivo_pausa, g.observacion].filter(Boolean).join(' · ') || '—' })
      ));
    }
  } catch (e) {
    manejarError(e, 'Cargar registros');
  }
}

async function actualizarFichaOT() {
  if (!S.ot) return;
  try {
    const r = await API.get(`/api/ordenes/${S.ot.id}`);
    const { registros, ...ot } = r;
    S.ot = ot;
    const i = S.ordenes.findIndex((x) => x.id === ot.id);
    if (i >= 0) S.ordenes[i] = ot;
    pintarFichaOT();
    pintarSectores();
  } catch (e) {
    console.error('Ficha OT', e);
  }
}

function renderizarTodo() {
  pintarFichaOT();
  pintarSectores();
  pintarEstadoVivo();
  pintarListaEtapas();
  renderBotones();
}
