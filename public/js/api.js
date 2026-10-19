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
    const icono = tipo === 'ok' ? '✔' : tipo === 'error' ? '✖' : '!';
    const a = h('div', { class: `aviso ${tipo}` },
      h('span', { class: 'aviso-tipo', text: icono }),
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
