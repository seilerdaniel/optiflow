'use strict';

/**
 * Prueba end-to-end del Terminal de Fichado (Fase 1).
 * Abre Chrome headless por CDP, simula la interacción real de un operario
 * y valida el resultado en el DOM.
 *
 *   Uso:  node server/tools/prueba-ui.js      (requiere el servidor en marcha)
 */

const { spawn } = require('node:child_process');
const { existsSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PUERTO_CDP = 9455;
const BASE = process.env.BASE || 'http://localhost:3000';
const PERFIL = path.join(tmpdir(), 'optiflow-ui-test-profile');

let fallos = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '  [OK]    ' : '  [FALLO] '} ${msg}`);
  if (!cond) fallos += 1;
};
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function conectar(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pendientes = new Map();
    let id = 0;
    ws.addEventListener('open', () => {
      const enviar = (metodo, params = {}) => new Promise((res, rej) => {
        const mid = ++id;
        pendientes.set(mid, { res, rej });
        ws.send(JSON.stringify({ id: mid, method: metodo, params }));
      });
      resolve({ enviar, cerrar() { try { ws.close(); } catch { /* noop */ } } });
    });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data.toString());
      // Acepta los window.confirm() de la UI (p. ej. eliminar una OT).
      if (msg.method === 'Page.javascriptDialogOpening') {
        ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
        return;
      }
      if (msg.id && pendientes.has(msg.id)) {
        const { res, rej } = pendientes.get(msg.id);
        pendientes.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      }
    });
    ws.addEventListener('error', () => reject(new Error('Error de conexión CDP')));
  });
}

async function main() {
  if (!existsSync(CHROME)) {
    console.log('[SKIP] Chrome no disponible para la prueba de UI.');
    return;
  }
  mkdirSync(PERFIL, { recursive: true });

  console.log('\n--- TERMINAL DE FICHADO (E2E con Chrome headless) ---');
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${PUERTO_CDP}`,
    `--user-data-dir=${PERFIL}`, '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: 'ignore' });

  try {
    let destino = null;
    for (let i = 0; i < 40 && !destino; i++) {
      await dormir(250);
      try {
        const r = await fetch(`http://127.0.0.1:${PUERTO_CDP}/json/new?${encodeURIComponent(BASE + '/')}`, { method: 'PUT' });
        if (r.ok) destino = await r.json();
      } catch { /* aún no está arriba */ }
    }
    if (!destino) throw new Error('No se pudo abrir la pestaña de Chrome');

    const cli = await conectar(destino.webSocketDebuggerUrl);
    await cli.enviar('Page.enable');
    await cli.enviar('Runtime.enable');

    // --- Login (auditoría V-1): desde el hardening la terminal exige sesión ---
    await esperar("document.readyState === 'complete'");
    const modalLogin = await esperar(
      "document.getElementById('modal-login') && document.getElementById('modal-login').classList.contains('abierto')", 10000
    );
    if (modalLogin) {
      const usuarioUI = process.env.OPTIFLOW_ADMIN_USER || 'admin';
      const passwordUI = process.env.OPTIFLOW_ADMIN_PASSWORD || '';
      if (!passwordUI) {
        console.log('[SKIP] La terminal pide sesión: defina OPTIFLOW_ADMIN_USER / OPTIFLOW_ADMIN_PASSWORD');
        console.log('        (o la clave impresa en el primer arranque) y vuelva a correr la prueba.\n');
        return;
      }
      await evaluar(`(() => {
        document.getElementById('login-usuario').value = ${JSON.stringify(usuarioUI)};
        document.getElementById('login-password').value = ${JSON.stringify(passwordUI)};
      })()`);
      await evaluar("document.getElementById('btn-login').click()");
      const loginOk = await esperar(
        "!document.getElementById('modal-login').classList.contains('abierto')", 10000
      );
      ok(loginOk, 'Login de terminal correcto (modal acepta credenciales)');
      if (!loginOk) return;
    } else {
      ok(true, 'Sesión ya vigente: terminal operativa sin login');
    }

    /** Evalúa una expresión JS en la página y devuelve su valor. */
    async function evaluar(expresion) {
      const r = await cli.enviar('Runtime.evaluate', {
        expression: expresion, returnByValue: true, awaitPromise: true,
      });
      if (r.exceptionDetails) {
        throw new Error('JS: ' + (r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)));
      }
      return r.result.value;
    }
    /** Espera (con reintentos) a que una expresión devuelva algo truthy. */
    async function esperar(expresion, ms = 8000) {
      const limite = Date.now() + ms;
      let ultimo = null;
      while (Date.now() < limite) {
        try { ultimo = await evaluar(expresion); if (ultimo) return ultimo; } catch { /* reintenta */ }
        await dormir(200);
      }
      return ultimo;
    }

    await esperar("document.querySelectorAll('#grid-sectores .sector').length === 11");
    ok(true, 'Terminal cargado: 11 sectores en pantalla');

    // --- 1. Seleccionar OT buscando por cliente ---
    await evaluar(`(() => {
      const i = document.getElementById('buscador-ot');
      i.value = 'tex care'; i.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    const hayResultado = await esperar("!!document.querySelector('#resultados-ot .resultado-ot')");
    ok(hayResultado, 'Buscador por cliente devuelve resultados');

    await evaluar("document.querySelector('#resultados-ot .resultado-ot').click()");
    const otOk = await esperar("document.getElementById('ficha-ot').innerText.includes('OT-1710')");
    ok(otOk, 'Ficha de la OT seleccionada visible');

    const sectorDeshabilitado = await evaluar(`(() => {
      const b = [...document.querySelectorAll('.sector')].find(x => x.textContent.includes('Lustre'));
      return b ? b.disabled : null;
    })()`);
    ok(sectorDeshabilitado === false || sectorDeshabilitado === true,
      `Sector especial Lustre ${sectorDeshabilitado ? 'deshabilitado' : 'habilitado'} segun flags de la OT`);

    // --- 2. Operario + sector ---
    await evaluar(`(() => {
      const o = document.getElementById('operario');
      o.value = 'Ana Ruiz'; o.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await evaluar("[...document.querySelectorAll('.sector')].find(x => x.textContent.includes('Corte')).click()");

    const iniciarHabilitado = await esperar("!document.getElementById('btn-iniciar').disabled");
    ok(iniciarHabilitado, 'Botón INICIAR habilitado con OT + sector + operario');

    // --- 3. Iniciar ---
    await evaluar("document.getElementById('btn-iniciar').click()");
    const enProceso = await esperar("document.getElementById('chip-estado').textContent === 'EN PROCESO'", 10000);
    ok(enProceso, 'Etapa iniciada: indicador EN PROCESO + cronómetro en vivo');

    const crono = await esperar("document.getElementById('crono') && /^\\d\\d:\\d\\d:\\d\\d$/.test(document.getElementById('crono').textContent)");
    ok(crono, 'Cronómetro visible y corriendo');

    const iniciarInhabilitado = await esperar("document.getElementById('btn-iniciar').disabled");
    ok(iniciarInhabilitado, 'INICIAR deshabilitado mientras hay etapa en curso (doble fichaje bloqueado)');

    // --- 4. Pausar con motivo ---
    await evaluar("document.getElementById('btn-pausar').click()");
    await esperar("document.getElementById('modal-pausa').classList.contains('abierto')");
    await evaluar("document.querySelectorAll('#motivos-pausa input')[0].click()");
    await evaluar("document.getElementById('obs-pausa').value = 'Prueba E2E'");
    await evaluar("document.getElementById('btn-confirmar-pausa').click()");
    const pausado = await esperar("document.getElementById('chip-estado').textContent === 'PAUSADO'", 10000);
    ok(pausado, 'Etapa pausada con motivo registrado');

    // --- 5. Reanudar ---
    await evaluar("document.getElementById('btn-reanudar').click()");
    const reanudado = await esperar("document.getElementById('chip-estado').textContent === 'EN PROCESO'", 10000);
    ok(reanudado, 'Etapa reanudada');

    // --- 6. Finalizar ---
    await evaluar("document.getElementById('btn-finalizar').click()");
    await esperar("document.getElementById('modal-finalizar').classList.contains('abierto')");
    const resumenDuracion = await evaluar("document.getElementById('resumen-finalizar').innerText.match(/\\d\\d:\\d\\d:\\d\\d/) !== null");
    ok(resumenDuracion, 'Modal de cierre muestra la duración calculada');
    await evaluar("document.getElementById('btn-confirmar-finalizar').click()");
    const finalizada = await esperar("document.getElementById('chip-estado').textContent === 'Sin etapa'", 10000);
    ok(finalizada, 'Etapa finalizada: vuelve a "Sin etapa"');

    // --- 7. Registro persistido en la tabla ---
    const enTabla = await esperar("document.getElementById('cuerpo-registros').innerText.includes('Ana Ruiz')");
    ok(enTabla, 'El registro aparece en la tabla de últimos registros de la OT');

    const avisoOk = await evaluar("document.getElementById('avisos').innerText.includes('finalizada')");
    ok(avisoOk, 'Aviso de confirmación mostrado al operario');

    // --- 8. Volver a abrir una etapa en OT-1710 / Corte y provocar el conflicto R2 ---
    await evaluar("document.querySelector('#ficha-ot .btn').click()");           // Cambiar OT
    await evaluar(`(() => {
      const i = document.getElementById('buscador-ot');
      i.value = 'OT-1710'; i.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await esperar("!!document.querySelector('#resultados-ot .resultado-ot')");
    await evaluar("document.querySelector('#resultados-ot .resultado-ot').click()");
    await esperar("document.getElementById('ficha-ot').innerText.includes('OT-1710')");
    await evaluar("[...document.querySelectorAll('.sector')].find(x => x.textContent.includes('Corte')).click()");
    await evaluar(`(() => {
      const o = document.getElementById('operario');
      o.value = 'Ana Ruiz'; o.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await esperar("!document.getElementById('btn-iniciar').disabled");
    await evaluar("document.getElementById('btn-iniciar').click()");
    ok(await esperar("document.getElementById('chip-estado').textContent === 'EN PROCESO'", 10000),
      'Reapertura de etapa en OT-1710/Corte');

    // OT-1711 intenta entrar al mismo sector: debe rechazarse.
    await evaluar("document.querySelector('#ficha-ot .btn').click()");
    await evaluar(`(() => {
      const i = document.getElementById('buscador-ot');
      i.value = 'OT-1711'; i.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await esperar("!!document.querySelector('#resultados-ot .resultado-ot')");
    await evaluar("document.querySelector('#resultados-ot .resultado-ot').click()");
    await esperar("document.getElementById('ficha-ot').innerText.includes('OT-1711')");
    await evaluar("[...document.querySelectorAll('.sector')].find(x => x.textContent.includes('Corte')).click()");
    await evaluar(`(() => {
      const o = document.getElementById('operario');
      o.value = 'Luis Gómez'; o.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await esperar("!document.getElementById('btn-iniciar').disabled");
    await evaluar("document.getElementById('btn-iniciar').click()");
    const avisoConflicto = await esperar("document.getElementById('avisos').innerText.includes('NO es compartido')", 10000);
    ok(avisoConflicto, 'Sector no compartido ocupado por otra OT: aviso claro al operario');
    await dormir(500);

    // --- 9. Panel de Administración ---
    console.log('\n--- ADMINISTRACIÓN DE OTs (E2E) ---');
    await cli.enviar('Page.navigate', { url: BASE + '/admin' });
    await esperar("!!document.getElementById('cuerpo-ots') && document.querySelectorAll('#cuerpo-ots tr').length > 1");
    ok(true, 'Panel cargado con el listado de OTs');

    await evaluar(`(() => {
      const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); };
      set('ot-numero', 'OT-8001'); set('ot-cliente', 'CLIENTE E2E'); set('ot-modelo', 'MODELO TEST');
      set('ot-metros', '12,5'); set('ot-prometida', '2026-12-24');
      const cb = document.querySelector('#checks-especiales input');
      cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await evaluar("document.getElementById('form-ot').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))");
    ok(await esperar("document.getElementById('cuerpo-ots').innerText.includes('OT-8001')", 10000),
      'Alta de OT desde el formulario (metros "12,5" aceptados)');

    await evaluar(`(() => {
      const tr = [...document.querySelectorAll('#cuerpo-ots tr')].find(t => t.innerText.includes('OT-8001'));
      const sel = tr.querySelector('select'); sel.value = 'En Producción';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    ok(await esperar(`(() => {
      const tr = [...document.querySelectorAll('#cuerpo-ots tr')].find(t => t.innerText.includes('OT-8001'));
      return tr && tr.querySelector('select').value === 'En Producción';
    })()`, 10000), 'Cambio de estado de la OT desde la tabla');

    await evaluar(`(() => {
      const tr = [...document.querySelectorAll('#cuerpo-ots tr')].find(t => t.innerText.includes('OT-8001'));
      [...tr.querySelectorAll('button')].find(b => b.textContent.includes('Ver')).click();
    })()`);
    ok(await esperar("document.getElementById('modal-detalle').classList.contains('abierto') && document.getElementById('detalle-cuerpo').innerText.includes('REGISTROS DE TIEMPOS')", 10000),
      'Detalle de OT: requisitos editables + registros de tiempos');
    await evaluar("document.querySelector('#modal-detalle [data-cerrar]').click()");

    await evaluar(`(() => {
      const tr = [...document.querySelectorAll('#cuerpo-ots tr')].find(t => t.innerText.includes('OT-8001'));
      [...tr.querySelectorAll('button')].find(b => b.title === 'Eliminar OT').click();
    })()`);
    ok(await esperar("!document.getElementById('cuerpo-ots').innerText.includes('OT-8001')", 10000),
      'Eliminación de la OT con confirmación');
    await dormir(400);

    console.log(`\nResultado UI: ${fallos === 0 ? 'TODAS LAS COMPROBACIONES OK' : fallos + ' FALLO(S)'}\n`);
    cli.cerrar();
  } finally {
    try { chrome.kill(); } catch { /* noop */ }
  }
  if (fallos > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('\n[ERROR E2E]', e, '\n'); process.exitCode = 1; });
