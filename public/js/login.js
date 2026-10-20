'use strict';

/* ============================================================
   OPTIFLOW - Página de inicio de sesión (auditoría V-1)
   Se usa para /admin (redirect desde el servidor) y como
   destino de ?siguiente= para volver al lugar original.
   ============================================================ */

const $ = (id) => document.getElementById(id);

/** Destino post-login: ?siguiente=/admin (sólo rutas internas, sin open-redirect). */
function destinoPostLogin() {
  const param = new URLSearchParams(location.search).get('siguiente') || '/admin';
  // Sólo se aceptan rutas relativas del propio sitio (nunca //host ni http://…).
  return param.startsWith('/') && !param.startsWith('//') ? param : '/admin';
}

document.addEventListener('DOMContentLoaded', async () => {
  // Si ya hay sesión vigente, no hace falta loguearse de nuevo.
  try {
    const s = await API.sesion();
    if (s && s.usuario) { location.href = destinoPostLogin(); return; }
  } catch { /* sin backend: se muestra el formulario */ }

  const form = $('form-login');
  const btn = $('btn-entrar');
  const err = $('login-error');

  $('login-usuario').focus();
  configurarOjoPassword($('login-password'), $('btn-ojo-password'));

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    mostrarErrorLogin(err, null);
    $('login-usuario').removeAttribute('aria-invalid');
    $('login-password').removeAttribute('aria-invalid');
    btn.disabled = true;
    btn.textContent = 'Verificando…';
    marcarCargando(btn, true);
    try {
      const r = await API.login($('login-usuario').value.trim(), $('login-password').value);
      Avisos.ok(`Bienvenido/a, ${r.usuario.nombre}`);
      setTimeout(() => { location.href = destinoPostLogin(); }, 350);
    } catch (e) {
      mostrarErrorLogin(err, e);
      if (e.status === 409) {
        // Las credenciales son válidas: la cuenta sólo está abierta en otro
        // dispositivo. No se marca la contraseña como incorrecta.
        $('login-password').removeAttribute('aria-invalid');
      } else {
        $('login-password').value = '';
        $('login-password').setAttribute('aria-invalid', 'true');
        $('login-password').focus();
      }
      btn.disabled = false;
      btn.textContent = 'Entrar';
      marcarCargando(btn, false);
    }
  });
});
