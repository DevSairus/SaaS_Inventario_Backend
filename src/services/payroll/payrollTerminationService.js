// backend/src/services/payroll/payrollTerminationService.js
/**
 * Liquidación definitiva / finiquito (Mejoras-Nomina-Sin-PILA-Nexora.md,
 * punto #7) -- el ítem más grande de la lista después de PILA, tratado
 * como su propio mini-proyecto según lo planteado ahí.
 *
 * Qué resuelve: `Employee.termination_date` ya existía, pero no había
 * cálculo asistido de lo que se le debe a un empleado al momento del
 * retiro (cesantías, intereses sobre cesantías, prima proporcional,
 * vacaciones pendientes), ni una forma de generar y enviar a la DIAN el
 * Documento Soporte de Nómina Electrónica correspondiente a esa
 * liquidación.
 *
 * Diseño: en vez de inventar un flujo paralelo, la liquidación definitiva
 * se modela como UN PayrollPeriod más (period_type='liquidacion', ver
 * migración 20260903010000) que cubre desde el día siguiente al último
 * periodo ya pagado del empleado hasta su `termination_date`, con las
 * novedades de cesantías/intereses/prima/vacaciones/indemnización ya
 * calculadas cargadas como PayrollNovedad de ese periodo -- así
 * `liquidarEmpleado()` (payrollService.js) y `emitirDocumentoEmpleado()`
 * (payrollPeriodEmissionService.js) se reutilizan tal cual, sin
 * reescribir la lógica de clasificación DIAN ni el envío/firma/DianEvent/
 * correo/idempotencia que ya tienen. El Básico y el Auxilio de Transporte
 * de esos días pendientes salen solos de `liquidarEmpleado()` (ya sabe
 * prorratear hasta `employee.termination_date`).
 *
 * MEJOR ESFUERZO -- fórmulas de liquidación laboral colombiana,
 * simplificadas para el caso general (salario fijo ordinario, sin
 * variables ni auxilios adicionales en el IBC). Antes de usar esto como
 * liquidación oficial firmada:
 *  - Cesantías/intereses: asume que las cesantías de años ANTERIORES ya
 *    fueron consignadas al fondo respectivo (obligación legal al 14 de
 *    febrero de cada año) y solo liquida lo causado desde el 1 de enero
 *    del año del retiro (o desde `hire_date` si ingresó ese mismo año).
 *    Si el retiro ocurre ANTES del 14 de febrero y la consignación del
 *    año anterior todavía no se hizo, este cálculo queda incompleto para
 *    ese año anterior -- revisar a mano ese caso.
 *  - Prima: proporcional al semestre en curso (Ene-Jun / Jul-Dic) desde
 *    su inicio (o `hire_date` si ingresó a mitad de semestre) hasta el
 *    retiro.
 *  - Vacaciones: causación simplificada a 15 días "comerciales" (base 360)
 *    por año completo trabajado, sin descontar licencias no remuneradas o
 *    incapacidades del tiempo base -- y sin distinguir hábiles/calendario.
 *    Días ya disfrutados/compensados se restan sumando TODAS las
 *    PayrollNovedad de dian_category='Vacaciones' que ya tenga el
 *    empleado en cualquier periodo anterior.
 *  - Indemnización y Bonificación por retiro NO se calculan: dependen de
 *    la causa del retiro (justa causa o no, tipo de contrato, antigüedad)
 *    y de negociaciones propias del caso -- se reciben como monto ya
 *    decidido por quien liquida (mismo criterio que horas extra/
 *    incapacidades en el resto del módulo: dato que requiere criterio
 *    humano, este servicio no lo inventa).
 */
'use strict';

const { Op } = require('sequelize');
const {
  Employee, PayrollPeriod, PayrollDocument, PayrollNovedad, Tenant,
} = require('../../models');
const {
  PAYROLL_CONSTANTS, diasComerciales, liquidarEmpleado, resumenLiquidacionParaImpresion,
} = require('./payrollService');
const { emitirDocumentoEmpleado, getPayrollResolution } = require('./payrollPeriodEmissionService');
const { extractDianConfig } = require('../dian/dianService');
const { generatePayrollEntry } = require('../accounting/autoEntries.service');
const logger = require('../../config/logger');

const PORCENTAJE_INTERESES_CESANTIAS = 12; // Ley 52/1975 -- 12% anual sobre cesantías causadas
const DIAS_VACACIONES_POR_ANIO = 15; // CST Art. 186 -- 15 días hábiles por año, ver aproximación en el comentario de arriba

/* ──────────────────────────────────────────────────────────
 * Helpers de fechas (ISO 'YYYY-MM-DD', aritmética en UTC -- mismo criterio
 * que payrollPeriods.controller.js#suggestNextPeriod, por la misma razón:
 * un periodo es una fecha civil, no debe arrastrar el TZ del servidor).
 * ────────────────────────────────────────────────────────── */
const parseISODate = (s) => new Date(`${s}T00:00:00Z`);
const toISODate = (d) => d.toISOString().slice(0, 10);
const addDaysISO = (isoStr, days) => {
  const d = parseISODate(isoStr);
  d.setUTCDate(d.getUTCDate() + days);
  return toISODate(d);
};
const maxISODate = (a, b) => (a > b ? a : b);

/* ──────────────────────────────────────────────────────────
 * 1. Rango del "salario pendiente" -- desde el día siguiente al último
 *    periodo ya pagado (aceptado por la DIAN) del empleado hasta su
 *    retiro. Si nunca se le liquidó nada, arranca desde `hire_date`.
 * ────────────────────────────────────────────────────────── */
async function obtenerRangoSalarioPendiente(tenantId, employee) {
  const ultimoDocumento = await PayrollDocument.findOne({
    where: { tenant_id: tenantId, employee_id: employee.id, dian_status: 'accepted' },
    include: [{ model: PayrollPeriod, as: 'period', attributes: ['end_date'] }],
    order: [[{ model: PayrollPeriod, as: 'period' }, 'end_date', 'DESC']],
  });

  const finPeriodoAnterior = ultimoDocumento?.period?.end_date || null;
  const inicio = finPeriodoAnterior ? addDaysISO(finPeriodoAnterior, 1) : employee.hire_date;
  const fin = employee.termination_date;

  return { inicio, fin, hayPeriodoAnterior: !!finPeriodoAnterior };
}

/* ──────────────────────────────────────────────────────────
 * 2. Cesantías + intereses
 * ────────────────────────────────────────────────────────── */
function calcularCesantiasEIntereses(employee) {
  const fechaRetiro = employee.termination_date;
  const anioRetiro = fechaRetiro.slice(0, 4);
  const inicioAnio = `${anioRetiro}-01-01`;
  const fechaInicioAcumulacion = maxISODate(employee.hire_date, inicioAnio);

  const dias = diasComerciales(fechaInicioAcumulacion, fechaRetiro);
  const salario = Number(employee.base_salary);

  const cesantias = (salario * dias) / 360;
  const intereses = cesantias * (PORCENTAJE_INTERESES_CESANTIAS / 100) * (dias / 360);

  return {
    fechaInicioAcumulacion, fechaCorte: fechaRetiro, dias,
    cesantias: Math.round(cesantias), intereses: Math.round(intereses),
  };
}

/* ──────────────────────────────────────────────────────────
 * 3. Prima de servicios proporcional al semestre en curso
 * ────────────────────────────────────────────────────────── */
function calcularPrimaProporcional(employee) {
  const fechaRetiro = employee.termination_date;
  const [anio, mes] = fechaRetiro.split('-');
  const esPrimerSemestre = Number(mes) <= 6;
  const inicioSemestre = esPrimerSemestre ? `${anio}-01-01` : `${anio}-07-01`;
  const fechaInicioAcumulacion = maxISODate(employee.hire_date, inicioSemestre);

  const dias = diasComerciales(fechaInicioAcumulacion, fechaRetiro);
  const salario = Number(employee.base_salary);
  const prima = (salario * dias) / 360;

  return {
    fechaInicioAcumulacion, fechaCorte: fechaRetiro, dias, semestre: esPrimerSemestre ? 1 : 2,
    prima: Math.round(prima),
  };
}

/* ──────────────────────────────────────────────────────────
 * 4. Vacaciones pendientes -- causadas desde el ingreso, menos las ya
 *    disfrutadas/compensadas en cualquier periodo anterior (sumadas desde
 *    las PayrollNovedad ya guardadas, dian_category='Vacaciones').
 * ────────────────────────────────────────────────────────── */
async function calcularVacacionesPendientes(tenantId, employee) {
  const diasTotalesVinculacion = diasComerciales(employee.hire_date, employee.termination_date);
  const diasCausados = (diasTotalesVinculacion / 360) * DIAS_VACACIONES_POR_ANIO;

  const novedadesVacaciones = await PayrollNovedad.findAll({
    where: { tenant_id: tenantId, employee_id: employee.id, dian_category: 'Vacaciones' },
    attributes: ['payload'],
  });

  let diasYaTomados = 0;
  for (const row of novedadesVacaciones) {
    const p = row.payload || {};
    for (const c of (p.comunes || [])) diasYaTomados += Number(c.cantidad) || 0;
    for (const c of (p.compensadas || [])) diasYaTomados += Number(c.cantidad) || 0;
  }

  const diasPendientes = Math.max(0, diasCausados - diasYaTomados);
  const salario = Number(employee.base_salary);
  // Tasa diaria sobre la misma convención de 30 días/mes que usa el resto
  // del módulo para el Básico (PAYROLL_CONSTANTS.DIAS_MES_COMERCIAL).
  const valor = (salario / PAYROLL_CONSTANTS.DIAS_MES_COMERCIAL) * diasPendientes;

  return {
    diasCausados: Math.round(diasCausados * 100) / 100,
    diasYaTomados,
    diasPendientes: Math.round(diasPendientes * 100) / 100,
    valor: Math.round(valor),
  };
}

/* ──────────────────────────────────────────────────────────
 * 5. Orquestación -- arma el breakdown + las novedades DIAN listas para
 *    pasar a liquidarEmpleado()/persistir.
 * ────────────────────────────────────────────────────────── */
async function calcularLiquidacionDefinitiva(tenantId, employee, { indemnizacion = 0, bonifRetiro = 0 } = {}) {
  if (!employee.termination_date) {
    throw new Error('El empleado no tiene fecha de retiro (termination_date) registrada -- edítelo primero en la ficha del empleado.');
  }

  const rangoPendiente = await obtenerRangoSalarioPendiente(tenantId, employee);
  const cesantias = calcularCesantiasEIntereses(employee);
  const prima = calcularPrimaProporcional(employee);
  const vacaciones = await calcularVacacionesPendientes(tenantId, employee);

  const novedades = [];
  if (cesantias.cesantias > 0) {
    novedades.push({
      dian_category: 'Cesantias',
      payload: { pago: cesantias.cesantias, porcentaje: PORCENTAJE_INTERESES_CESANTIAS, pagoIntereses: cesantias.intereses },
    });
  }
  if (prima.prima > 0) {
    novedades.push({ dian_category: 'Primas', payload: { cantidad: prima.dias, pago: prima.prima } });
  }
  if (vacaciones.diasPendientes > 0) {
    novedades.push({
      dian_category: 'Vacaciones',
      payload: { compensadas: [{ cantidad: vacaciones.diasPendientes, pago: vacaciones.valor }] },
    });
  }
  if (Number(indemnizacion) > 0) {
    novedades.push({ dian_category: 'Indemnizacion', payload: Number(indemnizacion) });
  }
  if (Number(bonifRetiro) > 0) {
    novedades.push({ dian_category: 'BonifRetiro', payload: Number(bonifRetiro) });
  }

  const notasLimitaciones = [
    'Cesantías/intereses asumen que los años anteriores ya fueron consignados al fondo (obligación al 14 de febrero) -- si el retiro es antes de esa fecha del año en curso, revise el año anterior a mano.',
    'Vacaciones: causación aproximada (15 días comerciales/año desde el ingreso, sin descontar incapacidades/licencias no remuneradas del tiempo base).',
  ];
  if (!Number(indemnizacion) && !Number(bonifRetiro)) {
    notasLimitaciones.push('No se incluyó indemnización ni bonificación por retiro -- si el retiro fue sin justa causa o hay una negociación de por medio, calcúlelas aparte e inclúyalas antes de emitir.');
  }

  return {
    employeeId: employee.id,
    employeeName: `${employee.first_name} ${employee.first_surname}`,
    fechaRetiro: employee.termination_date,
    rangoSalarioPendiente: rangoPendiente,
    cesantias,
    prima,
    vacaciones,
    indemnizacion: Math.round(Number(indemnizacion) || 0),
    bonifRetiro: Math.round(Number(bonifRetiro) || 0),
    novedades,
    notasLimitaciones,
  };
}

/**
 * Vista previa completa (SIN persistir nada) -- arma un PayrollPeriod
 * "virtual" (no guardado) con el rango de salario pendiente y llama
 * liquidarEmpleado() con las novedades de liquidación ya calculadas, para
 * mostrar exactamente lo que se firmaría/enviaría a la DIAN si se emite.
 */
async function previewLiquidacionDefinitiva(tenantId, employeeId, opciones = {}) {
  const employee = await Employee.findOne({ where: { id: employeeId, tenant_id: tenantId } });
  if (!employee) throw new Error('Empleado no encontrado');

  const breakdown = await calcularLiquidacionDefinitiva(tenantId, employee, opciones);
  const periodoVirtual = {
    start_date: breakdown.rangoSalarioPendiente.inicio,
    end_date: breakdown.rangoSalarioPendiente.fin,
    payment_date: null,
  };

  const liquidation = liquidarEmpleado({
    employee, period: periodoVirtual, novedades: breakdown.novedades, autoConcepts: [], diasNoRemunerados: 0, softwareSecurityCode: null,
  });

  return {
    breakdown,
    periodo: periodoVirtual,
    liquidation,
    resumen: resumenLiquidacionParaImpresion(liquidation),
    netoTotal: liquidation.devengadosTotal - liquidation.deduccionesTotal,
  };
}

/**
 * Emite la liquidación definitiva: crea (o retoma, si ya existía de un
 * intento previo) el PayrollPeriod 'liquidacion' del empleado, persiste
 * las novedades de cesantías/prima/vacaciones/indemnización/bonifRetiro
 * como PayrollNovedad (mismo rastro auditable que cualquier otra novedad
 * del módulo), y reutiliza emitirDocumentoEmpleado() para firmar y enviar
 * el Documento Soporte a la DIAN -- idéntico camino de idempotencia,
 * DianEvent y correo al empleado que usa cualquier periodo normal.
 *
 * Si queda aceptado, además genera el asiento contable (mismo
 * generatePayrollEntry que usa un periodo normal) y marca el periodo como
 * 'emitido'. Si la DIAN rechaza o hay un error, el periodo queda
 * disponible para reintentar (no se reenvía lo ya aceptado).
 */
async function emitirLiquidacionDefinitiva(tenantId, employeeId, userId, opciones = {}) {
  const employee = await Employee.findOne({ where: { id: employeeId, tenant_id: tenantId } });
  if (!employee) throw new Error('Empleado no encontrado');

  const tenant = await Tenant.findByPk(tenantId);
  if (!tenant) throw new Error('Tenant no encontrado');

  const breakdown = await calcularLiquidacionDefinitiva(tenantId, employee, opciones);
  const { inicio, fin } = breakdown.rangoSalarioPendiente;

  if (fin < inicio) {
    throw new Error(`La fecha de retiro (${fin}) es anterior al día siguiente del último periodo ya pagado (${inicio}) -- revise el retiro o los periodos ya emitidos de este empleado.`);
  }

  // Reutiliza el periodo de liquidación si ya se había creado en un
  // intento anterior (mismo tenant+empleado+fechas identifica de forma
  // única a ESTA liquidación, aunque el UNIQUE de la tabla ya no exige
  // fechas únicas entre liquidaciones de empleados distintos -- ver
  // migración 20260903010000).
  let period = await PayrollPeriod.findOne({
    where: {
      tenant_id: tenantId, period_type: 'liquidacion', start_date: inicio, end_date: fin,
      notes: { [Op.like]: `%${employee.id}%` },
    },
  });

  if (!period) {
    period = await PayrollPeriod.create({
      tenant_id: tenantId,
      branch_id: employee.branch_id || null,
      period_type: 'liquidacion',
      start_date: inicio,
      end_date: fin,
      payment_date: fin,
      status: 'abierto',
      notes: `Liquidación definitiva -- ${breakdown.employeeName} (${employee.document_type} ${employee.document_number}), empleado ${employee.id}, retiro ${fin}`,
      created_by: userId || null,
    });
  } else if (period.status === 'emitido') {
    // Ya se había emitido con éxito antes -- no reintentar, devolver tal cual.
    const documentoExistente = await PayrollDocument.findOne({
      where: { tenant_id: tenantId, employee_id: employee.id, payroll_period_id: period.id, dian_status: 'accepted' },
    });
    return {
      alreadyEmitted: true, period, breakdown,
      payrollDocumentId: documentoExistente?.id || null,
    };
  }

  // Reemplaza las novedades de este periodo (si es un reintento tras
  // recalcular -- ej. cambió el monto de indemnización) por las recién
  // calculadas, en vez de acumularlas.
  await PayrollNovedad.destroy({ where: { tenant_id: tenantId, employee_id: employee.id, payroll_period_id: period.id } });
  for (const nov of breakdown.novedades) {
    // eslint-disable-next-line no-await-in-loop -- pocas filas (máx. 5), no vale la pena paralelizar
    await PayrollNovedad.create({
      tenant_id: tenantId,
      employee_id: employee.id,
      payroll_period_id: period.id,
      dian_category: nov.dian_category,
      payload: nov.payload,
      notes: 'Generada automáticamente por la liquidación definitiva (mejora #7)',
      created_by: userId || null,
    });
  }

  const cfg = extractDianConfig(tenant);
  const isTest = cfg.environment !== 'production';
  // Falla rápido con un mensaje claro si falta la resolución de nómina --
  // mismo motivo que submitPayrollPeriod() la resuelve una vez antes de
  // arrancar (emitirDocumentoEmpleado igual la vuelve a resolver por su
  // cuenta internamente vía getNextConsecutive).
  await getPayrollResolution(tenantId, isTest);

  const result = await emitirDocumentoEmpleado({ tenant, period, employee, isTest, autoConcepts: [] });

  if (!result.accepted) {
    logger.warn(`[Nómina-Liquidación] Empleado ${employee.id}: liquidación definitiva NO aceptada por la DIAN -- ${result.error}`);
    return { accepted: false, error: result.error, period, breakdown };
  }

  await period.update({ status: 'emitido', closed_at: new Date(), closed_by: userId || null });

  let accountingEntry = null;
  try {
    accountingEntry = await generatePayrollEntry(period, [{ employee, liquidation: result.liquidation }], tenantId, userId);
  } catch (accError) {
    // Un problema contabilizando no debe hacer parecer que la liquidación
    // no se emitió a la DIAN -- ya quedó aceptada y el periodo ya avanzó.
    logger.error(`[Nómina-Liquidación] Error generando asiento contable de la liquidación (empleado ${employee.id}):`, accError);
  }

  return {
    accepted: true, period, breakdown, liquidation: result.liquidation,
    payrollDocumentId: result.payrollDocumentId, accountingEntryId: accountingEntry?.id || null,
  };
}

module.exports = {
  obtenerRangoSalarioPendiente,
  calcularCesantiasEIntereses,
  calcularPrimaProporcional,
  calcularVacacionesPendientes,
  calcularLiquidacionDefinitiva,
  previewLiquidacionDefinitiva,
  emitirLiquidacionDefinitiva,
};
