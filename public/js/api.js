'use strict';

/* ============================================================
   OPTIFLOW - Utilidades compartidas (API + UI + formato)
   ============================================================ */

const API = {
  /** Se invoca automáticamente cuando la API responde 401 (sesión vencida). */
  onSinSesion: null,

  /**
   * Petición genérica a la API de Optiflow.
   * Lanza un Error con el mensaje del servidor (ya traducido/castellanizado).
   */
  async req(metodo, ruta, cuerpo) {
    let r;
    try {
      r = await fetch(ruta, {
        method: metodo,
        headers: cuerpo ? { 'Content-Type': 'application/json' } : undefined,
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
        // Envía/recibe la cookie de sesión (HttpOnly) en el mismo origen.
        credentials: 'same-origin',
        cache: 'no-store',
      });
    } catch {
      throw new Error('No se pudo conectar con el servidor de Optiflow. Verifique que esté en marcha.');
    }

    let datos = null;
    try { datos = await r.json(); } catch { datos = null; }

    if (!r.ok) {
      const err = new Error((datos && (datos.error || datos.mensaje)) || `Error ${r.status}`);
      err.status = r.status;
      err.detalle = datos ? datos.detalle : null;
      if (r.status === 401) {
        err.sinSesion = true;
        if (typeof API.onSinSesion === 'function') API.onSinSesion();
      }
      throw err;
    }
    return datos;
  },
  get(ruta) { return this.req('GET', ruta); },
  post(ruta, cuerpo) { return this.req('POST', ruta, cuerpo || {}); },
  put(ruta, cuerpo) { return this.req('PUT', ruta, cuerpo || {}); },
  del(ruta) { return this.req('DELETE', ruta); },

  /* ------------- Sesiones (auditoría V-1) ------------- */
  /** Sesión vigente: { usuario: { id, usuario, nombre, rol } } o { usuario: null }. */
  sesion() { return this.get('/api/auth/usuario'); },
  login(usuario, password) { return this.post('/api/auth/login', { usuario, password }); },
  logout() { return this.post('/api/auth/logout', {}); },
};

/** Crea un elemento DOM de forma segura (sin innerHTML con datos del usuario). */
function h(tag, attrs, ...hijos) {
  const e = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, '');
      else e.setAttribute(k, String(v));
    }
  }
  for (const hijo of (hijos || []).flat()) {
    if (hijo === null || hijo === undefined || hijo === false) continue;
    e.append(hijo.nodeType ? hijo : document.createTextNode(String(hijo)));
  }
  return e;
}

/* ============================================================
   ICONOGRAFÍA NATIVA (R21)
   ------------------------------------------------------------
   Un único catálogo de trazos SVG inline, sin librerías ni CDN.
   Todos usan viewBox 24, trazo 2, currentColor y extremos
   redondeados: se alinean con .btn/.nav/.chip vía inline-flex.
   Los trazos son constantes del código (nunca datos de usuario),
   por eso el innerHTML se limita a un <svg> recién creado.
   ============================================================ */
const ICONOS_UI = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  alert: '<path d="m10.3 3.9-7.4 12.8A2 2 0 0 0 4.6 20h14.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
  play: '<path d="M8 5v14l11-7Z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  print: '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.6a2 2 0 0 1-.5 2.1L8 9.6a16 16 0 0 0 6.4 6.4l1.2-1.2a2 2 0 0 1 2.1-.5c.8.3 1.7.5 2.6.6a2 2 0 0 1 1.7 2Z"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  chart: '<path d="M3 3v18h18"/><path d="M8 17v-5"/><path d="M13 17V8"/><path d="M18 17v-8"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  package: '<path d="M21 8v8a2 2 0 0 1-1 1.73l-7 4a2 2 0 0 1-2 0l-7-4A2 2 0 0 1 3 16V8a2 2 0 0 1 1-1.73l7-4a2 2 0 0 1 2 0l7 4A2 2 0 0 1 21 8z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  bug: '<path d="M8 3v2M16 3v2"/><path d="M9 9h6a4 4 0 0 1 4 4v1a7 7 0 0 1-14 0v-1a4 4 0 0 1 4-4Z"/><path d="M12 9v9M8 13H3M21 13h-5M6 19l-2 2M18 19l2 2M7 5 5 3M17 5l2-2"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M7 12h10"/>',
  // Marca de flujo industrial: dos chevrones encadenados + nodo final, que
  // leen como proceso/trazabilidad en movimiento (sin monograma de letras).
  flujo: '<path d="M3 6l5.5 6L3 18"/><path d="M10 6l5.5 6L10 18"/><circle cx="20.5" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
};

/** Crea un SVG inline normalizado. El nombre debe existir en ICONOS_UI. */
function iconoSvg(nombre, clase) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', clase || 'ico-svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.innerHTML = ICONOS_UI[nombre] || ICONOS_UI.info;
  return svg;
}

const FORMATO = {
  /** 'HH:MM:SS' de una fecha ISO (hora local del equipo). */
  hora(iso) {
    if (!iso) return '--:--:--';
    const d = new Date(iso);
    if (Number.isNaN(d)) return '--:--:--';
    return d.toLocaleTimeString('es-AR', { hour12: false });
  },
  fecha(iso) {
    if (!iso) return '—';
    const d = iso.length === 10 ? new Date(iso + 'T00:00:00') : new Date(iso);
    if (Number.isNaN(d)) return String(iso);
    return d.toLocaleDateString('es-AR');
  },
  fechaHora(iso) {
    if (!iso) return '—';
    return `${FORMATO.fecha(iso)} ${FORMATO.hora(iso)}`;
  },
  /** Minutos -> '2 h 15 min' / '45 min' */
  duracion(minutos) {
    if (minutos === null || minutos === undefined) return '—';
    const total = Math.max(0, Math.round(minutos));
    const hh = Math.floor(total / 60);
    const mm = total % 60;
    return hh > 0 ? `${hh} h ${String(mm).padStart(2, '0')} min` : `${mm} min`;
  },
  /** Minutos -> cronómetro 'HH:MM:SS' */
  cronometro(minutos) {
    const total = Math.max(0, Math.round((minutos || 0) * 60));
    const hh = Math.floor(total / 3600);
    const mm = Math.floor((total % 3600) / 60);
    const ss = total % 60;
    const p = (n) => String(n).padStart(2, '0');
    return `${p(hh)}:${p(mm)}:${p(ss)}`;
  },
  metros(n) {
    if (n === null || n === undefined || n === '') return '—';
    return `${Number(n).toLocaleString('es-AR', { maximumFractionDigits: 2 })} m`;
  },
  /** Quita acentos/mayúsculas para buscar sin importar tildes. */
  normalizar(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  },
};

/** Minutos transcurridos (netos) de una etapa abierta, usando el reloj del servidor. */
function minutosDeEtapa(etapa, ahoraServidor) {
  if (!etapa) return 0;
  if (etapa.estado_etapa === 'Finalizado') return etapa.duracion_minutos || 0;
  const ahora = ahoraServidor || Date.now();
  let ms = ahora - new Date(etapa.fecha_hora_inicio).getTime();
  let seg = Number(etapa.segundos_pausados || 0);
  if (etapa.pausa_inicio) {
    seg += (ahora - new Date(etapa.pausa_inicio).getTime()) / 1000;
  }
  return Math.max(0, (ms / 1000 - seg) / 60);
}

/** Avisos flotantes. */
const Avisos = {
  mostrar(tipo, mensaje, detalle) {
    const cont = document.getElementById('avisos');
    if (!cont) return;
    const icono = iconoSvg(tipo === 'ok' ? 'check' : tipo === 'error' ? 'x' : 'info');
    const a = h('div', { class: `aviso ${tipo}` },
      h('span', { class: 'aviso-tipo' }, icono),
      h('div', {}, mensaje, detalle ? h('small', { text: detalle }) : null)
    );
    cont.append(a);
    setTimeout(() => {
      a.style.transition = 'opacity .3s, transform .3s';
      a.style.opacity = '0';
      a.style.transform = 'translateY(10px)';
      setTimeout(() => a.remove(), 320);
    }, tipo === 'error' ? 7000 : 4000);
  },
  ok(m, d) { this.mostrar('ok', m, d); },
  error(m, d) { this.mostrar('error', m, d); },
  aviso(m, d) { this.mostrar('aviso', m, d); },
};

/** Manejo estándar de errores de API en la UI. */
function manejarError(e, contexto) {
  console.error(contexto || 'Error', e);
  let extra = null;
  if (e.detalle) {
    extra = typeof e.detalle === 'string'
      ? e.detalle
      : e.detalle.accion || JSON.stringify(e.detalle);
  }
  Avisos.error(e.message || 'Error inesperado', extra);
}

/** Sincroniza el reloj local con el reloj del servidor (difiere por husos/pérdidas). */
const RelojServidor = {
  desfase: 0,
  async sincronizar() {
    try {
      const r = await API.get('/api/hora');
      this.desfase = r.epoch_ms - Date.now();
    } catch { /* se mantiene el reloj local */ }
  },
  ahora() { return Date.now() + this.desfase; },
  iso() { return new Date(this.ahora()).toISOString(); },
};

/**
 * Abre/cierra modales por id.
 * R20: foco gestionado (primer control), trampa de Tab dentro del diálogo y
 * restauración del foco al cerrar. Escape y clic en el fondo siguen viviendo
 * en iniciarBarraSuperior().
 */
const Modal = {
  _previos: new WeakMap(),

  abrir(id) {
    const m = document.getElementById(id);
    if (!m) return;
    if (!m.classList.contains('abierto')) {
      this._previos.set(m, document.activeElement);
    }
    m.classList.add('abierto');
    m.setAttribute('aria-hidden', 'false');

    // Espera al paint para que el control ya sea visible y enfocable.
    requestAnimationFrame(() => {
      const foco = m.querySelector(
        '[data-autofocus], input:not([type="hidden"]):not([disabled]), select:not([disabled]), '
        + 'textarea:not([disabled]), button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
      );
      if (foco) {
        try { foco.focus({ preventScroll: true }); } catch { foco.focus(); }
      }
    });

    if (m.dataset.trampaFoco !== '1') {
      m.dataset.trampaFoco = '1';
      m.addEventListener('keydown', (ev) => Modal._atraparTab(ev, m));
    }
  },

  cerrar(id) {
    const m = document.getElementById(id);
    if (!m) return;
    m.classList.remove('abierto');

    // Restaurar el foco ANTES de ocultar semánticamente el diálogo: así el
    // navegador nunca queda con foco dentro de un subárbol aria-hidden.
    const previo = this._previos.get(m);
    this._previos.delete(m);
    if (previo && document.contains(previo)) {
      try { previo.focus({ preventScroll: true }); } catch { /* sin foco previo */ }
    }
    m.setAttribute('aria-hidden', 'true');
  },

  cerrarTodos() {
    document.querySelectorAll('.modal-fondo.abierto').forEach((m) => Modal.cerrar(m.id));
  },

  /** Mantiene Tab/Shift+Tab dentro del diálogo abierto. */
  _atraparTab(ev, m) {
    if (ev.key !== 'Tab') return;
    const focos = [...m.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), '
      + 'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )].filter((el) => el.getClientRects().length > 0);
    if (!focos.length) return;
    const primero = focos[0];
    const ultimo = focos[focos.length - 1];
    if (ev.shiftKey && document.activeElement === primero) {
      ev.preventDefault();
      ultimo.focus();
    } else if (!ev.shiftKey && document.activeElement === ultimo) {
      ev.preventDefault();
      primero.focus();
    }
  },
};

/**
 * Marca/desmarca un botón como "trabajando": spinner CSS + aria-busy.
 * No altera disabled (cada flujo decide cuándo bloquear el control).
 */
function marcarCargando(boton, activo) {
  if (!boton) return;
  boton.classList.toggle('cargando', !!activo);
  if (activo) boton.setAttribute('aria-busy', 'true');
  else boton.removeAttribute('aria-busy');
}

/**
 * Muestra un overlay de carga dentro de un contenedor y marca aria-busy.
 * Uso: cargarEn('panel-objetivos-anio', true, 'Cargando comparativo…').
 */
function cargarEn(contenedor, activo, texto) {
  const el = typeof contenedor === 'string' ? document.getElementById(contenedor) : contenedor;
  if (!el) return;
  let overlay = el.querySelector(':scope > .cargando-overlay');
  if (activo) {
    el.setAttribute('aria-busy', 'true');
    if (!overlay) {
      overlay = h('div', { class: 'cargando-overlay', role: 'status', 'aria-live': 'polite' },
        h('span', { class: 'spinner', 'aria-hidden': 'true' }),
        h('span', { class: 'cargando-texto', text: texto || 'Cargando…' }));
      el.append(overlay);
    } else {
      const t = overlay.querySelector('.cargando-texto');
      if (t && texto) t.textContent = texto;
      overlay.hidden = false;
    }
  } else {
    el.removeAttribute('aria-busy');
    if (overlay) overlay.remove();
  }
}

/** Inicialización compartida: reloj de la barra + avisos + sincronización. */
async function iniciarBarraSuperior() {
  const cont = document.getElementById('avisos');
  if (!cont) {
    const div = h('div', {
      id: 'avisos', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'false',
    });
    document.body.append(div);
  }
  await RelojServidor.sincronizar();
  setInterval(() => RelojServidor.sincronizar(), 60000);

  const reloj = document.getElementById('reloj-hora');
  const fecha = document.getElementById('reloj-fecha');
  const pintar = () => {
    const d = new Date(RelojServidor.ahora());
    if (reloj) reloj.textContent = d.toLocaleTimeString('es-AR', { hour12: false });
    if (fecha) fecha.textContent = d.toLocaleDateString('es-AR', { weekday: 'short', day: '2-digit', month: '2-digit' });
  };
  pintar();
  setInterval(pintar, 1000);

  // Cerrar modales con Escape y clic en el fondo (los `.modal-bloqueante`,
  // p. ej. el de login, sólo se cierran desde su lógica interna).
  const cerrable = (m) => m && !m.classList.contains('modal-bloqueante');
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    document.querySelectorAll('.modal-fondo.abierto').forEach((m) => { if (cerrable(m)) Modal.cerrar(m.id); });
  });
  document.querySelectorAll('.modal-fondo').forEach((f) => {
    f.addEventListener('click', (ev) => { if (ev.target === f && cerrable(f)) Modal.cerrar(f.id); });
  });
}
