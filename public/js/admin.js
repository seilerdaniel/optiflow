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
});

/* ------------------------------------------------------------------ */
/* Sesión (V-1)                                                        */
/* ------------------------------------------------------------------ */

function pintarSesion(u) {
  const chip = $('sesion-chip');
  if (chip) { chip.hidden = false; chip.textContent = `👤 ${u.nombre} (${u.rol})`; }
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
    const m = await API.get('/api/metricas');
    S.metricas = m;
    pintarKPIs(m);
    pintarCargaSectores(m);
    pintarPausas(m);
    $('kpi-actualizado').textContent = `Actualizado ${FORMATO.hora(m.generado_en)} · período ${FORMATO.fecha(m.periodo.desde)} → ${FORMATO.fecha(m.periodo.hasta)}`;
  } catch (e) {
    manejarError(e, 'Cargar métricas');
  }
}

function pintarKPIs(m) {
  // OTs activas
  $('kpi-activas').textContent = String(m.ots.activas);
  $('kpi-activas-sub').textContent =
    `En Producción: ${m.ots.por_estado['En Producción']} · Detenidas: ${m.ots.por_estado.Detenido} · de ${m.ots.total} totales`;

  // Lead time promedio
  $('kpi-leadtime').textContent = m.lead_time.promedio_minutos === null ? '—' : m.lead_time.promedio_legible;
  $('kpi-leadtime-sub').textContent = m.lead_time.ots_medidas
    ? `Promedio de ${m.lead_time.ots_medidas} OT(s) medidas (Corte → Embalaje Final)`
    : 'Sin OTs medidas en el período (Corte → Embalaje Final)';

  // Cuello de botella del día
  const tarjeta = $('kpi-cuello-tarjeta');
  if (m.cuello_botella) {
    tarjeta.classList.add('alerta');
    $('kpi-cuello').textContent = m.cuello_botella.nombre_corto || m.cuello_botella.nombre_sector;
    $('kpi-cuello-sub').textContent =
      `${m.cuello_botella.horas_total} h acumuladas hoy (${m.cuello_botella.horas_en_proceso} h en proceso · ${m.cuello_botella.horas_pausado} h pausado) · ${m.cuello_botella.etapas_abiertas} etapa(s) abierta(s)`;
  } else {
    tarjeta.classList.remove('alerta');
    $('kpi-cuello').textContent = 'Sin carga';
    $('kpi-cuello-sub').textContent = 'No hay etapas activas ni cerradas hoy.';
  }
  $('cuello-dia').textContent = `Hoy: ${FORMATO.fecha(m.periodo.dia_cuello_botella)}`;

  // FTT
  $('kpi-ftt').textContent = m.ftt.porcentaje === null ? '—' : `${m.ftt.porcentaje}%`;
  $('kpi-ftt-sub').textContent = m.ftt.evaluadas
    ? `${m.ftt.conformes} de ${m.ftt.evaluadas} OT(s) sin ${m.ftt.motivos_reproceso.join(' / ')}`
    : 'Sin OTs avanzadas en el período';
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

function pintarTabla() {
  const q = FORMATO.normalizar($('filtro-ot').value.trim());
  const estado = $('filtro-estado').value;
  const cuerpo = $('cuerpo-ots');
  cuerpo.innerHTML = '';

  const filas = S.ordenes.filter((ot) => {
    if (estado && ot.estado_general !== estado) return false;
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

    $('detalle-cuerpo').innerHTML = '';
    $('detalle-cuerpo').append(
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
  const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=0&data=${encodeURIComponent(urlTerminal)}`;

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
      h('img', { class: 'hoja-qr', src: qrSrc, alt: `QR de ${ot.numero_ot}` }),
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
    cuerpo.append(h('tr', {}, h('td', { class: 'vacio', colspan: '7', text: 'Sin usuarios cargados.' })));
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
        onclick: () => cambiarEstadoUsuario(u),
      }, u.activo ? '⏸ Desactivar' : '▶ Activar'),
      esYo ? h('span', { class: 'texto-suave', text: '(usted)' }) : null
    );

    cuerpo.append(h('tr', {},
      h('td', { text: String(u.id) }),
      h('td', {}, h('b', { text: u.usuario })),
      h('td', { text: u.nombre }),
      h('td', { text: ETIQUETAS_ROL[u.rol] || u.rol }),
      h('td', { text: u.ultimo_acceso ? FORMATO.fechaHora(u.ultimo_acceso) : '—' }),
      h('td', {}, h('span', { class: `chip ${u.activo ? 'chip-verde' : 'chip-rojo'}`, text: u.activo ? 'Activo' : 'Inactivo' })),
      acciones
    ));
  }
}

async function agregarUsuario() {
  const usuario = $('usu-login').value.trim().toLowerCase();
  const nombre = $('usu-nombre').value.trim();
  const password = $('usu-password').value;
  const rol = $('usu-rol').value;

  if (!usuario || !nombre || !password) {
    Avisos.aviso('Complete usuario, nombre visible y contraseña para crear el acceso.');
    return;
  }
  if (password.length < 6) {
    Avisos.aviso('La contraseña debe tener al menos 6 caracteres.');
    return;
  }

  try {
    await API.post('/api/usuarios', { usuario, nombre, password, rol });
    Avisos.ok(`✔ Usuario "${usuario}" creado`, `Ya puede usar la Terminal de fichado.`);
    $('usu-login').value = '';
    $('usu-nombre').value = '';
    $('usu-password').value = '';
    await cargarUsuarios();
  } catch (e) {
    manejarError(e, 'Crear usuario');
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
