'use strict';

/**
 * ============================================================
 *  OPTIFLOW - Soporte: botón [Reportar Bug] → WhatsApp
 * ============================================================
 *
 * CERO dependencias npm: Vanilla JS + CSS nativo del proyecto. No carga
 * librerías, CDN ni fuentes externas.
 *
 * QUÉ HACE
 *  1. Inyecta un botón discreto en la barra superior (visible en la Terminal
 *     y en Administración; el sidebar queda sólo-icono en móvil, por eso el
 *     botón vive en la topbar, que sí está siempre).
 *  2. Al pulsarlo abre un modal con usuario y vista ya cargados.
 *  3. `enviarReporteBug()` arma el mensaje y abre
 *     `https://wa.me/<NUMERO_SOPORTE_ANALISTA>?text=<codificado>`
 *     en una pestaña nueva (o en la app de WhatsApp en el celular).
 *
 * NÚMERO DE SOPORTE
 *  · Prioridad 1: variable de entorno `NUMERO_SOPORTE_ANALISTA` del servidor,
 *    que la API pública `/api/meta` expone como `numero_soporte_analista`.
 *  · Prioridad 2: la constante de abajo, para funcionar sin tocar el server.
 *  Se lee al iniciar y se cachea: así el clic del usuario es SIEMPRE
 *  síncrono (si esperáramos un `fetch` en el submit, los navegadores
 *  bloquearían la ventana nueva por perder el gesto del usuario).
 *
 * El modal se construye en tiempo de ejecución en vez de duplicar el markup
 * en index.html y admin.html: así no puede desincronizarse entre páginas.
 */

/* --- Fallback local: si no hay env var en el server, use éste. --------- */
/* Ej.: '54911123456789'  (país 54 + celular 9 + 11 + número, sin +).     */
const NUMERO_SOPORTE_ANALISTA = '';

const Sop = {
  numero: null,          // número de soporte ya resuelto
  usuario: null,         // sesión actual cacheada
  botonListo: false,
};

const SopIDs = Object.freeze({
  BOTON: 'btn-reporte-bug',
  MODAL: 'modal-reporte-bug',
});

/* ------------------------------------------------------------------ */
/* Resolución de configuración                                         */
/* ------------------------------------------------------------------ */

/**
 * Toma el número del server (env var) y, si no hay, de la constante.
 * Se llama al iniciar y de nuevo al abrir el modal (sin bloquear el clic).
 */
async function refrescarNumeroSoporte() {
  if (!Sop.numero) {
    try {
      const meta = await API.get('/api/meta');
      if (meta && meta.numero_soporte_analista) Sop.numero = meta.numero_soporte_analista;
    } catch { /* se mantiene lo que haya */ }
  }
  if (!Sop.numero && NUMERO_SOPORTE_ANALISTA) Sop.numero = String(NUMERO_SOPORTE_ANALISTA);
  // Limpieza mínima por si alguien pegó el número con '+' o espacios.
  if (Sop.numero) Sop.numero = Sop.numero.replace(/[\s()+]/g, '').replace(/^00/, '');
  return Sop.numero;
}

/** ¿Ya sabemos a dónde mandar el reporte? */
function soporteConfigurado() { return !!Sop.numero; }

/* ------------------------------------------------------------------ */
/* Contexto: quién reporta y desde dónde                               */
/* ------------------------------------------------------------------ */

/** Usuario de la sesión: usa la caché de la página o consulta la API. */
async function usuarioReporte() {
  // `S` es la caché de sesión que comparten admin.js/terminal.js. Se consulta
  // como identificador y con try/catch: si esa página no lo define, seguimos.
  try {
    if (typeof S !== 'undefined' && S && S.usuario && S.usuario.nombre) {
      Sop.usuario = S.usuario;
    }
  } catch { /* página sin caché de sesión */ }

  if (!Sop.usuario) {
    try {
      const r = await API.get('/api/auth/usuario');
      if (r && r.usuario) Sop.usuario = r.usuario;
    } catch { /* sin sesión: se reporta como invitado */ }
  }
  return Sop.usuario || { nombre: 'No identificado', usuario: '—', rol: '—' };
}

/** Título del panel/section visible (la Terminal y Admin usan distinto DOM). */
function seccionVisible() {
  const panel = document.querySelector('.app-cuerpo .panel:not([hidden])')
    || document.querySelector('.app-cuerpo section:not([hidden])');
  if (!panel) return null;
  const t = panel.querySelector('.etiqueta-titulo') || panel.querySelector('.panel-titulo')
    || panel.querySelector('h2');
  const txt = t ? t.textContent.replace(/\s+/g, ' ').trim() : '';
  return txt || panel.id || null;
}

/**
 * Vista donde ocurre el problema: parte de `window.location.pathname` (como
 * pide la especificación) y le agrega la sección visible para que al analista
 * le llegue "Administración — Mantenimiento TPM" en vez de sólo "/admin".
 */
function detectarVista() {
  const ruta = window.location.pathname || '/';
  const nombres = [
    [/^\/admin/i, 'Administración'],
    [/^\/login/i, 'Login'],
    [/^\/(index\.html)?$/i, 'Terminal de fichado'],
  ];
  const hallado = nombres.find(([re]) => re.test(ruta));
  const base = hallado ? hallado[1] : ruta;
  const seccion = seccionVisible();
  const pantalla = seccion ? `${base} — ${seccion}` : `${base} (${ruta})`;
  return { pantalla, ruta, seccion };
}

/* ------------------------------------------------------------------ */
/* Mensaje y envío                                                      */
/* ------------------------------------------------------------------ */

/**
 * Arma el cuerpo del reporte. Texto plano con emojis y negrita `*asterisco*`
 * (se ve igual en WhatsApp, Telegram y cualquier gateway).
 */
function construirMensajeReporte({ usuario, pantalla, descripcion }) {
  return [
    '*OPTIFLOW | REPORTE DE BUG*',
    `*Usuario:* ${usuario}`,
    `*Vista:* ${pantalla}`,
    `*Detalle:* ${descripcion}`,
  ].join('\n');
}

/** Codificación segura para la querystring de wa.me (conserva los emojis). */
function codificarMensaje(texto) {
  return encodeURIComponent(texto);
}

/**
 * Enlace wa.me armado a mano (sin depender de constructor de URL: el mensaje
 * trae saltos de línea y asteriscos que hay que codificar tal cual).
 */
function enlaceWhatsApp(numero, mensaje) {
  return `https://wa.me/${numero}?text=${codificarMensaje(mensaje)}`;
}

/**
 * Punto de entrada: valida, arma el mensaje y abre WhatsApp en pestaña nueva.
 * Devuelve la URL (útil para pruebas) o null si faltan datos.
 */
async function enviarReporteBug() {
  const numero = await refrescarNumeroSoporte();
  if (!numero) {
    Avisos.aviso(
      'Falta configurar el número de soporte.',
      'Defina NUMERO_SOPORTE_ANALISTA en .env (o en la constante de soporte.js) con formato 5491123456789.'
    );
    return null;
  }

  const campo = document.getElementById('bug-detalle');
  const descripcion = campo ? campo.value.trim() : '';
  if (!descripcion) {
    Avisos.aviso('Describa el problema antes de enviarlo.', 'Con una o dos líneas alcanza.');
    if (campo) campo.focus();
    return null;
  }

  const u = await usuarioReporte();
  const usuarioTxt = u.usuario && u.usuario !== '—'
    ? `${u.nombre} (${u.usuario}${u.rol ? ` · ${u.rol}` : ''})`
    : (u.nombre || 'No identificado');
  const { pantalla } = detectarVista();

  const mensaje = construirMensajeReporte({
    usuario: usuarioTxt,
    pantalla,
    descripcion,
  });

  const url = enlaceWhatsApp(numero, mensaje);

  // `rel=noopener` + target _blank: la pestaña no puede tocar la de Optiflow.
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 0);

  Avisos.ok('Reporte preparado', 'Se abrió WhatsApp; allí confirme el envío al analista.');
  if (campo) campo.value = '';
  Modal.cerrar(SopIDs.MODAL);
  return url;
}

/* ------------------------------------------------------------------ */
/* Inyección de la interfaz                                             */
/* ------------------------------------------------------------------ */

/** Garantiza el contenedor de avisos si la página aún no lo creó. */
function asegurarAvisos() {
  if (!document.getElementById('avisos')) {
    const d = document.createElement('div');
    d.id = 'avisos';
    document.body.appendChild(d);
  }
}

/** Botón discreto en la topbar (no aparece dos veces aunque se reinicie). */
function montarBoton() {
  if (Sop.botonListo || document.getElementById(SopIDs.BOTON)) return;
  const topbar = document.querySelector('.topbar .topbar-dcha') || document.querySelector('.topbar');
  if (!topbar) return; // página sin topbar (login): no molesta

  const btn = document.createElement('button');
  btn.id = SopIDs.BOTON;
  btn.type = 'button';
  btn.className = 'btn-bug';
  btn.title = 'Reportar Bug / Error al Analista de Soporte';
  btn.setAttribute('aria-label', 'Reportar bug o error al soporte');
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.innerHTML =
    '<span class="btn-bug-ico" aria-hidden="true">'
    + '<svg class="ico-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M8 3v2M16 3v2"/><path d="M9 9h6a4 4 0 0 1 4 4v1a7 7 0 0 1-14 0v-1a4 4 0 0 1 4-4Z"/><path d="M12 9v9M8 13H3M21 13h-5M6 19l-2 2M18 19l2 2M7 5 5 3M17 5l2-2"/></svg>'
    + '</span><span class="btn-bug-txt">Reportar Bug</span>';
  btn.addEventListener('click', abrirSoporte);

  // Antes de la navegación: el botón queda junto al reloj, fuera del menú.
  const nav = topbar.querySelector('nav.nav');
  if (nav) topbar.insertBefore(btn, nav);
  else topbar.appendChild(btn);

  Sop.botonListo = true;
}

/** Modal (una sola vez; se construye en JS para no duplicarlo en los HTML). */
function montarModal() {
  if (document.getElementById(SopIDs.MODAL)) return;

  const fondo = document.createElement('div');
  fondo.className = 'modal-fondo';
  fondo.id = SopIDs.MODAL;
  fondo.innerHTML = `
    <div class="modal" style="width:min(560px,100%);" role="dialog"
         aria-modal="true" aria-labelledby="bug-titulo">
      <div class="modal-cabecera">
        <h3 id="bug-titulo"><svg class="ico-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M8 3v2M16 3v2"/><path d="M9 9h6a4 4 0 0 1 4 4v1a7 7 0 0 1-14 0v-1a4 4 0 0 1 4-4Z"/><path d="M12 9v9M8 13H3M21 13h-5M6 19l-2 2M18 19l2 2M7 5 5 3M17 5l2-2"/></svg>Reportar Bug / Error</h3>
        <button class="modal-cerrar" data-cerrar="${SopIDs.MODAL}" aria-label="Cerrar"><svg class="ico-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
      </div>
      <form id="form-reporte-bug" novalidate>
        <div class="modal-cuerpo">
          <label class="campo">
            <span>Usuario</span>
            <input type="text" id="bug-usuario" maxlength="120" readonly
                   autocomplete="off" aria-readonly="true">
          </label>

          <label class="campo">
            <span>Vista / Sección</span>
            <input type="text" id="bug-vista" maxlength="200" readonly
                   autocomplete="off" aria-readonly="true">
          </label>

          <label class="campo">
            <span>Descripción del problema *</span>
            <textarea id="bug-detalle" maxlength="1500" rows="5" required
                      placeholder="Qué hacía, qué esperaba, qué salió mal. Puede indicar hora y sector."
                      aria-describedby="bug-ayuda"></textarea>
          </label>

          <p class="texto-suave" id="bug-ayuda" style="margin:4px 0 0;">
            El reporte se abre en <b>WhatsApp</b> hacia el Analista de Datos/Soporte
            con el usuario y la vista ya cargados. Sólo falta confirmar el envío.
          </p>
          <p class="texto-suave bug-destino" id="bug-destino" style="margin:6px 0 0;" hidden></p>
        </div>
        <div class="modal-pie">
          <button type="button" class="btn" data-cerrar="${SopIDs.MODAL}"><svg class="ico-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M18 6 6 18M6 6l12 12"/></svg>Cancelar</button>
          <button type="submit" class="btn btn-primario" id="bug-enviar"><svg class="ico-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>Enviar a Soporte por WhatsApp</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(fondo);

  // Cerrar por / Cancelar (mismo contrato data-cerrar del resto de la app).
  fondo.addEventListener('click', (e) => {
    const cerrar = e.target && e.target.closest ? e.target.closest('[data-cerrar]') : null;
    if (cerrar) Modal.cerrar(cerrar.getAttribute('data-cerrar'));
    else if (e.target === fondo) Modal.cerrar(SopIDs.MODAL);
  });

  const form = document.getElementById('form-reporte-bug');
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      enviarReporteBug().catch((err) => {
        console.error('Reporte de bug', err);
        Avisos.error('No se pudo preparar el reporte.', 'Intente de nuevo.');
      });
    });
  }
}

/** Abre el modal precargando usuario, vista y estado del número de soporte. */
async function abrirSoporte() {
  asegurarAvisos();
  montarModal();

  const u = await usuarioReporte();
  const elUsu = document.getElementById('bug-usuario');
  const elVis = document.getElementById('bug-vista');
  const elDet = document.getElementById('bug-detalle');
  const elDest = document.getElementById('bug-destino');
  const elBtn = document.getElementById('bug-enviar');

  if (elUsu) {
    elUsu.value = u.usuario && u.usuario !== '—'
      ? `${u.nombre} (${u.usuario})` : (u.nombre || 'No identificado');
  }
  if (elVis) {
    const v = detectarVista();
    elVis.value = v.pantalla;
    elVis.title = v.ruta;
  }

  // Refresco en segundo plano: NO se espera en el submit para que la ventana
  // de WhatsApp abra con el gesto del clic todavía vigente.
  const numero = await refrescarNumeroSoporte().catch(() => null);

  if (elDest) {
    elDest.hidden = false;
    elDest.textContent = numero
      ? `Destino: +${numero}`
      : 'Sin número de soporte configurado: defina NUMERO_SOPORTE_ANALISTA.';
  }
  if (elBtn) elBtn.disabled = !numero;
  if (elDet) elDet.focus();

  Modal.abrir(SopIDs.MODAL);
}

/* ------------------------------------------------------------------ */
/* Arranque                                                             */
/* ------------------------------------------------------------------ */

(function arrancarSoporte() {
  const listo = () => {
    asegurarAvisos();
    montarBoton();
    montarModal();
    // Disparado sin esperar: el botón ya puede mostrarse aunque falle la red.
    refrescarNumeroSoporte().catch(() => {});
    usuarioReporte().catch(() => {});
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', listo, { once: true });
  } else {
    listo();
  }
})();
