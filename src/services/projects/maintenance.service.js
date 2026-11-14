// backend/src/services/projects/maintenance.service.js
//
// Mantenimientos recurrentes personalizables (Fase 4, req. 1.3).
//
//   - Se mantiene una INSTALACIÓN: el sistema de un cliente (p. ej. un
//     sistema solar completo). Puede venir de un proyecto de Pitbox o ser
//     anterior a Pitbox: se crea a mano o se importa desde Excel.
//   - La instalación puede tener equipos (inversor, paneles, tablero...).
//     El plan se programa sobre el sistema completo o sobre un equipo.
//   - Plan: frecuencia en meses, tareas (el checklist de la visita), días de
//     aviso antes de vencer y técnico responsable.
//   - Cada plan tiene UNA visita abierta (programada). Al cerrarla
//     (checklist, observaciones y firma del cliente) o cancelarla, se
//     programa la siguiente: fecha programada + frecuencia (si esa fecha ya
//     pasó, desde la fecha en que se hizo).
//   - Alertas: se calculan al consultar (sin trabajo nocturno): vencida si la
//     fecha ya pasó; por vencer si faltan menos días que el aviso del plan.
//     Los planes pausados no alertan.

const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { Project, Customer, User } = require('../../models');
const {
  MaintenanceInstallation, MaintenanceEquipment, MaintenancePlan, MaintenanceVisit,
} = require('../../models/maintenance/MaintenanceModels');
const { validateSignature } = require('../../utils/signature');
const { coDateStr } = require('../../utils/colombiaTime');

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const clean = (v, max) => String(v ?? '').trim().slice(0, max) || null;
const today = () => coDateStr(new Date());
const digits = (v) => String(v || '').replace(/\D/g, '');
const userName = (u) => (u ? [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email : null);
const customerName = (c) => (c ? (c.business_name || [c.first_name, c.last_name].filter(Boolean).join(' ')) : null);

// ── Reglas puras (probadas en __tests__/maintenance.test.js) ───────────
/** Suma meses a una fecha AAAA-MM-DD; si el día no existe en el mes destino, toma el último. */
function addMonths(iso, months) {
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

/** Fecha de la siguiente visita: la programada + frecuencia; si ya pasó, desde la fecha en que se hizo. */
function nextVisitDate(scheduledDate, doneDate, frequencyMonths) {
  const fromSchedule = addMonths(scheduledDate, frequencyMonths);
  return fromSchedule > doneDate ? fromSchedule : addMonths(doneDate, frequencyMonths);
}

const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/** Estado de alerta de una visita programada: overdue | due_soon | scheduled | null (no aplica). */
function alertState(visit, plan, on = today()) {
  if (visit.status !== 'scheduled' || (plan && plan.status !== 'active')) return null;
  const days = daysBetween(on, String(visit.scheduled_date).slice(0, 10));
  if (days < 0) return 'overdue';
  if (days <= Number(plan?.alert_days_before ?? 15)) return 'due_soon';
  return 'scheduled';
}

/** Tareas del plan: lista de textos (o texto separado por líneas o ';'), 1 a 50. */
function normalizeTasks(tasks) {
  const list = (Array.isArray(tasks) ? tasks : String(tasks || '').split(/\n|;/))
    .map((t) => String(typeof t === 'object' && t ? t.text : t || '').trim().slice(0, 300))
    .filter(Boolean);
  if (!list.length) throw httpError(400, 'Agrega al menos una tarea al plan (es el checklist de la visita)');
  if (list.length > 50) throw httpError(400, 'Máximo 50 tareas por plan');
  return list;
}

/** Checklist de la visita: cada tarea del plan con su resultado. results: [{ done, note }] por posición. */
function buildChecklist(tasks, results = []) {
  return tasks.map((text, i) => ({
    text,
    done: Boolean(results[i]?.done),
    note: clean(results[i]?.note, 500),
  }));
}

/** Fecha de Excel o texto (AAAA-MM-DD, DD/MM/AAAA) → AAAA-MM-DD, o null. */
function parseDateCell(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  if (isDate(s.slice(0, 10))) return s.slice(0, 10);
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
  if (m) {
    const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) ? undefined : iso;
  }
  return undefined; // inválida
}

// ── Consecutivo ───────────────────────────────────────────────────────
async function nextVisitNo(tenantId, transaction) {
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `maintenance_visits:${tenantId}` }, transaction });
  const rows = await MaintenanceVisit.findAll({ where: { tenant_id: tenantId, visit_no: { [Op.like]: 'MNT-%' } }, attributes: ['visit_no'], transaction, raw: true });
  const max = rows.reduce((m, r) => Math.max(m, parseInt(String(r.visit_no).split('-')[1], 10) || 0), 0);
  return `MNT-${String(max + 1).padStart(6, '0')}`;
}

async function scheduleVisit(plan, date, transaction) {
  return MaintenanceVisit.create({
    tenant_id: plan.tenant_id, plan_id: plan.id, installation_id: plan.installation_id, equipment_id: plan.equipment_id,
    visit_no: await nextVisitNo(plan.tenant_id, transaction), scheduled_date: date, status: 'scheduled',
    technician_user_id: plan.assigned_user_id || null,
  }, { transaction });
}

// ── Validaciones de entrada ───────────────────────────────────────────
async function assertUser(tenantId, userId) {
  if (!userId) return null;
  const u = await User.findOne({ where: { id: userId, tenant_id: tenantId }, attributes: ['id'] });
  if (!u) throw httpError(400, 'Técnico no encontrado');
  return userId;
}

function installationFields(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.name !== undefined) {
    out.name = clean(body.name, 200);
    if (!out.name) throw httpError(400, 'Ponle un nombre a la instalación (ej. Sistema solar 10 kWp - Finca El Roble)');
  }
  for (const [k, max] of [['system_type', 100], ['capacity', 50], ['site_address', 2000], ['city', 100], ['notes', 2000]]) {
    if (!partial || body[k] !== undefined) out[k] = clean(body[k], max);
  }
  if (!partial || body.installed_at !== undefined) {
    if (body.installed_at && !isDate(body.installed_at)) throw httpError(400, 'Fecha de instalación inválida');
    out.installed_at = body.installed_at || null;
  }
  return out;
}

function equipmentFields(body) {
  const name = clean(body.name, 150);
  if (!name) throw httpError(400, 'Ponle un nombre al equipo');
  if (body.installed_at && !isDate(body.installed_at)) throw httpError(400, 'Fecha de instalación inválida');
  return {
    name, brand: clean(body.brand, 100), model: clean(body.model, 100), serial: clean(body.serial, 100),
    location: clean(body.location, 150), installed_at: body.installed_at || null, notes: clean(body.notes, 2000),
  };
}

function planFields(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.name !== undefined) {
    out.name = clean(body.name, 150);
    if (!out.name) throw httpError(400, 'Ponle un nombre al plan');
  }
  if (!partial || body.frequency_months !== undefined) {
    const f = Number(body.frequency_months);
    if (!Number.isInteger(f) || f < 1 || f > 60) throw httpError(400, 'La frecuencia va de 1 a 60 meses');
    out.frequency_months = f;
  }
  if (!partial || body.tasks !== undefined) out.tasks = normalizeTasks(body.tasks);
  if (!partial || body.alert_days_before !== undefined) {
    const a = body.alert_days_before === undefined || body.alert_days_before === '' || body.alert_days_before === null ? 15 : Number(body.alert_days_before);
    if (!Number.isInteger(a) || a < 0 || a > 90) throw httpError(400, 'El aviso va de 0 a 90 días antes');
    out.alert_days_before = a;
  }
  if (body.notes !== undefined) out.notes = clean(body.notes, 2000);
  return out;
}

// ── Instalaciones ─────────────────────────────────────────────────────
async function loadInstallation(tenantId, installationId, transaction) {
  const inst = await MaintenanceInstallation.findOne({ where: { id: installationId, tenant_id: tenantId }, transaction });
  if (!inst) throw httpError(404, 'Instalación no encontrada');
  return inst;
}

async function assertCustomer(tenantId, customerId, transaction) {
  if (!customerId) throw httpError(400, 'Elige el cliente de la instalación');
  const c = await Customer.findOne({ where: { id: customerId, tenant_id: tenantId }, attributes: ['id'], transaction });
  if (!c) throw httpError(400, 'Cliente no encontrado');
  return c.id;
}

/**
 * Crea una instalación (con o sin proyecto). body.plan (opcional) crea además
 * su primer plan con la primera visita.
 */
async function createInstallation(tenantId, userId, body = {}, { transaction } = {}) {
  const fields = installationFields(body);
  const run = async (t) => {
    const customerId = await assertCustomer(tenantId, body.customer_id, t);
    const inst = await MaintenanceInstallation.create({
      tenant_id: tenantId, customer_id: customerId, project_id: body.project_id || null, ...fields, created_by: userId,
    }, { transaction: t });
    if (body.plan) await createPlanIn(tenantId, userId, inst, body.plan, t);
    return inst;
  };
  return transaction ? run(transaction) : sequelize.transaction(run);
}

async function updateInstallation(tenantId, installationId, body = {}) {
  const inst = await loadInstallation(tenantId, installationId);
  const fields = installationFields(body, { partial: true });
  if (body.customer_id !== undefined) fields.customer_id = await assertCustomer(tenantId, body.customer_id);
  if (body.is_active !== undefined) fields.is_active = Boolean(body.is_active);
  await inst.update(fields);
  return inst;
}

/** Instalación de un proyecto de Pitbox, o null. */
async function installationOfProject(tenantId, projectId) {
  return MaintenanceInstallation.findOne({ where: { tenant_id: tenantId, project_id: projectId } });
}

/** Activa el mantenimiento de un proyecto: crea su instalación con los datos del proyecto. */
async function installationFromProject(tenantId, userId, project) {
  const existing = await installationOfProject(tenantId, project.id);
  if (existing) return existing;
  if (project.status === 'cancelled') throw httpError(400, 'El proyecto está cancelado');
  if (!project.customer_id) throw httpError(400, 'El proyecto no tiene cliente: asígnaselo para programar su mantenimiento');
  return createInstallation(tenantId, userId, {
    customer_id: project.customer_id, project_id: project.id,
    name: `${project.code} · ${project.name}`.slice(0, 200),
    capacity: project.capacity_kwp ? `${Number(project.capacity_kwp)} kWp` : null,
    site_address: project.site_address, city: project.city,
    installed_at: project.end_date_actual || null,
  });
}

/** Instalaciones con su cliente, planes activos y la próxima visita (con alerta). */
async function listInstallations(tenantId, { search, customer_id: customerId, active } = {}) {
  const where = { tenant_id: tenantId };
  if (customerId) where.customer_id = customerId;
  if (active === 'true') where.is_active = true;
  const rows = await MaintenanceInstallation.findAll({ where, order: [['name', 'ASC']], limit: 1000, raw: true });
  const customers = await Customer.findAll({
    where: { tenant_id: tenantId, id: [...new Set(rows.map((r) => r.customer_id))] },
    attributes: ['id', 'business_name', 'first_name', 'last_name', 'tax_id'], raw: true,
  });
  const C = new Map(customers.map((c) => [c.id, c]));
  const q = String(search || '').trim().toLowerCase();
  const filtered = rows.filter((r) => !q || [r.name, r.city, customerName(C.get(r.customer_id)), C.get(r.customer_id)?.tax_id]
    .some((v) => String(v || '').toLowerCase().includes(q)));
  const ids = filtered.map((r) => r.id);
  const [plans, open] = ids.length ? await Promise.all([
    MaintenancePlan.findAll({ where: { tenant_id: tenantId, installation_id: ids }, attributes: ['id', 'installation_id', 'status', 'alert_days_before'], raw: true }),
    MaintenanceVisit.findAll({ where: { tenant_id: tenantId, installation_id: ids, status: 'scheduled' }, attributes: ['id', 'plan_id', 'installation_id', 'scheduled_date', 'status'], order: [['scheduled_date', 'ASC']], raw: true }),
  ]) : [[], []];
  const P = new Map(plans.map((p) => [p.id, p]));
  return filtered.map((r) => {
    const visits = open.filter((v) => v.installation_id === r.id).map((v) => ({ ...v, alert: alertState(v, P.get(v.plan_id)) }));
    const next = visits.find((v) => v.alert) || null;
    return {
      ...r, customer: C.get(r.customer_id) ? { id: r.customer_id, name: customerName(C.get(r.customer_id)), tax_id: C.get(r.customer_id).tax_id } : null,
      active_plans: plans.filter((p) => p.installation_id === r.id && p.status === 'active').length,
      next_visit: next ? { scheduled_date: next.scheduled_date, alert: next.alert } : null,
      overdue: visits.filter((v) => v.alert === 'overdue').length,
    };
  });
}

// ── Equipos ───────────────────────────────────────────────────────────
async function createEquipment(tenantId, installationId, body = {}) {
  const inst = await loadInstallation(tenantId, installationId);
  return MaintenanceEquipment.create({ tenant_id: tenantId, installation_id: inst.id, ...equipmentFields(body) });
}

async function updateEquipment(tenantId, installationId, equipmentId, body = {}) {
  const eq = await MaintenanceEquipment.findOne({ where: { id: equipmentId, tenant_id: tenantId, installation_id: installationId } });
  if (!eq) throw httpError(404, 'Equipo no encontrado');
  const updates = Object.keys(body).length === 1 && body.is_active !== undefined
    ? { is_active: Boolean(body.is_active) }
    : { ...equipmentFields(body), ...(body.is_active !== undefined ? { is_active: Boolean(body.is_active) } : {}) };
  await eq.update(updates);
  return eq;
}

// ── Planes ────────────────────────────────────────────────────────────
async function createPlanIn(tenantId, userId, inst, body, t) {
  const fields = planFields(body);
  const startDate = body.start_date || today();
  if (!isDate(startDate)) throw httpError(400, 'Fecha de la primera visita inválida');
  let equipmentId = null;
  if (body.equipment_id) {
    const eq = await MaintenanceEquipment.findOne({ where: { id: body.equipment_id, tenant_id: tenantId, installation_id: inst.id }, attributes: ['id', 'is_active'], transaction: t });
    if (!eq) throw httpError(400, 'Ese equipo no es de esta instalación');
    if (!eq.is_active) throw httpError(400, 'El equipo está inactivo');
    equipmentId = eq.id;
  }
  const assigned = await assertUser(tenantId, body.assigned_user_id);
  const plan = await MaintenancePlan.create({
    tenant_id: tenantId, installation_id: inst.id, equipment_id: equipmentId, ...fields,
    start_date: startDate, assigned_user_id: assigned, status: 'active', created_by: userId,
  }, { transaction: t });
  await scheduleVisit(plan, startDate, t);
  return plan;
}

async function createPlan(tenantId, userId, installationId, body = {}) {
  return sequelize.transaction(async (t) => {
    const inst = await loadInstallation(tenantId, installationId, t);
    if (!inst.is_active) throw httpError(400, 'La instalación está inactiva');
    return createPlanIn(tenantId, userId, inst, body, t);
  });
}

async function loadPlan(tenantId, planId, transaction) {
  const plan = await MaintenancePlan.findOne({ where: { id: planId, tenant_id: tenantId }, transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) });
  if (!plan) throw httpError(404, 'Plan no encontrado');
  return plan;
}

/**
 * Edita un plan. status: 'paused' (no alerta, no programa la siguiente),
 * 'ended' (cancela la visita abierta) o 'active' (si no tiene visita abierta,
 * programa una en next_date o hoy).
 */
async function updatePlan(tenantId, userId, planId, body = {}) {
  const fields = planFields(body, { partial: true });
  if (body.assigned_user_id !== undefined) fields.assigned_user_id = await assertUser(tenantId, body.assigned_user_id || null);
  if (body.status !== undefined && !['active', 'paused', 'ended'].includes(body.status)) throw httpError(400, 'Estado de plan inválido');
  if (body.next_date !== undefined && body.next_date && !isDate(body.next_date)) throw httpError(400, 'Fecha inválida');
  return sequelize.transaction(async (t) => {
    const plan = await loadPlan(tenantId, planId, t);
    if (plan.status === 'ended' && body.status === undefined) throw httpError(409, 'El plan está finalizado: reactívalo para editarlo');
    const open = await MaintenanceVisit.findOne({ where: { plan_id: plan.id, status: 'scheduled' }, transaction: t });
    if (body.status === 'ended' && open) {
      await open.update({ status: 'cancelled', cancel_reason: 'Plan finalizado' }, { transaction: t });
    }
    if (body.status === 'active' && !open) {
      await scheduleVisit({ ...plan.get(), ...fields }, body.next_date || today(), t);
    }
    if (body.status !== undefined) fields.status = body.status;
    if (fields.assigned_user_id !== undefined && open && body.status !== 'ended') {
      await open.update({ technician_user_id: fields.assigned_user_id }, { transaction: t });
    }
    await plan.update(fields, { transaction: t });
    return plan;
  });
}

// ── Visitas ───────────────────────────────────────────────────────────
async function loadVisit(tenantId, visitId, transaction) {
  const visit = await MaintenanceVisit.findOne({ where: { id: visitId, tenant_id: tenantId }, transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) });
  if (!visit) throw httpError(404, 'Visita no encontrada');
  return visit;
}

async function rescheduleVisit(tenantId, visitId, body = {}) {
  const visit = await loadVisit(tenantId, visitId);
  if (visit.status !== 'scheduled') throw httpError(409, 'Solo se reprograma una visita pendiente');
  const updates = {};
  if (body.scheduled_date !== undefined) {
    if (!isDate(body.scheduled_date)) throw httpError(400, 'Fecha inválida');
    updates.scheduled_date = body.scheduled_date;
  }
  if (body.technician_user_id !== undefined) updates.technician_user_id = await assertUser(tenantId, body.technician_user_id || null);
  await visit.update(updates);
  return visit;
}

/**
 * Cierra la visita: checklist con el resultado de cada tarea, observaciones
 * y firma del cliente (opcional). Programa la siguiente si el plan está activo.
 */
async function completeVisit(tenantId, userId, visitId, body = {}) {
  const signature = validateSignature(body.client_signature);
  const doneDate = body.done_date || today();
  if (!isDate(doneDate)) throw httpError(400, 'Fecha de la visita inválida');
  if (doneDate > today()) throw httpError(400, 'La visita no puede quedar con fecha futura');
  if (signature && !clean(body.client_name, 200)) throw httpError(400, 'Indica el nombre de quien firma por el cliente');
  return sequelize.transaction(async (t) => {
    const visit = await loadVisit(tenantId, visitId, t);
    if (visit.status !== 'scheduled') throw httpError(409, 'La visita ya está cerrada');
    const plan = await loadPlan(tenantId, visit.plan_id, t);
    const checklist = buildChecklist(plan.tasks || [], Array.isArray(body.checklist) ? body.checklist : []);
    await visit.update({
      status: 'done', checklist, observations: clean(body.observations, 5000),
      done_at: new Date(`${doneDate}T12:00:00-05:00`), technician_user_id: visit.technician_user_id || userId,
      client_name: clean(body.client_name, 200), client_document: clean(body.client_document, 30), client_signature: signature,
      completed_by: userId,
    }, { transaction: t });
    let next = null;
    if (plan.status === 'active') next = await scheduleVisit(plan, nextVisitDate(String(visit.scheduled_date), doneDate, plan.frequency_months), t);
    return { visit, next };
  });
}

async function cancelVisit(tenantId, userId, visitId, body = {}) {
  const reason = clean(body.reason, 1000);
  if (!reason) throw httpError(400, 'Indica por qué se cancela la visita');
  return sequelize.transaction(async (t) => {
    const visit = await loadVisit(tenantId, visitId, t);
    if (visit.status !== 'scheduled') throw httpError(409, 'La visita ya está cerrada');
    const plan = await loadPlan(tenantId, visit.plan_id, t);
    await visit.update({ status: 'cancelled', cancel_reason: reason, completed_by: userId }, { transaction: t });
    let next = null;
    if (plan.status === 'active') next = await scheduleVisit(plan, nextVisitDate(String(visit.scheduled_date), today(), plan.frequency_months), t);
    return { visit, next };
  });
}

// ── Consultas ─────────────────────────────────────────────────────────
function visitRow(v, { plan, installation, customer, project, equipment, technician } = {}) {
  return {
    id: v.id, visit_no: v.visit_no, scheduled_date: v.scheduled_date, status: v.status,
    alert: alertState(v, plan), done_at: v.done_at, observations: v.observations, cancel_reason: v.cancel_reason,
    checklist: v.checklist, client_name: v.client_name, has_signature: Boolean(v.client_signature),
    plan: plan ? { id: plan.id, name: plan.name, frequency_months: plan.frequency_months, status: plan.status, tasks: plan.tasks } : null,
    installation: installation ? {
      id: installation.id, name: installation.name, city: installation.city, site_address: installation.site_address,
      customer: customerName(customer), project: project ? { id: project.id, code: project.code } : null,
    } : null,
    equipment: equipment ? { id: equipment.id, name: equipment.name, serial: equipment.serial } : null,
    technician: technician ? { id: technician.id, name: userName(technician) } : null,
  };
}

async function hydrate(tenantId, visits) {
  const ids = (key, list = visits) => [...new Set(list.map((v) => v[key]).filter(Boolean))];
  const [plans, installations, equipment, users] = await Promise.all([
    MaintenancePlan.findAll({ where: { tenant_id: tenantId, id: ids('plan_id') }, raw: true }),
    MaintenanceInstallation.findAll({ where: { tenant_id: tenantId, id: ids('installation_id') }, raw: true }),
    MaintenanceEquipment.findAll({ where: { tenant_id: tenantId, id: ids('equipment_id') }, attributes: ['id', 'name', 'serial'], raw: true }),
    User.findAll({ where: { id: ids('technician_user_id') }, attributes: ['id', 'first_name', 'last_name', 'email'], raw: true }),
  ]);
  const [customers, projects] = await Promise.all([
    Customer.findAll({ where: { id: ids('customer_id', installations) }, attributes: ['id', 'business_name', 'first_name', 'last_name'], raw: true }),
    Project.findAll({ where: { tenant_id: tenantId, id: ids('project_id', installations) }, attributes: ['id', 'code'], raw: true }),
  ]);
  const by = (rows) => new Map(rows.map((r) => [r.id, r]));
  const [P, I, E, U, C, PR] = [by(plans), by(installations), by(equipment), by(users), by(customers), by(projects)];
  return visits.map((v) => {
    const inst = I.get(v.installation_id);
    return visitRow(v, {
      plan: P.get(v.plan_id), installation: inst, customer: inst && C.get(inst.customer_id), project: inst && PR.get(inst.project_id),
      equipment: E.get(v.equipment_id), technician: U.get(v.technician_user_id),
    });
  });
}

/** Detalle de una instalación: datos, equipos, planes (con su próxima visita) e historial. */
async function installationDetail(tenantId, installationId) {
  const inst = (await loadInstallation(tenantId, installationId)).get({ plain: true });
  const [customer, project, equipment, plans, visits] = await Promise.all([
    Customer.findOne({ where: { id: inst.customer_id, tenant_id: tenantId }, attributes: ['id', 'business_name', 'first_name', 'last_name', 'tax_id', 'phone', 'mobile'], raw: true }),
    inst.project_id ? Project.findOne({ where: { id: inst.project_id, tenant_id: tenantId }, attributes: ['id', 'code', 'name'], raw: true }) : null,
    MaintenanceEquipment.findAll({ where: { tenant_id: tenantId, installation_id: inst.id }, order: [['is_active', 'DESC'], ['name', 'ASC']], raw: true }),
    MaintenancePlan.findAll({ where: { tenant_id: tenantId, installation_id: inst.id }, order: [['created_at', 'ASC']], raw: true }),
    MaintenanceVisit.findAll({
      where: { tenant_id: tenantId, installation_id: inst.id }, attributes: { exclude: ['client_signature'] },
      order: [['scheduled_date', 'DESC']], limit: 200, raw: true,
    }),
  ]);
  const rows = await hydrate(tenantId, visits);
  return {
    installation: { ...inst, customer: customer ? { ...customer, name: customerName(customer) } : null, project },
    equipment,
    plans: plans.map((p) => {
      const open = rows.find((v) => v.plan?.id === p.id && v.status === 'scheduled') || null;
      const last = rows.find((v) => v.plan?.id === p.id && v.status === 'done') || null;
      return { ...p, equipment: equipment.find((e) => e.id === p.equipment_id) || null, next_visit: open, last_visit: last };
    }),
    visits: rows,
  };
}

/** Agenda de visitas de toda la empresa, con su alerta. */
async function agenda(tenantId, { status = 'scheduled', from, to, installation_id: installationId, technician_user_id: techId, alert } = {}) {
  const where = { tenant_id: tenantId };
  if (['scheduled', 'done', 'cancelled'].includes(status)) where.status = status;
  if (from || to) where.scheduled_date = { ...(isDate(from) ? { [Op.gte]: from } : {}), ...(isDate(to) ? { [Op.lte]: to } : {}) };
  if (installationId) where.installation_id = installationId;
  if (techId) where.technician_user_id = techId;
  const visits = await MaintenanceVisit.findAll({
    where, attributes: { exclude: ['client_signature'] }, order: [['scheduled_date', status === 'done' ? 'DESC' : 'ASC']], limit: 500, raw: true,
  });
  let rows = await hydrate(tenantId, visits);
  const summary = {
    overdue: rows.filter((r) => r.alert === 'overdue').length,
    due_soon: rows.filter((r) => r.alert === 'due_soon').length,
    scheduled: rows.filter((r) => r.status === 'scheduled').length,
  };
  if (['overdue', 'due_soon'].includes(alert)) rows = rows.filter((r) => r.alert === alert);
  return { summary, visits: rows };
}

/** Todo lo que necesita el PDF de la visita. */
async function getVisitForPdf(tenantId, visitId) {
  const visit = await MaintenanceVisit.findOne({ where: { id: visitId, tenant_id: tenantId }, raw: true });
  if (!visit) throw httpError(404, 'Visita no encontrada');
  const [row] = await hydrate(tenantId, [visit]);
  return { ...row, client_signature: visit.client_signature, client_document: visit.client_document };
}

// ── Importación de instalaciones anteriores a Pitbox ──────────────────
/**
 * Filas de Excel → instalaciones (y su plan). Cada fila: cliente (documento),
 * instalación y, opcional, un plan. Varias filas con el mismo cliente y
 * nombre de instalación = una instalación con varios planes. El cliente
 * debe existir en Pitbox (se busca por documento, con o sin DV).
 * dryRun: solo valida y devuelve el resultado por fila.
 */
async function importInstallations(tenantId, userId, rows, { dryRun = true } = {}) {
  if (!Array.isArray(rows) || !rows.length) throw httpError(400, 'El archivo no tiene filas');
  if (rows.length > 2000) throw httpError(400, 'Máximo 2.000 filas por archivo');
  const customers = await Customer.findAll({ where: { tenant_id: tenantId }, attributes: ['id', 'tax_id', 'business_name', 'first_name', 'last_name'], raw: true });
  const findCustomer = (doc) => {
    const d = digits(doc);
    if (!d) return null;
    const matches = customers.filter((c) => {
      const cd = digits(c.tax_id);
      return cd === d || (cd.length === d.length + 1 && cd.startsWith(d)) || (d.length === cd.length + 1 && d.startsWith(cd));
    });
    return matches.length === 1 ? matches[0] : matches.length > 1 ? 'many' : null;
  };
  const existing = await MaintenanceInstallation.findAll({ where: { tenant_id: tenantId }, attributes: ['id', 'customer_id', 'name'], raw: true });
  const key = (customerId, name) => `${customerId}|${String(name).trim().toLowerCase()}`;
  const existingByKey = new Map(existing.map((i) => [key(i.customer_id, i.name), i.id]));

  const results = [];
  const groups = new Map(); // key → { install fields, plans: [] , existingId }
  rows.forEach((r, idx) => {
    const line = Number(r.row) || idx + 2;
    const errors = [];
    const customer = findCustomer(r.customer_document);
    if (!digits(r.customer_document)) errors.push('Falta el documento del cliente');
    else if (customer === 'many') errors.push('Hay más de un cliente con ese documento');
    else if (!customer) errors.push(`No existe un cliente con documento ${r.customer_document}: créalo en Clientes`);
    let inst = null;
    try { inst = installationFields({ name: r.name, system_type: r.system_type, capacity: r.capacity, site_address: r.site_address, city: r.city, notes: r.notes }); } catch (e) { errors.push(e.message); }
    const installedAt = parseDateCell(r.installed_at);
    if (installedAt === undefined) errors.push('Fecha de instalación inválida');
    let plan = null;
    const wantsPlan = [r.plan_name, r.frequency_months, r.tasks].some((v) => v !== undefined && v !== null && String(v).trim() !== '');
    if (wantsPlan) {
      const firstVisit = parseDateCell(r.next_visit);
      if (firstVisit === undefined) errors.push('Fecha de la próxima visita inválida');
      try {
        plan = { ...planFields({ name: r.plan_name || 'Mantenimiento preventivo', frequency_months: Number(r.frequency_months), tasks: r.tasks, alert_days_before: r.alert_days_before === '' || r.alert_days_before == null ? undefined : Number(r.alert_days_before) }), start_date: firstVisit || today() };
      } catch (e) { errors.push(e.message); }
    }
    if (errors.length || !customer || customer === 'many') {
      results.push({ row: line, ok: false, errors });
      return;
    }
    const k = key(customer.id, inst.name);
    if (!groups.has(k)) groups.set(k, { customer_id: customer.id, ...inst, installed_at: installedAt || null, plans: [], existingId: existingByKey.get(k) || null });
    if (plan) groups.get(k).plans.push(plan);
    results.push({
      row: line, ok: true, customer: customerName(customer), installation: inst.name,
      action: existingByKey.get(k) ? 'existente' : 'nueva', plan: plan ? `${plan.name} cada ${plan.frequency_months} mes(es) desde ${plan.start_date}` : null,
    });
  });

  const summary = {
    rows: rows.length, valid: results.filter((r) => r.ok).length, invalid: results.filter((r) => !r.ok).length,
    new_installations: [...groups.values()].filter((g) => !g.existingId).length,
    plans: [...groups.values()].reduce((s, g) => s + g.plans.length, 0),
  };
  if (dryRun) return { dry_run: true, summary, results };
  if (summary.invalid) throw httpError(400, `Hay ${summary.invalid} fila(s) con errores: corrígelas antes de importar`);

  await sequelize.transaction(async (t) => {
    for (const g of groups.values()) {
      const { plans, existingId, ...fields } = g;
      // eslint-disable-next-line no-await-in-loop
      const inst = existingId
        ? await MaintenanceInstallation.findByPk(existingId, { transaction: t })
        : await MaintenanceInstallation.create({ tenant_id: tenantId, ...fields, created_by: userId }, { transaction: t });
      for (const p of plans) {
        // eslint-disable-next-line no-await-in-loop
        await createPlanIn(tenantId, userId, inst, p, t);
      }
    }
  });
  return { dry_run: false, summary, results };
}

module.exports = {
  addMonths, nextVisitDate, alertState, normalizeTasks, buildChecklist, parseDateCell,
  createInstallation, updateInstallation, installationOfProject, installationFromProject, listInstallations, installationDetail,
  createEquipment, updateEquipment, createPlan, updatePlan, rescheduleVisit, completeVisit, cancelVisit,
  agenda, getVisitForPdf, importInstallations,
};
