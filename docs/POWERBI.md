# Optiflow — Conexión con Power BI

Optiflow expone los registros de tiempos en dos formatos "llave en mano" para Power BI (o Excel):

```
http://<servidor>:<puerto>/api/export/registros.csv
http://<servidor>:<puerto>/api/export/registros.json
```

Ejemplos con filtros:

```
/api/export/registros.csv?desde=2026-10-01&hasta=2026-10-31
/api/export/registros.csv?sector_id=3&estado=Finalizado
/api/export/registros.json?numero_ot=OT-1710
```

### Acceso (auditoría V-1)

La exportación ya no es anónima. Power BI / Excel / scripts deben enviar el
**token de export** definido en la variable de entorno `OPTIFLOW_EXPORT_TOKEN`
(de lo contrario la API responde `401`):

```
/api/export/registros.csv?token=<TOKEN>&desde=2026-10-01&hasta=2026-10-31
```

Equivalente por header: `X-Optiflow-Token: <TOKEN>` (en Power Query,
`Web.Contents(url, [Headers=[#"X-Optiflow-Token"="…"]])`).
Si quien consume es un navegador con sesión iniciada en Optiflow, no hace falta
el token: se usa la cookie de sesión.

> Consejo: use un token largo y trátelo como contraseña; rote cambiando
> `OPTIFLOW_EXPORT_TOKEN` en el entorno (Vercel → Settings → Environment Variables).

---

## 1. Cómo cargarlo en Power BI Desktop

1. **Inicio → Obtener datos → Web → URL avanzada**.
2. Pegar la URL del CSV (por ejemplo `http://192.168.0.4:3000/api/export/registros.csv`).
3. En el editor, la primera fila se convierte en encabezados y los tipos se ajustan:
   * `metros_lineales` → Decimal
   * `duracion_minutos`, `duracion_horas` → Decimal
   * `fecha_hora_inicio_local`, `fecha_hora_fin_local` → Fecha/hora local
   * `fecha_hora_inicio_utc`, `fecha_hora_fin_utc` → Texto o Fecha/hora (UTC)
4. **Cargar** o **Transformar datos**.

Para actualizaciones automáticas: *Programar actualización → cada X minutos* en el gateway de datos.

> **JSON:** en Power Query, `Fuente = Json.Document(Web.Contents(url))` y luego expandir
> `registros`.

---

## 2. Columnas exportadas

| Columna | Tipo sugerido | Descripción |
|---|---|---|
| `id_registro` | Número | PK de `registros_tiempos` |
| `numero_ot` | Texto | Número de orden de trabajo |
| `cliente` | Texto | Cliente |
| `modelo` | Texto | Modelo |
| `metros_lineales` | Decimal | Metros lineales de la OT |
| `fecha_prometida` | Texto/Fecha | Fecha comprometida |
| `estado_ot` | Texto | `En Cola` / `En Producción` / `Detenido` / `Finalizado` |
| `linea_ot` | Texto | Línea de la OT: `Placares` / `Cocinas` (define qué sectores debe recorrer) |
| `sector` | Texto | Nombre completo del sector |
| `linea_area` | Texto | Línea/área **del sector**: `Placares` / `Cocinas` / `Compartido` / `General`. Los `Compartido` y `General` son los talleres que atienden a ambas líneas |
| `sector_compartido` | Texto | `SI` / `NO` (columna histórica) |
| `es_compartido` | Texto | `SI` / `NO` — el sector admite varias OTs a la vez |
| `operario` | Texto | Operario responsable |
| `fecha_hora_inicio_utc` | Fecha/hora (UTC) | Inicio según servidor |
| `fecha_hora_inicio_local` | Fecha/hora local | Inicio hora de planta |
| `fecha_hora_fin_utc` | Fecha/hora (UTC) | Fin (vacío si la etapa está abierta) |
| `fecha_hora_fin_local` | Fecha/hora local | Fin hora de planta |
| `duracion_minutos` | Decimal | Duración **neta** (descontadas las pausas) |
| `duracion_horas` | Decimal | Duración en horas (para promedios) |
| `ot_minutos_compartidos` | Decimal | Minutos netos acumulados por la OT en **sectores compartidos** (etapas cerradas) |
| `ot_minutos_estandar` | Decimal | Minutos netos acumulados por la OT en el **flujo propio de su línea** (no compartidos, etapas cerradas) |
| `estado_etapa` | Texto | `En Proceso` / `Pausado` / `Finalizado` |
| `motivo_pausa` | Texto | Motivo de la última pausa |
| `observacion` | Texto | Observación libre |

---

## 3. Medidas sugeridas (DAX)

```dax
Minutos totales = SUM ( Registros[duracion_minutos] )

Horas totales   = [Minutos totales] / 60

OT abiertas = DISTINCTCOUNT ( Registros[numero_ot] )

% de OTs finalizadas =
DIVIDE (
    CALCULATE ( DISTINCTCOUNT ( Registros[numero_ot] ), Registros[estado_ot] = "Finalizado" ),
    DISTINCTCOUNT ( Registros[numero_ot] )
)

Minutos de pausa =
CALCULATE (
    SUMX ( Filter ( Registros, [motivo_pausa] <> "" ), [duracion_minutos] )
)

// Compartido vs. estándar: ot_minutos_* es un atributo por OT repetido en
// cada fila; usar MAX por OT, nunca SUM.
Minutos compartidos por OT =
SUMX ( VALUES ( Registros[numero_ot] ),
       CALCULATE ( MAX ( Registros[ot_minutos_compartidos] ) ) )

Minutos estándar por OT =
SUMX ( VALUES ( Registros[numero_ot] ),
       CALCULATE ( MAX ( Registros[ot_minutos_estandar] ) ) )
```

Modelo recomendado: tabla `Registros` (hechos) + tabla `OTs` (dimensión, relacionando `numero_ot`)
+ tabla `Sectores` (dimensión, relacionando `sector`) + calendario con `fecha_hora_inicio_local`.

---

## 4. Consideraciones importantes

* Filtrar siempre por `linea_ot` cuando se comparan KPIs de sectores: una OT de
  Cocinas no recorre los sectores de Placares, así que sumar ambas líneas en un
  mismo "lead time por sector" mezcla flujos distintos. Para desglose, use
  `linea_area` (los sectores `Compartido`/`General` aparecen en ambas líneas).
* **No editar el CSV.** Es una instantánea por consulta; para tableros en vivo, reconsultar la URL.
* Los horarios se guardan en UTC en la base de datos: la columna `*_local` ya viene convertida a
  la hora de la planta del servidor, lista para mostrar.
* Etapas todavía abiertas salen con `fecha_hora_fin` vacío y `estado_etapa = En Proceso`;
  filtrar por `estado_etapa = "Finalizado"` para cierres definitivos.
* Las URLs son públicas dentro de la red interna (no hay autenticación en la Fase 1):
  publicar el servidor sólo en la red de planta.
