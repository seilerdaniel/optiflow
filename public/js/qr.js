'use strict';
/**
 * ============================================================
 *  OPTIFLOW · Generador de códigos QR 100% nativo
 * ============================================================
 *  Sin dependencias, sin CDN y sin servicios externos.
 *
 *  Implementa el estándar ISO/IEC 18004 en modo BYTE (UTF-8):
 *    · versiones 1 a 10
 *    · corrección de errores nivel M (15 %)
 *    · 8 máscaras con selección por penalización
 *    · render SVG (nítido en pantalla y en impresión)
 *
 *  API pública (window.QR):
 *    QR.matriz(texto, opciones) -> { size, modules, version, mask }
 *    QR.svg(texto, opciones)    -> string SVG
 *    QR.pintar(destino, texto, opciones) -> elemento SVG
 *    QR.payloadOT(ot)           -> URL de la Terminal con la OT precargada
 *
 *  Uso:
 *    QR.pintar('detalle-qr', QR.payloadOT(ot), { px: 112, quiet: 3 });
 *
 *  Si el contenido supera la capacidad de la versión 10-M (216 bytes),
 *  lanza un Error legible; la UI lo captura y oculta el QR.
 */
(function (global, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else global.QR = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  /* ------------------------------------------------------------------ */
  /* Tablas del estándar (nivel M)                                       */
  /* ------------------------------------------------------------------ */
  // total: codewords totales · ec: codewords de corrección por bloque
  // grupos: [cantidad de bloques, codewords de datos por bloque]
  const ECC_M = {
    1:  { total: 26,  ec: 10, grupos: [[1, 16]] },
    2:  { total: 44,  ec: 16, grupos: [[1, 28]] },
    3:  { total: 70,  ec: 26, grupos: [[1, 44]] },
    4:  { total: 100, ec: 18, grupos: [[2, 32]] },
    5:  { total: 134, ec: 24, grupos: [[2, 43]] },
    6:  { total: 172, ec: 16, grupos: [[4, 27]] },
    7:  { total: 196, ec: 18, grupos: [[4, 31]] },
    8:  { total: 242, ec: 22, grupos: [[2, 38], [2, 39]] },
    9:  { total: 292, ec: 22, grupos: [[3, 36], [2, 37]] },
    10: { total: 346, ec: 26, grupos: [[4, 43], [1, 44]] },
  };

  // Centros de los patrones de alineación por versión.
  const ALINEACION = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  };

  const NIVEL_M = 0; // bits del nivel M en la información de formato

  /* ------------------------------------------------------------------ */
  /* Utilidades                                                          */
  /* ------------------------------------------------------------------ */
  function utf8(texto) {
    if (typeof TextEncoder !== 'undefined') {
      return Array.from(new TextEncoder().encode(String(texto)));
    }
    // Fallback para entornos sin TextEncoder.
    const s = unescape(encodeURIComponent(String(texto)));
    const out = [];
    for (let i = 0; i < s.length; i += 1) out.push(s.charCodeAt(i));
    return out;
  }

  function capacidadDatos(version) {
    return ECC_M[version].grupos.reduce((a, g) => a + g[0] * g[1], 0);
  }

  function elegirVersion(nBytes) {
    for (let v = 1; v <= 10; v += 1) {
      const bitsContador = v <= 9 ? 8 : 16;
      if (4 + bitsContador + nBytes * 8 <= capacidadDatos(v) * 8) return v;
    }
    throw new Error(`QR: el contenido (${nBytes} bytes) supera la capacidad de la versión 10-M.`);
  }

  /* ------------------------------------------------------------------ */
  /* Flujo de datos (modo byte)                                          */
  /* ------------------------------------------------------------------ */
  function flujoDatos(bytes, version) {
    const maxBits = capacidadDatos(version) * 8;
    const bits = [];
    const push = (val, n) => {
      for (let i = n - 1; i >= 0; i -= 1) bits.push((val >>> i) & 1);
    };

    push(0b0100, 4);                                  // indicador de modo byte
    push(bytes.length, version <= 9 ? 8 : 16);        // longitud
    for (const b of bytes) push(b, 8);                // contenido

    for (let i = 0; i < 4 && bits.length < maxBits; i += 1) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);

    const relleno = [0xEC, 0x11];
    let k = 0;
    while (bits.length < maxBits) {
      push(relleno[k % 2], 8);
      k += 1;
    }

    const out = [];
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j += 1) b = (b << 1) | bits[i + j];
      out.push(b);
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Reed-Solomon sobre GF(256), polinomio 0x11D                        */
  /* ------------------------------------------------------------------ */
  function gfMul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i -= 1) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xFF;
  }

  function rsDivisor(grado) {
    const result = new Array(grado).fill(0);
    result[grado - 1] = 1;
    let root = 1;
    for (let i = 0; i < grado; i += 1) {
      for (let j = 0; j < result.length; j += 1) {
        result[j] = gfMul(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = gfMul(root, 0x02);
    }
    return result;
  }

  function rsResto(datos, divisor) {
    const result = new Array(divisor.length).fill(0);
    for (const byte of datos) {
      const factor = byte ^ result.shift();
      result.push(0);
      for (let i = 0; i < result.length; i += 1) {
        result[i] ^= gfMul(divisor[i], factor);
      }
    }
    return result;
  }

  /** Reparte los datos en bloques, calcula ECC y entrelaza todo. */
  function entrelazar(datos, version) {
    const info = ECC_M[version];
    const bloques = [];
    let off = 0;
    for (const [cantidad, largoDatos] of info.grupos) {
      for (let i = 0; i < cantidad; i += 1) {
        const bloque = datos.slice(off, off + largoDatos);
        off += largoDatos;
        bloques.push({ datos: bloque, ecc: rsResto(bloque, rsDivisor(info.ec)) });
      }
    }

    const out = [];
    const maxDatos = Math.max(...bloques.map((b) => b.datos.length));
    for (let i = 0; i < maxDatos; i += 1) {
      for (const b of bloques) if (i < b.datos.length) out.push(b.datos[i]);
    }
    for (let i = 0; i < info.ec; i += 1) {
      for (const b of bloques) out.push(b.ecc[i]);
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Información de formato y versión                                    */
  /* ------------------------------------------------------------------ */
  function bitsFormato(mask) {
    const data = (NIVEL_M << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  }

  function escribirFormato(m, size, mask) {
    const bits = bitsFormato(mask);
    const set = (y, x, v) => { m[y][x] = v; };

    for (let i = 0; i <= 5; i += 1) set(i, 8, (bits >>> i) & 1);
    set(7, 8, (bits >>> 6) & 1);
    set(8, 8, (bits >>> 7) & 1);
    set(8, 7, (bits >>> 8) & 1);
    for (let i = 9; i < 15; i += 1) set(8, 14 - i, (bits >>> i) & 1);

    for (let i = 0; i < 8; i += 1) set(8, size - 1 - i, (bits >>> i) & 1);
    for (let i = 8; i < 15; i += 1) set(size - 15 + i, 8, (bits >>> i) & 1);
    set(size - 8, 8, 1); // módulo oscuro obligatorio
  }

  /* ------------------------------------------------------------------ */
  /* Matriz base: patrones fijos y zonas reservadas                      */
  /* ------------------------------------------------------------------ */
  function matrizBase(version) {
    const size = version * 4 + 17;
    const m = Array.from({ length: size }, () => new Array(size).fill(0));
    const fn = Array.from({ length: size }, () => new Array(size).fill(false));
    const marca = (y, x, v) => { m[y][x] = v; fn[y][x] = true; };

    // Buscadores + separadores (las tres esquinas).
    for (const [ry, rx] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
      for (let dy = -1; dy <= 7; dy += 1) {
        for (let dx = -1; dx <= 7; dx += 1) {
          const y = ry + dy;
          const x = rx + dx;
          if (y < 0 || y >= size || x < 0 || x >= size) continue;
          const dentro = dy >= 0 && dy <= 6 && dx >= 0 && dx <= 6;
          const borde = dy === 0 || dy === 6 || dx === 0 || dx === 6;
          const centro = dy >= 2 && dy <= 4 && dx >= 2 && dx <= 4;
          marca(y, x, dentro && (borde || centro) ? 1 : 0);
        }
      }
    }

    // Patrones de sincronización (fila y columna 6).
    for (let i = 8; i < size - 8; i += 1) {
      const v = i % 2 === 0 ? 1 : 0;
      marca(6, i, v);
      marca(i, 6, v);
    }

    // Patrones de alineación (se omiten los que pisan un buscador).
    const pos = ALINEACION[version] || [];
    const ultimo = pos[pos.length - 1];
    for (const cy of pos) {
      for (const cx of pos) {
        if ((cy === 6 && cx === 6)
          || (cy === 6 && cx === ultimo)
          || (cy === ultimo && cx === 6)) continue;
        for (let dy = -2; dy <= 2; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) {
            const d = Math.max(Math.abs(dy), Math.abs(dx));
            marca(cy + dy, cx + dx, d === 2 || d === 0 ? 1 : 0);
          }
        }
      }
    }

    // Módulo oscuro.
    marca(size - 8, 8, 1);

    // Reserva de las dos copias de la información de formato.
    const reservar = (y, x) => { fn[y][x] = true; };
    for (let i = 0; i <= 5; i += 1) reservar(i, 8);
    reservar(7, 8); reservar(8, 8); reservar(8, 7);
    for (let i = 9; i < 15; i += 1) reservar(8, 14 - i);
    for (let i = 0; i < 8; i += 1) reservar(8, size - 1 - i);
    for (let i = 8; i < 15; i += 1) reservar(size - 15 + i, 8);

    // Información de versión (v >= 7), dos bloques de 3×6.
    if (version >= 7) {
      let rem = version;
      for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      const bits = (version << 12) | rem;
      for (let i = 0; i < 18; i += 1) {
        const bit = (bits >>> i) & 1;
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        marca(b, a, bit);
        marca(a, b, bit);
      }
    }

    return { m, fn, size };
  }

  /* ------------------------------------------------------------------ */
  /* Colocación de datos y máscaras                                      */
  /* ------------------------------------------------------------------ */
  function colocarDatos(m, fn, codewords, size) {
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert += 1) {
        for (let j = 0; j < 2; j += 1) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!fn[y][x] && i < codewords.length * 8) {
            m[y][x] = (codewords[i >>> 3] >>> (7 - (i & 7))) & 1;
            i += 1;
          }
        }
      }
    }
  }

  function condicionMascara(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
      default: return false;
    }
  }

  function aplicarMascara(m, fn, mask, size) {
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (!fn[y][x] && condicionMascara(mask, x, y)) m[y][x] ^= 1;
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Penalización (ISO 18004 §8.8.2) para elegir la mejor máscara        */
  /* ------------------------------------------------------------------ */
  function penalizacion(m, size) {
    let score = 0;

    // N1: rachas de 5 o más módulos iguales.
    for (let y = 0; y < size; y += 1) {
      let run = 1;
      for (let x = 1; x < size; x += 1) {
        if (m[y][x] === m[y][x - 1]) {
          run += 1;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else run = 1;
      }
    }
    for (let x = 0; x < size; x += 1) {
      let run = 1;
      for (let y = 1; y < size; y += 1) {
        if (m[y][x] === m[y - 1][x]) {
          run += 1;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else run = 1;
      }
    }

    // N2: bloques 2×2 del mismo color.
    for (let y = 0; y < size - 1; y += 1) {
      for (let x = 0; x < size - 1; x += 1) {
        const v = m[y][x];
        if (v === m[y][x + 1] && v === m[y + 1][x] && v === m[y + 1][x + 1]) score += 3;
      }
    }

    // N3: patrón 1:1:3:1:1 con 4 módulos claros a un lado.
    const patron = [1, 0, 1, 1, 1, 0, 1];
    const esPatron = (get, i) => {
      for (let k = 0; k < 7; k += 1) if (get(i + k) !== patron[k]) return false;
      return true;
    };
    const cuatroClaros = (get, desde, hacia, limite) => {
      for (let k = 1; k <= 4; k += 1) {
        const i = desde + hacia * k;
        if (i < 0 || i >= limite || get(i) !== 0) return false;
      }
      return true;
    };
    for (let y = 0; y < size; y += 1) {
      const get = (i) => m[y][i];
      for (let x = 0; x <= size - 7; x += 1) {
        if (esPatron(get, x)
          && (cuatroClaros(get, x - 1, -1, size) || cuatroClaros(get, x + 7, 1, size))) score += 40;
      }
    }
    for (let x = 0; x < size; x += 1) {
      const get = (i) => m[i][x];
      for (let y = 0; y <= size - 7; y += 1) {
        if (esPatron(get, y)
          && (cuatroClaros(get, y - 1, -1, size) || cuatroClaros(get, y + 7, 1, size))) score += 40;
      }
    }

    // N4: desbalance entre módulos oscuros y claros.
    let oscuros = 0;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) oscuros += m[y][x];
    }
    const total = size * size;
    score += 10 * Math.floor(Math.abs(oscuros * 20 - total * 10) / total);
    return score;
  }

  /* ------------------------------------------------------------------ */
  /* API principal                                                       */
  /* ------------------------------------------------------------------ */
  function crearMatriz(texto, opciones) {
    const opts = opciones || {};
    const bytes = utf8(texto);
    const version = opts.version ? Number(opts.version) : elegirVersion(bytes.length);
    if (!ECC_M[version]) throw new Error(`QR: versión no soportada (${version}); use 1-10.`);
    const bitsContador = version <= 9 ? 8 : 16;
    const maxBytes = Math.floor((capacidadDatos(version) * 8 - 4 - bitsContador) / 8);
    if (bytes.length > maxBytes) {
      throw new Error(`QR: ${bytes.length} bytes no caben en la versión ${version}-M (máx. ${maxBytes}).`);
    }

    const codewords = entrelazar(flujoDatos(bytes, version), version);
    const { m, fn, size } = matrizBase(version);
    colocarDatos(m, fn, codewords, size);

    const fija = opts.mask === undefined || opts.mask === null
      ? null
      : Math.max(0, Math.min(7, Number(opts.mask)));

    let mejor = null;
    const mascaras = fija === null ? [0, 1, 2, 3, 4, 5, 6, 7] : [fija];
    for (const mask of mascaras) {
      const copia = m.map((fila) => fila.slice());
      aplicarMascara(copia, fn, mask, size);
      escribirFormato(copia, size, mask);
      const score = fija === null ? penalizacion(copia, size) : 0;
      if (!mejor || score < mejor.score) mejor = { score, mask, m: copia };
    }

    return { size, modules: mejor.m, version, mask: mejor.mask };
  }

  function escaparXml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function svg(texto, opciones) {
    const opts = opciones || {};
    const qr = crearMatriz(texto, opts);
    const quiet = opts.quiet === undefined ? 4 : Math.max(0, Number(opts.quiet));
    const total = qr.size + quiet * 2;
    const color = opts.color || '#0f2f4f';
    const fondo = opts.fondo || '#ffffff';

    let path = '';
    for (let y = 0; y < qr.size; y += 1) {
      for (let x = 0; x < qr.size; x += 1) {
        if (qr.modules[y][x]) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
      }
    }

    const label = escaparXml(opts.label || 'Código QR');
    const px = opts.px ? ` width="${Number(opts.px)}" height="${Number(opts.px)}"` : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}"${px}`
      + ` role="img" aria-label="${label}" shape-rendering="crispEdges">`
      + `<rect width="${total}" height="${total}" fill="${fondo}"/>`
      + `<path d="${path}" fill="${color}"/></svg>`;
  }

  function pintar(destino, texto, opciones) {
    const el = typeof destino === 'string' ? document.getElementById(destino) : destino;
    if (!el) return null;
    try {
      el.innerHTML = svg(texto, opciones);
      return el.firstChild;
    } catch (e) {
      el.innerHTML = '';
      el.setAttribute('data-qr-error', e.message);
      return null;
    }
  }

  function payloadOT(ot) {
    const origen = typeof location !== 'undefined' ? location.origin : '';
    const numero = (ot && (ot.numero_ot || ot.numero)) || '';
    return `${origen}/?ot=${encodeURIComponent(numero)}`;
  }

  return {
    matriz: crearMatriz,
    svg,
    pintar,
    payloadOT,
    // Expuestos para pruebas de la suite (no usados por la UI).
    _pruebas: { elegirVersion, flujoDatos, entrelazar, bitsFormato, gfMul, capacidadDatos },
  };
});
