'use strict';
/* Prueba rápida de humo de la API de Optiflow (no forma parte de la app). */
const BASE = process.env.BASE || 'http://localhost:3000';

// Desde la auditoría V-1 la API exige sesión para escribir: la herramienta
// mantiene una cookie jar e inicia sesión con el usuario admin.
let cookie = null;

async function api(metodo, ruta, body) {
  const r = await fetch(BASE + ruta, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  let data = null;
  const txt = await r.text();
  try { data = JSON.parse(txt); } catch { data = txt; }
  return { status: r.status, data, headers: r.headers };
}

const ok = (cond, msg) => console.log(`${cond ? '  [OK]  ' : '  [FALLO]'} ${msg}`);

(async () => {
  console.log('\n--- SALUD ---');
  let r = await api('GET', '/api/salud');
  ok(r.status === 200 && r.data.ok, `GET /api/salud -> ${r.status}`);

  r = await api('GET', '/api/meta');
  ok(r.status === 200 && r.data.motivos_pausa.length === 5, `GET /api/meta -> ${r.status} (${r.data && r.data.motivos_pausa && r.data.motivos_pausa.length} motivos)`);

  r = await api('GET', '/api/hora');
  ok(r.status === 200, `GET /api/hora -> ${r.status} ${r.data && r.data.iso}`);

  console.log('\n--- SESIÓN (V-1) ---');
  const usuario = process.env.OPTIFLOW_ADMIN_USER || 'admin';
  r = await api('POST', '/api/auth/login', { usuario, password: process.env.OPTIFLOW_ADMIN_PASSWORD || '' });
  ok(r.status === 200, `login "${usuario}" -> ${r.status} (${r.status === 200 ? r.data.usuario.nombre : r.data && r.data.error})`);
  if (r.status !== 200) {
    console.log('\n  Defina OPTIFLOW_ADMIN_USER / OPTIFLOW_ADMIN_PASSWORD (o use la clave');
    console.log('  impresa en el primer arranque) para ejecutar las pruebas de escritura.\n');
    process.exit(0);
  }

  // Sin sesión: las escrituras deben responder 401.
  const sinCookie = cookie;
  cookie = null;
  r = await api('POST', '/api/registros', { ot_id: 1, sector_id: 1, operario_nombre: 'X' });
  ok(r.status === 401, `POST /api/registros SIN sesión -> ${r.status} (esperado 401)`);
  cookie = sinCookie;

  console.log('\n--- SECTORES ---');
  r = await api('GET', '/api/sectores');
  ok(r.status === 200 && r.data.total === 11, `GET /api/sectores -> ${r.status} (${r.data.total} sectores)`);
  const sectores = r.data.sectores;
  const sCorte = sectores.find((s) => s.nombre_sector.includes('Seccionadora'));
  const sHerrajes = sectores.find((s) => s.clave_especial === null && s.nombre_corto === 'Herrajes');
  const sVidrio = sectores.find((s) => s.clave_especial === 'vidrio');

  console.log('\n--- OTs ---');
  r = await api('GET', '/api/ordenes');
  ok(r.status === 200 && r.data.total === 3, `GET /api/ordenes -> ${r.status} (${r.data.total} OTs)`);
  const ot = r.data.ordenes[0];
  ok(ot.progreso.sectores_requeridos === 8, `OT con vidrio -> ${ot.progreso.sectores_requeridos} sectores requeridos`);
  ok(ot.estado_general === 'En Cola', `estado inicial -> ${ot.estado_general}`);

  r = await api('POST', '/api/ordenes', {
    numero_ot: 'ot-1710', cliente: 'DUPLICADA', modelo: 'X', metros_lineales: '10,5',
    fecha_prometida: '2026-12-31',
  });
  ok(r.status === 409, `alta OT duplicada -> ${r.status} (${r.data.error})`);

  r = await api('POST', '/api/ordenes', {
    numero_ot: 'OT-9000', cliente: 'CLIENTE NUEVO', modelo: 'PRUEBA', metros_lineales: '10,5',
    fecha_prometida: '2026-12-31', requiere_especiales: true,
  });
  ok(r.status === 201 && r.data.metros_lineales === 10.5, `alta OT nueva -> ${r.status} (metros=${r.data.metros_lineales})`);
  const otNueva = r.data;

  console.log('\n--- INICIO DE ETAPA ---');
  r = await api('POST', '/api/registros', { ot_id: ot.id, sector_id: sCorte.id, operario_nombre: 'Carlos Pérez' });
  ok(r.status === 201, `iniciar etapa -> ${r.status} (${r.data && r.data.error})`);
  const reg1 = r.data && r.data.registro;
  ok(!!reg1 && !!reg1.fecha_hora_inicio, `fecha_hora_inicio servidor = ${reg1 && reg1.fecha_hora_inicio}`);

  r = await api('POST', '/api/registros', { ot_id: ot.id, sector_id: sCorte.id, operario_nombre: 'Otro Operario' });
  ok(r.status === 409, `R1 duplicada mismo OT+sector -> ${r.status} (${r.data.error})`);

  r = await api('POST', '/api/registros', { ot_id: otNueva.id, sector_id: sCorte.id, operario_nombre: 'María López' });
  ok(r.status === 409, `R2 sector no compartido ocupado -> ${r.status} (${r.data.error})`);

  r = await api('POST', '/api/registros', { ot_id: ot.id, sector_id: sVidrio.id, operario_nombre: 'María López' });
  ok(r.status === 201, `sector especial requerido -> ${r.status}`);

  r = await api('POST', '/api/registros', { ot_id: otNueva.id, sector_id: sVidrio.id, operario_nombre: 'Jorge Díaz' });
  ok(r.status === 409, `R4 sector especial NO requerido -> ${r.status} (${r.data.error})`);

  r = await api('GET', `/api/estado?ot_id=${ot.id}`);
  ok(r.status === 200 && r.data.etapas_abiertas.length === 2, `estado en vivo -> ${r.status} (${r.data.etapas_abiertas.length} etapas abiertas)`);

  r = await api('POST', '/api/registros', { ot_id: ot.id, sector_id: sHerrajes.id, operario_nombre: 'Carlos Pérez' });
  ok(r.status === 409, `R3 operario con etapa abierta -> ${r.status} (${r.data.error})`);

  const regVidrio = r = await api('POST', '/api/registros', { ot_id: ot.id, sector_id: sHerrajes.id, operario_nombre: 'Jorge Díaz' });
  ok(r.status === 201, `otra etapa en sector compartido -> ${r.status}`);
  const reg2 = r.data.registro;

  console.log('\n--- PAUSA / REANUDAR / FINALIZAR ---');
  r = await api('POST', `/api/registros/${reg1.id}/pausar`, { motivo_pausa: 'Cualquiera', observacion: 'x' });
  ok(r.status === 400, `motivo inválido -> ${r.status} (${r.data.error})`);

  await new Promise((s) => setTimeout(s, 400));
  r = await api('POST', `/api/registros/${reg1.id}/pausar`, { motivo_pausa: 'Falta de herrajes', observacion: 'Llega proveedor 15:00' });
  ok(r.status === 200 && r.data.registro.estado_etapa === 'Pausado', `pausar -> ${r.status} (${r.data.registro.estado_etapa})`);

  r = await api('POST', `/api/registros/${reg1.id}/reanudar`, {});
  ok(r.status === 200 && r.data.registro.estado_etapa === 'En Proceso', `reanudar -> ${r.status} (pausas acumuladas ${Math.round(r.data.registro.segundos_pausados * 100) / 100}s)`);

  await new Promise((s) => setTimeout(s, 500));
  r = await api('POST', `/api/registros/${reg1.id}/finalizar`, { observacion: 'OK' });
  ok(r.status === 200 && r.data.registro.estado_etapa === 'Finalizado', `finalizar -> ${r.status} (${r.data.registro.estado_etapa})`);
  ok(typeof r.data.registro.duracion_minutos === 'number' && r.data.registro.duracion_minutos >= 0,
    `duracion_minutos = ${r.data.registro.duracion_minutos}`);
  ok(r.data.ot.estado_general === 'En Producción', `estado OT -> ${r.data.ot.estado_general}`);

  r = await api('POST', `/api/registros/${reg1.id}/finalizar`, {});
  ok(r.status === 409, `doble finalizar -> ${r.status} (${r.data.error})`);

  console.log('\n--- CONSULTAS / EXPORT ---');
  r = await api('GET', '/api/registros?limit=10');
  ok(r.status === 200 && r.data.total >= 2, `GET /api/registros -> ${r.status} (total ${r.data.total})`);

  r = await api('GET', '/api/operarios');
  ok(r.status === 200 && r.data.operarios.length >= 2, `GET /api/operarios -> ${r.status} (${r.data.operarios.length})`);

  r = await api('GET', '/api/export/registros.json');
  ok(r.status === 200 && r.data.registros.length >= 2 && r.data.registros[0].fecha_hora_inicio_local,
    `export JSON -> ${r.status} (${r.data.total} registros, local=${r.data.registros[0].fecha_hora_inicio_local})`);

  const csv = await fetch(BASE + '/api/export/registros.csv', { headers: cookie ? { Cookie: cookie } : {} });
  const csvTxt = await csv.text();
  const lineas = csvTxt.replace(/^\uFEFF/, '').trim().split('\r\n');
  ok(csv.status === 200 && lineas[0].startsWith('id_registro,numero_ot'),
    `export CSV -> ${csv.status} | ${lineas.length} líneas | BOM=${csvTxt.charCodeAt(0) === 0xfeff}`);
  ok(csv.headers.get('content-disposition')?.includes('.csv'), `filename = ${csv.headers.get('content-disposition')}`);
  console.log('   cabecera CSV: ' + lineas[0].slice(0, 120));
  console.log('   fila 1     : ' + (lineas[1] || '').slice(0, 160));

  r = await api('PUT', `/api/sectores/${sCorte.id}`, { es_compartido: false });
  ok(r.status === 200, `PUT sector -> ${r.status}`);

  r = await api('PUT', `/api/ordenes/${ot.id}`, { estado_general: 'Detenido' });
  ok(r.status === 200 && r.data.estado_general === 'Detenido', `PUT OT estado -> ${r.status} (${r.data.estado_general})`);

  r = await api('POST', '/api/registros', { ot_id: ot.id, sector_id: sHerrajes.id, operario_nombre: 'Nuevo' });
  ok(r.status === 201 || r.status === 409, `iniciar sobre OT detenida -> ${r.status} (${r.data.error || 'permitido'})`);

  r = await api('DELETE', `/api/ordenes/${otNueva.id}`);
  ok(r.status === 200, `DELETE OT -> ${r.status} (${r.data.error || r.data.registros_eliminados + ' registros borrados'})`);

  r = await api('GET', '/api/noexiste');
  ok(r.status === 404, `404 -> ${r.status} (${r.data.error})`);

  r = await api('POST', '/api/ordenes', {});
  ok(r.status === 400, `validación vacía -> ${r.status} (${r.data.error})`);

  console.log('\n--- ESTÁTICOS ---');
  for (const p of ['/', '/admin', '/css/app.css', '/js/api.js']) {
    const rr = await fetch(BASE + p);
    ok(rr.status === 200 || rr.status === 404, `GET ${p} -> ${rr.status}`);
  }

  console.log('\nListo.\n');
})().catch((e) => { console.error('ERROR DE PRUEBA:', e); process.exit(1); });
