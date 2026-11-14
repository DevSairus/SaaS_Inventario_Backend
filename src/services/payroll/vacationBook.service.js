// backend/src/services/payroll/vacationBook.service.js
//
// Libro de vacaciones por empleado: días causados, disfrutados, compensados
// en dinero y disponibles a una fecha.
//
//  - Causación: 15 días por cada 360 días de vinculación (CST art. 186), con
//    la misma convención comercial de 30 días/mes del resto del módulo
//    (diasComerciales, ambas fechas inclusive). No se causan los días de
//    licencia no remunerada ni los días no remunerados/suspensiones
//    registrados como novedad (CST art. 53).
//  - Punto de partida: la fecha de ingreso, o la fecha de corte del saldo
//    inicial (vacation_opening_date) si el empleado traía un saldo de antes
//    de llevar la nómina en Pitbox. En ese caso solo cuentan las novedades de
//    periodos que empiezan en o después de esa fecha: las anteriores se
//    suponen incluidas en el saldo.
//  - Movimientos: las novedades dian_category='Vacaciones' de cualquier
//    estado de periodo (abierto incluido: ya están registradas), sumando
//    'comunes' (disfrutadas) y 'compensadas' (pagadas en dinero).
//
// La liquidación definitiva (payrollTerminationService) usa este mismo
// cálculo a la fecha de retiro.
'use strict';

const { Op } = require('sequelize');
const { Employee, PayrollNovedad, PayrollPeriod } = require('../../models');
const { PAYROLL_CONSTANTS, diasComerciales } = require('./payrollService');

const DIAS_VACACIONES_POR_ANIO = 15;
const DIAS_ANIO_COMERCIAL = 360;
// Más de dos periodos (30 días) acumulados: CST art. 190 lo permite solo en
// casos especiales (técnicos, especialistas, de confianza, extranjeros).
const MAX_DIAS_ACUMULABLES = 30;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round2 = (n) => Math.round(n * 100) / 100;
const list = (v) => (Array.isArray(v) ? v : (v ? [v] : []));
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Cálculo puro (sin base de datos).
 * @param {object} employee  { hire_date, termination_date, base_salary, vacation_opening_days, vacation_opening_date }
 * @param {Array}  novedades [{ dian_category, payload, unpaid_days, notes, period: { start_date, end_date, status } }]
 * @param {string} asOf      fecha 'YYYY-MM-DD' (por defecto hoy; nunca después del retiro)
 */
function computeVacationBook(employee, novedades = [], asOf = todayStr()) {
  const openingDate = employee.vacation_opening_date || null;
  const openingDays = openingDate ? num(employee.vacation_opening_days) : 0;
  const start = openingDate || employee.hire_date;
  const end = employee.termination_date && employee.termination_date < asOf ? employee.termination_date : asOf;
  const diasVinculo = end >= start ? diasComerciales(start, end) : 0;

  const relevant = novedades.filter((n) => !openingDate || (n.period?.start_date && n.period.start_date >= openingDate));

  let diasNoCausan = 0;
  let disfrutados = 0;
  let compensados = 0;
  let valorPagado = 0;
  const movimientos = [];
  for (const n of relevant) {
    diasNoCausan += num(n.unpaid_days);
    const p = n.payload || {};
    if (n.dian_category === 'Licencias') {
      for (const it of list(p.noRemunerada)) diasNoCausan += num(it.cantidad);
    }
    if (n.dian_category !== 'Vacaciones') continue;
    for (const [tipo, items] of [['disfrutadas', list(p.comunes)], ['compensadas', list(p.compensadas)]]) {
      for (const it of items) {
        const dias = num(it.cantidad);
        const valor = num(it.pago);
        if (tipo === 'disfrutadas') disfrutados += dias; else compensados += dias;
        valorPagado += valor;
        movimientos.push({
          tipo,
          dias,
          valor,
          fecha_inicio: it.fechaInicio || null,
          fecha_fin: it.fechaFin || null,
          periodo: n.period ? { id: n.period.id, start_date: n.period.start_date, end_date: n.period.end_date, status: n.period.status } : null,
          notas: n.notes || null,
        });
      }
    }
  }
  movimientos.sort((a, b) => String(a.fecha_inicio || a.periodo?.start_date || '').localeCompare(String(b.fecha_inicio || b.periodo?.start_date || '')));

  const diasCausan = Math.max(0, diasVinculo - diasNoCausan);
  const causados = (diasCausan / DIAS_ANIO_COMERCIAL) * DIAS_VACACIONES_POR_ANIO;
  const disponibles = openingDays + causados - disfrutados - compensados;
  const valorDia = num(employee.base_salary) / PAYROLL_CONSTANTS.DIAS_MES_COMERCIAL;

  const alertas = [];
  if (disponibles > MAX_DIAS_ACUMULABLES) {
    alertas.push(`Acumula ${round2(disponibles)} días: más de dos periodos (art. 190 CST solo lo permite a técnicos, especialistas, personal de confianza o extranjeros).`);
  }
  if (disponibles < 0) alertas.push('Tomó más días de los causados (vacaciones anticipadas).');
  const totalTomados = disfrutados + compensados;
  if (compensados > 0 && totalTomados > 0 && compensados > (openingDays + causados) / 2) {
    alertas.push('Los días compensados en dinero superan la mitad de los causados (art. 189 CST).');
  }

  return {
    desde: start,
    hasta: end,
    saldo_inicial: round2(openingDays),
    fecha_saldo_inicial: openingDate,
    dias_vinculo: diasVinculo,
    dias_no_causan: round2(diasNoCausan),
    causados: round2(causados),
    disfrutados: round2(disfrutados),
    compensados: round2(compensados),
    disponibles: round2(disponibles),
    valor_dia: Math.round(valorDia),
    valor_disponibles: Math.round(valorDia * Math.max(0, disponibles)),
    valor_pagado: Math.round(valorPagado),
    alertas,
    movimientos,
  };
}

async function loadNovedades(tenantId, employeeIds) {
  return PayrollNovedad.findAll({
    where: {
      tenant_id: tenantId,
      employee_id: { [Op.in]: employeeIds },
      [Op.or]: [
        { dian_category: { [Op.in]: ['Vacaciones', 'Licencias'] } },
        { unpaid_days: { [Op.gt]: 0 } },
      ],
    },
    attributes: ['id', 'employee_id', 'dian_category', 'payload', 'unpaid_days', 'notes'],
    include: [{ model: PayrollPeriod, as: 'period', attributes: ['id', 'period_type', 'start_date', 'end_date', 'status'] }],
  });
}

/**
 * @param {object} [options.forSettlement] para la liquidación definitiva: sin
 *   las novedades de periodos de liquidación aún no emitidos (las de un intento
 *   anterior que se va a reemplazar; contarlas descontaría las vacaciones dos veces).
 */
async function getEmployeeBook(tenantId, employee, asOf, { forSettlement = false } = {}) {
  let novedades = (await loadNovedades(tenantId, [employee.id])).map((n) => n.get({ plain: true }));
  if (forSettlement) novedades = novedades.filter((n) => !(n.period?.period_type === 'liquidacion' && n.period.status !== 'emitido'));
  // 6.5 — liquidaciones de vacaciones pagadas fuera de período y aún no absorbidas por una nómina.
  const vacationService = require('./payrollVacationService');
  novedades.push(...vacationService.settlementsAsNovedades(await vacationService.pendingForBook(tenantId, [employee.id])));
  return computeVacationBook(employee, novedades, asOf);
}

/** Resumen para todos los empleados (activos por defecto). */
async function listBooks(tenantId, { includeInactive = false, asOf } = {}) {
  const where = { tenant_id: tenantId };
  if (!includeInactive) where.is_active = true;
  const employees = await Employee.findAll({
    where,
    attributes: ['id', 'first_name', 'other_names', 'first_surname', 'second_surname', 'document_number', 'position',
      'hire_date', 'termination_date', 'base_salary', 'is_active', 'vacation_opening_days', 'vacation_opening_date'],
    order: [['first_surname', 'ASC'], ['first_name', 'ASC']],
  });
  if (!employees.length) return [];
  const novedades = await loadNovedades(tenantId, employees.map((e) => e.id));
  const byEmployee = new Map();
  for (const n of novedades) {
    const plain = n.get({ plain: true });
    if (!byEmployee.has(plain.employee_id)) byEmployee.set(plain.employee_id, []);
    byEmployee.get(plain.employee_id).push(plain);
  }
  // 6.5 — liquidaciones de vacaciones pagadas fuera de período y aún no absorbidas.
  const vacationService = require('./payrollVacationService');
  const pendientes = await vacationService.pendingForBook(tenantId, employees.map((e) => e.id));
  for (const s of pendientes) {
    if (!byEmployee.has(s.employee_id)) byEmployee.set(s.employee_id, []);
    byEmployee.get(s.employee_id).push(...vacationService.settlementsAsNovedades([s]));
  }
  return employees.map((e) => {
    const { movimientos, ...book } = computeVacationBook(e, byEmployee.get(e.id) || [], asOf);
    return {
      employee: {
        id: e.id, document_number: e.document_number, position: e.position, hire_date: e.hire_date, is_active: e.is_active,
        name: [e.first_name, e.other_names, e.first_surname, e.second_surname].filter(Boolean).join(' '),
      },
      ...book,
      movimientos_count: movimientos.length,
    };
  });
}

/** Guarda (o borra, con days/date vacíos) el saldo inicial del empleado. */
async function setOpeningBalance(employee, { days, date }) {
  const empty = (v) => v === undefined || v === null || v === '';
  if (empty(days) && empty(date)) {
    await employee.update({ vacation_opening_days: null, vacation_opening_date: null });
    return employee;
  }
  const d = Number(days);
  if (!Number.isFinite(d) || d < -60 || d > 365) {
    const err = new Error('Escribe los días pendientes del saldo inicial (entre -60 y 365)');
    err.statusCode = 400;
    throw err;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    const err = new Error('Indica la fecha de corte del saldo inicial');
    err.statusCode = 400;
    throw err;
  }
  if (date < employee.hire_date) {
    const err = new Error('La fecha de corte no puede ser anterior a la fecha de ingreso');
    err.statusCode = 400;
    throw err;
  }
  await employee.update({ vacation_opening_days: round2(d), vacation_opening_date: date });
  return employee;
}

module.exports = {
  DIAS_VACACIONES_POR_ANIO,
  computeVacationBook,
  getEmployeeBook,
  listBooks,
  setOpeningBalance,
};
