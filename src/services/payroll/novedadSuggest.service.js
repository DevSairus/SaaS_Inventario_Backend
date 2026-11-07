// backend/src/services/payroll/novedadSuggest.service.js
//
// Valores sugeridos para una novedad de nómina mientras se captura: con las
// fechas o la cantidad, calcula los días y el valor en pesos (igual que las
// horas extra en el formulario). El operador puede corregir cualquier valor;
// esto solo propone.
//
//  - Vacaciones disfrutadas: días HÁBILES (sin domingos ni festivos; sin
//    sábados si la empresa no los trabaja) entre fecha de inicio y fin, o la
//    fecha de fin a partir de los días. Valor: salario / 30 × días hábiles; con
//    comisiones, se suma el promedio mensual del último año (CST art. 192).
//  - Vacaciones compensadas: salario (+ promedio de comisiones) / 30 × días.
//  - Incapacidades: días calendario. Común (EPS): 66,67 % del salario, nunca
//    menos del salario mínimo diario. Laboral (ARL): 100 %.
//  - Licencias de maternidad/paternidad y remuneradas: días calendario ×
//    salario / 30. No remuneradas y huelgas: solo los días.
//  - Primas: días trabajados en el semestre hasta el fin del periodo;
//    (salario + auxilio de transporte) × días / 360.
//  - Cesantías: intereses = cesantías × % (12 % anual).
//  - Cuotas sindicales: salario × %.
//
// Con salario integral, las incapacidades y licencias se calculan sobre el
// 70 % (su IBC) y no hay prima ni auxilio de transporte.
'use strict';

const { Op } = require('sequelize');
const { PAYROLL_CONSTANTS, diasComerciales } = require('./payrollService');
const { isHoliday } = require('../radian/businessDays');

const DAY_MS = 86400000;
const PORCENTAJE_INCAPACIDAD_COMUN = 66.67;
const FACTOR_IBC_INTEGRAL = 0.7;

const num = (v) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const toUTC = (s) => new Date(`${s}T00:00:00Z`);
const toStr = (d) => d.toISOString().slice(0, 10);
const money = (n) => `$ ${Math.round(n).toLocaleString('es-CO')}`;
const fmtDate = (s) => toUTC(s).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** ¿Es día hábil para vacaciones? Domingo y festivo nunca; sábado según la empresa. */
function isVacationBusinessDay(date, saturdayIsBusiness = true) {
  const dow = date.getUTCDay();
  if (dow === 0) return false;
  if (dow === 6 && !saturdayIsBusiness) return false;
  return !isHoliday(date);
}

/** Días calendario entre dos fechas, ambas inclusive. */
function calendarDays(from, to) {
  if (!isDate(from) || !isDate(to) || to < from) return null;
  return Math.round((toUTC(to) - toUTC(from)) / DAY_MS) + 1;
}

/** Días hábiles entre dos fechas (ambas inclusive) y los no hábiles que hay en medio. */
function businessDaysBetween(from, to, saturdayIsBusiness = true) {
  if (!isDate(from) || !isDate(to) || to < from) return null;
  let count = 0;
  const skipped = [];
  for (let d = toUTC(from); d <= toUTC(to); d = new Date(d.getTime() + DAY_MS)) {
    if (isVacationBusinessDay(d, saturdayIsBusiness)) count += 1;
    else skipped.push(toStr(d));
  }
  return { count, skipped };
}

/** Último día de N días hábiles de vacaciones que empiezan en `from` (si `from` es hábil, cuenta). */
function lastBusinessDay(from, n, saturdayIsBusiness = true) {
  if (!isDate(from) || !(n > 0) || n > 400) return null;
  let d = toUTC(from);
  let remaining = Math.ceil(n);
  for (;;) {
    if (isVacationBusinessDay(d, saturdayIsBusiness)) {
      remaining -= 1;
      if (remaining === 0) return toStr(d);
    }
    d = new Date(d.getTime() + DAY_MS);
  }
}

function nextBusinessDay(dateStr, saturdayIsBusiness = true) {
  let d = new Date(toUTC(dateStr).getTime() + DAY_MS);
  while (!isVacationBusinessDay(d, saturdayIsBusiness)) d = new Date(d.getTime() + DAY_MS);
  return toStr(d);
}

/**
 * Cálculo puro.
 * @param {object} ctx { employee, period, settings, commissionsAvg }
 * @param {object} input { category, subtype, values, source }
 *   source: campo que el operador acaba de editar (para Vacaciones decide si
 *   se calcula la fecha de fin a partir de los días o al revés).
 * @returns {{ values: object, detail: string|null, warnings: string[] }}
 */
function suggestNovedad(ctx, input) {
  const { employee, period, settings = {} } = ctx;
  const { category, subtype, source } = input;
  const v = input.values || {};
  const out = {};
  const warnings = [];
  let detail = null;

  const salary = Number(employee?.base_salary) || 0;
  const integral = employee?.salary_type === 'integral';
  const dayRate = salary / PAYROLL_CONSTANTS.DIAS_MES_COMERCIAL;
  const ibcDayRate = (integral ? salary * FACTOR_IBC_INTEGRAL : salary) / PAYROLL_CONSTANTS.DIAS_MES_COMERCIAL;
  const commissionsAvg = Number(ctx.commissionsAvg) || 0;
  const saturdayIsBusiness = settings.vacation_business_days !== 'mon_fri';
  if (!salary) warnings.push('El empleado no tiene salario registrado: escribe el valor a mano.');

  const vacationRate = (salary + (integral ? 0 : commissionsAvg)) / PAYROLL_CONSTANTS.DIAS_MES_COMERCIAL;
  const vacationRateText = () => (commissionsAvg > 0 && !integral
    ? `(salario ${money(salary)} + promedio de comisiones ${money(commissionsAvg)}) / 30 = ${money(vacationRate)} por día`
    : `${money(vacationRate)} por día (salario / 30)`);

  if (category === 'Vacaciones' && subtype === 'comunes') {
    let dias = num(v.cantidad);
    let fin = v.fechaFin;
    if (isDate(v.fechaInicio)) {
      if (source === 'fechaFin' && isDate(fin)) {
        const r = businessDaysBetween(v.fechaInicio, fin, saturdayIsBusiness);
        if (r) { dias = r.count; out.cantidad = dias; }
      } else if (dias > 0) {
        fin = lastBusinessDay(v.fechaInicio, dias, saturdayIsBusiness);
        if (fin) out.fechaFin = fin;
      } else if (isDate(fin)) {
        const r = businessDaysBetween(v.fechaInicio, fin, saturdayIsBusiness);
        if (r) { dias = r.count; out.cantidad = dias; }
      }
    }
    if (dias > 0 && salary) {
      out.pago = Math.round(vacationRate * dias);
      const parts = [`${dias} días hábiles × ${vacationRateText()} = ${money(out.pago)}.`];
      if (isDate(v.fechaInicio) && isDate(fin)) {
        const total = calendarDays(v.fechaInicio, fin);
        parts.push(`Del ${fmtDate(v.fechaInicio)} al ${fmtDate(fin)} (${total} días calendario, ${saturdayIsBusiness ? 'sin domingos ni festivos' : 'sin sábados, domingos ni festivos'}); regresa el ${fmtDate(nextBusinessDay(fin, saturdayIsBusiness))}.`);
        if (period?.end_date && fin > period.end_date && v.fechaInicio <= period.end_date) {
          const inPeriod = businessDaysBetween(v.fechaInicio, period.end_date, saturdayIsBusiness)?.count || 0;
          warnings.push(`Terminan después del fin de este periodo (${fmtDate(period.end_date)}): aquí se pagan y descuentan del sueldo los ${dias} días hábiles completos. Si prefieres repartirlas, registra en este periodo ${inPeriod} días hábiles (hasta el ${fmtDate(period.end_date)}) y el resto en el siguiente.`);
        }
      }
      detail = parts.join(' ');
    }
  } else if (category === 'Vacaciones' && subtype === 'compensadas') {
    const dias = num(v.cantidad);
    if (dias > 0 && salary) {
      out.pago = Math.round(vacationRate * dias);
      detail = `${dias} días × ${vacationRateText()} = ${money(out.pago)}.`;
    }
  } else if (category === 'Incapacidades') {
    const dias = calendarDays(v.fechaInicio, v.fechaFin);
    if (dias) out.cantidad = dias;
    const tipo = v.tipo || '1';
    if (!v.tipo) out.tipo = '1';
    const d = dias || num(v.cantidad);
    if (d > 0 && salary) {
      if (tipo === '2') {
        out.pago = Math.round(ibcDayRate * d);
        detail = `Laboral (ARL): ${d} días × ${money(ibcDayRate)} (100 %${integral ? ' del 70 % del salario integral' : ' del salario diario'}) = ${money(out.pago)}.`;
      } else {
        const minDay = PAYROLL_CONSTANTS.SMLMV / PAYROLL_CONSTANTS.DIAS_MES_COMERCIAL;
        const rate = Math.max(ibcDayRate * (PORCENTAJE_INCAPACIDAD_COMUN / 100), minDay);
        out.pago = Math.round(rate * d);
        detail = `Común (EPS): ${d} días × ${money(rate)} (${String(PORCENTAJE_INCAPACIDAD_COMUN).replace('.', ',')} % del salario diario${rate === minDay ? ', ajustado al salario mínimo diario' : ''}) = ${money(out.pago)}. Los 2 primeros días los asume la empresa; desde el tercero, la EPS.`;
        if (d > 180) warnings.push('Más de 180 días: desde el día 181 el pago lo asume el fondo de pensiones; revise el valor.');
      }
    }
  } else if (category === 'Licencias') {
    const dias = calendarDays(v.fechaInicio, v.fechaFin);
    if (dias) out.cantidad = dias;
    const d = dias || num(v.cantidad);
    if (subtype !== 'noRemunerada' && d > 0 && salary) {
      out.pago = Math.round(ibcDayRate * d);
      detail = `${d} días calendario × ${money(ibcDayRate)} por día${integral ? ' (70 % del salario integral)' : ' (salario / 30)'} = ${money(out.pago)}.${subtype === 'maternidadPaternidad' ? ' La EPS la reconoce a la empresa.' : ''}`;
    } else if (subtype === 'noRemunerada' && d > 0) {
      detail = `${d} días calendario sin pago: se descuentan del sueldo y no causan vacaciones ni prestaciones.`;
    }
  } else if (category === 'HuelgasLegales') {
    const dias = calendarDays(v.fechaInicio, v.fechaFin);
    if (dias) { out.cantidad = dias; detail = `${dias} días calendario.`; }
  } else if (category === 'Primas') {
    if (integral) warnings.push('El salario integral ya incluye la prima: normalmente no se paga.');
    let dias = num(v.cantidad);
    if (!(dias > 0) && period?.end_date && employee?.hire_date) {
      const end = period.end_date;
      const semStart = `${end.slice(0, 4)}-${Number(end.slice(5, 7)) <= 6 ? '01' : '07'}-01`;
      const from = employee.hire_date > semStart ? employee.hire_date : semStart;
      dias = Math.min(180, diasComerciales(from, end));
      out.cantidad = dias;
    }
    const aux = !integral && employee?.transport_allowance_eligible && salary <= PAYROLL_CONSTANTS.SMLMV * PAYROLL_CONSTANTS.TOPE_AUXILIO_TRANSPORTE_SMLMV
      ? PAYROLL_CONSTANTS.AUXILIO_TRANSPORTE : 0;
    if (dias > 0 && salary) {
      out.pago = Math.round(((salary + aux) * dias) / 360);
      detail = `(${money(salary)}${aux ? ` + auxilio de transporte ${money(aux)}` : ''}) × ${dias} días / 360 = ${money(out.pago)}.`;
    }
  } else if (category === 'Cesantias') {
    const pct = num(v.porcentaje) ?? 12;
    if (num(v.porcentaje) === null) out.porcentaje = 12;
    const pago = num(v.pago);
    if (pago > 0) {
      out.pagoIntereses = Math.round((pago * pct) / 100);
      detail = `Intereses: ${money(pago)} × ${pct} % = ${money(out.pagoIntereses)} (año completo; si trabajó menos, se prorratea por días).`;
    }
  } else if (category === 'Sindicatos') {
    const pct = num(v.porcentaje);
    if (pct > 0 && salary) {
      out.deduccion = Math.round((salary * pct) / 100);
      detail = `${money(salary)} × ${pct} % = ${money(out.deduccion)}.`;
    }
  }

  return { values: out, detail, warnings };
}

/** Promedio mensual de comisiones de los últimos 12 meses (novedades 'Comisiones'). */
async function commissionsMonthlyAverage(tenantId, employeeId, until) {
  const { PayrollNovedad, PayrollPeriod } = require('../../models');
  const end = isDate(until) ? until : toStr(new Date());
  const startD = toUTC(end);
  startD.setUTCFullYear(startD.getUTCFullYear() - 1);
  const rows = await PayrollNovedad.findAll({
    where: { tenant_id: tenantId, employee_id: employeeId, dian_category: 'Comisiones' },
    attributes: ['payload'],
    include: [{ model: PayrollPeriod, as: 'period', attributes: ['end_date'], where: { end_date: { [Op.gt]: toStr(startD), [Op.lte]: end } } }],
  });
  const sum = rows.reduce((s, r) => {
    const p = r.payload;
    const items = Array.isArray(p) ? p : [p];
    return s + items.reduce((a, it) => a + (Number(typeof it === 'object' && it !== null ? it.comision ?? it.valor ?? 0 : it) || 0), 0);
  }, 0);
  return sum / 12;
}

module.exports = {
  suggestNovedad,
  commissionsMonthlyAverage,
  businessDaysBetween,
  lastBusinessDay,
  calendarDays,
};
