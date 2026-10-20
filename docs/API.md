# Optiflow — Referencia de la API (Fase 1 → Fase 7)

Base: `http://<servidor>:<puerto>` (por defecto `http://localhost:3000`)

* Todas las respuestas son `application/json; charset=utf-8` salvo los exportadores.
* Todas las fechas llegan en **ISO-8601 UTC** (`2026-10-12T19:23:34.225Z`) y se generan **siempre en el servidor**.
* Errores: `{ "error": "mensaje legible", "detalle": { ... } }` con el código HTTP apropiado
  (`400` validación, `401` sin sesión, `403` rol insuficiente, `404` inexistente,
  `409` conflicto/regla de negocio, `413` body muy grande, `429` login rate-limited,
  `500` interno — en producción el `detalle` técnico se oculta: `{ "codigo": "E_INTERNO" }`).
* CORS: sólo se acepta el **mismo origen** y la allowlist de `OPTIFLOW_CORS_ORIGINS`
  (auditoría V-2; antes era `*`). Power BI usa el token de export en lugar de CORS.

### Fase 7 (cloud)

* La misma API se sirve **local** (`node server/server.js`, puerto 3000) y en **Vercel**
  (`api/[...slug].js` delega en `manejar()`), con la base en **Supabase (PostgreSQL)**.
  En la nube la raíz es `https://<proyecto>.vercel.app` y las rutas `/api/*` no cambian.
* Todas las respuestas de la API se obtienen con `await` (el driver `pg` es asíncrono);
  la forma de las respuestas es idéntica a las fases anteriores.
* Sin `SUPABASE_DB_URL`, los endpoints que tocan datos responden `500` con el mensaje
  `Falta la variable de entorno SUPABASE_DB_URL`; `/api/salud`, `/api/meta` y `/api/hora`
  responden igualmente (`200`) porque no requieren base.
* La terminal acepta el parámetro de escaneo `?ot=<número>` (p. ej. `/?ot=1710`):
  no es un endpoint, pero la URL del QR impreso lo genera.

---

## Autenticación (auditoría V-1)

* **Sesión por cookie** `optiflow_sesion` (HttpOnly, SameSite=Strict, Secure en https).
  El token sólo viaja en la cookie; en la base se guarda su SHA-256.
* Contraseñas: **scrypt** con salt aleatorio (columnas `password_hash`/`password_salt`).
* Roles: `operario` (fichar en terminal), `encargado` (gestión de planta),
  `admin` (gestión + usuarios del sistema).
* Primer arranque con tabla `usuarios` vacía: se crea `admin` (o `OPTIFLOW_ADMIN_USER`)
  con `OPTIFLOW_ADMIN_PASSWORD` o con una clave aleatoria impresa **una sola vez**.

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| POST | `/api/auth/login` | pública | `{ usuario, password }` → setea cookie y devuelve `{ usuario, expira_en }`. `401` genérico si falla; `429` tras varios intentos. |
| POST | `/api/auth/logout` | pública | Cierra la sesión vigente y borra la cookie |
| GET | `/api/auth/usuario` | pública | `{ usuario: {...} }` o `{ usuario: null }` (siempre `200`) |
| GET | `/api/usuarios` | `encargado`+ | Lista de usuarios del sistema |
| POST | `/api/usuarios` | `admin` | Alta: `{ usuario, nombre, password, rol, activo? }` |
| PUT | `/api/usuarios/:id` | `admin` | Edición; `password` opcional. Protege al último admin activo |

**Qué rutas exigen sesión:**

* `POST /api/registros` (+ `pausar`/`reanudar`/`finalizar`) → cualquier sesión.
* Escrituras de `ordenes`, `sectores`, `operarios` → `admin` o `encargado`.
* `/api/export/*` → sesión **o** token estático (ver abajo).
* Página `/admin` → sin sesión redirige a `/login.html`.
* Lecturas (`GET`) públicas: `salud`, `meta`, `hora`, `estado`, `ordenes`, `sectores`,
  `operarios`, `registros`, `metricas`.

**Integridad concurrencial (C-1/C-2/A-5/V-4):** los fichajes usan advisory locks por
sector/OT/operario dentro de `BEGIN…COMMIT`, UPDATEs con guarda de estado verificando
`changes`, y los índices únicos parciales `uq_reg_ot_sector_abierta` /
`uq_reg_operario_abierto` como última línea (un duplicado simultáneo responde `409`).

---

## Sistema

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/salud` | Ping del servidor + versión |
| GET | `/api/meta` | Enumeraciones (estados OT, estados de etapa, motivos de pausa, motivos de reproceso, umbrales de tiempo por sector, zona horaria) |
| GET | `/api/hora` | `{ epoch_ms, iso, zona_horaria }` → usado para sincronizar el reloj de la UI |

### `GET /api/metricas?desde=AAAA-MM-DD&hasta=AAAA-MM-DD` (Fase 2)
Métricas ejecutivas para el Dashboard (por defecto: últimos 30 días):
```json
{
  "periodo": { "desde": "2026-09-12", "hasta": "2026-10-12", "dia_cuello_botella": "2026-10-12" },
  "ots": { "total": 3, "activas": 2, "por_estado": { "En Producción": 2, "Detenido": 0, "En Cola": 0, "Finalizado": 1 } },
  "lead_time": { "ots_medidas": 1, "promedio_minutos": 3120.5, "promedio_legible": "2 d 04 h" },
  "ftt": { "evaluadas": 3, "conformes": 2, "porcentaje": 66.7, "motivos_reproceso": ["Error de plano", "Rotura de placa"] },
  "cuello_botella": { "sector_id": 1, "nombre_sector": "Seccionadora / Corte", "horas_total": 6.2, "horas_en_proceso": 5.1, "horas_pausado": 1.1, "etapas_abiertas": 2, "pausas_hoy": 1 },
  "sectores_carga_hoy": [ ... ],
  "pausas_por_motivo": [ { "motivo": "Falta de herrajes", "frecuencia": 4, "horas_perdidas": 5.5 }, ... ]
}
```
Definiciones: **Lead time** = inicio de Corte → fin de Embalaje Final (sólo OTs cerradas en ambos); **Cuello de botella del día** = sector con más horas hoy en `En Proceso` + `Pausado` (fecha local de planta); **FTT** = % de OTs que avanzaron sin pausas por reproceso/error.

---

## Órdenes de trabajo

### `GET /api/ordenes`
```json
{
  "total": 3,
  "ordenes": [{
    "id": 1, "numero_ot": "OT-1710", "cliente": "TEX CARE VESTIDOR",
    "modelo": "L.MATE", "linea_area": "Placares",
    "metros_lineales": 24.5, "fecha_prometida": "2026-10-20",
    "requiere_vidrio": true, "requiere_lustre": false,
    "requiere_herreria": false, "requiere_especiales": false,
    "estado_general": "En Producción",
    "sectores_requeridos": [1,2,3,4,5,6,7,8],
    "progreso": { "sectores_requeridos": 8, "sectores_finalizados": 2, "porcentaje": 25,
                  "finalizados_ids": [1,2] },
    "minutos_acumulados": 134.5,
    "etapa_activa": { ...registro abierto o null... },
    "sectores_bloqueados": { "5": "Requiere finalizar: Corte, Enfiladora" },
    "sector_actual": { "id": 3, "sector_id": 3, "nombre_sector": "Armado de Cajoneras",
                       "nombre_corto": "Armado", "estado_etapa": "En Proceso" },
    "etapas_completadas": [1,2],
    "materiales": [ ...filas de ot_materiales... ],
    "resumen_materiales": { "lineas": 2, "placas_requeridas": 16,
                            "placas_consumidas": 4, "placas_restantes": 12,
                            "porcentaje_consumo": 25 },
    "alertas": [ { "id": 8, "sector_id": 1, "tipo_falla": "Error de veta",
                   "estado": "Pendiente", "fecha_registro": "2026-10-20T13:05:00.000Z" } ],
    "alertas_abiertas": 1
  }]
}
```
* sin parámetros devuelve todas las OTs, igual que antes. Acepta filtros
  opcionales `?linea_area=Placares|Cocinas`, `?estado=...` y `?q=texto`
  (busca en `numero_ot`, `cliente` y `modelo`).
* el servidor hace **3 consultas fijas** (OTs + sectores, etapas batch,
  materiales + no conformidades batch) y cruza todo en memoria con `Map`
  indexados por `ot_id`; no hay consultas por OT.
* `materiales`, `resumen_materiales`, `alertas`, `sector_actual` y
  `etapas_completadas` son campos aditivos: los consumidores anteriores siguen
  usando `progreso`, `etapa_activa` y `sectores_bloqueados`.

### `POST /api/ordenes`
```json
{
  "numero_ot": "OT-1713", "cliente": "TEX CARE VESTIDOR", "modelo": "L.MATE",
  "linea_area": "Placares",
  "metros_lineales": "24,5", "fecha_prometida": "2026-11-10",
  "requiere_vidrio": true, "requiere_lustre": false,
  "requiere_herreria": false, "requiere_especiales": false,
  "materiales": [
    { "material_nombre": "Melamina Aglomerado 18mm", "cantidad_placas": 12, "observaciones": null },
    { "material_nombre": "MDF 22mm", "cantidad_placas": 4 }
  ]
}
```
* `numero_ot` único (sin distinguir mayúsculas) → `409` si existe.
* `linea_area` ∈ `Placares | Cocinas` (por defecto `Placares`): define qué
  sectores debe recorrer la OT. Es el filtro que separa los dos flujos.
* `metros_lineales` acepta coma decimal (`"24,5"`); es obligatorio en toda alta.
* `materiales` es opcional: lista dinámica de placas requeridas. Cada fila
  acepta `material_nombre` (obligatorio), `cantidad_placas` (obligatorio, > 0),
  `cantidad_consumida` (opcional, por defecto 0) y `observaciones` (opcional).
  Nombres repetidos (ignorando mayúsculas) → `400`.
* Respuesta `201` con la OT creada, sus `materiales` y `resumen_materiales`.
  Estados permitidos: `En Cola` · `En Producción` · `Detenido` · `Finalizado`.

### `PUT /api/ordenes/:id`
Recibe **sólo los campos a modificar** (merge). Ej.: `{ "estado_general": "Detenido" }`.
Si el body incluye `materiales` (misma forma que en `POST`), se **reemplaza la
lista completa** de forma id-preserving: las filas que traen `id` se actualizan,
las nuevas se insertan y las ausentes se eliminan. Respuesta `200` con la OT
actualizada, `materiales` y `resumen_materiales`.

Cambiar `linea_area` re-scopa todo el flujo de la OT (otros sectores exigidos,
otro orden, otro lead time), por lo que sólo se permite **mientras no haya
etapas finalizadas**; si las hay responde `409` con `detalle.accion`.

### `PUT /api/ordenes/:id/materiales`
Reemplaza la lista completa de materiales de la OT. Body: `{ "materiales": [...] }`
(misma validación que `POST`). Respuesta `200` con `{ materiales, resumen_materiales }`.

### `PUT /api/ordenes/:id/materiales/:mid`
Actualiza una sola línea de material (consumo, cantidad u observaciones).
Body parcial: `{ "cantidad_consumida": 8 }`. `404` si el material no pertenece
a la OT; `400` si `cantidad_consumida` supera `cantidad_placas`.
Respuesta `200` con `{ material, materiales, resumen_materiales }`.

### `DELETE /api/ordenes/:id`
Responde `{ "eliminada": true, "numero_ot": "OT-1710", "registros_eliminados": 12, "materiales_eliminados": 3 }`.
Si la OT tiene etapas abiertas responde `409`. Los materiales se eliminan en cascada.

---

## Sectores

### `GET /api/sectores`
```json
{ "total": 16, "incluye_inactivos": false, "sectores": [{
    "id": 1, "nombre_sector": "Seccionadora / Corte", "nombre_corto": "Corte",
    "es_compartido": false, "clave_especial": null,
    "linea_area": "Placares", "orden_flujo": 1,
    "operarios_sugeridos": null, "activo": true,
    "etapas_abiertas": 1, "ordenes_activas": ["OT-1710"]
}]}
```
* `linea_area` ∈ `Placares | Cocinas | Compartido | General`. Clasifica el
  sector dentro de la fábrica y decide en qué flujos entra: los de `Placares`
  y `Cocinas` son propios de su línea; los `Compartido` y `General` los puede
  usar cualquier OT.
* `orden_flujo` es la posición del sector **dentro de su línea** y también la
  secuencia visual de la grilla en la Terminal. El `id` ya no define el orden:
  ambos flujos conviven en la misma tabla.
* `clave_especial` ∈ `vidrio | lustre | herreria | especiales | null` (null = flujo regular).
* Por defecto se listan **sólo los activos** y ordenados por línea y
  `orden_flujo`. `?todos=1` incluye los dados de baja (`incluye_inactivos: true`).

### `POST /api/sectores`
```json
{ "nombre_sector": "Pulido de Acabados", "linea_area": "Cocinas",
  "es_compartido": false, "orden_flujo": 6, "operarios_sugeridos": "Nico, Joel" }
```
* `nombre_sector` obligatorio (máx. 80) y **único** sin distinguir mayúsculas
  ni acentos → `409` si ya existe.
* `linea_area` por defecto `General`; `nombre_corto` se deriva del nombre si no
  se envía; `orden_flujo` se asigna al final de la línea si no se envía.
* `operarios_sugeridos` es texto libre separado por comas (pista en la Terminal;
  el alta en el maestro de operarios es libre). Respuesta `201`.

### `PUT /api/sectores/:id`
Body **parcial**: acepta `nombre_sector`, `nombre_corto`, `linea_area`,
`es_compartido`, `orden_flujo`, `operarios_sugeridos` y `activo`
(máx. 80 / entero ≥ 0 / `booleano` respectivamente). Los campos ausentes no cambian.

* Renombrar un sector **no requiere propagar nada**: `registros_tiempos` guarda
  `sector_id` y todos los reportes (detalle, métricas, export) hacen `JOIN` con
  `sectores`, así que el nombre histórico siempre se lee de la fuente única de
  verdad. La respuesta incluye `registros_historicos_actualizados` (conteo de
  registros que quedan asociados).
* `activo: false` lo oculta de la Terminal e impide iniciar etapas nuevas (R7);
  conserva su historial y las etapas abiertas se pueden cerrar.

---

## Registros de tiempos (eventos de producción)

### `POST /api/registros` — Iniciar etapa
```json
{ "ot_id": 1, "sector_id": 1, "operario_nombre": "Carlos Pérez" }
```
`operario_nombre` es **obligatorio** (`400` si viene vacío): toda etapa queda
asociada a un operario responsable. El servidor captura `fecha_hora_inicio` y,
al finalizar, `fecha_hora_fin` + `duracion_minutos` (neto de pausas).
`horas_hombre` = `duracion_minutos / 60` (1 operario por etapa).

Respuesta `201`:
```json
{ "registro": { "id": 1, "estado_etapa": "En Proceso",
    "fecha_hora_inicio": "2026-10-12T19:23:34.225Z",
    "minutos_transcurridos": 0, ... } }
```

**Validaciones (todas responden `409` con `detalle.accion` explicando qué hacer):**
1. Etapa abierta de la misma OT en el mismo sector.
2. Sector no compartido ocupado por otra OT.
3. Operario con otra etapa abierta.
4. Sector especial no requerido por la OT.
5. OT en estado `Finalizado`.
6. **Orden del flujo (Fase 2):** faltan sectores prerrequisito. El orden se
   calcula **dentro de la línea de la OT** (`linea_area`), usando `orden_flujo`:
   * **Placares:** Corte → Enfiladora → Pantógrafo → Cajoneras → Herrajes →
     Control de Calidad → Embalaje Final.
   * **Cocinas:** Corte B → Enfilado de Cantos → Mecanizado de Puertas →
     Armado de Módulos → Secuenciado y Distribución.
   * Los sectores `Compartido` / `General` aplican a ambas líneas.
   * Los especiales (Vidrio/Lustre/Herrería/Especiales) requieren el **corte de
     la línea** finalizado.
   * Control de Calidad requiere además todos los especiales REQUERIDOS por la OT.
7. **Sector desactivado (Fase 5):** `sectores.activo = false`.
8. **Sector de otra línea (Fase 5):** el sector pertenece a `Placares` y la OT
   es de `Cocinas` (o al revés). Los `Compartido` / `General` no aplican esta regla.

### `POST /api/registros/:id/pausar`
```json
{ "motivo_pausa": "Falta de herrajes", "observacion": "Llega proveedor 15:00" }
```
`motivo_pausa` obligatorio y válido: `Falta de herrajes` · `Error de plano` ·
`Ajuste de herramienta` · `Rotura de placa` · `Otro`.
Cada pausa crea un evento en `eventos_pausa` (motivo, inicio, fin y segundos reales)
que alimenta `/api/metricas` y el desglose de horas perdidas.

### `POST /api/registros/:id/reanudar`
Acumula el tiempo pausado en `segundos_pausados`, vuelve a `En Proceso` y cierra
el evento de pausa abierto con sus segundos reales.

### `POST /api/registros/:id/finalizar`
```json
{ "observacion": "Trabajado según plano rev. B" }
```
Calcula `duracion_minutos` (neto de pausas) y `fecha_hora_fin`.
Al cerrar la **última etapa del flujo de la línea** de la OT (`orden_flujo`
máximo de su `linea_area`, p. ej. *Embalaje Final* en Placares o *Secuenciado y
Distribución* en Cocinas) y siempre que **todos** los sectores requeridos por la
OT estén finalizados y no quede ninguna etapa abierta, la OT pasa a `Finalizado`.

### `GET /api/registros`
Query: `ot_id`, `sector_id`, `estado` (`En Proceso|Pausado|Finalizado`), `operario`,
`desde`/`hasta` (`AAAA-MM-DD`), `limit` (≤500), `offset`.
Devuelve `{ total, limit, offset, registros: [...] }` con los datos de la OT y del sector "pegados".

### `GET /api/estado?ot_id=` — Estado en vivo
```json
{ "ahora": "…Z",
  "etapas_abiertas": [ { "id": 1, "ot_id": 1, "sector_id": 1, "estado_etapa": "En Proceso",
                         "fecha_hora_inicio": "…Z", "pausa_inicio": null,
                         "segundos_pausados": 0, "minutos_transcurridos": 12.4, ... } ],
  "actividad_sectores": [ { "sector_id": 1, "nombre_sector": "Seccionadora / Corte",
                            "abiertas": 1, "ordenes_activas": ["OT-1710"] } ] }
```
Sin `ot_id` devuelve todas las etapas abiertas de la planta.

### `GET /api/operarios`
Maestro de operarios. Por defecto devuelve **sólo los activos** (alimenta el
autocompletado de la Terminal). `?todos=1` incluye los inactivos (para la tabla
de Administración).

Respuesta:
```json
{ "total": 14,
  "operarios": [{
    "id": 1, "nombre": "Diego", "activo": true,
    "etapas": 120, "etapas_abiertas": 0,
    "ultima_actividad": "2026-10-12T19:23:34.225Z", "fecha_creacion": "…"
  }] }
```

### `POST /api/operarios`
Alta de operario. Body: `{ "nombre": "Juan Pérez", "activo": true }`.
`409` si el nombre ya existe (ignora mayúsculas).

### `PUT /api/operarios/:id`
Edita nombre y/o estado activo. Body parcial: `{ "nombre": "Nuevo Nombre" }`
o `{ "activo": false }`.

* **Renombrar** propaga el cambio a `registros_tiempos` (COLLATE NOCASE) para
  corregir typos sin partir las métricas históricas. La respuesta incluye
  `registros_actualizados` con la cantidad de registros afectados.
* `409` si el nuevo nombre pertenece a otro operario.
* **Desactivar** impide que el operario inicie nuevas etapas (`409` desde la
  Terminal), pero su historial se conserva íntegro.

### Auto-guardado en `POST /api/registros`
Si el `operario_nombre` enviado **no existe** en el maestro, se registra
automáticamente como activo (no se bloquea la planta por un alta olvidada).
Si existe pero está **desactivado**, responde `409` con acción sugerida.

---

## Exportación

| Ruta | Formato |
|---|---|
| `/api/export/registros.csv` | CSV UTF-8 con BOM, separado por comillas, `Content-Disposition: attachment` |
| `/api/export/registros.json` | `{ fuente, generado_en, total, filtros, registros: [...] }` |

Query compartida: `desde`, `hasta`, `ot_id`, `numero_ot`, `sector_id`, `estado`, `operario`,
`limite` (≤500 000), `bom=0` (sin BOM), `sep=;` (punto y coma).

**Acceso (auditoría V-1):** requiere sesión de usuario **o** token estático definido en
`OPTIFLOW_EXPORT_TOKEN`. Power BI / scripts: `?token=<TOKEN>` o header
`X-Optiflow-Token: <TOKEN>`. Si no hay sesión ni token (o no se definió el env), `401`.

Ver `docs/POWERBI.md` para las columnas y el alta en Power BI.
