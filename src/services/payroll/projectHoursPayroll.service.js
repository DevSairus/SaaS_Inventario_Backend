// backend/src/services/payroll/projectHoursPayroll.service.js
//
// Novedades de horas extra y recargos generadas desde la planilla de las
// obras (Fase 4, req. 1.1).
//
//   - Toma las horas de los proyectos con fecha dentro del período, de los
//     empleados vigentes en él, y las clasifica (services/projects/workHours.js).
//   - Crea una novedad por empleado y categoría (HEDs, HENs, HRNs, HEDDFs,
//     HRDDFs, HENDFs, HRNDFs) con source = 'project_hours', el % de
//     Configuración de nómina y el valor: valor hora × (1 + %) en las extra,
//     valor hora × % en los recargos (como PayrollNovedadModal).
//   - Volver a generar reemplaza solo las novedades con source
//     'project_hours'; las manuales no se tocan, pero se avisa si el empleado
//     ya tiene horas manuales de la misma categoría (se pagarían dos veces).
//   - Solo con el período abierto o liquidado (igual que las novedades a mano).

const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { PayrollPeriod, PayrollNovedad, ProjectTimeEntry } = require('../../models');
const { getEmployeesActiveInPeriod, refreshLiquidationPreview } = require('./payrollPeriodEmissionService');
const { getSettings } = require('./payrollAccountingService');
const { monthlyHoursFor } = require('./jornada');
const { CATEGORIAS_HORAS_EXTRA, validarTopeHorasExtra } = require('./payrollService');
const { classifyEmployeeEntries, PAYABLE, LABELS } = require('../projects/workHours');

const SOURCE = 'project_hours';
const PCT_FIELD = {
  HEDs: 'heds_percentage', HENs: 'hens_percentage', HRNs: 'hrns_percentage', HEDDFs: 'heddfs_percentage',
  HRDDFs: 'hrddfs_percentage', HENDFs: 'hendfs_percentage', HRNDFs: 'hrndfs_percentage',
};
const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d || '').slice(0, 10));
const employeeName = (e) => [e.first_name, e.other_names, e.first_surname, e.second_surname].filter(Boolean).join(' ');

/** Valor de una novedad de horas (mismo cálculo que PayrollNovedadModal). */
function hoursPay({ baseSalary, monthHours, category, hours, pct }) {
  const hourly = monthHours > 0 ? Number(baseSalary || 0) / monthHours : 0;
  const factor = CATEGORIAS_HORAS_EXTRA.has(category) ? 1 + pct / 100 : pct / 100;
  return Math.round(hourly * factor * hours);
}

/** Calcula, sin guardar, las novedades que saldrían de las horas del período. */
async function buildPeriodHours(tenantId, period) {
  if (period.period_type === 'liquidacion') throw httpError(400, 'Las liquidaciones definitivas no toman horas de proyectos');
  const settings = await getSettings(tenantId);
  const employees = await getEmployeesActiveInPeriod(tenantId, period);
  if (!employees.length) return { settings, rows: [] };
  const from = iso(period.start_date);
  const to = iso(period.end_date);
  const entries = await ProjectTimeEntry.findAll({
    where: { tenant_id: tenantId, employee_id: employees.map((e) => e.id), work_date: { [Op.between]: [from, to] } },
    raw: true,
  });
  const monthHours = monthlyHoursFor(to, settings.weekly_hours);
  const rows = [];
  for (const emp of employees) {
    const list = entries.filter((e) => e.employee_id === emp.id);
    if (!list.length) continue;
    const { totals } = classifyEmployeeEntries(list, settings);
    const novedades = PAYABLE.filter((c) => totals[c] > 0).map((c) => {
      const pct = Number(settings[PCT_FIELD[c]]) || 0;
      return { dian_category: c, label: LABELS[c], cantidad: totals[c], porcentaje: pct, pago: hoursPay({ baseSalary: emp.base_salary, monthHours, category: c, hours: totals[c], pct }) };
    });
    rows.push({
      employee_id: emp.id, name: employeeName(emp), worked_hours: round2(list.reduce((s, e) => s + Number(e.hours), 0)),
      ordinary_hours: totals.ORD, novedades, total_pay: novedades.reduce((s, n) => s + n.pago, 0),
    });
  }
  return { settings, rows };
}

async function loadPeriod(tenantId, periodId) {
  const period = await PayrollPeriod.findOne({ where: { id: periodId, tenant_id: tenantId } });
  if (!period) throw httpError(404, 'Periodo no encontrado');
  return period;
}

async function previewPeriodHours(tenantId, periodId) {
  const period = await loadPeriod(tenantId, periodId);
  const { rows } = await buildPeriodHours(tenantId, period);
  const generated = await PayrollNovedad.count({ where: { tenant_id: tenantId, payroll_period_id: period.id, source: SOURCE } });
  return { period: { id: period.id, start_date: period.start_date, end_date: period.end_date, status: period.status }, rows, generated };
}

async function generatePeriodHours(tenantId, userId, periodId) {
  const period = await loadPeriod(tenantId, periodId);
  if (!['abierto', 'liquidado'].includes(period.status)) {
    throw httpError(400, `No se pueden generar novedades en un periodo en estado "${period.status}"`);
  }
  const { rows } = await buildPeriodHours(tenantId, period);
  const warnings = [];
  const created = await sequelize.transaction(async (t) => {
    await PayrollNovedad.destroy({ where: { tenant_id: tenantId, payroll_period_id: period.id, source: SOURCE }, transaction: t });
    const manual = await PayrollNovedad.findAll({
      where: { tenant_id: tenantId, payroll_period_id: period.id, source: null, dian_category: Object.keys(PCT_FIELD) },
      attributes: ['employee_id', 'dian_category', 'payload'], raw: true, transaction: t,
    });
    const toCreate = [];
    for (const r of rows) {
      for (const n of r.novedades) {
        if (manual.some((m) => m.employee_id === r.employee_id && m.dian_category === n.dian_category)) {
          warnings.push(`${r.name}: ya tiene una novedad manual de ${n.label}; revisa que no se pague dos veces.`);
        }
        toCreate.push({
          tenant_id: tenantId, employee_id: r.employee_id, payroll_period_id: period.id, dian_category: n.dian_category,
          payload: { cantidad: n.cantidad, porcentaje: n.porcentaje, pago: n.pago }, unpaid_days: 0,
          notes: `Horas de proyectos (${LABELS[n.dian_category]})`, source: SOURCE, created_by: userId,
        });
      }
      const extra = manual.filter((m) => m.employee_id === r.employee_id && CATEGORIAS_HORAS_EXTRA.has(m.dian_category))
        .concat(r.novedades.filter((n) => CATEGORIAS_HORAS_EXTRA.has(n.dian_category)).map((n) => ({ dian_category: n.dian_category, payload: { cantidad: n.cantidad } })));
      const tope = validarTopeHorasExtra(extra, period);
      if (tope) warnings.push(`${r.name}: ${tope}`);
    }
    if (toCreate.length) await PayrollNovedad.bulkCreate(toCreate, { transaction: t });
    return toCreate.length;
  });
  try { await refreshLiquidationPreview(period, tenantId); } catch (e) { /* el resumen se recalcula al liquidar */ }
  return { created, employees: rows.filter((r) => r.novedades.length).length, total_pay: rows.reduce((s, r) => s + r.total_pay, 0), warnings };
}

module.exports = { previewPeriodHours, generatePeriodHours, hoursPay, SOURCE };
