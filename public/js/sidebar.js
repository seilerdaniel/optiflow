'use strict';

/* ============================================================
   OPTIFLOW - SIDEBAR INDUSTRIAL RESPONSIVE
   "De Otro Tiempo" · Planta Placares / Cocinas
   ------------------------------------------------------------
   · CERO dependencias externas: DOM nativo, sin frameworks.
   · Fuente única del menú: el marcado se genera desde acá y se
     comparte entre / (terminal de fichado) y /admin, de modo que
     las dos vistas nunca pueden desincronizarse.
   · No requiere a api.js para su estructura: sólo lo usa (si
     existe) para pintar la sesión y cerrarla.
   · Comportamiento por ancho (ver public/css/app.css):
       > 1024px  Escritorio  : desplegado 260px; ☰ colapsa a rail 64px.
       768-1023px Tabletas   : RAIL automático 64px; ☰ lo superpone.
       < 768px   Celulares   : DRAWER desde el ☰ de la barra superior.
   ============================================================ */

(function () {
  /**
   * Versión mostrada en la cabecera.
   * Fuente única de verdad: package.json (server/server.js la expone en
   * /api/salud). Este texto sólo es el respaldo que se ve mientras la
   * versión real carga (o si la planta está sin red): nunca se edita a
   * mano para "subir la versión" — eso se hace en package.json.
   */
  const VERSION_RESPALDO = 'v—';

  const CLAVE_ALMACEN = 'optiflow:sidebar';

  /* --------------------------- Menú --------------------------- */
  /**
   * Estructura modular. `href` puede llevar query (?linea=…) para los
   * filtros rápidos de línea y ancla (#id) para saltar a un panel de admin.
   * `acento` pinta la barra lateral según la identidad de la línea.
   */
  const MENU = [
    { seccion: 'Planta / Operativa' },
    {
      clave: 'terminal', href: '/', ico: '⏱', titulo: 'Terminal de Fichado',
      texto: 'Terminal de Fichado', sub: 'Lectura de QR · marcado de etapas',
    },
    {
      clave: 'ots', href: '/admin#panel-ots', ico: '📋', titulo: 'Órdenes de Trabajo',
      texto: 'Órdenes de Trabajo', sub: 'Listado · alta · Hoja de Ruta',
    },

    { seccion: 'Líneas de producción' },
    {
      clave: 'placares', href: '/admin?linea=Placares#panel-ots', ico: '📦',
      texto: 'Placares', sub: 'Filtro rápido de la línea', acento: 'placares',
    },
    {
      clave: 'cocinas', href: '/admin?linea=Cocinas#panel-ots', ico: '🍳',
      texto: 'Cocinas', sub: 'Filtro rápido de la línea', acento: 'cocinas',
    },
    {
      clave: 'compartidos', href: '/admin#panel-compartidos', ico: '🤝',
      texto: 'Sectores Compartidos', sub: 'Lustre · Herrería · Vidrio · Especiales',
      acento: 'compartidos',
    },

    { seccion: 'Administración y métricas' },
    {
      clave: 'operarios', href: '/admin#panel-operarios', ico: '👷',
      texto: 'Operarios', sub: 'Maestro de personal',
    },
    {
      clave: 'materiales', href: '/admin#panel-materiales', ico: '🪵',
      texto: 'Materiales / Placas', sub: 'Melaminas · MDF · Fibroplus',
    },
    {
      clave: 'sectores', href: '/admin#panel-sectores', ico: '🏭',
      texto: 'Sectores y Flujos', sub: 'Etapas por línea de producción',
    },
    {
      clave: 'analitica', href: '/admin#panel-kpis', ico: '📊',
      texto: 'Analítica & Power BI', sub: 'Cuellos de botella · Lead Time · Export',
    },
  ];

  /** Anclas de admin -> clave de ítem activo. */
  const ANCLAS = {
    'panel-ots': 'ots',
    'panel-operarios': 'operarios',
    'panel-sectores': 'sectores',
    'panel-kpis': 'analitica',
    'panel-materiales': 'materiales',
    'panel-compartidos': 'compartidos',
    // Alias heredados (anclas que el menú usaba antes de los paneles dedicados).
    'materiales-bloque': 'materiales',
  };

  /* ------------------------ Utilidades ------------------------ */
  const $ = (id) => document.getElementById(id);

  /** createElement con atributos seguros (sin innerHTML). */
  function el(tag, attrs, ...hijos) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      // 'onclick' -> addEventListener('click'): el nombre del evento NO
      // lleva el prefijo 'on' (si no, el handler queda colgado y nunca se
      // dispara: botón ☰, fondo del drawer y cerrar sesión muertos).
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, '');
      else e.setAttribute(k, String(v));
    }
    for (const h of hijos.flat()) {
      if (h === null || h === undefined || h === false) continue;
      e.append(h.nodeType ? h : document.createTextNode(String(h)));
    }
    return e;
  }

  const esTerminal = () => {
    const p = location.pathname.replace(/\/+$/, '') || '/';
    return p === '/' || p.endsWith('/index.html');
  };
  const esAdmin = () => /admin/i.test(location.pathname);

  /* Media queries de los tres escenarios. */
  const mqMovil = window.matchMedia('(max-width: 767px)');
  const mqRail = window.matchMedia('(min-width: 768px) and (max-width: 1023px)');
  const mqEscritorio = window.matchMedia('(min-width: 1024px)');

  /* ------------------- Ítem activo (highlight) ------------------- */
  /**
   * Regla de resaltado:
   *  1. ?linea=… manda (Placares / Cocinas / compartidos).
   *  2. En la terminal, el ítem Terminal de Fichado.
   *  3. En admin, el panel del #ancla; sin ancla, Órdenes de Trabajo.
   */
  function claveActiva() {
    const linea = new URLSearchParams(location.search).get('linea');
    if (linea && esAdmin()) {
      const k = linea.toLowerCase();
      if (k === 'placares' || k === 'cocinas' || k === 'compartidos') return k;
    }
    if (esTerminal()) return 'terminal';
    if (esAdmin()) {
      const ancla = location.hash.replace(/^#/, '');
      if (ancla && ANCLAS[ancla]) return ANCLAS[ancla];
      return 'ots';
    }
    return null;
  }

  function marcarActivo(clave) {
    const menu = $('sb-menu');
    if (!menu) return;
    const buscado = clave || claveActiva();
    menu.querySelectorAll('.sb-item').forEach((a) => {
      const activo = a.dataset.clave === buscado;
      a.classList.toggle('activo', activo);
      if (activo) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  }

  /* --------------------------- Sesión --------------------------- */
  function etiquetaRol(rol) {
    if (rol === 'admin') return 'Administrador';
    if (rol === 'encargado') return 'Encargado';
    return 'Operario';
  }

  function iniciales(nombre) {
    const partes = String(nombre || '').trim().split(/\s+/).filter(Boolean);
    if (!partes.length) return '—';
    return (partes[0][0] + (partes[1] ? partes[1][0] : '')).toUpperCase();
  }

  /** Pinta el perfil del pie. `usuario` = { nombre, rol } o null. */
  function pintarSesion(usuario) {
    const nombre = $('sb-nombre');
    const rol = $('sb-rol');
    const avatar = $('sb-avatar');
    const salir = $('sb-salir');
    if (!nombre || !rol || !avatar || !salir) return;

    if (!usuario) {
      nombre.textContent = 'Sin sesión';
      rol.textContent = 'Acceso restringido';
      avatar.textContent = '—';
      salir.dataset.modo = 'login';
      const txt = salir.querySelector('.sb-salir-txt');
      if (txt) txt.textContent = 'Iniciar sesión';
      return;
    }

    nombre.textContent = usuario.nombre || usuario.usuario || '—';
    nombre.title = usuario.usuario || '';
    rol.textContent = etiquetaRol(usuario.rol);
    avatar.textContent = iniciales(usuario.nombre || usuario.usuario);
    avatar.title = etiquetaRol(usuario.rol);
    salir.dataset.modo = 'salir';
    const txt = salir.querySelector('.sb-salir-txt');
    if (txt) txt.textContent = 'Cerrar sesión';
  }

  async function accionSesion() {
    // NOTA: API es una `const` de api.js: vive en el ámbito léxico global,
    // NO en window. El chequeo correcto es typeof, no window.API.
    if (typeof API === 'undefined') { location.href = '/login.html'; return; }
    if ($('sb-salir').dataset.modo === 'login') { location.href = '/login.html'; return; }
    try { await API.logout(); } catch { /* aun si falla, salimos de la vista */ }
    // La terminal tiene su propio modal de login: recargarla lo vuelve a mostrar.
    if (esTerminal()) location.reload();
    else location.href = '/login.html';
  }

  /* --------------------- Apertura / cierre --------------------- */
  function fondoVisible(visible) {
    const f = $('sb-fondo');
    if (f) f.hidden = !visible;
  }

  function abrir() {
    document.body.classList.add('sb-abierto');
    fondoVisible(true);
    sincronizarAria();
    const primero = document.querySelector('#sb-menu .sb-item');
    if (primero) primero.focus({ preventScroll: true });
  }

  function cerrar() {
    document.body.classList.remove('sb-abierto');
    fondoVisible(false);
    sincronizarAria();
  }

  function colapsado() { return document.body.classList.contains('sb-colapsado'); }

  function alternar() {
    if (mqEscritorio.matches) {
      const nuevo = !colapsado();
      document.body.classList.toggle('sb-colapsado', nuevo);
      try { localStorage.setItem(CLAVE_ALMACEN, nuevo ? 'colapsada' : 'expandida'); } catch { /* modo privado */ }
    } else {
      // Móvil (drawer) y tablet (rail superpuesto) comparten la clase.
      if (document.body.classList.contains('sb-abierto')) cerrar();
      else abrir();
    }
    sincronizarAria();
  }

  function sincronizarAria() {
    const btn = $('sb-colapsar');
    if (!btn) return;
    const abierto = document.body.classList.contains('sb-abierto');
    const railEnEscritorio = mqEscritorio.matches && !colapsado();
    // En escritorio el botón colapsa/expande; en móvil/tablet abre/cierra.
    const expandidoVisual = mqEscritorio.matches ? railEnEscritorio : abierto;
    btn.setAttribute('aria-expanded', String(expandidoVisual));
    btn.setAttribute('aria-label', expandidoVisual ? 'Contraer menú' : 'Expandir menú');
    btn.title = expandidoVisual ? 'Contraer menú (☰)' : 'Expandir menú (☰)';

    const movil = $('sb-menu-btn');
    if (movil) movil.setAttribute('aria-expanded', String(abierto));
  }

  /* ------------------------- Construcción ------------------------- */
  function construirItem(d) {
    const a = el('a', {
      class: 'sb-item',
      href: d.href,
      'data-clave': d.clave,
      'data-acento': d.acento || null,
      // Tooltip nativo: es lo que se ve en formato rail (sólo iconos).
      title: d.sub ? `${d.texto} — ${d.sub}` : d.texto,
      'aria-label': d.texto,
    },
      el('span', { class: 'sb-ico', 'aria-hidden': 'true', text: d.ico }),
      el('span', { class: 'sb-txt' },
        el('span', { text: d.texto }),
        d.sub ? el('span', { class: 'sb-sub', text: d.sub }) : null)
    );

    a.addEventListener('click', (ev) => {
      const destino = new URL(a.href, location.href);
      const mismaPagina = destino.pathname === location.pathname && destino.search === location.search;
      if (mismaPagina && destino.hash) {
        // Ya estoy en ese panel: scroll suave en lugar de recargar.
        ev.preventDefault();
        const obj = document.querySelector(destino.hash);
        if (obj) obj.scrollIntoView({ behavior: 'smooth', block: 'start' });
        if (history.replaceState) history.replaceState(null, '', destino.hash);
        marcarActivo(destino.hash.replace(/^#/, '') && ANCLAS[destino.hash.replace(/^#/, '')]);
      }
      if (mqMovil.matches || mqRail.matches) cerrar();
    });
    return a;
  }

  function construir() {
    if ($('sidebar')) return; // idempotente: una sola vez por página

    const menu = el('nav', { class: 'sb-menu', id: 'sb-menu', 'aria-label': 'Secciones de Optiflow' });
    for (const d of MENU) {
      if (d.seccion) {
        menu.append(el('p', { class: 'sb-seccion' }, el('span', { text: d.seccion })));
      } else {
        menu.append(construirItem(d));
      }
    }

    const sidebar = el('aside', { class: 'sidebar', id: 'sidebar', 'aria-label': 'Menú lateral de Optiflow' },
      el('div', { class: 'sb-cabecera' },
        el('a', { class: 'sb-marca', href: '/', title: 'Optiflow · Terminal de fichado' },
          el('span', { class: 'sb-escudo', 'aria-hidden': 'true', text: 'OF' }),
          el('span', { class: 'sb-marca-txt' },
            el('b', { text: 'OPTIFLOW' }),
            el('small', { id: 'sb-version', text: VERSION_RESPALDO }))),
        el('button', {
          class: 'sb-btn', id: 'sb-colapsar', type: 'button',
          'aria-label': 'Contraer menú', text: '☰',
          onclick: alternar,
        })),
      menu,
      el('div', { class: 'sb-pie' },
        el('div', { class: 'sb-usuario' },
          el('span', { class: 'sb-avatar', id: 'sb-avatar', 'aria-hidden': 'true', text: '—' }),
          el('span', { class: 'sb-usuario-txt' },
            el('b', { id: 'sb-nombre', text: 'Sin sesión' }),
            el('small', { id: 'sb-rol', text: 'Acceso restringido' }))),
        el('button', {
          class: 'sb-salir', id: 'sb-salir', type: 'button',
          'data-modo': 'login', 'aria-label': 'Cerrar sesión',
          onclick: accionSesion,
        },
          el('span', { 'aria-hidden': 'true', text: '⏻' }),
          el('span', { class: 'sb-salir-txt', text: 'Iniciar sesión' }))));

    const fondo = el('div', { class: 'sb-fondo', id: 'sb-fondo', hidden: true, onclick: cerrar });

    // Va ANTES del contenido para que el orden de lectura sea lógico.
    const cuerpo = document.querySelector('.app-cuerpo');
    if (cuerpo && cuerpo.parentNode) cuerpo.parentNode.insertBefore(sidebar, cuerpo);
    else document.body.append(sidebar);
    document.body.append(fondo);

    // Botón hamburguesa de la barra superior (visible sólo en móviles).
    const topbar = document.querySelector('.topbar');
    if (topbar && !$('sb-menu-btn')) {
      topbar.prepend(el('button', {
        class: 'topbar-menu', id: 'sb-menu-btn', type: 'button',
        'aria-label': 'Abrir menú', 'aria-controls': 'sidebar', 'aria-expanded': 'false',
        text: '☰', onclick: alternar,
      }));
    }
  }

  /* --------------------------- Eventos --------------------------- */
  function ligarEventos() {
    // Escape cierra el drawer/superposición (no el colapso de escritorio).
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && document.body.classList.contains('sb-abierto')) cerrar();
    });

    // Al cruzar de breakpoint se descartan los estados que ya no aplican.
    const alCambiarBreakpoint = () => {
      if (!mqMovil.matches && !mqRail.matches) cerrar();
      sincronizarAria();
      marcarActivo();
    };
    if (mqMovil.addEventListener) {
      mqMovil.addEventListener('change', alCambiarBreakpoint);
      mqRail.addEventListener('change', alCambiarBreakpoint);
      mqEscritorio.addEventListener('change', alCambiarBreakpoint);
    } else if (mqMovil.addListener) { // navegadores antiguos
      mqMovil.addListener(alCambiarBreakpoint);
      mqRail.addListener(alCambiarBreakpoint);
      mqEscritorio.addListener(alCambiarBreakpoint);
    }

    // El resaltado sigue al hash (navegación interna del panel de admin).
    window.addEventListener('hashchange', () => marcarActivo());

    // El filtro de línea del panel de admin también decide el ítem activo.
    // Se difiere al final del ciclo de eventos: admin.js sincroniza la URL en
    // su propio listener (misma cascada de eventos) y el resaltado tiene que
    // leer el estado YA actualizado, no el anterior.
    const filtroLinea = $('filtro-linea');
    if (filtroLinea) {
      filtroLinea.addEventListener('change', () => {
        const v = filtroLinea.value;
        setTimeout(() => marcarActivo(v ? v.toLowerCase() : null), 0);
      });
    }
  }

  /* --------------------------- Arranque --------------------------- */
  /**
   * La versión real viene de package.json vía /api/salud (público, sin
   * sesión). Si la planta está sin red, se conserva VERSION_RESPALDO:
   * el menú sigue siendo usable, sólo muestra "v—" en el cabezal.
   */
  async function cargarVersion() {
    if (typeof API === 'undefined' || typeof API.get !== 'function') return;
    try {
      const d = await API.get('/api/salud');
      const v = d && d.version ? String(d.version) : '';
      if (!v) return;
      const nodo = $('sb-version');
      if (nodo) nodo.textContent = 'v' + v;
      // Se recuerda la última versión vista: tras un reload offline la
      // terminal muestra la última conocida en vez del respaldo.
      try { localStorage.setItem('optiflow:version', v); } catch { /* modo privado */ }
    } catch {
      try {
        const previa = localStorage.getItem('optiflow:version');
        const nodo = $('sb-version');
        if (previa && nodo) nodo.textContent = 'v' + previa;
      } catch { /* modo privado: se queda el respaldo */ }
    }
  }

  function iniciar() {
    if (!document.body) return;

    // Preferencia de colapso guardada (sólo aplica en escritorio).
    try {
      if (localStorage.getItem(CLAVE_ALMACEN) === 'colapsada' && mqEscritorio.matches) {
        document.body.classList.add('sb-colapsado');
      }
    } catch { /* modo privado: se arranca desplegado */ }

    construir();
    ligarEventos();
    marcarActivo();
    sincronizarAria();
    cargarVersion(); // async: no bloquea el menú

    // API es opcional: si la página no la incluye, el pie queda en "Sin sesión".
    window.Sidebar = {
      pintarSesion,
      abrir,
      cerrar,
      alternar,
      refrescarActivo: () => marcarActivo(),
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciar);
  } else {
    iniciar();
  }
})();
