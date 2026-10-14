'use strict';

/** Utilidades HTTP compartidas (sin dependencias externas). */

const MAX_BODY = 1 * 1024 * 1024; // 1 MB

class ApiError extends Error {
  constructor(status, mensaje, detalle) {
    super(mensaje);
    this.status = status;
    this.detalle = detalle || null;
  }
}

/**
 * Cabeceras de respuesta comunes. Los headers CORS YA NO se emiten en '*':
 * los calcula server.js (cabecerasCORS) según el Origin del request y la
 * allowlist de OPTIFLOW_CORS_ORIGINS, y se pasan en `extraHeaders`.
 */
function sendJson(res, status, data, extraHeaders) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(extraHeaders || {}),
  });
  res.end(payload);
}

function sendText(res, status, texto, contentType, extraHeaders) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(texto),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(extraHeaders || {}),
  });
  res.end(texto);
}

/**
 * Lee el cuerpo JSON de una petición de forma ROBUSTA (auditoría A-1/A-2):
 *
 *  - `size > MAX_BODY`     -> 413 y se corta la conexión (sin acumular más).
 *  - Cliente que corta a mitad del cuerpo ('aborted' / 'close' sin 'end')
 *    -> rechaza con 499 en lugar de dejar la promesa colgada (que en
 *       serverless consumiría el invocador hasta el timeout).
 *  - Cuerpo que nunca termina -> timeout (15 s por defecto) -> 408.
 *  - Un solo settle: los listeners se desligan al resolver/rechazar para no
 *    acumular handlers ni disparar dos rechazos.
 */
function readBody(req, { max = MAX_BODY, timeoutMs = Number(process.env.READ_BODY_TIMEOUT_MS) || 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let listo = false;
    const chunks = [];

    const temporizador = timeoutMs > 0
      ? setTimeout(() => fallar(new ApiError(408, 'El cuerpo de la solicitud nunca llegó a completarse.')), timeoutMs)
      : null;

    function limpiar() {
      if (temporizador) clearTimeout(temporizador);
      req.removeListener('data', alData);
      req.removeListener('end', alEnd);
      req.removeListener('error', alError);
      req.removeListener('aborted', alAbortado);
      req.removeListener('close', alCerrado);
    }
    function resolver(valor) {
      if (listo) return;
      listo = true;
      limpiar();
      resolve(valor);
    }
    function fallar(err) {
      if (listo) return;
      listo = true;
      limpiar();
      // Destruir el socket evita que el cliente siga enviando bytes inútiles
      // y libere el file descriptor cuanto antes.
      try { req.destroy(); } catch { /* noop */ }
      reject(err);
    }

    function alData(c) {
      size += c.length;
      if (size > max) {
        fallar(new ApiError(413, 'Cuerpo de la solicitud demasiado grande'));
        return;
      }
      chunks.push(c);
    }
    function alEnd() {
      if (!chunks.length) return resolver({});
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolver({});
      try {
        resolver(JSON.parse(raw));
      } catch {
        fallar(new ApiError(400, 'JSON inválido en el cuerpo de la solicitud'));
      }
    }
    function alError() { fallar(new ApiError(400, 'Error al leer el cuerpo de la solicitud.')); }
    function alAbortado() { fallar(new ApiError(499, 'El cliente cerró la conexión antes de enviar el cuerpo.')); }
    function alCerrado() {
      // 'close' sin 'end' => el socket murió a mitad del cuerpo.
      if (!listo) fallar(new ApiError(499, 'El cliente cerró la conexión a mitad del cuerpo.'));
    }

    req.on('data', alData);
    req.on('end', alEnd);
    req.on('error', alError);
    req.on('aborted', alAbortado);
    req.on('close', alCerrado);
  });
}

/** Objeto plano con los query params. */
function queryToObject(url) {
  const obj = {};
  for (const [k, v] of url.searchParams.entries()) obj[k] = v;
  return obj;
}

/* ------------------------- Validaciones --------------------------- */

function textoRequerido(valor, campo, { max = 120, min = 1 } = {}) {
  const v = (valor === undefined || valor === null ? '' : String(valor)).trim();
  if (v.length < min) throw new ApiError(400, `El campo "${campo}" es obligatorio.`);
  if (v.length > max) throw new ApiError(400, `El campo "${campo}" supera los ${max} caracteres.`);
  return v;
}

function textoOpcional(valor, campo, { max = 500 } = {}) {
  if (valor === undefined || valor === null) return null;
  const v = String(valor).trim();
  if (!v) return null;
  if (v.length > max) throw new ApiError(400, `El campo "${campo}" supera los ${max} caracteres.`);
  return v;
}

/** Acepta "12,5" y "12.5". */
function decimal(valor, campo, { min = 0, max = 1000000, requerido = false, porDefecto = 0 } = {}) {
  if (valor === undefined || valor === null || valor === '') {
    if (requerido) throw new ApiError(400, `El campo "${campo}" es obligatorio.`);
    return porDefecto;
  }
  const n = Number(String(valor).replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(n)) throw new ApiError(400, `El campo "${campo}" debe ser numérico.`);
  if (n < min || n > max) throw new ApiError(400, `El campo "${campo}" está fuera del rango permitido.`);
  return n;
}

function entero(valor, campo, { requerido = true } = {}) {
  if (valor === undefined || valor === null || valor === '') {
    if (requerido) throw new ApiError(400, `El campo "${campo}" es obligatorio.`);
    return null;
  }
  const n = Number(valor);
  if (!Number.isInteger(n) || n <= 0) throw new ApiError(400, `El campo "${campo}" debe ser un identificador válido.`);
  return n;
}

function fecha(valor, campo) {
  if (valor === undefined || valor === null || valor === '') return null;
  const v = String(valor).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(new Date(v + 'T00:00:00').getTime())) {
    throw new ApiError(400, `El campo "${campo}" debe tener formato YYYY-MM-DD.`);
  }
  return v;
}

function booleano(valor, porDefecto = false) {
  if (valor === undefined || valor === null || valor === '') return porDefecto;
  if (typeof valor === 'boolean') return valor;
  if (typeof valor === 'number') return valor !== 0;
  const v = String(valor).toLowerCase();
  return v === 'true' || v === '1' || v === 'sí' || v === 'si';
}

function enumOpcion(valor, opciones, campo) {
  const v = (valor === undefined || valor === null ? '' : String(valor)).trim();
  if (!v) throw new ApiError(400, `El campo "${campo}" es obligatorio.`);
  if (!opciones.includes(v)) {
    throw new ApiError(400, `Valor no permitido para "${campo}". Opciones válidas: ${opciones.join(', ')}.`);
  }
  return v;
}

/** Escapa celdas para CSV (comillas dobles, coma y saltos de línea). */
function celdaCSV(valor) {
  if (valor === null || valor === undefined) return '';
  const s = String(valor);
  return /[",;\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

module.exports = {
  ApiError,
  sendJson,
  sendText,
  readBody,
  queryToObject,
  textoRequerido,
  textoOpcional,
  decimal,
  entero,
  fecha,
  booleano,
  enumOpcion,
  celdaCSV,
};
