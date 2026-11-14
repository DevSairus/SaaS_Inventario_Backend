// backend/src/services/projects/projectWorkHours.service.js
//
// Horarios de obra (Fase 4, req. 1.1):
//   - Turnos de la empresa (work_shifts) para precargar la planilla.
//   - Planilla diaria del encargado: entrada, salida y descanso de cada
//     trabajador en la obra (project_time_entries con start_time/end_time).
//   - Distribución de horas por empleado y proyecto, clasificadas en
//     ordinarias, extra y recargos (workHours.js).
// Las novedades de nómina salen de aquí: services/payroll/projectHoursPayroll.service.js.

const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { Project, ProjectTimeEntry, Employee } = require('../../models');
const WorkShift = require('../../models/projects/WorkShift');
const { INACTIVE_STATUSES } = require('./projectStock.service');
const { toMinutes, workedHours, classifyEmployeeEntries, CATEGORIES } = require('./workHours');

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const employeeName = (e) => (e ? [e.first_name, e.other_names, e.first_surname, e.second_surname].filter(Boolean).join(' ') : '');
const normTime = (t) => (toMinutes(t) === null ? null : `${String(t).trim().slice(0, 5).padStart(5, '0')}`);

// ── Turnos ───────────────────────────────────────────────────────────────
async function listShifts(tenantId, { all = false } = {}) {
  return WorkShift.findAll({ where: { tenant_id: tenantId, ...(all ? {} : { is_active: true }) }, order: [['start_time', 'ASC'], ['name', 'ASC']] });
}

function shiftFields(body) {
  const name = String(body.name || '').trim().slice(0, 80);
  if (!name) throw httpError(400, 'Ponle un nombre al turno');
  const start = normTime(body.start_time);
  const end = normTime(body.end_time);
  if (!start || !end) throw httpError(400, 'Indica la hora de entrada y de salida del turno (HH:MM)');
  if (start === end) throw httpError(400, 'La entrada y la salida no pueden ser iguales');
  const brk = Number(body.break_minutes || 0);
  if (!Number.isInteger(brk) || brk < 0 || brk > 480) throw httpError(400, 'El descanso va de 0 a 480 minutos');
  if (workedHours({ work_date: '2026-01-05', start_time: start, end_time: end, break_minutes: brk }) <= 0) throw httpError(400, 'El descanso no puede ser todo el turno');
  return { name, start_time: start, end_time: end, break_minutes: brk };
}

async function createShift(tenantId, body) {
  return WorkShift.create({ tenant_id: tenantId, ...shiftFields(body || {}) });
}

async function updateShift(tenantId, shiftId, body) {
  const shift = await WorkShift.findOne({ where: { id: shiftId, tenant_id: tenantId } });
  if (!shift) throw httpError(404, 'Turno no encontrado');
  const updates = body.is_active !== undefined && Object.keys(body).length === 1
    ? { is_active: Boolean(body.is_active) }
    : { ...shiftFields(body), ...(body.is_active !== undefined ? { is_active: Boolean(body.is_active) } : {}) };
  await shift.update(updates);
  return shift;
}

// ── Planilla diaria ──────────────────────────────────────────────────────
/**
 * Valida una fila de la planilla y devuelve los campos a guardar.
 * row: { employee_id, start_time, end_time, break_minutes?, shift_id?, notes? }
 */
function sheetRow(row, workDate) {
  const start = normTime(row.start_time);
  const end = normTime(row.end_time);
  if (!start || !end) throw httpError(400, 'Cada trabajador necesita hora de entrada y de salida (HH:MM)');
  if (start === end) throw httpError(400, 'La entrada y la salida no pueden ser iguales');
  const brk = Number(row.break_minutes || 0);
  if (!Number.isInteger(brk) || brk < 0 || brk > 480) throw httpError(400, 'El descanso va de 0 a 480 minutos');
  const hours = workedHours({ work_date: workDate, start_time: start, end_time: end, break_minutes: brk });
  if (!(hours > 0) || hours > 24) throw httpError(400, 'Las horas trabajadas deben estar entre 0 y 24');
  return {
    employee_id: row.employee_id, start_time: start, end_time: end, break_minutes: brk, hours,
    shift_id: row.shift_id || null, notes: String(row.notes || '').trim().slice(0, 255) || null,
  };
}

/** Intervalos [inicio, fin) en minutos absolutos desde la medianoche de workDate. */
function interval(e) {
  const s = toMinutes(e.start_time);
  const t = toMinutes(e.end_time);
  if (s === null || t === null) return null;
  return [s, t > s ? t : t + 1440];
}

/**
 * Guarda la planilla del día de una obra: reemplaza, para los trabajadores
 * que vienen, sus registros con entrada/salida de esa obra y fecha. Valida
 * que no se crucen con lo que tengan en otras obras ese día.
 */
async function saveDailySheet(req, project, body = {}) {
  const tenantId = req.user.tenant_id;
  if (INACTIVE_STATUSES.includes(project.status)) throw httpError(400, 'El proyecto está cerrado o cancelado');
  const workDate = String(body.work_date || '');
  if (!isDate(workDate)) throw httpError(400, 'Indica la fecha de la planilla');
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) throw httpError(400, 'La planilla no tiene trabajadores');
  if (rows.length > 200) throw httpError(400, 'Máximo 200 trabajadores por planilla');
  const parsed = rows.map((r) => sheetRow(r, workDate));
  const ids = [...new Set(parsed.map((r) => r.employee_id))];
  if (ids.length !== parsed.length) throw httpError(400, 'Hay un trabajador repetido en la planilla');

  const employees = await Employee.findAll({ where: { tenant_id: tenantId, id: ids }, attributes: ['id', 'first_name', 'other_names', 'first_surname', 'second_surname'] });
  if (employees.length !== ids.length) throw httpError(400, 'Hay un empleado que no existe');
  const nameById = new Map(employees.map((e) => [e.id, employeeName(e)]));

  return sequelize.transaction(async (t) => {
    // Lo que ya tienen ese día (todas las obras), sin los registros que se reemplazan.
    const existing = await ProjectTimeEntry.findAll({
      where: { tenant_id: tenantId, employee_id: ids, work_date: workDate },
      transaction: t,
    });
    const keep = existing.filter((e) => !(e.project_id === project.id && e.start_time));
    for (const r of parsed) {
      const mine = interval(r);
      const others = keep.filter((e) => e.employee_id === r.employee_id);
      const total = others.reduce((s, e) => s + Number(e.hours), 0) + r.hours;
      if (total > 24) throw httpError(400, `${nameById.get(r.employee_id)}: ese día suma ${round2(total)} h entre todas las obras`);
      for (const o of others) {
        const iv = interval(o);
        if (iv && mine[0] < iv[1] && iv[0] < mine[1]) {
          throw httpError(409, `${nameById.get(r.employee_id)}: el horario ${r.start_time}–${r.end_time} se cruza con ${String(o.start_time).slice(0, 5)}–${String(o.end_time).slice(0, 5)} en otra obra`);
        }
      }
    }
    await ProjectTimeEntry.destroy({
      where: { tenant_id: tenantId, project_id: project.id, work_date: workDate, employee_id: ids, start_time: { [Op.ne]: null } },
      transaction: t,
    });
    await ProjectTimeEntry.bulkCreate(parsed.map((r) => ({
      ...r, tenant_id: tenantId, project_id: project.id, work_date: workDate, created_by: req.user.id,
    })), { transaction: t });
    return { work_date: workDate, workers: parsed.length, hours: round2(parsed.reduce((s, r) => s + r.hours, 0)) };
  });
}

// ── Distribución por empleado y proyecto ────────────────────────────────
/**
 * Horas del rango, clasificadas, por empleado y proyecto. La clasificación
 * (qué es extra) se hace con todas las obras del empleado ese día.
 */
async function hoursDistribution(tenantId, { from, to, project_id: projectId = null, employee_id: employeeId = null, settings = null } = {}) {
  if (!isDate(from) || !isDate(to) || from > to) throw httpError(400, 'Indica el rango de fechas');
  const where = { tenant_id: tenantId, work_date: { [Op.between]: [from, to] } };
  if (employeeId) where.employee_id = employeeId;
  // Si se filtra por proyecto, igual se cargan todas las obras de esos empleados para clasificar bien.
  if (projectId) {
    const ids = await ProjectTimeEntry.findAll({ where: { ...where, project_id: projectId }, attributes: ['employee_id'], group: ['employee_id'], raw: true });
    if (!ids.length) return { from, to, employees: [], totals: Object.fromEntries(CATEGORIES.map((c) => [c, 0])) };
    where.employee_id = ids.map((r) => r.employee_id);
  }
  const entries = await ProjectTimeEntry.findAll({ where, raw: true, order: [['work_date', 'ASC']] });
  const cfg = settings || await require('../payroll/payrollAccountingService').getSettings(tenantId);
  const [employees, projects] = await Promise.all([
    Employee.findAll({ where: { tenant_id: tenantId, id: [...new Set(entries.map((e) => e.employee_id))] }, attributes: ['id', 'first_name', 'other_names', 'first_surname', 'second_surname', 'document_number', 'base_salary'], raw: true }),
    Project.findAll({ where: { tenant_id: tenantId, id: [...new Set(entries.map((e) => e.project_id))] }, attributes: ['id', 'code', 'name'], raw: true }),
  ]);
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const byEmployee = new Map();
  for (const e of entries) {
    if (!byEmployee.has(e.employee_id)) byEmployee.set(e.employee_id, []);
    byEmployee.get(e.employee_id).push(e);
  }
  const grand = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  const out = [];
  for (const emp of employees) {
    const list = byEmployee.get(emp.id) || [];
    const { byEntry, totals, days } = classifyEmployeeEntries(list, cfg);
    const perProject = new Map();
    for (const e of list) {
      if (projectId && e.project_id !== projectId) continue;
      if (!perProject.has(e.project_id)) perProject.set(e.project_id, Object.fromEntries(CATEGORIES.map((c) => [c, 0])));
      const acc = perProject.get(e.project_id);
      const h = byEntry.get(e.id);
      for (const c of CATEGORIES) acc[c] = round2(acc[c] + h[c]);
    }
    const shown = projectId ? Object.fromEntries(CATEGORIES.map((c) => [c, round2([...perProject.values()].reduce((s, p) => s + p[c], 0))])) : totals;
    for (const c of CATEGORIES) grand[c] = round2(grand[c] + shown[c]);
    out.push({
      employee_id: emp.id, name: employeeName(emp), document_number: emp.document_number,
      totals: shown,
      total_hours: round2(CATEGORIES.reduce((s, c) => s + shown[c], 0)),
      extra_days: days.filter((d) => d.extra > 0).length,
      projects: [...perProject.entries()].map(([pid, hours]) => ({
        project_id: pid, code: projectById.get(pid)?.code || '', name: projectById.get(pid)?.name || '',
        hours, total_hours: round2(CATEGORIES.reduce((s, c) => s + hours[c], 0)),
      })).sort((a, b) => b.total_hours - a.total_hours),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { from, to, employees: out, totals: grand };
}

module.exports = { listShifts, createShift, updateShift, saveDailySheet, hoursDistribution, sheetRow };
