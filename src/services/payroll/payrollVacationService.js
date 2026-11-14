// backend/src/services/payroll/payrollVacationService.js
//
// 6.5 — Liquidación y pago directo de vacaciones fuera de un período de nómina.
//
// Flujo:
//   1. create   → 'borrador': calcula días y valor con el libro de vacaciones.
//   2. pay      → 'pagada': asiento Dr 133015 Anticipos de nómina (tercero = empleado)
//                 / Cr banco. Es un ANTICIPO porque el devengo lo reconoce el período:
//   3. attach   → el período de nómina donde cae la fecha de pago la absorbe: crea la
//                 novedad Vacaciones (devengado, la reporta la DIAN) y una deducción
//                 de Anticipos por el mismo valor, así el neto del período no la paga
//                 dos veces y el gasto/provisión se reconoce una sola vez.
//   4. void     → anula (reversa el asiento; si estaba absorbida y el período no se
//                 ha emitido, retira sus novedades).
//
// El libro de vacaciones cuenta las liquidaciones pagadas aún no absorbidas
// (settlementsAsNovedades) para que no se tomen dos veces los mismos días, y las
// absorbidas las cuenta por sus novedades.
'use strict';

const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { PAYROLL_CONSTANTS } = require('./payrollService');

const models = () => require('../../models');
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const fail = (message, statusCode = 400) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
};

/**
 * Cálculo puro. El valor del día es base/30 (convención de nómina); `baseOverride`
 * permite usar una base distinta del básico (p. ej. con el promedio de variables).
 */
function calculateSettlement({ baseSalary, baseOverride, daysEnjoyed = 0, daysCompensated = 0 }) {
  const base = num(baseOverride) > 0 ? num(baseOverride) : num(baseSalary);
  const dailyValue = round2(base / PAYROLL_CONSTANTS.DIAS_MES_COMERCIAL);
  const enjoyed = round2(daysEnjoyed);
  const compensated = round2(daysCompensated);
  const valueEnjoyed = Math.round(dailyValue * enjoyed);
  const valueCompensated = Math.round(dailyValue * compensated);
  return {
    base_salary: round2(base),
    daily_value: dailyValue,
    days_enjoyed: enjoyed,
    days_compensated: compensated,
    value_enjoyed: valueEnjoyed,
    value_compensated: valueCompensated,
    total_value: valueEnjoyed + valueCompensated,
  };
}

/**
 * Reglas (puras) contra el libro de vacaciones del empleado. Lanza 400.
 * @param {object} book  resultado de computeVacationBook
 */
function validateSettlement({ employee, input, book }) {
  const enjoyed = num(input.days_enjoyed);
  const compensated = num(input.days_compensated);
  if (enjoyed < 0 || compensated < 0 || enjoyed + compensated <= 0) throw fail('Indique los días a disfrutar o a compensar en dinero');
  if (employee.is_active === false) throw fail('El empleado está inactivo');
  if (employee.termination_date) throw fail('El empleado tiene fecha de retiro: sus vacaciones pendientes se pagan en la liquidación definitiva');

  if (enjoyed > 0) {
    if (!ISO_DATE.test(String(input.start_date || '')) || !ISO_DATE.test(String(input.end_date || ''))) {
      throw fail('Indique el primer y el último día de las vacaciones disfrutadas');
    }
    if (input.end_date < input.start_date) throw fail('El último día no puede ser anterior al primero');
    if (input.start_date < employee.hire_date) throw fail('Las vacaciones no pueden empezar antes de la fecha de ingreso');
  }

  const total = enjoyed + compensated;
  if (total > num(book.disponibles) + 0.005) {
    throw fail(`El empleado tiene ${round2(book.disponibles)} día(s) disponibles y se piden ${round2(total)}`);
  }
  // CST art. 189: solo puede compensarse en dinero hasta la mitad de las vacaciones.
  const causadasTotales = num(book.saldo_inicial) + num(book.causados);
  if (compensated > 0 && num(book.compensados) + compensated > causadasTotales / 2 + 0.005) {
    throw fail('Solo puede compensarse en dinero hasta la mitad de las vacaciones causadas (CST art. 189)');
  }
}

/** Fila de liquidación → pseudo-novedad para el libro (solo las pagadas y no absorbidas). */
function settlementsAsNovedades(rows = []) {
  return rows
    .filter((s) => s.status === 'pagada' && !s.payroll_period_id)
    .map((s) => ({
      dian_category: 'Vacaciones',
      unpaid_days: 0,
      notes: `Liquidación de vacaciones VAC-${s.doc_number}`,
      payload: {
        comunes: num(s.days_enjoyed) > 0 ? [{ cantidad: num(s.days_enjoyed), pago: num(s.value_enjoyed), fechaInicio: s.start_date, fechaFin: s.end_date }] : [],
        compensadas: num(s.days_compensated) > 0 ? [{ cantidad: num(s.days_compensated), pago: num(s.value_compensated) }] : [],
      },
      // El libro filtra por el inicio del período contra la fecha de saldo inicial;
      // aquí la fecha de pago hace ese papel.
      period: { id: null, start_date: s.payment_date, end_date: s.payment_date, status: 'fuera_de_periodo' },
    }));
}

/** Novedades y deducción que crea al absorberla un período (pura). */
function buildPeriodNovedades(settlement) {
  const comunes = num(settlement.days_enjoyed) > 0
    ? [{ cantidad: num(settlement.days_enjoyed), pago: num(settlement.value_enjoyed), fechaInicio: settlement.start_date, fechaFin: settlement.end_date }]
    : [];
  const compensadas = num(settlement.days_compensated) > 0
    ? [{ cantidad: num(settlement.days_compensated), pago: num(settlement.value_compensated) }]
    : [];
  return [
    {
      dian_category: 'Vacaciones',
      payload: { comunes, compensadas },
      notes: `Liquidación de vacaciones VAC-${settlement.doc_number} (pagada el ${settlement.payment_date})`,
    },
    {
      dian_category: 'AnticiposDeducciones',
      payload: round2(settlement.total_value),
      notes: `Descuento del anticipo pagado en la liquidación de vacaciones VAC-${settlement.doc_number}`,
    },
  ];
}

async function nextDocNumber(tenantId, t) {
  const { PayrollVacationSettlement } = models();
  const max = await PayrollVacationSettlement.max('doc_number', { where: { tenant_id: tenantId }, transaction: t });
  return (max || 0) + 1;
}

async function loadEmployee(tenantId, employeeId, t) {
  const { Employee } = models();
  const employee = await Employee.findOne({ where: { id: employeeId, tenant_id: tenantId }, transaction: t });
  if (!employee) throw fail('Empleado no encontrado', 404);
  return employee;
}

async function loadSettlement(tenantId, id, t, lock = false) {
  const { PayrollVacationSettlement } = models();
  const s = await PayrollVacationSettlement.findOne({ where: { id, tenant_id: tenantId }, transaction: t, ...(lock ? { lock: t.LOCK.UPDATE } : {}) });
  if (!s) throw fail('Liquidación de vacaciones no encontrada', 404);
  return s;
}

/** Libro del empleado SIN contar esta liquidación (para recalcular un borrador). */
async function bookFor(tenantId, employee, asOf) {
  const { getEmployeeBook } = require('./vacationBook.service');
  return getEmployeeBook(tenantId, employee, asOf);
}

async function create(tenantId, input, userId) {
  const { PayrollVacationSettlement } = models();
  const employee = await loadEmployee(tenantId, input.employee_id);
  const calc = calculateSettlement({
    baseSalary: employee.base_salary,
    baseOverride: input.base_override,
    daysEnjoyed: input.days_enjoyed,
    daysCompensated: input.days_compensated,
  });
  const asOf = input.start_date && ISO_DATE.test(input.start_date) ? input.start_date : undefined;
  const book = await bookFor(tenantId, employee, asOf);
  validateSettlement({ employee, input: { ...input, ...calc }, book });
  if (calc.total_value <= 0) throw fail('El valor de las vacaciones es cero: revise el salario del empleado');

  const t = await sequelize.transaction();
  try {
    const settlement = await PayrollVacationSettlement.create({
      tenant_id: tenantId,
      employee_id: employee.id,
      doc_number: await nextDocNumber(tenantId, t),
      status: 'borrador',
      start_date: calc.days_enjoyed > 0 ? input.start_date : null,
      end_date: calc.days_enjoyed > 0 ? input.end_date : null,
      ...calc,
      notes: input.notes || null,
      created_by: userId || null,
    }, { transaction: t });
    await t.commit();
    return settlement;
  } catch (error) {
    if (!t.finished) await t.rollback();
    throw error;
  }
}

/** Contabiliza y registra el desembolso. */
async function pay(tenantId, id, { paymentDate, bankAccountId, reference }, userId) {
  if (!ISO_DATE.test(String(paymentDate || ''))) throw fail('La fecha de pago es obligatoria');
  const { registrarPagoVacaciones } = require('./payrollAccountingService');

  const t = await sequelize.transaction();
  try {
    const settlement = await loadSettlement(tenantId, id, t, true);
    if (settlement.status !== 'borrador') throw fail(`La liquidación está ${settlement.status}: solo se paga un borrador`, 409);
    const employee = await loadEmployee(tenantId, settlement.employee_id, t);

    // El libro puede haber cambiado desde el borrador (otra liquidación, una novedad).
    const book = await bookFor(tenantId, employee, settlement.start_date || paymentDate);
    validateSettlement({ employee, input: settlement.get({ plain: true }), book });

    const entry = await registrarPagoVacaciones({ tenantId, settlement, employee, paymentDate, bankAccountId, reference, userId, t });
    await settlement.update({
      status: 'pagada', payment_date: paymentDate, bank_account_id: bankAccountId || null,
      reference: reference || null, journal_entry_id: entry.id, paid_by: userId || null,
    }, { transaction: t });
    await t.commit();
    return settlement;
  } catch (error) {
    if (!t.finished) await t.rollback();
    throw error;
  }
}

/** El período de nómina absorbe la liquidación (novedad Vacaciones + descuento del anticipo). */
async function attachToPeriod(tenantId, id, periodId, userId) {
  const { PayrollPeriod, PayrollNovedad } = models();
  const t = await sequelize.transaction();
  try {
    const settlement = await loadSettlement(tenantId, id, t, true);
    if (settlement.status !== 'pagada') throw fail('Solo se agrega a un período una liquidación ya pagada', 409);
    if (settlement.payroll_period_id) throw fail('La liquidación ya está en un período de nómina', 409);

    const period = await PayrollPeriod.findOne({ where: { id: periodId, tenant_id: tenantId }, transaction: t, lock: t.LOCK.UPDATE });
    if (!period) throw fail('Período no encontrado', 404);
    if (period.period_type === 'liquidacion') throw fail('Una liquidación de vacaciones no va en un período de liquidación definitiva');
    if (period.status !== 'abierto') throw fail(`El período está ${period.status}: solo se agrega a un período abierto`, 409);
    if (settlement.payment_date < period.start_date || settlement.payment_date > period.end_date) {
      throw fail(`La fecha de pago (${settlement.payment_date}) no cae dentro del período ${period.start_date} — ${period.end_date}`);
    }

    const ids = [];
    for (const nov of buildPeriodNovedades(settlement)) {
      // eslint-disable-next-line no-await-in-loop
      const row = await PayrollNovedad.create({
        tenant_id: tenantId, employee_id: settlement.employee_id, payroll_period_id: period.id,
        dian_category: nov.dian_category, payload: nov.payload, notes: nov.notes, created_by: userId || null,
      }, { transaction: t });
      ids.push(row.id);
    }
    await settlement.update({ payroll_period_id: period.id, novedad_ids: ids }, { transaction: t });
    await t.commit();
    return settlement;
  } catch (error) {
    if (!t.finished) await t.rollback();
    throw error;
  }
}

async function voidSettlement(tenantId, id, reason, userId) {
  if (!String(reason || '').trim()) throw fail('Indique el motivo de la anulación');
  const { PayrollNovedad, PayrollPeriod, JournalEntry } = models();
  const { reverseEntry } = require('../accounting/journalEntry.service');

  const t = await sequelize.transaction();
  try {
    const settlement = await loadSettlement(tenantId, id, t, true);
    if (settlement.status === 'anulada') throw fail('La liquidación ya está anulada', 409);

    if (settlement.payroll_period_id) {
      const period = await PayrollPeriod.findOne({ where: { id: settlement.payroll_period_id, tenant_id: tenantId }, transaction: t });
      if (period && period.status !== 'abierto') {
        throw fail(`Ya está en un período ${period.status}: no se puede anular. Haga una nota de ajuste del período.`, 409);
      }
      if (settlement.novedad_ids?.length) {
        await PayrollNovedad.destroy({ where: { tenant_id: tenantId, id: { [Op.in]: settlement.novedad_ids } }, transaction: t });
      }
    }
    if (settlement.journal_entry_id) {
      const entry = await JournalEntry.findOne({ where: { id: settlement.journal_entry_id, tenant_id: tenantId }, transaction: t });
      if (entry && entry.status !== 'voided' && !entry.reversed_by_entry_id) {
        await reverseEntry(entry.id, tenantId, userId, `Anulación liquidación de vacaciones VAC-${settlement.doc_number}: ${reason}`, t);
      }
    }
    await settlement.update({
      status: 'anulada', void_reason: reason, voided_by: userId || null, voided_at: new Date(),
      payroll_period_id: null, novedad_ids: [],
    }, { transaction: t });
    await t.commit();
    return settlement;
  } catch (error) {
    if (!t.finished) await t.rollback();
    throw error;
  }
}

async function list(tenantId, { employeeId, status } = {}) {
  const { PayrollVacationSettlement, Employee } = models();
  const where = { tenant_id: tenantId };
  if (employeeId) where.employee_id = employeeId;
  if (status) where.status = status;
  return PayrollVacationSettlement.findAll({
    where,
    include: [{ model: Employee, as: 'employee', attributes: ['id', 'first_name', 'other_names', 'first_surname', 'second_surname', 'document_number'] }],
    order: [['doc_number', 'DESC']],
    limit: 300,
  });
}

async function get(tenantId, id) {
  const { Employee } = models();
  const settlement = await loadSettlement(tenantId, id);
  const employee = await Employee.findOne({ where: { id: settlement.employee_id, tenant_id: tenantId } });
  return { settlement, employee };
}

/** Pagadas y aún sin período, para el libro (pseudo-novedades). */
async function pendingForBook(tenantId, employeeIds) {
  const { PayrollVacationSettlement } = models();
  if (!employeeIds.length) return [];
  const rows = await PayrollVacationSettlement.findAll({
    where: { tenant_id: tenantId, employee_id: { [Op.in]: employeeIds }, status: 'pagada', payroll_period_id: null },
  });
  return rows.map((r) => r.get({ plain: true }));
}

module.exports = {
  calculateSettlement,
  validateSettlement,
  settlementsAsNovedades,
  buildPeriodNovedades,
  create,
  pay,
  attachToPeriod,
  voidSettlement,
  list,
  get,
  pendingForBook,
};
