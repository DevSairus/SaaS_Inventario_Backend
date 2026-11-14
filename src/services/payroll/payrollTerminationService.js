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
 *  - Vacaciones: saldo del libro de vacaciones a la fecha de retiro
 *    (vacationBook.service.js): 15 días por 360 días comerciales desde el
 *    ingreso o desde el saldo inicial, sin causar licencias no remuneradas
 *    ni días no remunerados, menos lo disfrutado/compensado. Sin distinguir
 *    hábiles/calendario.
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
const { emitirDocumentoEmpleado, getPayrollResolution, isEmployeeInPeriod } = require('./payrollPeriodEmissionService');
const { extractDianConfig } = require('../dian/dianService');
const { generatePayrollEntry } = require('../accounting/autoEntries.service');
const { terminationReasonLabel, calcularIndemnizacionSugerida } = require('./terminationReasons');
const logger = require('../../config/logger');

const PORCENTAJE_INTERESES_CESANTIAS = 12; // Ley 52/1975 -- 12% anual sobre cesantías causadas

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

  // salarioCubierto: el período normal ya pagó los días hasta el retiro, así
  // que la liquidación NO paga salario (solo prestaciones y vacaciones).
  return { inicio, fin, hayPeriodoAnterior: !!finPeriodoAnterior, salarioCubierto: inicio > fin, pagadoHasta: finPeriodoAnterior };
}

/* ──────────────────────────────────────────────────────────
 * 1b. Secuencia obligatoria (6.4): antes de liquidar, los períodos normales
 *     que incluyen al empleado hasta su retiro deben estar emitidos y
 *     aceptados; ahí se pagan los días causados. Devuelve los que faltan.
 * ────────────────────────────────────────────────────────── */
async function obtenerPeriodosPendientes(tenantId, employee) {
  const periodos = await PayrollPeriod.findAll({
    where: {
      tenant_id: tenantId,
      period_type: { [Op.in]: ['mensual', 'quincenal'] },
      start_date: { [Op.lte]: employee.termination_date },
      end_date: { [Op.gte]: employee.hire_date },
    },
    order: [['start_date', 'ASC']],
  });
  const aplicables = periodos.filter((p) => (
    p.period_type === employee.payroll_periodicity
    && (!p.branch_id || p.branch_id === employee.branch_id)
    && isEmployeeInPeriod(employee, p)
  ));
  if (aplicables.length === 0) return [];

  const pagados = await PayrollDocument.findAll({
    where: {
      tenant_id: tenantId, employee_id: employee.id, dian_status: 'accepted',
      payroll_period_id: { [Op.in]: aplicables.map((p) => p.id) },
    },
    attributes: ['payroll_period_id'],
  });
  const idsPagados = new Set(pagados.map((d) => d.payroll_period_id));
  return aplicables
    .filter((p) => !idsPagados.has(p.id))
    .map((p) => ({ id: p.id, period_type: p.period_type, start_date: p.start_date, end_date: p.end_date, status: p.status }));
}

/* Prima del semestre que ya se pagó en un período normal (p. ej. la de
 * diciembre cuando el retiro es después): se descuenta para no pagarla dos veces. */
async function obtenerPrimaYaPagada(tenantId, employee, desdeISO) {
  const documentos = await PayrollDocument.findAll({
    where: { tenant_id: tenantId, employee_id: employee.id, dian_status: 'accepted' },
    include: [{ model: PayrollPeriod, as: 'period', attributes: ['end_date', 'period_type'] }],
  });
  let total = 0;
  for (const doc of documentos) {
    const periodo = doc.period;
    if (!periodo || periodo.period_type === 'liquidacion') continue;
    if (periodo.end_date < desdeISO || periodo.end_date > employee.termination_date) continue;
    const primas = doc.snapshot_liquidation?.devengados?.primas;
    if (primas) total += (Number(primas.pago) || 0) + (Number(primas.pagoNS) || 0);
  }
  return Math.round(total);
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
 * 4. Vacaciones pendientes -- saldo del libro de vacaciones a la fecha
 *    de retiro (ver vacationBook.service.js).
 * ────────────────────────────────────────────────────────── */
async function calcularVacacionesPendientes(tenantId, employee) {
  // Mismo cálculo del libro de vacaciones a la fecha de retiro: saldo inicial
  // (si lo tiene), días causados sin licencias no remuneradas ni días no
  // remunerados, menos lo disfrutado/compensado.
  const { getEmployeeBook } = require('./vacationBook.service');
  const book = await getEmployeeBook(tenantId, employee, employee.termination_date, { forSettlement: true });
  const diasPendientes = Math.max(0, book.disponibles);
  const salario = Number(employee.base_salary);
  // Tasa diaria sobre la misma convención de 30 días/mes que usa el resto
  // del módulo para el Básico (PAYROLL_CONSTANTS.DIAS_MES_COMERCIAL).
  const valor = (salario / PAYROLL_CONSTANTS.DIAS_MES_COMERCIAL) * diasPendientes;

  return {
    saldoInicial: book.saldo_inicial,
    fechaSaldoInicial: book.fecha_saldo_inicial,
    diasCausados: book.causados,
    diasNoCausan: book.dias_no_causan,
    diasYaTomados: Math.round((book.disfrutados + book.compensados) * 100) / 100,
    diasPendientes: Math.round(diasPendientes * 100) / 100,
    valor: Math.round(valor),
  };
}

/* ──────────────────────────────────────────────────────────
 * 4b. Indemnización SUGERIDA según la causa del retiro (6.2). No se suma a
 *     la liquidación sola: quien liquida decide el monto (ver
 *     terminationReasons.js para las fórmulas y sus límites).
 * ────────────────────────────────────────────────────────── */
function sugerirIndemnizacion(employee) {
  const serviceDays = diasComerciales(employee.hire_date, employee.termination_date);
  const remainingDays = employee.contract_type === '2' && employee.contract_end_date
    && employee.contract_end_date > employee.termination_date
    ? diasComerciales(addDaysISO(employee.termination_date, 1), employee.contract_end_date)
    : (employee.contract_type === '2' && employee.contract_end_date ? 0 : null);
  return calcularIndemnizacionSugerida({
    reason: employee.termination_reason,
    contractType: employee.contract_type,
    baseSalary: employee.base_salary,
    serviceDays,
    smlmv: PAYROLL_CONSTANTS.SMLMV,
    remainingDays,
  });
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
  const primaCausada = calcularPrimaProporcional(employee);
  const primaYaPagada = await obtenerPrimaYaPagada(tenantId, employee, primaCausada.fechaInicioAcumulacion);
  // `prima` es lo que se paga en esta liquidación (causada menos lo ya pagado).
  const prima = { ...primaCausada, primaCausada: primaCausada.prima, yaPagada: primaYaPagada, prima: Math.max(0, primaCausada.prima - primaYaPagada) };
  const periodosPendientes = await obtenerPeriodosPendientes(tenantId, employee);
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
    'Vacaciones: según el libro de vacaciones (15 días por 360 días comerciales desde el ingreso o desde el saldo inicial, sin causar licencias no remuneradas ni días no remunerados). Revise el saldo inicial del empleado si entró antes de llevar la nómina en Pitbox.',
  ];
  if (!employee.termination_reason) {
    notasLimitaciones.push('Falta registrar la causa del retiro en la ficha del empleado: es obligatoria para emitir la liquidación.');
  }
  if (periodosPendientes.length > 0) {
    notasLimitaciones.push(`Antes de liquidar debe emitir y ver aceptado por la DIAN ${periodosPendientes.length === 1 ? 'el período' : 'los períodos'} de nómina ${periodosPendientes.map((p) => `${p.start_date} a ${p.end_date}`).join(', ')}: ahí se pagan los días causados hasta el retiro.`);
  }
  if (rangoPendiente.salarioCubierto) {
    notasLimitaciones.push(`Los días de salario hasta el retiro ya se pagaron en la nómina (hasta el ${rangoPendiente.pagadoHasta}): esta liquidación no incluye salario, solo prestaciones, vacaciones y lo que ingrese.`);
  }
  if (primaYaPagada > 0) {
    notasLimitaciones.push(`A la prima del semestre se le descontó lo ya pagado en nómina (${primaYaPagada}).`);
  }
  const indemnizacionSugerida = sugerirIndemnizacion(employee);
  if (indemnizacionSugerida.applies && !Number(indemnizacion)) {
    notasLimitaciones.push(`El retiro fue sin justa causa: ${indemnizacionSugerida.note}${indemnizacionSugerida.amount > 0 ? ' Use el valor sugerido o ingrese el que corresponda; no se suma sola.' : ''}`);
  } else if (!Number(indemnizacion) && !Number(bonifRetiro)) {
    notasLimitaciones.push('No se incluyó indemnización ni bonificación por retiro -- si hay una negociación de por medio, calcúlelas aparte e inclúyalas antes de emitir.');
  }

  return {
    employeeId: employee.id,
    employeeName: `${employee.first_name} ${employee.first_surname}`,
    fechaRetiro: employee.termination_date,
    motivoRetiro: employee.termination_reason || null,
    motivoRetiroEtiqueta: terminationReasonLabel(employee.termination_reason),
    observacionesRetiro: employee.termination_notes || null,
    indemnizacionSugerida,
    rangoSalarioPendiente: rangoPendiente,
    salarioCubierto: rangoPendiente.salarioCubierto,
    periodosPendientes,
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
  // Si el salario ya está cubierto, el período de la liquidación es solo el
  // día del retiro y no paga sueldo (excludes_salary).
  const cubierto = breakdown.salarioCubierto;
  const periodoVirtual = {
    start_date: cubierto ? breakdown.rangoSalarioPendiente.fin : breakdown.rangoSalarioPendiente.inicio,
    end_date: breakdown.rangoSalarioPendiente.fin,
    payment_date: null,
    excludes_salary: cubierto,
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
 * Datos para el PDF de la liquidación (6.3).
 *  - Si ya hay una liquidación EMITIDA y aceptada por la DIAN, se arma con lo
 *    que quedó firmado (snapshot del documento): recalcular daría otro tramo
 *    de salario, porque el último pago ya es la propia liquidación.
 *  - Si no, es un borrador con el cálculo actual (sin persistir nada).
 */
async function obtenerLiquidacionParaPdf(tenantId, employeeId, opciones = {}) {
  const employee = await Employee.findOne({ where: { id: employeeId, tenant_id: tenantId } });
  if (!employee) throw new Error('Empleado no encontrado');
  if (!employee.termination_date) throw new Error('El empleado no tiene fecha de retiro registrada');

  const period = await PayrollPeriod.findOne({
    where: {
      tenant_id: tenantId, period_type: 'liquidacion', status: 'emitido',
      [Op.or]: [{ employee_id: employee.id }, { notes: { [Op.like]: `%${employee.id}%` } }],
    },
    order: [['end_date', 'DESC']],
  });
  const emitted = period
    ? await PayrollDocument.findOne({
      where: { tenant_id: tenantId, employee_id: employee.id, payroll_period_id: period.id, dian_status: 'accepted' },
    })
    : null;

  if (emitted && emitted.snapshot_liquidation) {
    return {
      employee,
      status: 'emitida',
      periodo: { start_date: period.start_date, end_date: period.end_date },
      resumen: resumenLiquidacionParaImpresion(emitted.snapshot_liquidation),
      netoTotal: Number(emitted.comprobante_total) || 0,
      breakdown: null,
      excludesSalary: !!period.excludes_salary,
      terminationReason: period.termination_reason || employee.termination_reason || null,
      documentNumber: emitted.payroll_document_number,
      cune: emitted.cune,
    };
  }

  const preview = await previewLiquidacionDefinitiva(tenantId, employeeId, opciones);
  return {
    employee,
    status: 'borrador',
    periodo: preview.periodo,
    resumen: preview.resumen,
    netoTotal: preview.netoTotal,
    breakdown: preview.breakdown,
    excludesSalary: !!preview.breakdown.salarioCubierto,
    terminationReason: employee.termination_reason || null,
    documentNumber: null,
    cune: null,
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

  if (!employee.termination_reason) {
    throw new Error('Registre la causa del retiro en la ficha del empleado antes de emitir la liquidación definitiva.');
  }

  // Idempotencia: si la liquidación de este retiro ya fue emitida y aceptada,
  // se devuelve tal cual. Hay que mirarlo ANTES de recalcular: el último pago
  // aceptado es la propia liquidación, así que el tramo pendiente saldría
  // vacío (inicio > fin) y el reintento fallaría con un error engañoso.
  const periodoEmitido = await PayrollPeriod.findOne({
    where: {
      tenant_id: tenantId, period_type: 'liquidacion', status: 'emitido', end_date: employee.termination_date,
      [Op.or]: [{ employee_id: employee.id }, { notes: { [Op.like]: `%${employee.id}%` } }],
    },
  });
  if (periodoEmitido) {
    const documentoAceptado = await PayrollDocument.findOne({
      where: { tenant_id: tenantId, employee_id: employee.id, payroll_period_id: periodoEmitido.id, dian_status: 'accepted' },
    });
    if (documentoAceptado) {
      return {
        alreadyEmitted: true, period: periodoEmitido, breakdown: null,
        payrollDocumentId: documentoAceptado.id,
      };
    }
  }

  const breakdown = await calcularLiquidacionDefinitiva(tenantId, employee, opciones);
  const { fin } = breakdown.rangoSalarioPendiente;

  // Secuencia obligatoria (6.4): primero la nómina de los días causados.
  if (breakdown.periodosPendientes.length > 0) {
    const lista = breakdown.periodosPendientes.map((p) => `${p.start_date} a ${p.end_date}`).join(', ');
    throw new Error(`Antes de emitir la liquidación definitiva debe emitir y ver aceptado por la DIAN ${breakdown.periodosPendientes.length === 1 ? 'el período' : 'los períodos'} de nómina ${lista}: ahí se pagan los días causados hasta el retiro.`);
  }

  // Si el salario ya está cubierto, el período de la liquidación es solo el
  // día del retiro y no paga sueldo (excludes_salary).
  const excludesSalary = breakdown.salarioCubierto;
  const inicio = excludesSalary ? fin : breakdown.rangoSalarioPendiente.inicio;

  // Reutiliza el periodo de liquidación si ya se había creado en un intento
  // anterior: el enlace es el empleado (employee_id) y la fecha de retiro.
  let period = await PayrollPeriod.findOne({
    where: {
      tenant_id: tenantId, period_type: 'liquidacion', end_date: fin,
      [Op.or]: [{ employee_id: employee.id }, { notes: { [Op.like]: `%${employee.id}%` } }],
    },
  });

  if (period && period.status !== 'emitido') {
    // Reintento tras recalcular: el tramo pudo cambiar (p. ej. se emitió la nómina que faltaba).
    await period.update({
      start_date: inicio, excludes_salary: excludesSalary, employee_id: employee.id,
      termination_reason: employee.termination_reason,
    });
  }

  if (!period) {
    period = await PayrollPeriod.create({
      tenant_id: tenantId,
      branch_id: employee.branch_id || null,
      employee_id: employee.id,
      period_type: 'liquidacion',
      start_date: inicio,
      end_date: fin,
      payment_date: fin,
      status: 'abierto',
      excludes_salary: excludesSalary,
      termination_reason: employee.termination_reason,
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
  obtenerPeriodosPendientes,
  obtenerPrimaYaPagada,
  obtenerLiquidacionParaPdf,
  sugerirIndemnizacion,
  obtenerRangoSalarioPendiente,
  calcularCesantiasEIntereses,
  calcularPrimaProporcional,
  calcularVacacionesPendientes,
  calcularLiquidacionDefinitiva,
  previewLiquidacionDefinitiva,
  emitirLiquidacionDefinitiva,
};
