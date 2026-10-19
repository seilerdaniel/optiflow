# Sistema de diseño y accesibilidad (R20)

Optiflow es una aplicación **Vanilla JS + CSS nativo** con una única dependencia de
servidor (`pg`). Por esa restricción de proyecto **no se incorporó Tailwind CSS**
ni ningún runtime/CDN externo. El contrato que pedía un `tailwind.config.js`
( tokens, estados semánticos, tipografía y targets táctiles) se implementó en la
capa `:root` de `public/css/app.css`.

## Tokens semánticos

Los tokens originales (`--azul`, `--verde`, `--amarillo`, `--rojo`, etc.) **no se
renombran, eliminan ni modifican**. Sobre ellos se agregan alias estables:

| Token | Uso |
| --- | --- |
| `--success` / `--success-strong` | Estado conforme / acción iniciar |
| `--warning` / `--warning-strong` | Pausa, advertencia; el segundo es AA sobre ámbar claro |
| `--danger` / `--danger-strong` | Detenido, error, acción finalizar |
| `--info` / `--info-strong` | Información y acción reanudar |
| `--success-on-dark`, `--warning-on-dark`, `--danger-on-dark` | Texto de estado sobre `--bg-card` / `--bg-raised` |
| `--linea-placares-dark`, `--linea-cocinas-dark`, `--linea-compartidos-dark` | Acentos no-texto sobre superficie oscura |
| `--texto-apagado-aa` | Metadatos pequeños sobre superficie oscura (>= 4.5:1) |
| `--fs-display`, `--fs-kpi`, `--fs-h1..h3`, `--fs-sm`, `--fs-xs` | Jerarquía tipográfica |
| `--touch-min` (44px), `--touch-comfortable` (48px), `--touch-planta` (56px) | Objetivos táctiles |
| `--motion-fast/base/slow`, `--ease-salida` | Transiciones consistentes |

## Reglas de interacción

- **Touch targets:** `.btn-chico`, `.modal-cerrar`, `.corte-nav-btn`,
  `.estado-select`, `.btn-bug`, `.alerta-tpm-cerrar` y `.resultado-ot` tienen
  mínimo 44px. La terminal eleva botones/campos a 56px.
- **Foco visible:** anillo cian de 3px + offset en `:focus-visible`, reforzado en
  formularios, buscador, panel industrial y modales. No se usa `:focus` para
  pintar el anillo (evita ruido con clic/táctil).
- **Modales:** al abrir se enfoca el primer control, Tab/Shift+Tab quedan
  atrapados dentro del diálogo y al cerrar se restaura el foco anterior.
- **Carga:** `.spinner`, `.skeleton`, `.cargando-overlay` y `aria-busy` para
  cambios de año, detalle de OT y guardados asíncronos.
- **Movimiento reducido:** `prefers-reduced-motion` desactiva animaciones y
  transiciones; los skeletons conservan su forma estática.
- **Alto contraste:** `forced-colors` usa `ButtonText` / `Highlight` del sistema.

## Impresión

- `@media print` oculta topbar, sidebar, acciones, botones, modales, avisos y
  alertas. `body.imprimiendo` aísla la Hoja de Ruta en `#capa-impresion`.
- El QR de la Hoja de Ruta mide 3.4cm y tiene un mínimo explícito de **2×2cm**.
- Se fuerza `print-color-adjust: exact` para conservar encabezados de línea y
  se evita el corte de bloques/tablas con `break-inside: avoid`.

## Contraste verificado

Pares críticos comprobados con fórmula WCAG 2.x:

| Combinación | Ratio |
| --- | --- |
| Texto principal `#16222e` sobre `#eef2f6` | 14.33:1 |
| Texto suave `#5b6b7a` sobre blanco | 5.48:1 |
| Blanco sobre `--acento #1d6fd1` | 4.95:1 |
| Blanco sobre `--verde-osc #12813b` | 4.97:1 (acción iniciar / toast ok) |
| Blanco sobre `--rojo #dc2626` | 4.83:1 |
| `--warning-strong #7a4f00` sobre `#fef3c7` | >= 4.5:1 |
| `--texto-apagado-aa #9AA1AC` sobre `--bg-raised #2b2e33` | >= 4.5:1 |
| `--danger-on-dark #FF8A8A` sobre `--bg-raised` | >= 4.5:1 |

> El detalle de contrastes se puede reproducir con cualquier calculadora WCAG;
> no se añadió ninguna dependencia al proyecto para verificarlo.
