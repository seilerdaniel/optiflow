# Migración a Next.js — Fase 1

## Estrategia

OptiFlow se migra con el patrón **strangler**: Next.js toma la capa de
presentación y el servidor Node/PostgreSQL existente sigue siendo la fuente de
verdad de las reglas de negocio.

```
Navegador
   │
   ├── /admin/*      → Next.js (App Router, puerto 3001)
   ├── /terminal     → Next.js (App Router, puerto 3001)
   └── /api/*        → rewrite de Next.js → API Node (puerto 3000)
```

### Qué se preserva en el API

- R1-R22: sesión activa por OT/sector, sector ocupado, flujo, línea, sector
  desactivado, claves especiales y OT finalizada.
- Horas-hombre netas y descuento de pausas.
- Respuesta `409` con `detalle.accion` para conflictos de negocio.
- Auto-cierre de la OT al finalizar la última etapa requerida.
- Cómputo de metas de corte, proyección, ritmo y FTT.
- Esquema PostgreSQL de `supabase_schema.sql` (incluidas las tablas del
  despiece y del pañol creadas en la Fase 1 de Oficina Técnica).

Next.js **no reimplementa** esas reglas. La terminal y las pantallas
administrativas consumen los endpoints existentes.

## Scripts

| Comando | Uso |
| --- | --- |
| `npm run dev` | Levanta el API legado (3000) y Next.js (3001) con `concurrently`. |
| `npm run dev:api` | Sólo el API legado. |
| `npm run dev:web` | Sólo Next.js en 3001. |
| `npm run build` | Build de producción de Next.js. |
| `npm run start:web` | Sirve el build de Next.js en 3001. |
| `npm run typecheck` | `tsc --noEmit`. |

## Variables de entorno

- `OPTIFLOW_API_ORIGIN` (opcional): origen absoluto del API para el rewrite y
  los Server Components. Por defecto `http://127.0.0.1:3000`.
- `PORT` (opcional): puerto del API legado. Si se cambia, actualizar
  `OPTIFLOW_API_ORIGIN`.

## Autenticación y cookies

- El navegador llama a `/api/*` en el mismo origen (3001). El rewrite de Next
  reenvía la petición a 3000, de modo que la cookie de sesión viaja sin CORS ni
  cambios en el backend.
- Los Server Components usan `lib/api-server.ts`, que lee la cookie con
  `next/headers` y la reenvía al API.
- `public/login.html` sigue disponible en `/login.html`. El login redirige a
  `/admin` (gestión) o `/` (operario). `/admin` redirige a
  `/admin/dashboard`; `/` redirige a `/terminal`.

## Rutas implementadas

| Ruta | Pantalla |
| --- | --- |
| `/admin/dashboard` | KPIs, meta de corte, piso y OTs en curso. |
| `/admin/ordenes` | Listado filtrable de OTs y avance. |
| `/admin/oficina-tecnica/despiece` | Despiece por módulo, bultos, pañol y placas. |
| `/admin/materiales` | Catálogo de placas por familia, espesor y consumo. |
| `/admin/operarios` | Maestro de personal y actividad. |
| `/admin/sectores` | Flujos por línea, sectores compartidos y especiales. |
| `/admin/calidad` | QMS, no conformidades y FTT. |
| `/admin/mantenimiento` | TPM por horas netas y historial. |
| `/terminal` | Fichado táctil; acepta `?ot=<id>`. |

## Decisiones de Fase 1

- Tailwind CSS v3 con `tailwind.config.ts` (el formato pedido).
- Fuentes `Inter` y `JetBrains_Mono` vía `next/font/google`.
- Iconografía inline en `components/icons.tsx` para no sumar una dependencia.
- Sidebar: drawer en mobile, icon-rail de 64 px en tablet y 240-260 px en
  desktop; enlace activo con `usePathname()`.
- Terminal: controles con área táctil mínima de 56 px. Inicia y finaliza
  etapas contra el API; muestra el `409` con la acción sugerida.
- Las pantallas administrativas son de **lectura** en esta fase. Las
  mutaciones de OTs, materiales, operarios, sectores, QMS y TPM siguen en el
  panel legacy.

## Fase 2 sugerida

1. Grilla editable de despiece y pañol (POST/PATCH existentes).
2. Formularios de alta/edición de OTs y maestros.
3. Pausa/reanudación desde la terminal con motivo.
4. Tests de componentes y de integración con el API.
5. Evaluar el reemplazo gradual del API Node por Route Handlers de Next.js,
   manteniendo el mismo contrato y el mismo esquema.
