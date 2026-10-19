# Optiflow — Plataforma Web de Control de Tiempos y Trazabilidad en Planta

**Fábrica "De Otro Tiempo" · Fase 7 (Cloud: Supabase + Vercel + PWA)**

Optiflow es una aplicación web interna para registrar, en tiempo real, el inicio, la pausa y el fin
de cada proceso productivo por orden de trabajo (OT), sector y operario. Está pensada para usarse
desde **tablets o PCs en la planta**, con botones grandes y pocos pasos.

En la **Fase 7** la plataforma se despliega en la nube: la base de datos vive en **Supabase
(PostgreSQL)**, la API corre como **Serverless Functions en Vercel** y la interfaz es una **PWA**
 instalable en las tablets. Además cada OT puede imprimirse su **Hoja de Ruta con QR** para
 escanearla en planta.

---

## 1. Requisitos

| Ítem | Detalle |
|---|---|
| Base de datos | **Supabase** (PostgreSQL) — se conecta por la cadena `SUPABASE_DB_URL` |
| Runtime | **Node.js 22.5+** (en Vercel se provee solo; local, `install.bat` instala el portátil en `.runtime\node`) |
| Dependencias | Sólo **`pg`** (driver de PostgreSQL). Sin compilación ni servicios locales |
| Navegador | Chrome / Edge / Safari (la UI está optimizada para pantallas táctiles; funciona como PWA) |
| Despliegue | **Vercel** (producción) o `start.bat` (local / red de planta) |

> En local, ejecute `install.bat` una vez: instala el runtime portátil, corre `npm install`
> (baja `pg`) y crea un `.env` de ejemplo. En Vercel no hace falta nada de eso.

---

## 2. Instalación y arranque

### 2.1 Base de datos (Supabase)

1. Cree un proyecto en [supabase.com](https://supabase.com).
2. Abra **SQL Editor → New query**, pegue el contenido de **`supabase_schema.sql`** y ejecútelo.
   (El servidor también lo aplica solo en el primer arranque si la base está vacía.)
3. Copie la **cadena de conexión**: Dashboard → Project Settings → Database →
   Connection string (URI) → usar el **pooler (puerto 6543)**.

### 2.2 Variables de entorno

Copie `.env.example` a `.env` (local) o configurelas en Vercel (Project → Settings →
Environment Variables):

| Variable | Requerida | Descripción |
|---|---|---|
| `SUPABASE_DB_URL` | sí | Cadena de conexión de Supabase (pooler, puerto 6543) |
| `OPTIFLOW_TZ` | no | Zona horaria de planta (por defecto `America/Argentina/Buenos_Aires`) |
| `PG_POOL_MAX` | no | Tamaño del pool (Vercel: 3 por defecto) |
| `PG_SSL_VERIFY` | no | `1` para validar el certificado TLS del pooler |

### 2.3 Desplegar en Vercel

```bash
npm i -g vercel        # una sola vez
vercel link            # vincula el proyecto
vercel env add SUPABASE_DB_URL
vercel --prod
```

`vercel.json` sirve `public/` como sitio estático y expone dos Serverless Functions:
`api/[...slug].js` (catch-all de `/api/*`) y `api/admin.js` (guardián de `/admin`,
que exige sesión). No hay build: el front es HTML/CSS/JS puro.

### 2.4 Ejecutar en local / red de planta

```
optiflow/
├── start.bat            ← doble clic para arrancar el servidor (abre el navegador)
├── detener.bat          ← detiene el servidor
├── install.bat          ← runtime portátil + npm install + .env de ejemplo
├── .env                 ← cadena de Supabase (no se sube al repo)
├── supabase_schema.sql  ← esquema PostgreSQL (ejecutar en Supabase)
├── vercel.json          ← configuración de despliegue en Vercel
├── api\[...slug].js     ← Serverless Function (catch-all de /api/*)
├── server\              ← API + lógica de negocio (Node.js)
├── public\              ← interfaz + PWA (manifest, service worker, iconos)
└── .runtime\node\       ← Node.js portátil (opcional)
```

1. Doble clic en **`start.bat`** (o `npm start`).
2. Se abre `http://localhost:3000` automáticamente.
3. En consola aparece la **URL de red local** (ej. `http://192.168.0.4:3000`) → esa es la URL que
   usan las tablets de planta (debe abrirse el puerto 3000 en el firewall de Windows para la red privada).

Puerto alternativo: `set PORT=3001` antes de `start.bat`.

### Pantallas

| URL | Pantalla | Usuario |
|---|---|---|
| `/` | **Terminal de Fichado Rápido** | Operarios / encargados de sector |
| `/admin` | **Administración de OTs** | Oficina técnica / encargado |

### Flujo en el Terminal (4 pasos)

1. **Buscar la OT** por número o cliente → se carga la ficha.
2. **Tocar el sector** donde se trabaja (los sectores especiales aparecen deshabilitados si la OT no
   los tiene marcados).
3. **Escribir el operario** (o tocar un operario reciente).
4. Tocar **▶ INICIAR ETAPA** → la hora la guarda el servidor. Después: **⏸ PAUSAR** (con motivo),
   **⏵ REANUDAR** o **■ FINALIZAR** (calcula la duración neta).

### Flujo con QR (nuevo en Fase 7)

Desde **Administración → Detalle OT → 🖨️ Imprimir Hoja de Ruta** se imprime una hoja A4 con un
código QR. Al escanearlo con la tablet:

1. La Terminal abre `/?ot=<número>` y **selecciona la OT sola**.
2. El buscador queda **bloqueado** (para cambiar, `✕ Cambiar OT`).
3. Se destaca la **línea** de la OT (**Placares** azul / **Cocinas** rojo).
4. queda lista para que el encargado elija el Sector y pulse **▶ Iniciar etapa**.

---

## 2.5. PWA (nuevo en Fase 7)

La interfaz es una ** Progressive Web App ** instalable en las tablets:

* `public/manifest.json` con colores industriales oscuros, iconos y accesos directos
  (Terminal / Administración).
* `public/sw.js` cachea los estáticos (app shell) para que la Terminal cargue aunque la red de
  planta parpadee; **nunca cachea `/api/*`** (los fichajes son transaccionales).
* Se registra automáticamente en `index.html` y `admin.html`. En el navegador aparece la opción
  "Instalar aplicación" / "Agregar a pantalla de inicio".

---

## 3. Modelo de datos

La Fase 7 migra a **PostgreSQL** (Supabase). El esquema completo y las semillas están en
**`supabase_schema.sql`**. Resumen de las tablas principales:

```sql
ordenes_trabajo(id, numero_ot UNIQUE, cliente, modelo, linea_area, metros_lineales,
                fecha_prometida, requiere_vidrio, requiere_lustre, requiere_herreria,
                requiere_especiales, estado_general, fecha_creacion, fecha_actualizacion)

sectores(id, nombre_sector UNIQUE, nombre_corto, es_compartido, clave_especial,
         linea_area, orden_flujo, operarios_sugeridos, activo)

registros_tiempos(id, ot_id → ordenes_trabajo, sector_id → sectores, operario_nombre,
                  fecha_hora_inicio, fecha_hora_fin, duracion_minutos, estado_etapa,
                  motivo_pausa, observacion, pausa_inicio, segundos_pausados,
                  fecha_creacion, fecha_actualizacion)

ot_materiales(id, ot_id → ordenes_trabajo, material_nombre, cantidad_placas,
              cantidad_consumida, observaciones, ...)

eventos_pausa(id, registro_id → registros_tiempos, motivo_pausa, observacion,
              inicio_pausa, fin_pausa, segundos, fecha_creacion)

operarios(id, nombre, nombre_norm UNIQUE, activo, fecha_creacion)

usuarios(id, usuario UNIQUE, nombre, nombre_norm UNIQUE, email, password_hash,
         password_salt, rol, activo, ultimo_acceso, ...)      -- Fase 7 (base de auth)

sesiones(id, usuario_id → usuarios, token_hash UNIQUE, ip, user_agent,
         creada_en, expira_en, cerrada_en, ...)               -- Fase 7 (tokens)
```

* `fecha_hora_*` se guardan como **TEXT en ISO-8601 UTC generados por el servidor** (nunca por el
  navegador): evita diferencias de reloj y de huso horario entre tablets, y permite usar
  `substr(fecha,1,10)` para comparar por día. Se conservan como TEXT (no `timestamptz`) por eso.
* Los flags 0/1 (`activo`, `es_compartido`, `requiere_*`) son **SMALLINT**, no `BOOLEAN`, para que
  los mappers sigan haciendo `!!row.flag`.
* `pausa_inicio` y `segundos_pausados` permiten descontar las pausas y mostrar un cronómetro neto.
* `usuarios` y `sesiones` son **nuevas en la Fase 7** como base de autenticación (con RLS activada
  y sin políticas: sólo accesibles desde el rol `postgres`); todavía no hay login en la UI.
* La zona horaria de planta es explícita (`OPTIFLOW_TZ`, por defecto `America/Argentina/Buenos_Aires`)
  porque el runtime de Vercel corre en UTC.

---

## 4. Reglas de negocio implementadas

| # | Regla | Respuesta |
|---|---|---|
| R1 | No iniciar dos etapas de la **misma OT en el mismo sector** a la vez | `409` con el detalle de la etapa en curso |
| R2 | Si el sector **no es compartido**, no puede haber otra OT trabajándolo | `409` |
| R3 | Un **operario** no puede tener dos etapas abiertas (evita olvidos de "Finalizar") | `409` |
| R4 | Un **sector especial** sólo se abre si la OT lo tiene marcado | `409` |
| R5 | Las OTs **Finalizadas** no aceptan nuevas etapas | `409` |
| R6 | Al iniciar, la OT pasa a **En Producción**; al finalizar "Embalaje Final", a **Finalizado** | automático |
| R7 | `duracion_minutos` = (fin − inicio) − tiempo en pausa | calculado al finalizar |

---

## 5. Exportación para Power BI

```
GET /api/export/registros.csv                → CSV con BOM (Excel/Power BI)
GET /api/export/registros.json               → JSON
GET /api/export/registros.csv?desde=2026-10-01&hasta=2026-10-31&sector_id=1&estado=Finalizado
```

Incluye `fecha_hora_inicio_utc` (para modelar sin ambigüedades) y
`fecha_hora_inicio_local` (hora real de planta). Detalle completo en **`docs/POWERBI.md`**.

---

## 6. API resumida

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/ordenes` | Lista de OTs con progreso y tiempo acumulado |
| POST | `/api/ordenes` | Alta de OT |
| PUT | `/api/ordenes/:id` | Edita OT (incluye `estado_general`) |
| DELETE | `/api/ordenes/:id` | Elimina OT (bloqueada si tiene etapas abiertas) |
| GET | `/api/sectores` | Sectores + etapas abiertas por sector |
| GET | `/api/estado?ot_id=` | Estado en vivo (etapas abiertas, actividad por sector) |
| GET | `/api/registros?ot_id=&estado=&desde=&hasta=` | Registros de tiempos |
| POST | `/api/registros` | **Iniciar etapa** |
| POST | `/api/registros/:id/pausar` | Pausar (motivo + observación) |
| POST | `/api/registros/:id/reanudar` | Reanudar |
| POST | `/api/registros/:id/finalizar` | Finalizar (calcula duración) |

Documento completo: **`docs/API.md`**.

---

## 7. Pruebas

```bat
.runtime\node\node.exe server\tools\prueba-api.js    " suite de la API (requiere el servidor arriba)
```

---

## 8. Estado y roadmap

**Incluido hasta la Fase 7:**

* Control de tiempos, pausas, métricas (FTT, lead time, cuellos de botella) y exportación a
  Power BI (Fases 1–6).
* Migración a **Supabase (PostgreSQL)** con transacciones reales para FTT / lead time /
  auto-cierre de OT (Fase 7).
* API como **Serverless Functions en Vercel** (`api/[...slug].js` + `vercel.json`).
* **PWA** instalable (manifest + service worker + iconos).
* **Hoja de Ruta imprimible** con QR y código de color por línea (Placares azul / Cocinas rojo).
* **Escaneo de QR** en la Terminal (`/?ot=…`) que precarga y bloquea la OT.
* Tablas base de autenticación (`usuarios`, `sesiones`) creadas como cimiento.

**Pendiente / futuro:**

* Login real con `usuarios`/`sesiones` y roles (operario / encargado / oficina técnica).
* Tablero OEE y tiempos por sector en el Dashboard.
* Copia de seguridad programada y multiusuario con bloqueo optimista.
