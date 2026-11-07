// backend/src/services/projects/projectLabor.service.js
//
// Mano de obra por proyecto (Fase 2, caso de demo 6):
//   - Se registran horas por empleado, proyecto y día (project_time_entries).
//   - Al repartir un periodo de nómina, el costo de cada empleado en ese
//     periodo (devengado + aportes del empleador + provisiones, con las
//     mismas funciones de la contabilización de nómina) se distribuye entre
//     los proyectos en proporción a sus horas.
//   - Base del reparto: la mayor entre las horas registradas y la jornada
//     del periodo (services/payroll/jornada.js). Si un técnico registró 40 h
//     en una obra en un mes de 210 h, a la obra va 40/210 de su costo; el
//     resto queda como gasto general (no se carga a ningún proyecto).
//   - El costo sale de los comprobantes del periodo (su snapshot, con las
//     notas de ajuste aceptadas aplicadas); si el periodo está liquidado pero
//     aún no emitido, de la misma liquidación que muestra la vista previa.
//   - Repartir de nuevo un periodo reemplaza el reparto anterior.

const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const {
  Project, ProjectTimeEntry, ProjectLaborAllocation, Employee, PayrollPeriod, PayrollDocument, PayrollDocumentAdjustment, User,
} = require('../../models');
const { monthlyHoursFor } = require('../payroll/jornada');
const { INACTIVE_STATUSES } = require('./projectStock.service');

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const num = (v) => Number(v) || 0;
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const round4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;
const employeeName = (e) => (e ? [e.first_name, e.other_names, e.first_surname, e.second_surname].filter(Boolean).join(' ') : '');
const ALLOCATABLE_PERIOD_STATUSES = ['liquidado', 'emitido', 'cerrado'];

// ── Horas ────────────────────────────────────────────────────────────────
async function listTimeEntries(tenantId, projectId, { from, to } = {}) {
  const where = { tenant_id: tenantId, project_id: projectId };
  if (from || to) where.work_date = { ...(from ? { [Op.gte]: from } : {}), ...(to ? { [Op.lte]: to } : {}) };
  return ProjectTimeEntry.findAll({
    where,
    include: [
      { model: Employee, as: 'employee', attributes: ['id', 'first_name', 'other_names', 'first_surname', 'second_surname', 'document_number'] },
      { model: User, as: 'creator', attributes: ['id', 'first_name', 'last_name', 'email'] },
    ],
    order: [['work_date', 'DESC'], ['created_at', 'DESC']],
    limit: 500,
  });
}

async function addTimeEntry(req, project, body) {
  const tenantId = req.user.tenant_id;
  if (INACTIVE_STATUSES.includes(project.status)) throw httpError(400, 'El proyecto está cerrado o cancelado');
  const hours = round2(num(body.hours));
  if (!(hours > 0) || hours > 24) throw httpError(400, 'Las horas deben estar entre 0 y 24');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.work_date || ''))) throw httpError(400, 'Indica la fecha');
  const employee = await Employee.findOne({ where: { id: body.employee_id, tenant_id: tenantId }, attributes: ['id', 'is_active'] });
  if (!employee) throw httpError(400, 'Empleado no encontrado');
  // Un empleado no trabaja más de 24 h en un día, sumando todos los proyectos.
  const dayTotal = num(await ProjectTimeEntry.sum('hours', { where: { tenant_id: tenantId, employee_id: employee.id, work_date: body.work_date } }));
  if (dayTotal + hours > 24) throw httpError(400, `Ese día ya tiene ${dayTotal} h registradas en proyectos`);
  return ProjectTimeEntry.create({
    tenant_id: tenantId, project_id: project.id, employee_id: employee.id, work_date: body.work_date, hours,
    notes: String(body.notes || '').trim().slice(0, 255) || null, created_by: req.user.id,
  });
}

async function deleteTimeEntry(tenantId, project, entryId) {
  const n = await ProjectTimeEntry.destroy({ where: { id: entryId, tenant_id: tenantId, project_id: project.id } });
  if (!n) throw httpError(404, 'Registro de horas no encontrado');
}

// ── Costo del empleado en el periodo ─────────────────────────────────────
const sumValues = (obj) => Object.values(obj || {}).reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);

/**
 * Costo para la empresa de una liquidación: devengado + aportes del empleador
 * + provisiones. Las prestaciones (prima, vacaciones, cesantías e intereses)
 * ya se cargan cada mes como provisión, así que su pago no vuelve a sumar.
 */
function costOfLiquidation({ employee, liquidation, settings, isLiquidacion = false }) {
  const accounting = require('../payroll/payrollAccountingService');
  const { aportes, provisiones } = accounting.calcularAportesYProvisiones({ employee, liquidation, settings, isLiquidacion });
  const prestacionesPagadas = accounting.desglosarDevengados(liquidation)
    .filter((i) => i.prestacion)
    .reduce((s, i) => s + num(i.amount), 0);
  const devengado = num(liquidation.devengadosTotal) - prestacionesPagadas;
  const a = round2(sumValues(aportes));
  const p = round2(sumValues(provisiones));
  // by_concept: lo usa la reclasificación contable (projectAccounting.service.js).
  return { devengado: round2(devengado), aportes: a, provisiones: p, total: round2(devengado + a + p), by_concept: { aportes, provisiones } };
}

async function employeeCostsForPeriod(tenantId, period, employeeIds) {
  const accounting = require('../payroll/payrollAccountingService');
  const settings = await accounting.getSettings(tenantId);
  const isLiquidacion = period.period_type === 'liquidacion';
  const costs = new Map();
  const add = (employee, liquidation, source) => {
    if (!employee || !liquidation) return;
    costs.set(employee.id, { employee, ...costOfLiquidation({ employee, liquidation, settings, isLiquidacion }), source });
  };

  // 1) Comprobantes del periodo (los rechazados por la DIAN no cuentan).
  const docs = await PayrollDocument.findAll({
    where: { tenant_id: tenantId, payroll_period_id: period.id, employee_id: employeeIds, dian_status: { [Op.ne]: 'rejected' } },
    include: [{ model: Employee, as: 'employee' }, { model: PayrollDocumentAdjustment, as: 'adjustments', required: false }],
  });
  for (const d of docs) add(d.employee, accounting.liquidacionVigente(d), 'comprobante');

  // 2) Liquidado sin emitir: la misma liquidación de la vista previa.
  const missing = employeeIds.filter((id) => !costs.has(id));
  if (missing.length) {
    const emission = require('../payroll/payrollPeriodEmissionService');
    const { liquidarEmpleado } = require('../payroll/payrollService');
    const autoConcepts = await emission.getActiveAutoConcepts(tenantId);
    const employees = await Employee.findAll({ where: { id: missing, tenant_id: tenantId } });
    for (const employee of employees) {
      const { diasNoRemunerados, novedadesDian } = await emission.getNovedadesParaLiquidacion(tenantId, employee.id, period.id);
      const liquidation = liquidarEmpleado({ employee, period, novedades: novedadesDian, autoConcepts, diasNoRemunerados, softwareSecurityCode: null });
      add(employee, liquidation, 'liquidación');
    }
  }
  return costs;
}

// Jornada del periodo: horas del mes (ley 2101 o la de la empresa) en
// proporción a los días del periodo (mes comercial de 30 días).
function baseHoursForPeriod(period, weeklyOverride) {
  const start = new Date(`${period.start_date}T00:00:00`);
  const end = new Date(`${period.end_date}T00:00:00`);
  const days = Math.min(Math.round((end - start) / 86400000) + 1, 30);
  return round2(monthlyHoursFor(period.end_date, weeklyOverride) * (days / 30));
}

/**
 * Reparto puro (sin BD), para probarlo aparte.
 * hours: [{ employee_id, project_id, hours }]; costs: Map employee_id → { total, ... }
 * @returns {{ rows: Array, overhead: number }}
 */
function computeAllocations({ hours, costs, baseHours }) {
  const byEmployee = new Map();
  for (const h of hours) {
    if (!byEmployee.has(h.employee_id)) byEmployee.set(h.employee_id, new Map());
    const m = byEmployee.get(h.employee_id);
    m.set(h.project_id, round2((m.get(h.project_id) || 0) + num(h.hours)));
  }
  const rows = [];
  let overhead = 0;
  for (const [employeeId, projects] of byEmployee) {
    const cost = costs.get(employeeId);
    if (!cost || !(cost.total > 0)) continue;
    const registered = round2([...projects.values()].reduce((s, h) => s + h, 0));
    const base = Math.max(registered, baseHours);
    let assigned = 0;
    const entries = [...projects.entries()];
    entries.forEach(([projectId, h], idx) => {
      const pct = h / base;
      // Si las horas cubren toda la jornada, el último proyecto absorbe el
      // centavo de redondeo para que el reparto sume exactamente el costo.
      const amount = registered >= baseHours && idx === entries.length - 1
        ? round2(cost.total - assigned)
        : round2(cost.total * pct);
      assigned = round2(assigned + amount);
      rows.push({ employee_id: employeeId, project_id: projectId, hours: h, base_hours: base, percentage: round4(pct * 100), employee_cost: cost.total, amount, breakdown: { devengado: cost.devengado, aportes: cost.aportes, provisiones: cost.provisiones, source: cost.source } });
    });
    overhead = round2(overhead + cost.total - assigned);
  }
  return { rows, overhead };
}

/** Reparte (o vuelve a repartir) el costo de nómina de un periodo entre proyectos. */
async function allocatePeriod(req, periodId) {
  const tenantId = req.user.tenant_id;
  const period = await PayrollPeriod.findOne({ where: { id: periodId, tenant_id: tenantId } });
  if (!period) throw httpError(404, 'Periodo de nómina no encontrado');
  if (!ALLOCATABLE_PERIOD_STATUSES.includes(period.status)) throw httpError(400, 'Liquida el periodo de nómina antes de repartirlo entre proyectos');

  const hours = await ProjectTimeEntry.findAll({
    where: { tenant_id: tenantId, work_date: { [Op.between]: [period.start_date, period.end_date] } },
    attributes: ['employee_id', 'project_id', 'hours'],
    raw: true,
  });
  const employeeIds = [...new Set(hours.map((h) => h.employee_id))];
  const settings = await require('../payroll/payrollAccountingService').getSettings(tenantId);
  const baseHours = baseHoursForPeriod(period, settings?.weekly_hours);
  const costs = employeeIds.length ? await employeeCostsForPeriod(tenantId, period, employeeIds) : new Map();
  const { rows, overhead } = computeAllocations({ hours, costs, baseHours });

  await sequelize.transaction(async (t) => {
    await ProjectLaborAllocation.destroy({ where: { tenant_id: tenantId, payroll_period_id: period.id }, transaction: t });
    if (rows.length) {
      await ProjectLaborAllocation.bulkCreate(rows.map((r) => ({
        ...r, tenant_id: tenantId, payroll_period_id: period.id, period_end: period.end_date, created_by: req.user.id,
      })), { transaction: t });
    }
  });

  const withoutCost = employeeIds.filter((id) => !costs.has(id)).length;
  // Contabilidad: reclasifica a las obras el gasto de nómina repartido.
  const accounting = await require('../accounting/projectAccounting.service').postLaborReclass(tenantId, period, req.user.id);
  return {
    accounting,
    period: { id: period.id, start_date: period.start_date, end_date: period.end_date },
    base_hours: baseHours,
    employees: employeeIds.length,
    employees_without_payroll: withoutCost,
    allocated: round2(rows.reduce((s, r) => s + r.amount, 0)),
    overhead,
    projects: [...new Set(rows.map((r) => r.project_id))].length,
  };
}

/** Periodos que se pueden repartir, con lo ya repartido. */
async function allocatablePeriods(tenantId) {
  const periods = await PayrollPeriod.findAll({
    where: { tenant_id: tenantId, status: ALLOCATABLE_PERIOD_STATUSES },
    attributes: ['id', 'start_date', 'end_date', 'status', 'period_type'],
    order: [['end_date', 'DESC']],
    limit: 24,
  });
  const sums = await ProjectLaborAllocation.findAll({
    where: { tenant_id: tenantId, payroll_period_id: periods.map((p) => p.id) },
    attributes: ['payroll_period_id', [sequelize.fn('SUM', sequelize.col('amount')), 'allocated'], [sequelize.fn('MAX', sequelize.col('created_at')), 'allocated_at']],
    group: ['payroll_period_id'],
    raw: true,
  });
  const by = new Map(sums.map((s) => [s.payroll_period_id, s]));
  return periods.map((p) => ({ ...p.toJSON(), allocated: num(by.get(p.id)?.allocated), allocated_at: by.get(p.id)?.allocated_at || null }));
}

async function projectAllocations(tenantId, projectId) {
  return ProjectLaborAllocation.findAll({
    where: { tenant_id: tenantId, project_id: projectId },
    include: [
      { model: Employee, as: 'employee', attributes: ['id', 'first_name', 'other_names', 'first_surname', 'second_surname'] },
      { model: PayrollPeriod, as: 'period', attributes: ['id', 'start_date', 'end_date', 'status'] },
    ],
    order: [['period_end', 'DESC']],
  });
}

async function employeeOptions(tenantId) {
  const rows = await Employee.findAll({
    where: { tenant_id: tenantId, is_active: true },
    attributes: ['id', 'first_name', 'other_names', 'first_surname', 'second_surname', 'document_number'],
    order: [['first_name', 'ASC'], ['first_surname', 'ASC']],
    limit: 500,
  });
  return rows.map((e) => ({ id: e.id, name: employeeName(e), document_number: e.document_number }));
}

// ── Estimado de horas aún sin reparto ─────────────────────────────────────
// Mientras la nómina del periodo no se liquide y reparta, las horas no tienen
// costo real. Para que el proyecto no muestre $0, se estiman con el costo por
// hora del empleado en un mes completo (salario + aportes + provisiones, con
// las mismas funciones de la nómina) / horas del mes. Al repartir el periodo,
// esas horas pasan al costo real y salen del estimado.

/** Horas del proyecto que ninguna asignación de nómina cubre todavía, por empleado. */
async function pendingHours(tenantId, projectId, { from, to } = {}) {
  const t = (name) => `"${require('../../config/tenantContext').getCurrentSchema() || 'public'}"."${name}"`;
  const replacements = { tenantId, projectId };
  let dates = '';
  if (from) { dates += ' AND te.work_date >= :from'; replacements.from = from; }
  if (to) { dates += ' AND te.work_date <= :to'; replacements.to = to; }
  return sequelize.query(`
    SELECT te.employee_id, SUM(te.hours) AS hours, MAX(te.work_date) AS last_date
      FROM ${t('project_time_entries')} te
     WHERE te.tenant_id = :tenantId AND te.project_id = :projectId ${dates}
       AND NOT EXISTS (
         SELECT 1 FROM ${t('project_labor_allocations')} a
           JOIN ${t('payroll_periods')} pp ON pp.id = a.payroll_period_id
          WHERE a.tenant_id = te.tenant_id AND a.employee_id = te.employee_id AND a.project_id = te.project_id
            AND te.work_date BETWEEN pp.start_date AND pp.end_date)
     GROUP BY te.employee_id
  `, { replacements, type: sequelize.QueryTypes.SELECT });
}

/** Costo por hora estimado: un mes completo de nómina sin novedades / horas del mes. */
async function estimatedHourlyCost(tenantId, employee, monthDate, settings) {
  const { liquidarEmpleado } = require('../payroll/payrollService');
  const emission = require('../payroll/payrollPeriodEmissionService');
  const month = String(monthDate).slice(0, 7);
  const period = { start_date: `${month}-01`, end_date: `${month}-30`, period_type: 'mensual' };
  const autoConcepts = await emission.getActiveAutoConcepts(tenantId);
  const liquidation = liquidarEmpleado({ employee, period, novedades: [], autoConcepts, diasNoRemunerados: 0, softwareSecurityCode: null });
  const { total } = costOfLiquidation({ employee, liquidation, settings });
  const monthHours = monthlyHoursFor(period.end_date, settings?.weekly_hours);
  return monthHours > 0 ? total / monthHours : 0;
}

/** @returns {{ hours, amount, by_employee: [{ employee_id, name, hours, hourly_cost, amount }] }} */
async function estimatePendingLabor(tenantId, projectId, range = {}) {
  const rows = await pendingHours(tenantId, projectId, range);
  if (!rows.length) return { hours: 0, amount: 0, by_employee: [] };
  const settings = await require('../payroll/payrollAccountingService').getSettings(tenantId);
  const employees = await Employee.findAll({ where: { tenant_id: tenantId, id: rows.map((r) => r.employee_id) } });
  const byId = new Map(employees.map((e) => [e.id, e]));
  const byEmployee = [];
  for (const r of rows) {
    const employee = byId.get(r.employee_id);
    if (!employee) continue;
    // eslint-disable-next-line no-await-in-loop -- pocos empleados por proyecto
    const rate = num(employee.base_salary) > 0 ? await estimatedHourlyCost(tenantId, employee, r.last_date, settings) : 0;
    byEmployee.push({
      employee_id: employee.id, name: employeeName(employee), hours: round2(r.hours),
      hourly_cost: round2(rate), amount: round2(rate * num(r.hours)),
    });
  }
  return {
    hours: round2(byEmployee.reduce((s, e) => s + e.hours, 0)),
    amount: round2(byEmployee.reduce((s, e) => s + e.amount, 0)),
    by_employee: byEmployee,
  };
}

module.exports = {
  listTimeEntries, addTimeEntry, deleteTimeEntry, allocatePeriod, allocatablePeriods, projectAllocations, employeeOptions,
  computeAllocations, baseHoursForPeriod, employeeName, employeeCostsForPeriod, estimatePendingLabor,
};
