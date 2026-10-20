'use strict';

/* ============================================================
   OPTIFLOW · Página dedicada de inicio de sesión
   ------------------------------------------------------------
   · Redirección por rol: admin -> /admin, resto -> Terminal /.
   · 409: sesión activa en otro dispositivo (aviso destacado).
   · 401/400: credenciales incorrectas.
   · Foco automático, ojo de contraseña y estado de carga.
   ============================================================ */

const $ = (id) => document.getElementById(id);

/** Destino posterior al login según el rol devuelto por la API. */
function destinoPostLogin(usuario) {
  return usuario && usuario.rol === 'admin' ? '/admin' : '/';
}

/** Reemplaza la entrada actual para que "Atrás" no vuelva al formulario. */
function redirigirSegunRol(usuario) {
  window.location.replace(destinoPostLogin(usuario));
}

document.addEventListener('DOMContentLoaded', async () => {
  const form = $('form-login');
  const usuario = $('login-usuario');
  const password = $('login-password');
  const boton = $('btn-entrar');
  const etiquetaBoton = boton ? boton.querySelector('.btn-label') : null;
  const aviso = $('login-aviso');
  const avisoTitulo = $('aviso-titulo');
  const avisoTexto = $('aviso-texto');

  if (!form || !usuario || !password || !boton || !aviso) return;

  let ocupado = false;

  function mostrarAviso(tipo, titulo, texto) {
    aviso.dataset.tipo = tipo;
    avisoTitulo.textContent = titulo;
    avisoTexto.textContent = texto;
    aviso.hidden = false;
  }

  function ocultarAviso() {
    aviso.hidden = true;
    delete aviso.dataset.tipo;
    avisoTitulo.textContent = '';
    avisoTexto.textContent = '';
  }

  function limpiarErrorDeCampo(campo) {
    campo.removeAttribute('aria-invalid');
    // Un conflicto de sesión (409) no es un error de tipeo: se conserva
    // visible hasta el próximo intento para que el aviso no se pierda.
    if (aviso.dataset.tipo === 'danger') ocultarAviso();
  }

  function cambiarEstadoCarga(activo, texto) {
    ocupado = activo;
    boton.disabled = activo;
    boton.classList.toggle('cargando', activo);
    if (activo) {
      boton.setAttribute('aria-busy', 'true');
      form.setAttribute('aria-busy', 'true');
    } else {
      boton.removeAttribute('aria-busy');
      form.removeAttribute('aria-busy');
    }
    if (etiquetaBoton) etiquetaBoton.textContent = texto || (activo ? 'Verificando…' : 'Ingresar');
  }

  usuario.addEventListener('input', () => limpiarErrorDeCampo(usuario));
  password.addEventListener('input', () => limpiarErrorDeCampo(password));

  // Si ya hay una sesión válida, se evita mostrar el formulario.
  try {
    const sesion = await API.sesion();
    if (sesion && sesion.usuario) {
      redirigirSegunRol(sesion.usuario);
      return;
    }
  } catch {
    // Sin backend o sin red: se muestra el formulario y el error se informa
    // recién al intentar ingresar.
  }

  usuario.focus({ preventScroll: true });
  configurarOjoPassword(password, $('btn-ojo-password'));

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (ocupado) return;

    ocultarAviso();
    usuario.removeAttribute('aria-invalid');
    password.removeAttribute('aria-invalid');

    const nombreUsuario = usuario.value.trim();
    const clave = password.value;

    if (!nombreUsuario || !clave) {
      mostrarAviso('danger', 'Faltan datos', 'Ingresá tu usuario y contraseña para continuar.');
      const campo = !nombreUsuario ? usuario : password;
      campo.setAttribute('aria-invalid', 'true');
      campo.focus({ preventScroll: true });
      return;
    }

    cambiarEstadoCarga(true);

    try {
      const respuesta = await API.login(nombreUsuario, clave);

      if (!respuesta || !respuesta.usuario) {
        throw new Error('El servidor no devolvió los datos del usuario.');
      }

      // Acceso concedido: se confirma visualmente antes de navegar. Se deja
      // `ocupado` en true para bloquear cualquier reenvío durante el redirect.
      boton.classList.remove('cargando');
      boton.removeAttribute('aria-busy');
      boton.disabled = true;
      form.removeAttribute('aria-busy');
      if (etiquetaBoton) etiquetaBoton.textContent = 'Acceso concedido';
      setTimeout(() => redirigirSegunRol(respuesta.usuario), 220);
    } catch (error) {
      const status = Number(error && error.status);

      if (status === 409) {
        mostrarAviso(
          'sesion-activa',
          'Sesión activa en otro dispositivo',
          (error && error.message) || 'El usuario ya tiene una sesión activa en otro dispositivo.'
        );
        password.removeAttribute('aria-invalid');
      } else if (status === 401 || status === 400) {
        mostrarAviso('danger', 'Credenciales incorrectas', 'Usuario o contraseña incorrectos.');
        password.value = '';
        password.setAttribute('aria-invalid', 'true');
        password.focus({ preventScroll: true });
      } else {
        mostrarAviso(
          'danger',
          'No se pudo iniciar sesión',
          (error && error.message) || 'No se pudo conectar con el servidor. Intentá nuevamente.'
        );
      }

      cambiarEstadoCarga(false);
    }
  });
});
