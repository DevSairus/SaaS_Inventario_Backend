// backend/src/services/payroll/payrollService.js
/**
 * Motor de liquidación de nómina — Fase 1 del plan de Nómina Electrónica.
 *
 * Calcula, para un Employee y un PayrollPeriod dados, el objeto
 * `liquidation` exacto que consume payrollXmlBuilder.js#buildPayrollXml()
 * (mismos nombres de sub-objeto: devengados.basico, deducciones.salud, etc.)
 *
 * Responsabilidades:
 *  1. Devengados/deducciones LEGALES obligatorios, calculados automáticamente:
 *     Básico (prorrateado por días trabajados), Auxilio de Transporte
 *     (si aplica), Salud (4%), Fondo de Pensión (4%), Fondo de Solidaridad
 *     Pensional (si el salario >= 4 SMLMV).
 *  2. Todo lo demás (horas extra, bonificaciones, licencias, libranzas,
 *     comisiones, etc.) se recibe como "novedades" ya estructuradas desde
 *     el llamador (frontend/controller) — este servicio NO inventa esos
 *     valores, los clasifica según el `dian_category` del PayrollConcept
 *     correspondiente y los acumula en los totales.
 *
 * Los porcentajes y topes de seguridad social están en PAYROLL_CONSTANTS
 * más abajo, con su fuente y fecha de vigencia — deben revisarse cada vez
 * que el Gobierno actualice el SMLMV/auxilio de transporte (usualmente cada
 * 1 de enero, por decreto).
 */
'use strict';

/* ──────────────────────────────────────────────────────────
 * Constantes legales vigentes
 * ────────────────────────────────────────────────────────── */

// Vigentes desde el 1 de enero de 2026 (Decretos 1469 y 1470 del
// 29-dic-2025, ratificados por el Decreto transitorio 0159 del 19-feb-2026
// tras la suspensión provisional del Consejo de Estado sobre el Decreto
// 1469). Actualizar cada vez que cambie el SMLMV/auxilio de transporte.
const PAYROLL_CONSTANTS = {
  SMLMV: 1750905,
  AUXILIO_TRANSPORTE: 249095,
  TOPE_AUXILIO_TRANSPORTE_SMLMV: 2, // aplica a quien devengue hasta 2 SMLMV
  PORCENTAJE_SALUD_EMPLEADO: 4,
  PORCENTAJE_PENSION_EMPLEADO: 4,
  // Fondo de Solidaridad Pensional (Ley 100/1993 Art. 27-28, Ley 797/2003) —
  // tramos estables desde hace años, no ligados al Anexo DIAN sino a la
  // legislación pensional. MEJOR ESFUERZO: verificar contra la normativa
  // vigente del período que se esté liquidando, no solo contra este archivo.
  FSP_TRAMOS: [
    { desdeSMLMV: 4, hastaSMLMV: 16, porcentaje: 1.0 },
    { desdeSMLMV: 16, hastaSMLMV: 17, porcentaje: 1.2 },
    { desdeSMLMV: 17, hastaSMLMV: 18, porcentaje: 1.4 },
    { desdeSMLMV: 18, hastaSMLMV: 19, porcentaje: 1.6 },
    { desdeSMLMV: 19, hastaSMLMV: 20, porcentaje: 1.8 },
    { desdeSMLMV: 20, hastaSMLMV: Infinity, porcentaje: 2.0 },
  ],
  DIAS_MES_COMERCIAL: 30, // convención estándar de nómina colombiana: mes de 30 días, sin importar el mes calendario real
  // Tope legal de horas extra — Código Sustantivo del Trabajo Art. 22 (mod.
  // Ley 2101/2021) y Art. 51: máximo 2 horas extra diarias y 12 horas
  // extra semanales por trabajador (salvo autorización especial del
  // Ministerio del Trabajo para casos excepcionales, que este cálculo no
  // contempla). Vigente en 2026, sin cambios recientes sobre este tope
  // específico (a diferencia de los porcentajes de recargo, que sí
  // cambiaron con la Ley 2466/2025).
  HORAS_EXTRA_TOPE_DIARIO: 2,
  HORAS_EXTRA_TOPE_SEMANAL: 12,
};

// Categorías DIAN que son horas EXTRA propiamente (trabajo por encima de
// la jornada ordinaria, sujeto al tope legal de 2h/día y 12h/semana). Las
// categorías "HRNs"/"HRDDFs"/"HRNDFs" son RECARGO sobre jornada ordinaria
// (trabajar de noche, o trabajar en domingo/festivo dentro del horario
// normal) — no son horas extra y no cuentan para este tope.
const CATEGORIAS_HORAS_EXTRA = new Set(['HEDs', 'HENs', 'HEDDFs', 'HENDFs']);

/* ──────────────────────────────────────────────────────────
 * Helpers de fechas — convención de "días comerciales" (mes de 30 días)
 * estándar en liquidación de nómina colombiana.
 * ────────────────────────────────────────────────────────── */

function toDate(d) {
  return d instanceof Date ? d : new Date(`${d}T00:00:00`);
}

// Días entre dos fechas bajo la convención comercial de 30 días/mes,
// AMBAS fechas inclusive (ej. 1 al 30 de un mismo mes = 30 días, no 29).
function diasComerciales(fechaInicio, fechaFin) {
  const a = toDate(fechaInicio);
  const b = toDate(fechaFin);
  const d1 = Math.min(a.getDate(), 30);
  const d2 = Math.min(b.getDate(), 30);
  const dias = (b.getFullYear() - a.getFullYear()) * 360
    + (b.getMonth() - a.getMonth()) * 30
    + (d2 - d1) + 1;
  return Math.max(0, dias);
}

/* ──────────────────────────────────────────────────────────
 * 1. Básico — prorrateado por días trabajados en el periodo
 * ────────────────────────────────────────────────────────── */

/**
 * @param {object} employee - instancia Employee
 * @param {object} period - instancia PayrollPeriod
 * @param {number} diasNoRemunerados - días del periodo NO pagados
 *   (licencia no remunerada, suspensión, ausencia injustificada) ya
 *   sumados desde las novedades del periodo — se restan del básico.
 */
function calcularBasico(employee, period, diasNoRemunerados = 0) {
  const inicioPeriodo = toDate(period.start_date);
  const finPeriodo = toDate(period.end_date);
  const diasPeriodoCompleto = diasComerciales(period.start_date, period.end_date);

  // Fecha efectiva de inicio: la mayor entre inicio del periodo y fecha de
  // ingreso (si el empleado ingresó a mitad del periodo).
  const fechaIngreso = toDate(employee.hire_date);
  const efectivoInicio = fechaIngreso > inicioPeriodo ? fechaIngreso : inicioPeriodo;

  // Fecha efectiva de fin: la menor entre fin del periodo y fecha de
  // retiro (si el empleado se retiró a mitad del periodo).
  let efectivoFin = finPeriodo;
  if (employee.termination_date) {
    const fechaRetiro = toDate(employee.termination_date);
    if (fechaRetiro < finPeriodo) efectivoFin = fechaRetiro;
  }

  let diasTrabajados = efectivoFin >= efectivoInicio
    ? diasComerciales(efectivoInicio, efectivoFin)
    : 0;
  diasTrabajados = Math.max(0, diasTrabajados - diasNoRemunerados);
  diasTrabajados = Math.min(diasTrabajados, diasPeriodoCompleto);

  const sueldoTrabajado = (Number(employee.base_salary) / PAYROLL_CONSTANTS.DIAS_MES_COMERCIAL) * diasTrabajados;

  return { diasTrabajados, sueldoTrabajado, diasPeriodoCompleto };
}

/* ──────────────────────────────────────────────────────────
 * 2. Auxilio de transporte
 * ────────────────────────────────────────────────────────── */

function calcularAuxilioTransporte(employee, diasTrabajados, diasPeriodoCompleto) {
  if (!employee.transport_allowance_eligible) return null;
  const tope = PAYROLL_CONSTANTS.SMLMV * PAYROLL_CONSTANTS.TOPE_AUXILIO_TRANSPORTE_SMLMV;
  if (Number(employee.base_salary) > tope) return null;
  if (employee.salary_type === 'integral') return null; // salario integral no tiene derecho a auxilio de transporte (ya incluido en el factor prestacional)

  const auxilioTransporte = (PAYROLL_CONSTANTS.AUXILIO_TRANSPORTE / diasPeriodoCompleto) * diasTrabajados;
  return { auxilioTransporte };
}

/* ──────────────────────────────────────────────────────────
 * 3. Deducciones legales obligatorias — Salud, Pensión, FSP
 * IBC (Ingreso Base de Cotización) = sueldoTrabajado del Básico prorrateado
 * del periodo. MEJOR ESFUERZO: en la práctica el IBC puede incluir otros
 * devengados salariales del periodo (comisiones, etc.) según el caso — este
 * cálculo cubre el caso base (solo salario). Si el tenant tiene devengados
 * salariales adicionales que deban integrar el IBC, ajustar antes de
 * habilitación.
 * ────────────────────────────────────────────────────────── */

function calcularDeduccionesLegales(employee, ibc) {
  const salud = {
    porcentaje: PAYROLL_CONSTANTS.PORCENTAJE_SALUD_EMPLEADO,
    deduccion: ibc * (PAYROLL_CONSTANTS.PORCENTAJE_SALUD_EMPLEADO / 100),
  };
  const fondoPension = {
    porcentaje: PAYROLL_CONSTANTS.PORCENTAJE_PENSION_EMPLEADO,
    deduccion: ibc * (PAYROLL_CONSTANTS.PORCENTAJE_PENSION_EMPLEADO / 100),
  };

  let fondoSP = null;
  const salarioMensualEquivalente = Number(employee.base_salary); // el FSP se evalúa sobre el salario, no sobre el IBC prorrateado del periodo parcial
  const smlmvRatio = salarioMensualEquivalente / PAYROLL_CONSTANTS.SMLMV;
  const tramo = PAYROLL_CONSTANTS.FSP_TRAMOS.find(t => smlmvRatio >= t.desdeSMLMV && smlmvRatio < t.hastaSMLMV);
  if (tramo) {
    fondoSP = { porcentaje: tramo.porcentaje, deduccionSP: ibc * (tramo.porcentaje / 100) };
  }

  return { salud, fondoPension, fondoSP };
}

/* ──────────────────────────────────────────────────────────
 * 4. Novedades — clasificación por dian_category del PayrollConcept
 *
 * Cada novedad viene del llamador como:
 *   { concept_id, dian_category, payload: {...} }
 * donde `payload` ya trae los campos exactos que espera el sub-builder de
 * payrollXmlBuilder.js correspondiente (ej. para dian_category='HEDs':
 *   { horaInicio, horaFin, cantidad, porcentaje, pago }).
 * Este servicio NO recalcula porcentajes de recargo ni valida horarios —
 * esa responsabilidad es del formulario de captura de novedades (Fase 3,
 * PayrollPeriodsPage.jsx), que conoce la tabla 5.5.5 del Anexo y las
 * reglas de negocio del tenant. Aquí solo se clasifica y suma.
 * ────────────────────────────────────────────────────────── */

// Mapea dian_category (PayrollConcept) → { bucket: 'devengados'|'deducciones', kind: 'array'|'single'|'simpleList', key }
const DIAN_CATEGORY_MAP = {
  // Devengados — grupos de arreglo
  HEDs: { bucket: 'devengados', kind: 'array', key: 'heds' },
  HENs: { bucket: 'devengados', kind: 'array', key: 'hens' },
  HRNs: { bucket: 'devengados', kind: 'array', key: 'hrns' },
  HEDDFs: { bucket: 'devengados', kind: 'array', key: 'heddfs' },
  HRDDFs: { bucket: 'devengados', kind: 'array', key: 'hrddfs' },
  HENDFs: { bucket: 'devengados', kind: 'array', key: 'hendfs' },
  HRNDFs: { bucket: 'devengados', kind: 'array', key: 'hrndfs' },
  Incapacidades: { bucket: 'devengados', kind: 'array', key: 'incapacidades' },
  Bonificaciones: { bucket: 'devengados', kind: 'array', key: 'bonificaciones' },
  Auxilios: { bucket: 'devengados', kind: 'array', key: 'auxilios' },
  HuelgasLegales: { bucket: 'devengados', kind: 'array', key: 'huelgasLegales' },
  OtrosConceptos: { bucket: 'devengados', kind: 'array', key: 'otrosConceptos' },
  Compensaciones: { bucket: 'devengados', kind: 'array', key: 'compensaciones' },
  BonoEPCTVs: { bucket: 'devengados', kind: 'array', key: 'bonoEPCTVs' },
  // Devengados — listas de valor simple
  Comisiones: { bucket: 'devengados', kind: 'simpleList', key: 'comisiones' },
  PagosTercerosDevengados: { bucket: 'devengados', kind: 'simpleList', key: 'pagosTerceros' },
  AnticiposDevengados: { bucket: 'devengados', kind: 'simpleList', key: 'anticipos' },
  // Devengados — elementos simples 0-1
  Dotacion: { bucket: 'devengados', kind: 'single', key: 'dotacion' },
  ApoyoSost: { bucket: 'devengados', kind: 'single', key: 'apoyoSost' },
  Teletrabajo: { bucket: 'devengados', kind: 'single', key: 'teletrabajo' },
  BonifRetiro: { bucket: 'devengados', kind: 'single', key: 'bonifRetiro' },
  Indemnizacion: { bucket: 'devengados', kind: 'single', key: 'indemnizacion' },
  ReintegroDevengado: { bucket: 'devengados', kind: 'single', key: 'reintegro' },
  Primas: { bucket: 'devengados', kind: 'object', key: 'primas' },
  Cesantias: { bucket: 'devengados', kind: 'object', key: 'cesantias' },
  Vacaciones: { bucket: 'devengados', kind: 'object', key: 'vacaciones', merge: true },
  Licencias: { bucket: 'devengados', kind: 'object', key: 'licencias', merge: true },
  // Deducciones — grupos de arreglo
  Sindicatos: { bucket: 'deducciones', kind: 'array', key: 'sindicatos' },
  Sanciones: { bucket: 'deducciones', kind: 'array', key: 'sanciones' },
  Libranza: { bucket: 'deducciones', kind: 'array', key: 'libranzas' },
  PagosTercerosDeducciones: { bucket: 'deducciones', kind: 'array', key: 'pagosTerceros' },
  AnticiposDeducciones: { bucket: 'deducciones', kind: 'array', key: 'anticipos' },
  OtrasDeducciones: { bucket: 'deducciones', kind: 'simpleList', key: 'otrasDeducciones' },
  // Deducciones — elementos simples 0-1
  PensionVoluntaria: { bucket: 'deducciones', kind: 'single', key: 'pensionVoluntaria' },
  RetencionFuente: { bucket: 'deducciones', kind: 'single', key: 'retencionFuente' },
  AFC: { bucket: 'deducciones', kind: 'single', key: 'afc' },
  Cooperativa: { bucket: 'deducciones', kind: 'single', key: 'cooperativa' },
  EmbargoFiscal: { bucket: 'deducciones', kind: 'single', key: 'embargoFiscal' },
  PlanComplementarios: { bucket: 'deducciones', kind: 'single', key: 'planComplementarios' },
  Educacion: { bucket: 'deducciones', kind: 'single', key: 'educacion' },
  ReintegroDeduccion: { bucket: 'deducciones', kind: 'single', key: 'reintegro' },
  Deuda: { bucket: 'deducciones', kind: 'single', key: 'deuda' },
};

// Suma numérica recursiva de un valor de novedad (para acumular en los
// totales), sin importar si es number, {pago:...}, {cantidad,pago:...} etc.
// Se listan explícitamente los campos "de valor monetario" conocidos por
// tipo de grupo para no sumar por accidente cosas como @Cantidad o
// @Porcentaje, que NO son plata.
const CAMPOS_MONETARIOS = new Set([
  'pago', 'pagoNS', 'sueldoTrabajado', 'auxilioTransporte', 'viaticoManuAlojS', 'viaticoManuAlojNS',
  'pagoIntereses', 'bonificacionS', 'bonificacionNS', 'auxilioS', 'auxilioNS',
  'conceptoS', 'conceptoNS', 'compensacionO', 'compensacionE',
  'pagoS', 'pagoAlimentacionS', 'pagoAlimentacionNS',
  'deduccion', 'deduccionSP', 'deduccionSub', 'sancionPublic', 'sancionPriv',
]);

// BUG CORREGIDO: para categorías 'object' con merge:true (Vacaciones,
// Licencias) el payload real es {comunes:[...], compensadas:[...]} /
// {maternidadPaternidad:[...], remunerada:[...], noRemunerada:[...]} --
// arreglos ANIDADOS dentro de un objeto plano, no un arreglo en el
// primer nivel. La versión anterior solo recursaba cuando `payload` en sí
// era un array, así que el `Object.entries` del objeto contenedor
// filtraba por CAMPOS_MONETARIOS sobre claves como "comunes"/"compensadas"
// (que nunca están en ese set) y sumaba 0 -- unas vacaciones compensadas
// pagadas no sumaban al total devengado ni aparecían en el resumen de
// impresión. Ahora, si un valor de esa recorrida es un arreglo, se
// recursa en vez de descartarlo.
function sumarValorNovedad(payload) {
  if (payload == null) return 0;
  if (typeof payload === 'number') return payload;
  if (Array.isArray(payload)) return payload.reduce((s, v) => s + sumarValorNovedad(v), 0);
  if (typeof payload === 'object') {
    return Object.entries(payload)
      .reduce((s, [k, v]) => {
        if (CAMPOS_MONETARIOS.has(k)) return s + (Number(v) || 0);
        if (Array.isArray(v)) return s + sumarValorNovedad(v);
        return s;
      }, 0);
  }
  return 0;
}

/**
 * Aplica una lista de novedades ya clasificadas por PayrollConcept sobre
 * los acumuladores devengados/deducciones, y retorna el total sumado.
 *
 * @param {Array<{dian_category: string, payload: any}>} novedades
 * @param {object} devengados - acumulador (ya con basico/transporte puestos)
 * @param {object} deducciones - acumulador (ya con salud/fondoPension puestos)
 */
function aplicarNovedades(novedades, devengados, deducciones) {
  let totalNovedadesDevengados = 0;
  let totalNovedadesDeducciones = 0;

  for (const nov of novedades || []) {
    const mapping = DIAN_CATEGORY_MAP[nov.dian_category];
    if (!mapping) {
      throw new Error(`dian_category desconocida en novedad: "${nov.dian_category}". Debe ser una de: ${Object.keys(DIAN_CATEGORY_MAP).join(', ')}`);
    }
    const target = mapping.bucket === 'devengados' ? devengados : deducciones;
    const valor = sumarValorNovedad(nov.payload);

    switch (mapping.kind) {
      case 'array':
        if (!target[mapping.key]) target[mapping.key] = [];
        target[mapping.key].push(nov.payload);
        break;
      case 'simpleList':
        if (!target[mapping.key]) target[mapping.key] = [];
        target[mapping.key].push(nov.payload);
        break;
      case 'single':
        target[mapping.key] = (target[mapping.key] || 0) + Number(nov.payload);
        break;
      case 'object':
        if (mapping.merge && target[mapping.key]) {
          // Vacaciones/Licencias: mergear arreglos internos (comunes/compensadas, maternidadPaternidad/remunerada/noRemunerada)
          for (const [k, v] of Object.entries(nov.payload)) {
            target[mapping.key][k] = [...(target[mapping.key][k] || []), ...(Array.isArray(v) ? v : [v])];
          }
        } else {
          target[mapping.key] = nov.payload;
        }
        break;
      default:
        throw new Error(`kind de mapeo no soportado: ${mapping.kind}`);
    }

    if (mapping.bucket === 'devengados') totalNovedadesDevengados += valor;
    else totalNovedadesDeducciones += valor;
  }

  return { totalNovedadesDevengados, totalNovedadesDeducciones };
}

/**
 * Suma las horas ("cantidad") reportadas en novedades de horas EXTRA
 * (ver CATEGORIAS_HORAS_EXTRA — excluye recargos) para un mismo
 * employee_id, a partir de filas de PayrollNovedad ya cargadas.
 */
function sumarHorasExtraNovedades(novedadesRows) {
  return (novedadesRows || [])
    .filter((n) => CATEGORIAS_HORAS_EXTRA.has(n.dian_category))
    .reduce((total, n) => total + (Number(n.payload?.cantidad) || 0), 0);
}

/**
 * Calcula el tope legal de horas extra "equivalente" para un periodo de
 * nómina, prorrateando el tope SEMANAL (12h) según la duración del
 * periodo en días comerciales — así un periodo quincenal admite ~24h y
 * uno mensual ~51.4h, en vez de aplicar el tope semanal tal cual a
 * periodos más largos. MEJOR ESFUERZO: es una equivalencia aritmética,
 * no una regla legal explícita para periodos no semanales — sirve como
 * alerta orientativa, no como validación exacta día por día (el payload
 * de horas extra no captura fecha por fecha, solo el total del periodo).
 */
function calcularTopeHorasExtraPeriodo(period) {
  const diasPeriodo = diasComerciales(period.start_date, period.end_date);
  const semanas = diasPeriodo / 7;
  return PAYROLL_CONSTANTS.HORAS_EXTRA_TOPE_SEMANAL * semanas;
}



/**
 * Verifica si el total de horas extra de un empleado en un periodo (ya
 * incluyendo la novedad nueva que se está guardando) supera el tope legal
 * equivalente del periodo. NO bloquea — devuelve un mensaje de aviso o
 * null, porque puede haber excepciones legales autorizadas (Art. 22 CST)
 * que el sistema no puede verificar por sí solo.
 *
 * @param {Array} novedadesRows - TODAS las novedades de horas extra del
 *   empleado en el periodo, incluida la recién creada.
 * @param {object} period - instancia/objeto PayrollPeriod (start_date, end_date)
 */
function validarTopeHorasExtra(novedadesRows, period) {
  const totalHoras = sumarHorasExtraNovedades(novedadesRows);
  const tope = calcularTopeHorasExtraPeriodo(period);
  if (totalHoras <= tope) return null;
  return `El empleado acumula ${totalHoras.toFixed(2)} horas extra en este periodo, por encima del tope legal orientativo de ${tope.toFixed(2)} horas (${PAYROLL_CONSTANTS.HORAS_EXTRA_TOPE_SEMANAL}h/semana, Art. 22 y 51 CST). Verifique si aplica alguna excepción legal antes de continuar.`;
}

/**
 * Resuelve los PayrollConcept con auto_apply=true a novedades sintéticas
 * {dian_category, payload} usando el `ibc` ya calculado del empleado —
 * por eso esto vive DENTRO de liquidarEmpleado (después de calcularBasico)
 * y no en el llamador: un concepto 'percentage' necesita el ibc del
 * periodo, que no existe todavía cuando el llamador arma los datos de
 * entrada. Solo admite categorías DIAN de valor simple (ver
 * validateAutoApply en payrollConcepts.controller.js, que ya debería
 * impedir guardar cualquier otra) — si de todos modos llega una que no
 * aplica (ej. DIAN_CATEGORY_MAP cambió después de guardado el concepto),
 * se omite con un aviso en vez de corromper el XML con un número plano
 * donde se espera un objeto estructurado.
 */
function resolverConceptosAutomaticos(autoConcepts, ibc) {
  const novedadesAuto = [];
  for (const concept of autoConcepts || []) {
    const mapping = DIAN_CATEGORY_MAP[concept.dian_category];
    if (!mapping || !['single', 'simpleList'].includes(mapping.kind)) {
      console.warn(`[Nómina] Concepto automático "${concept.name}" (${concept.dian_category}) ya no admite valor simple — se omite. Revisar validateAutoApply().`);
      continue;
    }
    const valor = concept.calculation_type === 'percentage'
      ? ibc * (Number(concept.default_value) / 100)
      : Number(concept.default_value);
    if (valor) novedadesAuto.push({ dian_category: concept.dian_category, payload: valor });
  }
  return novedadesAuto;
}

/* ──────────────────────────────────────────────────────────
 * Orquestación principal
 * ────────────────────────────────────────────────────────── */

/**
 * Liquida un empleado para un periodo dado.
 *
 * @param {object} params.employee - instancia Employee
 * @param {object} params.period - instancia PayrollPeriod
 * @param {Array} params.novedades - novedades ya clasificadas (ver arriba).
 *   Las de dian_category 'LicenciaNR'/'HuelgasLegales' que restan días del
 *   Básico deben incluir además `diasNoRemunerados` en el payload para que
 *   se contabilicen ahí — ver `diasNoRemunerados` más abajo.
 * @param {Array} params.autoConcepts - PayrollConcept con auto_apply=true
 *   vigentes del tenant ({ name, dian_category, calculation_type,
 *   default_value }) — se resuelven a novedades sintéticas usando el ibc
 *   de ESTE empleado (ver resolverConceptosAutomaticos arriba). El
 *   llamador los trae una sola vez por periodo (no cambian por empleado),
 *   ver payrollPeriodEmissionService.js#getActiveAutoConcepts.
 * @param {number} params.diasNoRemunerados - total de días del periodo que
 *   NO se pagan (licencia no remunerada + suspensión + ausencia
 *   injustificada), ya sumados por el llamador desde sus propias novedades
 *   de asistencia. Se resta del Básico.
 * @param {object} params.softwareSecurityCode - SoftwareSC ya calculado
 *   (numeral 8.3, mismo mecanismo que factura) — se pasa tal cual a
 *   payrollXmlBuilder.js.
 */
function liquidarEmpleado({ employee, period, novedades = [], autoConcepts = [], diasNoRemunerados = 0, softwareSecurityCode }) {
  const { diasTrabajados, sueldoTrabajado, diasPeriodoCompleto } = calcularBasico(employee, period, diasNoRemunerados);

  const devengados = { basico: { diasTrabajados, sueldoTrabajado } };
  const transporte = calcularAuxilioTransporte(employee, diasTrabajados, diasPeriodoCompleto);
  if (transporte) devengados.transporte = transporte;

  // IBC del periodo = sueldoTrabajado prorrateado (más auxilio de
  // transporte NO se incluye — es no salarial por definición legal, nunca
  // integra el IBC).
  const ibc = sueldoTrabajado;
  const { salud, fondoPension, fondoSP } = calcularDeduccionesLegales(employee, ibc);
  const deducciones = { salud, fondoPension };
  if (fondoSP) deducciones.fondoSP = fondoSP;

  let devengadosTotal = sueldoTrabajado + (transporte ? transporte.auxilioTransporte : 0);
  let deduccionesTotal = salud.deduccion + fondoPension.deduccion + (fondoSP ? fondoSP.deduccionSP : 0);

  const novedadesAuto = resolverConceptosAutomaticos(autoConcepts, ibc);
  const { totalNovedadesDevengados, totalNovedadesDeducciones } = aplicarNovedades([...novedades, ...novedadesAuto], devengados, deducciones);
  devengadosTotal += totalNovedadesDevengados;
  deduccionesTotal += totalNovedadesDeducciones;

  return {
    devengados,
    deducciones,
    devengadosTotal,
    deduccionesTotal,
    tiempoLaboradoDias: diasTrabajados,
    softwareSecurityCode,
    paymentDates: period.payment_date ? [period.payment_date] : [],
  };
}

// Etiquetas en español para cada `key` que puede aparecer en
// devengados/deducciones de una liquidación — cubre los legales
// calculados (basico, transporte, salud, fondoPension, fondoSP) y todos
// los `key` que usa DIAN_CATEGORY_MAP para novedades. Si aparece un `key`
// no listado aquí (no debería, salvo que se agregue una categoría DIAN
// nueva sin actualizar este mapa) se usa el propio key como fallback.
const CONCEPT_LABELS = {
  basico: 'Básico',
  transporte: 'Auxilio de transporte',
  salud: 'Salud (empleado)',
  fondoPension: 'Fondo de pensión (empleado)',
  fondoSP: 'Fondo de solidaridad pensional',
  heds: 'Horas extra diurnas',
  hens: 'Horas extra nocturnas',
  hrns: 'Horas de recargo nocturno',
  heddfs: 'Horas extra diurnas dominical/festivo',
  hrddfs: 'Horas de recargo diurno dominical/festivo',
  hendfs: 'Horas extra nocturnas dominical/festivo',
  hrndfs: 'Horas de recargo nocturno dominical/festivo',
  incapacidades: 'Incapacidades',
  bonificaciones: 'Bonificaciones',
  auxilios: 'Auxilios',
  huelgasLegales: 'Huelgas o legales',
  otrosConceptos: 'Otros conceptos',
  compensaciones: 'Compensaciones',
  bonoEPCTVs: 'Bono EPCTV',
  comisiones: 'Comisiones',
  pagosTerceros: 'Pagos a terceros',
  anticipos: 'Anticipos',
  dotacion: 'Dotación',
  apoyoSost: 'Apoyo de sostenimiento',
  teletrabajo: 'Auxilio de teletrabajo',
  bonifRetiro: 'Bonificación por retiro',
  indemnizacion: 'Indemnización',
  reintegro: 'Reintegro',
  primas: 'Primas',
  cesantias: 'Cesantías e intereses',
  vacaciones: 'Vacaciones',
  licencias: 'Licencias',
  sindicatos: 'Cuota sindical',
  sanciones: 'Sanciones',
  libranzas: 'Libranzas',
  otrasDeducciones: 'Otras deducciones',
  pensionVoluntaria: 'Pensión voluntaria',
  retencionFuente: 'Retención en la fuente',
  afc: 'Cuenta AFC',
  cooperativa: 'Cooperativa',
  embargoFiscal: 'Embargo fiscal',
  planComplementarios: 'Plan complementario de salud',
  educacion: 'Educación',
  deuda: 'Deuda',
};

/**
 * Convierte un `liquidation` (salida de liquidarEmpleado, o el
 * `snapshot_liquidation` ya guardado en un PayrollDocument) en dos listas
 * planas de líneas {label, amount} listas para mostrar — usado tanto por
 * payrollPdfService.js (representación gráfica) como por el detalle que
 * expone payrollDocuments.controller.js al frontend. No recalcula nada:
 * si un valor no cuadra con devengadosTotal/deduccionesTotal ya guardados,
 * el problema es de liquidarEmpleado(), no de este resumen.
 */
function resumenLiquidacionParaImpresion(liquidation) {
  const toLines = (bucket) => {
    if (!bucket) return [];
    const lines = [];
    for (const [key, value] of Object.entries(bucket)) {
      const label = CONCEPT_LABELS[key] || key;
      if (key === 'basico') {
        lines.push({ label: `${label} (${value.diasTrabajados} días)`, amount: Number(value.sueldoTrabajado) || 0 });
        continue;
      }
      const amount = sumarValorNovedad(value);
      if (amount) lines.push({ label, amount });
    }
    return lines;
  };

  return {
    devengadosLines: toLines(liquidation.devengados),
    deduccionesLines: toLines(liquidation.deducciones),
  };
}

module.exports = {
  PAYROLL_CONSTANTS,
  DIAN_CATEGORY_MAP,
  CATEGORIAS_HORAS_EXTRA,
  CONCEPT_LABELS,
  diasComerciales,
  calcularBasico,
  calcularAuxilioTransporte,
  calcularDeduccionesLegales,
  aplicarNovedades,
  sumarValorNovedad,
  sumarHorasExtraNovedades,
  calcularTopeHorasExtraPeriodo,
  validarTopeHorasExtra,
  resolverConceptosAutomaticos,
  liquidarEmpleado,
  resumenLiquidacionParaImpresion,
};