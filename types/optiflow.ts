/**
 * Contratos de dominio de OptiFlow.
 *
 * Estos tipos describen EXACTAMENTE lo que expone el API Node/PostgreSQL
 * existente. No redefinen reglas de negocio: la fuente de verdad sigue siendo
 * `server/` (R1-R22, horas-hombre netas, 409 de sesión activa, auto-cierre de
 * OTs y cómputo de metas).
 */

/* ------------------------------------------------------------------ */
/* Catálogos base                                                      */
/* ------------------------------------------------------------------ */

/** Línea de una OT. Define qué flujo de sectores debe recorrer. */
export type LineaOT = 'Placares' | 'Cocinas';

/** Línea/área de un sector. `Compartido` y `General` aplican a ambas líneas. */
export type LineaArea = LineaOT | 'Compartido' | 'General';

export type EstadoOT = 'En Cola' | 'En Producción' | 'Detenido' | 'Finalizado';

export type EstadoEtapa = 'En Proceso' | 'Pausado' | 'Finalizado';

export type ClaveEspecial = 'vidrio' | 'lustre' | 'herreria' | 'especiales';

export type MotivoPausa =
  | 'Falta de herrajes'
  | 'Error de plano'
  | 'Ajuste de herramienta'
  | 'Rotura de placa'
  | 'Otro';

export type TipoFalla =
  | 'Rotura de placa / Astillado'
  | 'Error de veta'
  | 'Defecto de laca / Lustre'
  | 'Falla de mecanizado / Cota'
  | 'Error de plano'
  | 'Otro';

export type EstadoNoConformidad = 'Pendiente' | 'En Reproceso' | 'Resuelto' | 'Descartado';

export type EstadoTPM = 'ok' | 'advertencia' | 'critico';

/* ------------------------------------------------------------------ */
/* Sectores                                                            */
/* ------------------------------------------------------------------ */

export interface Sector {
  id: number;
  nombre_sector: string;
  nombre_corto: string;
  es_compartido: boolean;
  clave_especial: ClaveEspecial | null;
  linea_area: LineaArea;
  orden_flujo: number;
  /** Texto libre del maestro: "José" o "Joel, Tiago"; null si no hay sugeridos. */
  operarios_sugeridos: string | null;
  activo: boolean;
  /** Enriquecimiento de `GET /api/sectores`: etapas abiertas ahora mismo. */
  etapas_abiertas?: number;
  /** Enriquecimiento de `GET /api/sectores`: OTs con etapas abiertas. */
  ordenes_activas?: string[];
}

/* ------------------------------------------------------------------ */
/* Operarios                                                           */
/* ------------------------------------------------------------------ */

export interface Operario {
  id: number;
  nombre: string;
  activo: boolean;
  fecha_creacion: string;
  /** Enriquecimiento de `GET /api/operarios?todos=1`. */
  etapas?: number;
  etapas_abiertas?: number;
  ultima_actividad?: string | null;
}

/* ------------------------------------------------------------------ */
/* Materiales                                                          */
/* ------------------------------------------------------------------ */

export interface MaterialOT {
  id: number;
  ot_id: number;
  material_nombre: string;
  cantidad_placas: number;
  cantidad_consumida: number;
  placas_restantes: number;
  observaciones: string | null;
  fecha_actualizacion: string;
}

export interface ResumenMateriales {
  lineas: number;
  placas_requeridas: number;
  placas_consumidas: number;
  placas_restantes: number;
  porcentaje_consumo: number;
}

export interface MaterialCatalogoItem {
  material_nombre: string;
  familia: string;
  espesor_mm: number | null;
  placas_requeridas: number;
  placas_consumidas: number;
  placas_restantes: number;
  pct_consumo: number;
  ots_usan: number;
  ultima_fecha: string | null;
}

export interface ResumenFamiliaMaterial {
  familia: string;
  materiales: number;
  requeridas: number;
  consumidas: number;
}

export interface MaterialCatalogoResponse {
  total: number;
  espesores_disponibles: number[];
  resumen_familias: ResumenFamiliaMaterial[];
  catalogo: MaterialCatalogoItem[];
  nota: string;
}

/* ------------------------------------------------------------------ */
/* Registros de tiempo (fichaje)                                       */
/* ------------------------------------------------------------------ */

export interface RegistroTiempo {
  id: number;
  ot_id: number;
  sector_id: number;
  operario_nombre: string;
  fecha_hora_inicio: string;
  fecha_hora_fin: string | null;
  duracion_minutos: number | null;
  /** Horas-hombre netas: (minutos netos / 60), sin contar pausas. */
  horas_hombre: number | null;
  estado_etapa: EstadoEtapa;
  motivo_pausa: MotivoPausa | null;
  observacion: string | null;
  pausa_inicio: string | null;
  segundos_pausados: number;
  fecha_hora_inicio_local?: string | null;
  fecha_hora_fin_local?: string | null;
  pausa_inicio_local?: string | null;
  numero_ot?: string;
  cliente?: string;
  modelo?: string;
  nombre_sector?: string;
  nombre_corto?: string;
  /** Derivado por `GET /api/estado` para etapas abiertas. */
  minutos_transcurridos?: number | null;
}

export interface ActividadSector {
  sector_id: number;
  nombre_sector: string;
  abiertas: number;
  ordenes_activas: string[];
}

export interface EstadoPlanta {
  ahora: string;
  etapas_abiertas: RegistroTiempo[];
  actividad_sectores: ActividadSector[];
}

/* ------------------------------------------------------------------ */
/* Órdenes de trabajo                                                  */
/* ------------------------------------------------------------------ */

export interface ProgresoOT {
  sectores_requeridos: number;
  sectores_finalizados: number;
  porcentaje: number;
  finalizados_ids: number[];
}

export interface SectorActualOT {
  id: number;
  sector_id: number;
  nombre_sector: string | null;
  nombre_corto: string | null;
  estado_etapa: EstadoEtapa;
  fecha_hora_inicio: string;
}

export interface OrdenTrabajo {
  id: number;
  numero_ot: string;
  cliente: string;
  modelo: string | null;
  linea_area: LineaOT;
  metros_lineales: number;
  /** Fecha de compromiso en formato YYYY-MM-DD. */
  fecha_prometida: string | null;
  requiere_vidrio: boolean;
  requiere_lustre: boolean;
  requiere_herreria: boolean;
  requiere_especiales: boolean;
  estado_general: EstadoOT;
  fecha_creacion: string;
  fecha_actualizacion: string;

  /* Enriquecimiento de `GET /api/ordenes` y `GET /api/ordenes/:id`. */
  sectores_requeridos?: number[];
  progreso?: ProgresoOT;
  minutos_acumulados?: number;
  etapa_activa?: RegistroTiempo | null;
  sectores_bloqueados?: Record<string, string>;
  sector_actual?: SectorActualOT | null;
  etapas_completadas?: number[];
  total_etapas_completadas?: number;
  materiales?: MaterialOT[];
  resumen_materiales?: ResumenMateriales;
  alertas?: NoConformidad[];
  alertas_abiertas?: number;
  /** Sólo presente en `GET /api/ordenes/:id`. */
  registros?: RegistroTiempo[];
}

export interface OrdenesResponse {
  total: number;
  ordenes: OrdenTrabajo[];
}

/** Body de `POST /api/ordenes` (alta desde Oficina Técnica). */
export interface CrearOTPayload {
  numero_ot: string;
  cliente: string;
  modelo?: string | null;
  linea_area: LineaOT;
  metros_lineales: number;
  fecha_prometida?: string | null;
  requiere_vidrio?: boolean;
  requiere_lustre?: boolean;
  requiere_herreria?: boolean;
  requiere_especiales?: boolean;
}

export type RolUsuario = 'admin' | 'encargado' | 'operario';

export interface UsuarioSesion {
  id: number;
  usuario: string;
  nombre: string;
  rol: RolUsuario;
}

/** Respuesta de `GET /api/auth/usuario` (200 siempre; `usuario` puede ser null). */
export interface UsuarioActualResponse {
  ok: boolean;
  usuario: UsuarioSesion | null;
}

/** Cabecera reducida que devuelve `GET /api/ot/:id/despiece`. */
export type OrdenTrabajoDespiece = Pick<
  OrdenTrabajo,
  | 'id'
  | 'numero_ot'
  | 'cliente'
  | 'modelo'
  | 'linea_area'
  | 'metros_lineales'
  | 'estado_general'
  | 'fecha_prometida'
  | 'requiere_lustre'
>;

/* ------------------------------------------------------------------ */
/* Oficina Técnica: despiece, bultos y pañol                           */
/* ------------------------------------------------------------------ */

export interface DespiecePieza {
  id: number;
  modulo_id: number;
  mueble_numero: number;
  modulo_numero: number;
  nombre_modulo: string;
  numero_bulto: number;
  tipo_pieza: string;
  nombre_pieza: string;
  cantidad: number;
  ancho_mm: number;
  profundidad_mm: number;
  espesor_mm: number;
  tipo_placa: string;
  color_codigo: string;
  es_laqueado: boolean;
  es_enchapado: boolean;
  filos_cantidad: number;
  filos_detalle: string | null;
  /** Observación libre de la pieza: "Con Led", "Veta horizontal", etc. */
  observacion?: string | null;
  cargado_en_flete: boolean;
  fecha_cargado: string | null;
}

export interface DespieceModulo {
  id: number;
  mueble_numero: number;
  modulo_numero: number;
  nombre_modulo: string;
  metros_lineales: number;
  posee_puertas_vidrio_rometal: boolean;
  cantidad_cajoneras: number;
  observaciones: string | null;
  /** Anidado por `GET /api/ot/:id/despiece`. */
  piezas: DespiecePieza[];
}

export interface HerrajeItem {
  id: number;
  ot_id: number;
  mueble_numero: number;
  herraje_nombre: string;
  codigo_sku: string | null;
  cantidad: number;
  entregado_por_panol: boolean;
  observaciones: string | null;
}

export interface ResumenPlaca {
  tipo_placa: string;
  espesor_mm: number;
  color_codigo: string;
  filas: number;
  piezas: number;
  laqueadas: number;
  m2: number;
}

/**
 * Bulto del control de despacho. `numero_bulto` es secuencial por OT y lo
 * asigna el servidor; el cliente nunca lo impone.
 */
export interface BultoDespacho {
  numero_bulto: number;
  /** Módulos que componen el bulto, ej. "M1 · Mód. 2 (Vestidor)". */
  descripcion: string;
  cantidad_piezas: number;
  cargado_en_flete: boolean;
}

export interface ResumenBulto extends BultoDespacho {
  filas: number;
  unidades: number;
  m2: number;
  /** Alias histórico de `cargado_en_flete`. */
  cargado: boolean;
  fecha_cargado: string | null;
  modulos: string[];
}

export interface ResumenDespiece {
  modulos: number;
  filas_piezas: number;
  piezas: number;
  bultos: number;
  m2: number;
  laqueadas: number;
  herrajes: number;
  unidades_herrajes: number;
}

export interface DespieceOT {
  ot: OrdenTrabajoDespiece;
  modulos: DespieceModulo[];
  piezas: DespiecePieza[];
  herrajes: HerrajeItem[];
  resumen_placas: ResumenPlaca[];
  bultos: ResumenBulto[];
  resumen: ResumenDespiece;
}

/* ------------------------------------------------------------------ */
/* Calidad (QMS)                                                       */
/* ------------------------------------------------------------------ */

export interface NoConformidad {
  id: number;
  ot_id: number;
  numero_ot: string | null;
  cliente: string | null;
  linea_area: LineaArea | null;
  sector_id: number;
  nombre_sector: string | null;
  operario_responsable: string | null;
  encargado_reporta: string;
  tipo_falla: TipoFalla;
  observacion: string | null;
  foto_url: string | null;
  estado: EstadoNoConformidad;
  accion_correctiva: string | null;
  resuelto_por: string | null;
  fecha_resolucion: string | null;
  fecha_resolucion_local: string | null;
  fecha_registro: string;
  fecha_registro_local: string | null;
}

export interface QMSResumen {
  periodo: string;
  desde: string;
  hasta: string;
  total_mes: number;
  pendientes: number;
  en_reproceso: number;
  resueltas_mes: number;
  descartadas_mes: number;
  abiertas: number;
  por_tipo: Array<{ tipo_falla: TipoFalla; cantidad: number }>;
  tipo_mas_recurrente: { tipo_falla: TipoFalla; cantidad: number } | null;
  ftt: {
    evaluadas: number;
    conformes: number;
    porcentaje: number | null;
  };
}

export interface QMSFiltros {
  ot_id: string | null;
  sector_id: string | null;
  estado: EstadoNoConformidad | null;
  tipo_falla: TipoFalla | null;
  desde: string | null;
  hasta: string | null;
  limite: number;
}

export interface QMSResponse {
  no_conformidades: NoConformidad[];
  resumen: QMSResumen;
  filtros: QMSFiltros;
}

/* ------------------------------------------------------------------ */
/* Mantenimiento preventivo (TPM)                                      */
/* ------------------------------------------------------------------ */

export interface MaquinaTPM {
  id: number;
  sector_id: number;
  nombre_sector: string | null;
  linea_area: LineaArea | null;
  nombre_maquina: string;
  tarea_mantenimiento: string;
  intervalo_horas_target: number;
  horas_acumuladas_sector: number;
  horas_ultimo_mantenimiento: number;
  horas_desde_ultimo_mantenimiento: number;
  horas_restantes: number;
  pct_uso: number;
  estado: EstadoTPM;
  activo: boolean;
}

export interface HistorialMantenimiento {
  id: number;
  maquina_tpm_id: number;
  nombre_maquina: string | null;
  tarea_mantenimiento: string | null;
  nombre_sector: string | null;
  tecnico_operario: string;
  fecha_hora: string;
  horas_acumuladas_al_service: number;
  observaciones: string | null;
}

export interface TPMResumen {
  total: number;
  ok: number;
  advertencia: number;
  critico: number;
  inactivas: number;
}

export interface TPMResponse {
  maquinas: MaquinaTPM[];
  historial: HistorialMantenimiento[];
  resumen: TPMResumen;
}

export interface TPMEstadoResponse {
  maquinas: MaquinaTPM[];
  criticas: MaquinaTPM[];
  advertencias: MaquinaTPM[];
}

/* ------------------------------------------------------------------ */
/* Metas de corte                                                      */
/* ------------------------------------------------------------------ */

export interface MetaCorte {
  totales: number;
  placares: number;
  cocinas: number;
  unidades: number | null;
  monto: number | null;
}

export interface SerieMeta {
  fecha: string;
  metros: number;
  acumulado: number;
  ideal: number | null;
  ideal_acumulado: number | null;
}

export interface MetaPorLinea {
  linea: LineaOT;
  meta: number;
  cortados: number;
  porcentaje: number | null;
}

/**
 * Respuesta de `GET /api/metricas/objetivo-corte`.
 *
 * `porcentaje`, `diferencia_proyeccion` e `ideal*` llegan en `null` cuando el
 * período no tiene meta configurada. No inventar ceros en la UI.
 */
export interface MetricasObjetivo {
  periodo: string;
  es_mes_en_curso: boolean;
  meta_configurada: boolean;
  meta: MetaCorte;
  categoria_o_area: string | null;
  cortados: number;
  porcentaje: number | null;
  dias: {
    transcurridos: number;
    totales: number;
    restantes: number;
  };
  ritmo_diario: number;
  ritmo_necesario: number;
  proyeccion_cierre: number;
  diferencia_proyeccion: number | null;
  por_linea: MetaPorLinea[];
  serie: SerieMeta[];
  ots_contadas: number;
  generado_en: string;
}

/* ------------------------------------------------------------------ */
/* Respuestas de catálogos                                             */
/* ------------------------------------------------------------------ */

export interface SectoresResponse {
  total: number;
  incluye_inactivos: boolean;
  sectores: Sector[];
}

export interface OperariosResponse {
  total: number;
  operarios: Operario[];
}

/* ------------------------------------------------------------------ */
/* Fichaje (terminal)                                                  */
/* ------------------------------------------------------------------ */

export interface IniciarEtapaPayload {
  ot_id: number;
  sector_id: number;
  operario_nombre: string;
}

export interface IniciarEtapaResponse {
  registro: RegistroTiempo;
}
