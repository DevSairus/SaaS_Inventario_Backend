// backend/src/services/tools/tools.service.js
//
// Herramientas (Fase 3 del módulo Proyectos): hoja de vida, asignación a un
// responsable (empleado o usuario) con o sin proyecto, actas de entrega y
// devolución con firma, mantenimientos, calibraciones y bajas.
//
// Costo (tools.cost_mode):
//   - zero:        solo control por cantidad y responsable; no se valoriza.
//   - expense:     se llevó al gasto al comprarla (acquisition_reference
//                  apunta al documento); aquí es informativo.
//   - fixed_asset: vinculada a un activo fijo; la depreciación la hace el
//                  módulo de activos fijos y al dar de baja la herramienta se
//                  puede dar de baja el activo.
// Además, usage_rate_daily es un cargo interno opcional por día de uso que
// suma al estado de resultados del proyecto (no genera asientos). La tarifa
// se congela en la asignación (daily_rate).
//
// Disponibilidad: quantity_total menos lo asignado (asignaciones activas).
// Una herramienta individual tiene quantity_total = 1.

const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const {
  Tool, ToolAssignment, ToolEvent, Employee, User, Project, Supplier, FixedAsset, FixedAssetDepreciationEntry,
} = require('../../models');
const { employeeName } = require('../projects/projectLabor.service');
const { validateSignature } = require('../../utils/signature');

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const todayLocal = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const clean = (v, max) => {
  if (v === undefined) return undefined;
  const s = v === null ? '' : String(v).trim();
  return s ? s.slice(0, max) : null;
};
// Suma meses a una fecha 'YYYY-MM-DD' (día ajustado al fin de mes).
function addMonths(date, months) {
  const [y, m, d] = date.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}
// Días de uso de una asignación: inclusivo (entregada y devuelta el mismo día = 1).
function usageDays(from, to) {
  const ms = new Date(`${to}T12:00:00Z`) - new Date(`${from}T12:00:00Z`);
  return Math.max(1, Math.round(ms / 86400000) + 1);
}

const PROJECT_CLOSED = ['closed', 'cancelled'];
const COST_MODES = ['zero', 'expense', 'fixed_asset'];
const MANUAL_EVENTS = ['maintenance', 'calibration', 'repair', 'damage', 'note'];
const DUE_SOON_DAYS = 30;

// ── Consecutivos ──────────────────────────────────────────────────────
async function nextNumber(Model, field, prefix, pad, tenantId, transaction) {
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', {
    replacements: { key: `${Model.tableName}:${tenantId}` }, transaction,
  });
  const rows = await Model.findAll({
    where: { tenant_id: tenantId, [field]: { [Op.like]: `${prefix}-%` } },
    attributes: [field],
    transaction,
  });
  const max = rows.reduce((m, r) => Math.max(m, parseInt(String(r[field]).split('-')[1], 10) || 0), 0);
  return `${prefix}-${String(max + 1).padStart(pad, '0')}`;
}

// ── Validaciones ──────────────────────────────────────────────────────
function normalizeToolData(body, { creating }) {
  const data = {};
  const str = { name: 200, category: 100, brand: 100, model: 100, serial_number: 100, acquisition_reference: 100, location: 150, notes: 5000 };
  for (const [k, max] of Object.entries(str)) {
    const v = clean(body[k], max);
    if (v !== undefined) data[k] = v;
  }
  if (creating && !data.name) throw httpError(400, 'El nombre de la herramienta es obligatorio');
  if (data.name === null) throw httpError(400, 'El nombre de la herramienta es obligatorio');

  if (body.tracking !== undefined) {
    if (!['individual', 'quantity'].includes(body.tracking)) throw httpError(400, 'Control inválido');
    data.tracking = body.tracking;
  }
  if (body.quantity_total !== undefined) {
    const n = Number(body.quantity_total);
    if (!Number.isInteger(n) || n < 1 || n > 100000) throw httpError(400, 'La cantidad debe ser un entero mayor que cero');
    data.quantity_total = n;
  }
  if (body.cost_mode !== undefined) {
    if (!COST_MODES.includes(body.cost_mode)) throw httpError(400, 'Manejo de costo inválido');
    data.cost_mode = body.cost_mode;
  }
  for (const k of ['acquisition_cost', 'usage_rate_daily']) {
    if (body[k] === undefined) continue;
    if (body[k] === null || body[k] === '') { data[k] = k === 'usage_rate_daily' ? 0 : null; continue; }
    const n = Number(body[k]);
    if (!Number.isFinite(n) || n < 0) throw httpError(400, 'Los valores no pueden ser negativos');
    data[k] = round2(n);
  }
  for (const k of ['acquisition_date', 'next_calibration_date', 'next_maintenance_date']) {
    if (body[k] === undefined) continue;
    if (body[k] === null || body[k] === '') { data[k] = null; continue; }
    if (!isDate(body[k])) throw httpError(400, 'Fecha inválida');
    data[k] = body[k];
  }
  for (const k of ['calibration_interval_months', 'maintenance_interval_months']) {
    if (body[k] === undefined) continue;
    if (body[k] === null || body[k] === '') { data[k] = null; continue; }
    const n = Number(body[k]);
    if (!Number.isInteger(n) || n < 1 || n > 120) throw httpError(400, 'La frecuencia va de 1 a 120 meses');
    data[k] = n;
  }
  if (body.requires_calibration !== undefined) data.requires_calibration = Boolean(body.requires_calibration);
  for (const k of ['supplier_id', 'fixed_asset_id']) {
    if (body[k] !== undefined) data[k] = body[k] || null;
  }
  return data;
}

async function validateToolRefs(tenantId, data, tool, transaction) {
  if (data.supplier_id) {
    const ok = await Supplier.count({ where: { id: data.supplier_id, tenant_id: tenantId }, transaction });
    if (!ok) throw httpError(400, 'Proveedor no encontrado');
  }
  const mode = data.cost_mode ?? tool?.cost_mode ?? 'zero';
  if (mode !== 'fixed_asset') data.fixed_asset_id = null;
  const assetId = data.fixed_asset_id !== undefined ? data.fixed_asset_id : tool?.fixed_asset_id;
  if (mode === 'fixed_asset' && !assetId) throw httpError(400, 'Selecciona el activo fijo de la herramienta');
  if (data.fixed_asset_id) {
    const asset = await FixedAsset.findOne({ where: { id: data.fixed_asset_id, tenant_id: tenantId }, transaction });
    if (!asset) throw httpError(400, 'Activo fijo no encontrado');
    const taken = await Tool.findOne({
      where: { tenant_id: tenantId, fixed_asset_id: data.fixed_asset_id, ...(tool ? { id: { [Op.ne]: tool.id } } : {}) },
      attributes: ['code'],
      transaction,
    });
    if (taken) throw httpError(409, `Ese activo fijo ya está vinculado a la herramienta ${taken.code}`);
  }
  const tracking = data.tracking ?? tool?.tracking ?? 'individual';
  if (tracking === 'individual') data.quantity_total = 1;
  else if (data.quantity_total === undefined && !tool) throw httpError(400, 'Indica cuántas unidades hay');
}

// ── Disponibilidad ────────────────────────────────────────────────────
async function assignedQtyByTool(tenantId, toolIds, transaction) {
  if (!toolIds.length) return new Map();
  const rows = await ToolAssignment.findAll({
    where: { tenant_id: tenantId, tool_id: toolIds, status: 'active' },
    attributes: ['tool_id', [sequelize.fn('SUM', sequelize.col('quantity')), 'qty']],
    group: ['tool_id'],
    raw: true,
    transaction,
  });
  return new Map(rows.map((r) => [r.tool_id, Number(r.qty) || 0]));
}

function dueInfo(tool, today = todayLocal()) {
  const soon = addDays(today, DUE_SOON_DAYS);
  const check = (date) => (!date ? null : date < today ? 'overdue' : date <= soon ? 'soon' : null);
  return {
    calibration: tool.requires_calibration ? check(tool.next_calibration_date) : null,
    maintenance: check(tool.next_maintenance_date),
  };
}
function addDays(date, days) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Estado visible: dada de baja / en mantenimiento / asignada / disponible.
function displayStatus(tool, assignedQty) {
  if (tool.status === 'retired') return 'retired';
  if (tool.status === 'maintenance') return 'maintenance';
  if (assignedQty >= tool.quantity_total) return 'assigned';
  if (assignedQty > 0) return 'partial';
  return 'available';
}

const responsibleInclude = [
  { model: Employee, as: 'employee', attributes: ['id', 'first_name', 'other_names', 'first_surname', 'second_surname', 'document_number'] },
  { model: User, as: 'user', attributes: ['id', 'first_name', 'last_name', 'email'] },
  { model: Project, as: 'project', attributes: ['id', 'code', 'name', 'status'] },
];

function serializeAssignment(a, { withSignatures = false } = {}) {
  const j = a.toJSON ? a.toJSON() : a;
  const out = {
    ...j,
    has_delivery_signature: Boolean(j.delivery_signature),
    has_return_signature: Boolean(j.return_signature),
  };
  if (!withSignatures) {
    delete out.delivery_signature;
    delete out.return_signature;
  }
  return out;
}

// ── Listado y detalle ─────────────────────────────────────────────────
async function listTools(tenantId, query = {}) {
  const where = { tenant_id: tenantId };
  if (query.status === 'retired') where.status = 'retired';
  else if (query.status === 'maintenance') where.status = 'maintenance';
  else if (query.include_retired !== 'true') where.status = { [Op.ne]: 'retired' };
  if (query.category) where.category = query.category;
  if (query.search && String(query.search).trim()) {
    const q = `%${String(query.search).trim()}%`;
    where[Op.or] = [
      { code: { [Op.iLike]: q } }, { name: { [Op.iLike]: q } }, { serial_number: { [Op.iLike]: q } },
      { brand: { [Op.iLike]: q } }, { category: { [Op.iLike]: q } },
    ];
  }
  const tools = await Tool.findAll({ where, order: [['code', 'ASC']], limit: 1000 });
  const ids = tools.map((t) => t.id);
  const [assigned, active] = await Promise.all([
    assignedQtyByTool(tenantId, ids),
    ids.length ? ToolAssignment.findAll({
      where: { tenant_id: tenantId, tool_id: ids, status: 'active' },
      attributes: { exclude: ['delivery_signature', 'return_signature'] },
      include: responsibleInclude,
      order: [['assigned_at', 'ASC']],
    }) : [],
  ]);
  const activeBy = new Map();
  for (const a of active) {
    if (!activeBy.has(a.tool_id)) activeBy.set(a.tool_id, []);
    activeBy.get(a.tool_id).push(a);
  }
  const today = todayLocal();
  let rows = tools.map((t) => {
    const qty = assigned.get(t.id) || 0;
    const assignments = activeBy.get(t.id) || [];
    return {
      ...t.toJSON(),
      assigned_quantity: qty,
      available_quantity: t.status === 'active' ? Math.max(0, t.quantity_total - qty) : 0,
      display_status: displayStatus(t, qty),
      due: dueInfo(t, today),
      active_assignments: assignments.map((a) => ({
        id: a.id, number: a.number, quantity: a.quantity, responsible_name: a.responsible_name,
        project: a.project ? { id: a.project.id, code: a.project.code, name: a.project.name } : null,
        assigned_at: a.assigned_at, expected_return_date: a.expected_return_date,
        overdue: Boolean(a.expected_return_date && a.expected_return_date < today),
      })),
    };
  });
  if (query.state === 'available') rows = rows.filter((r) => r.available_quantity > 0);
  if (query.state === 'assigned') rows = rows.filter((r) => r.assigned_quantity > 0);
  if (query.state === 'due') rows = rows.filter((r) => r.due.calibration || r.due.maintenance);
  if (query.project_id) rows = rows.filter((r) => r.active_assignments.some((a) => a.project?.id === query.project_id));

  const categories = await Tool.findAll({
    where: { tenant_id: tenantId, category: { [Op.ne]: null } },
    attributes: [[sequelize.fn('DISTINCT', sequelize.col('category')), 'category']],
    raw: true,
  });
  return {
    tools: rows,
    categories: categories.map((c) => c.category).sort((a, b) => a.localeCompare(b, 'es')),
    summary: {
      total: rows.length,
      assigned: rows.filter((r) => r.assigned_quantity > 0).length,
      maintenance: rows.filter((r) => r.status === 'maintenance').length,
      due: rows.filter((r) => r.due.calibration || r.due.maintenance).length,
    },
  };
}

async function fixedAssetSummary(tenantId, assetId) {
  if (!assetId) return null;
  const asset = await FixedAsset.findOne({
    where: { id: assetId, tenant_id: tenantId },
    attributes: ['id', 'name', 'category', 'acquisition_cost', 'acquisition_date', 'useful_life_months', 'salvage_value', 'status', 'disposal_date'],
  });
  if (!asset) return null;
  const accumulated = round2(await FixedAssetDepreciationEntry.sum('amount', { where: { fixed_asset_id: asset.id, tenant_id: tenantId } }));
  return { ...asset.toJSON(), accumulated_depreciation: accumulated, book_value: round2(Number(asset.acquisition_cost) - accumulated) };
}

async function getTool(tenantId, id) {
  const tool = await Tool.findOne({
    where: { id, tenant_id: tenantId },
    include: [
      { model: Supplier, as: 'supplier', attributes: ['id', 'name', 'business_name', 'tax_id'] },
      { model: User, as: 'creator', attributes: ['id', 'first_name', 'last_name'] },
    ],
  });
  if (!tool) throw httpError(404, 'Herramienta no encontrada');
  const [assignments, events, fixedAsset, assigned] = await Promise.all([
    ToolAssignment.findAll({
      where: { tenant_id: tenantId, tool_id: id },
      include: [
        ...responsibleInclude,
        { model: User, as: 'deliverer', attributes: ['id', 'first_name', 'last_name'] },
        { model: User, as: 'receiver', attributes: ['id', 'first_name', 'last_name'] },
      ],
      order: [['assigned_at', 'DESC'], ['created_at', 'DESC']],
    }),
    ToolEvent.findAll({
      where: { tenant_id: tenantId, tool_id: id },
      include: [
        { model: Supplier, as: 'supplier', attributes: ['id', 'name', 'business_name'] },
        { model: Project, as: 'project', attributes: ['id', 'code', 'name'] },
        { model: ToolAssignment, as: 'assignment', attributes: ['id', 'number'] },
        { model: User, as: 'creator', attributes: ['id', 'first_name', 'last_name'] },
      ],
      order: [['event_date', 'DESC'], ['created_at', 'DESC']],
    }),
    fixedAssetSummary(tenantId, tool.fixed_asset_id),
    assignedQtyByTool(tenantId, [id]),
  ]);
  const qty = assigned.get(id) || 0;
  const maintenanceCost = round2(events.reduce((s, e) => s + (['maintenance', 'calibration', 'repair'].includes(e.event_type) ? Number(e.cost) || 0 : 0), 0));
  return {
    ...tool.toJSON(),
    assigned_quantity: qty,
    available_quantity: tool.status === 'active' ? Math.max(0, tool.quantity_total - qty) : 0,
    display_status: displayStatus(tool, qty),
    due: dueInfo(tool),
    fixed_asset: fixedAsset,
    maintenance_cost_total: maintenanceCost,
    assignments: assignments.map((a) => serializeAssignment(a)),
    events,
  };
}

// ── Alta y edición ────────────────────────────────────────────────────
async function createTool(tenantId, userId, body) {
  const data = normalizeToolData(body, { creating: true });
  return sequelize.transaction(async (t) => {
    await validateToolRefs(tenantId, data, null, t);
    const code = await nextNumber(Tool, 'code', 'HER', 4, tenantId, t);
    const tool = await Tool.create({ ...data, tenant_id: tenantId, code, status: 'active', created_by: userId }, { transaction: t });
    await ToolEvent.create({
      tenant_id: tenantId, tool_id: tool.id, event_type: 'created',
      event_date: data.acquisition_date || todayLocal(),
      description: tool.tracking === 'quantity' ? `Alta de ${tool.quantity_total} unidades` : 'Alta de la herramienta',
      cost: data.acquisition_cost != null ? round2(data.acquisition_cost * tool.quantity_total) : null,
      supplier_id: data.supplier_id || null,
      created_by: userId,
    }, { transaction: t });
    return tool;
  });
}

async function updateTool(tenantId, userId, id, body) {
  return sequelize.transaction(async (t) => {
    const tool = await Tool.findOne({ where: { id, tenant_id: tenantId }, transaction: t, lock: t.LOCK.UPDATE });
    if (!tool) throw httpError(404, 'Herramienta no encontrada');
    if (tool.status === 'retired') throw httpError(409, 'La herramienta está dada de baja');
    const data = normalizeToolData(body, { creating: false });
    await validateToolRefs(tenantId, data, tool, t);
    const tracking = data.tracking ?? tool.tracking;
    const qty = (await assignedQtyByTool(tenantId, [id], t)).get(id) || 0;
    if (data.tracking && data.tracking !== tool.tracking && qty > 0) {
      throw httpError(409, 'No se puede cambiar el tipo de control mientras la herramienta está asignada');
    }
    if (tracking === 'quantity' && data.quantity_total !== undefined && data.quantity_total < qty) {
      throw httpError(409, `Hay ${qty} unidades asignadas: la cantidad no puede ser menor`);
    }
    const before = { quantity_total: tool.quantity_total };
    await tool.update(data, { transaction: t });
    if (data.quantity_total !== undefined && data.quantity_total !== before.quantity_total) {
      await ToolEvent.create({
        tenant_id: tenantId, tool_id: id, event_type: 'note', event_date: todayLocal(),
        description: `Cantidad ajustada de ${before.quantity_total} a ${data.quantity_total}`,
        created_by: userId,
      }, { transaction: t });
    }
    return tool;
  });
}

// ── Asignación (acta de entrega) ──────────────────────────────────────
const validSignature = (sig) => validateSignature(sig);

async function resolveResponsible(tenantId, body, transaction) {
  if (body.employee_id) {
    const e = await Employee.findOne({ where: { id: body.employee_id, tenant_id: tenantId }, transaction });
    if (!e) throw httpError(400, 'Empleado no encontrado');
    return { employee_id: e.id, user_id: null, responsible_name: employeeName(e), responsible_document: e.document_number || null };
  }
  if (body.user_id) {
    const u = await User.findOne({ where: { id: body.user_id, tenant_id: tenantId }, transaction });
    if (!u) throw httpError(400, 'Usuario no encontrado');
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email;
    return { employee_id: null, user_id: u.id, responsible_name: name, responsible_document: clean(body.responsible_document, 30) || null };
  }
  const name = clean(body.responsible_name, 200);
  if (!name) throw httpError(400, 'Indica a quién se le entrega la herramienta');
  return { employee_id: null, user_id: null, responsible_name: name, responsible_document: clean(body.responsible_document, 30) || null };
}

// `transaction` opcional: el lote (toolBatches.service.js) entrega varias herramientas
// en una sola transacción, todo o nada.
async function assignTool(tenantId, userId, toolId, body, { transaction } = {}) {
  const run = async (t) => {
    const tool = await Tool.findOne({ where: { id: toolId, tenant_id: tenantId }, transaction: t, lock: t.LOCK.UPDATE });
    if (!tool) throw httpError(404, 'Herramienta no encontrada');
    if (tool.status === 'retired') throw httpError(409, 'La herramienta está dada de baja');
    if (tool.status === 'maintenance') throw httpError(409, 'La herramienta está en mantenimiento');

    const quantity = tool.tracking === 'individual' ? 1 : Number(body.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) throw httpError(400, 'La cantidad debe ser un entero mayor que cero');
    const assigned = (await assignedQtyByTool(tenantId, [toolId], t)).get(toolId) || 0;
    const available = tool.quantity_total - assigned;
    if (quantity > available) {
      throw httpError(409, tool.tracking === 'individual'
        ? 'La herramienta ya está asignada: primero registra la devolución'
        : `Solo hay ${available} unidades disponibles`);
    }

    const assignedAt = body.assigned_at || todayLocal();
    if (!isDate(assignedAt)) throw httpError(400, 'Fecha de entrega inválida');
    if (body.expected_return_date && (!isDate(body.expected_return_date) || body.expected_return_date < assignedAt)) {
      throw httpError(400, 'La fecha esperada de devolución no puede ser anterior a la entrega');
    }

    let project = null;
    if (body.project_id) {
      project = await Project.findOne({ where: { id: body.project_id, tenant_id: tenantId }, transaction: t });
      if (!project) throw httpError(400, 'Proyecto no encontrado');
      if (PROJECT_CLOSED.includes(project.status)) throw httpError(409, `El proyecto ${project.code} está cerrado`);
    }
    const responsible = await resolveResponsible(tenantId, body, t);
    const signature = validSignature(body.delivery_signature);
    const number = await nextNumber(ToolAssignment, 'number', 'ENT', 6, tenantId, t);

    const assignment = await ToolAssignment.create({
      tenant_id: tenantId,
      number,
      tool_id: toolId,
      quantity,
      ...responsible,
      project_id: project?.id || null,
      status: 'active',
      assigned_at: assignedAt,
      expected_return_date: body.expected_return_date || null,
      // El cargo de uso solo aplica a proyectos.
      daily_rate: project ? Number(tool.usage_rate_daily) || 0 : 0,
      delivery_condition: ['good', 'damaged'].includes(body.delivery_condition) ? body.delivery_condition : 'good',
      delivery_notes: clean(body.delivery_notes, 500) || null,
      delivery_signature: signature,
      delivery_signed_name: signature ? (clean(body.delivery_signed_name, 200) || responsible.responsible_name) : null,
      delivered_by: userId,
    }, { transaction: t });

    await ToolEvent.create({
      tenant_id: tenantId, tool_id: toolId, event_type: 'assigned', event_date: assignedAt,
      description: `${number}: ${quantity > 1 ? `${quantity} unidades a ` : ''}${responsible.responsible_name}${project ? ` · ${project.code} ${project.name}` : ''}`,
      assignment_id: assignment.id, project_id: project?.id || null, created_by: userId,
    }, { transaction: t });
    return assignment;
  };
  return transaction ? run(transaction) : sequelize.transaction(run);
}

// ── Devolución (acta de devolución) ───────────────────────────────────
async function returnAssignment(tenantId, userId, assignmentId, body, { transaction } = {}) {
  const run = async (t) => {
    const a = await ToolAssignment.findOne({ where: { id: assignmentId, tenant_id: tenantId }, transaction: t, lock: t.LOCK.UPDATE });
    if (!a) throw httpError(404, 'Entrega no encontrada');
    if (a.status !== 'active') throw httpError(409, 'Esta entrega ya fue devuelta');
    const tool = await Tool.findOne({ where: { id: a.tool_id, tenant_id: tenantId }, transaction: t, lock: t.LOCK.UPDATE });

    const returnedAt = body.returned_at || todayLocal();
    if (!isDate(returnedAt)) throw httpError(400, 'Fecha de devolución inválida');
    if (returnedAt < a.assigned_at) throw httpError(400, 'La devolución no puede ser anterior a la entrega');

    const condition = body.return_condition || 'good';
    if (!['good', 'damaged', 'lost'].includes(condition)) throw httpError(400, 'Estado de devolución inválido');
    let lost = 0;
    if (condition === 'lost') lost = a.quantity;
    else if (tool.tracking === 'quantity' && body.lost_quantity) {
      lost = Number(body.lost_quantity);
      if (!Number.isInteger(lost) || lost < 0 || lost > a.quantity) throw httpError(400, `Las unidades perdidas van de 0 a ${a.quantity}`);
    }
    const notes = clean(body.return_notes, 500) || null;
    if ((condition !== 'good' || lost > 0) && !notes) throw httpError(400, 'Describe el daño o la pérdida');
    const signature = validSignature(body.return_signature);

    await a.update({
      status: 'returned',
      returned_at: returnedAt,
      return_condition: condition,
      lost_quantity: lost,
      return_notes: notes,
      return_signature: signature,
      return_signed_name: signature ? (clean(body.return_signed_name, 200) || a.responsible_name) : null,
      received_by: userId,
    }, { transaction: t });

    const base = { tenant_id: tenantId, tool_id: tool.id, event_date: returnedAt, assignment_id: a.id, project_id: a.project_id, created_by: userId };
    const returnedQty = a.quantity - lost;
    await ToolEvent.create({
      ...base, event_type: 'returned',
      description: `${a.number}: devuelta por ${a.responsible_name}${returnedQty !== a.quantity ? ` (${returnedQty} de ${a.quantity} unidades)` : ''}`,
    }, { transaction: t });

    if (lost > 0) {
      await ToolEvent.create({ ...base, event_type: 'lost', description: `${lost} ${lost === 1 ? 'unidad perdida' : 'unidades perdidas'}: ${notes}` }, { transaction: t });
      if (tool.tracking === 'individual') {
        await tool.update({ status: 'retired', retired_at: returnedAt, retirement_reason: `Pérdida (${a.number}): ${notes}` }, { transaction: t });
        await ToolEvent.create({ ...base, event_type: 'retired', description: 'Baja por pérdida' }, { transaction: t });
      } else {
        await tool.update({ quantity_total: Math.max(0, tool.quantity_total - lost) }, { transaction: t });
      }
    }
    if (condition === 'damaged') {
      await ToolEvent.create({ ...base, event_type: 'damage', description: notes }, { transaction: t });
      // Una herramienta individual dañada no se puede volver a entregar
      // hasta que se registre su reparación.
      if (tool.tracking === 'individual') await tool.update({ status: 'maintenance' }, { transaction: t });
    }
    return a;
  };
  return transaction ? run(transaction) : sequelize.transaction(run);
}

// ── Mantenimiento, calibración y notas ────────────────────────────────
async function addEvent(tenantId, userId, toolId, body) {
  if (!MANUAL_EVENTS.includes(body.event_type)) throw httpError(400, 'Tipo de registro inválido');
  return sequelize.transaction(async (t) => {
    const tool = await Tool.findOne({ where: { id: toolId, tenant_id: tenantId }, transaction: t, lock: t.LOCK.UPDATE });
    if (!tool) throw httpError(404, 'Herramienta no encontrada');
    if (tool.status === 'retired') throw httpError(409, 'La herramienta está dada de baja');
    const date = body.event_date || todayLocal();
    if (!isDate(date)) throw httpError(400, 'Fecha inválida');
    if (date > todayLocal()) throw httpError(400, 'La fecha no puede ser futura');
    const description = clean(body.description, 500) || null;
    if (['damage', 'note', 'repair'].includes(body.event_type) && !description) throw httpError(400, 'Escribe una descripción');
    let cost = null;
    if (body.cost !== undefined && body.cost !== null && body.cost !== '') {
      cost = Number(body.cost);
      if (!Number.isFinite(cost) || cost < 0) throw httpError(400, 'Costo inválido');
      cost = round2(cost);
    }
    if (body.supplier_id) {
      const ok = await Supplier.count({ where: { id: body.supplier_id, tenant_id: tenantId }, transaction: t });
      if (!ok) throw httpError(400, 'Proveedor no encontrado');
    }
    let nextDue = null;
    if (body.next_due_date) {
      if (!isDate(body.next_due_date) || body.next_due_date <= date) throw httpError(400, 'La próxima fecha debe ser posterior');
      nextDue = body.next_due_date;
    }

    const toolUpdate = {};
    if (body.event_type === 'calibration') {
      nextDue = nextDue || (tool.calibration_interval_months ? addMonths(date, tool.calibration_interval_months) : null);
      toolUpdate.next_calibration_date = nextDue;
    } else if (body.event_type === 'maintenance') {
      nextDue = nextDue || (tool.maintenance_interval_months ? addMonths(date, tool.maintenance_interval_months) : null);
      toolUpdate.next_maintenance_date = nextDue;
    }
    // Mantenimiento/calibración/reparación terminada: vuelve a estar disponible.
    if (['maintenance', 'calibration', 'repair'].includes(body.event_type) && tool.status === 'maintenance' && body.back_in_service !== false) {
      toolUpdate.status = 'active';
    }
    if (body.event_type === 'damage' && tool.tracking === 'individual') {
      const qty = (await assignedQtyByTool(tenantId, [toolId], t)).get(toolId) || 0;
      if (!qty) toolUpdate.status = 'maintenance';
    }
    if (Object.keys(toolUpdate).length) await tool.update(toolUpdate, { transaction: t });

    return ToolEvent.create({
      tenant_id: tenantId, tool_id: toolId, event_type: body.event_type, event_date: date, description, cost,
      supplier_id: body.supplier_id || null,
      certificate_number: body.event_type === 'calibration' ? clean(body.certificate_number, 100) || null : null,
      next_due_date: nextDue,
      created_by: userId,
    }, { transaction: t });
  });
}

// Enviar a mantenimiento (sale de servicio) o volver a servicio sin registro de costo.
async function setInService(tenantId, userId, toolId, inService, reason) {
  return sequelize.transaction(async (t) => {
    const tool = await Tool.findOne({ where: { id: toolId, tenant_id: tenantId }, transaction: t, lock: t.LOCK.UPDATE });
    if (!tool) throw httpError(404, 'Herramienta no encontrada');
    if (tool.status === 'retired') throw httpError(409, 'La herramienta está dada de baja');
    const target = inService ? 'active' : 'maintenance';
    if (tool.status === target) return tool;
    if (!inService && tool.tracking === 'individual') {
      const qty = (await assignedQtyByTool(tenantId, [toolId], t)).get(toolId) || 0;
      if (qty) throw httpError(409, 'La herramienta está asignada: primero registra la devolución');
    }
    await tool.update({ status: target }, { transaction: t });
    await ToolEvent.create({
      tenant_id: tenantId, tool_id: toolId, event_type: inService ? 'reactivated' : 'maintenance', event_date: todayLocal(),
      description: clean(reason, 500) || (inService ? 'Vuelve a servicio' : 'Sale de servicio por mantenimiento'),
      created_by: userId,
    }, { transaction: t });
    return tool;
  });
}

// ── Baja ──────────────────────────────────────────────────────────────
async function retireTool(tenantId, userId, toolId, body) {
  const result = await sequelize.transaction(async (t) => {
    const tool = await Tool.findOne({ where: { id: toolId, tenant_id: tenantId }, transaction: t, lock: t.LOCK.UPDATE });
    if (!tool) throw httpError(404, 'Herramienta no encontrada');
    if (tool.status === 'retired') throw httpError(409, 'La herramienta ya está dada de baja');
    const qty = (await assignedQtyByTool(tenantId, [toolId], t)).get(toolId) || 0;
    if (qty) throw httpError(409, 'La herramienta está asignada: primero registra la devolución');
    const date = body.retired_at || todayLocal();
    if (!isDate(date)) throw httpError(400, 'Fecha inválida');
    const reason = clean(body.reason, 255);
    if (!reason) throw httpError(400, 'Indica el motivo de la baja');

    await tool.update({ status: 'retired', retired_at: date, retirement_reason: reason }, { transaction: t });
    await ToolEvent.create({
      tenant_id: tenantId, tool_id: toolId, event_type: 'retired', event_date: date,
      description: reason, created_by: userId,
    }, { transaction: t });
    return { tool, date, reason };
  });

  // Activo fijo: se retira igual que desde Activos fijos (deprecia hasta el
  // día de la baja y genera el asiento de retiro, con la pérdida por el valor
  // en libros). Va después de la baja de la herramienta: si el asiento falla
  // (por ejemplo, el mes está cerrado), la herramienta queda dada de baja y
  // se informa para retirar el activo desde Contabilidad.
  let assetDisposed = false;
  let assetError = null;
  if (result.tool.fixed_asset_id && body.dispose_fixed_asset) {
    const asset = await FixedAsset.findOne({ where: { id: result.tool.fixed_asset_id, tenant_id: tenantId } });
    if (asset && asset.status !== 'dado_de_baja') {
      try {
        await require('../accounting/fixedAssetDepreciation.service').disposeAsset(asset, {
          disposal_date: result.date, disposal_type: 'retiro', disposal_reason: `Baja de la herramienta ${result.tool.code}: ${result.reason}`,
        }, tenantId, userId);
        assetDisposed = true;
        await ToolEvent.create({ tenant_id: tenantId, tool_id: toolId, event_type: 'note', event_date: result.date, description: 'Activo fijo dado de baja con su asiento de retiro', created_by: userId });
      } catch (error) {
        assetError = error.message;
      }
    }
  }
  return { tool: result.tool, asset_disposed: assetDisposed, asset_error: assetError };
}

// ── Opciones para formularios ─────────────────────────────────────────
async function responsibleOptions(tenantId) {
  const [employees, users] = await Promise.all([
    Employee.findAll({
      where: { tenant_id: tenantId, is_active: true },
      attributes: ['id', 'first_name', 'other_names', 'first_surname', 'second_surname', 'document_number'],
      order: [['first_name', 'ASC'], ['first_surname', 'ASC']],
      limit: 500,
    }),
    User.findAll({
      where: { tenant_id: tenantId, is_active: true },
      attributes: ['id', 'first_name', 'last_name', 'email', 'role'],
      order: [['first_name', 'ASC']],
      limit: 500,
    }),
  ]);
  return {
    employees: employees.map((e) => ({ id: e.id, name: employeeName(e), document_number: e.document_number })),
    users: users.map((u) => ({ id: u.id, name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email, role: u.role })),
  };
}

async function fixedAssetOptions(tenantId) {
  const [assets, linked] = await Promise.all([
    FixedAsset.findAll({
      where: { tenant_id: tenantId, status: { [Op.ne]: 'dado_de_baja' } },
      attributes: ['id', 'name', 'category', 'acquisition_cost', 'acquisition_date'],
      order: [['name', 'ASC']],
    }),
    Tool.findAll({ where: { tenant_id: tenantId, fixed_asset_id: { [Op.ne]: null } }, attributes: ['fixed_asset_id', 'code'], raw: true }),
  ]);
  const linkedBy = new Map(linked.map((l) => [l.fixed_asset_id, l.code]));
  return assets.map((a) => ({ ...a.toJSON(), linked_tool: linkedBy.get(a.id) || null }));
}

// ── Proyecto: herramientas asignadas y costo de uso ───────────────────
async function projectTools(tenantId, projectId) {
  const rows = await ToolAssignment.findAll({
    where: { tenant_id: tenantId, project_id: projectId },
    attributes: { exclude: ['delivery_signature', 'return_signature'] },
    include: [
      { model: Tool, as: 'tool', attributes: ['id', 'code', 'name', 'category', 'serial_number', 'tracking', 'cost_mode'] },
      ...responsibleInclude.filter((i) => i.as !== 'project'),
    ],
    order: [['status', 'ASC'], ['assigned_at', 'DESC']],
  });
  const today = todayLocal();
  return rows.map((a) => {
    const days = usageDays(a.assigned_at, a.returned_at || today);
    return {
      ...a.toJSON(),
      days,
      usage_cost: round2(days * Number(a.daily_rate) * a.quantity),
      overdue: a.status === 'active' && Boolean(a.expected_return_date && a.expected_return_date < today),
    };
  });
}

// Costo interno de uso para el estado de resultados del proyecto: días de
// cada asignación dentro del rango × tarifa congelada × cantidad.
async function projectUsageCost(tenantId, projectId, range = {}) {
  const today = todayLocal();
  const rows = await ToolAssignment.findAll({
    where: { tenant_id: tenantId, project_id: projectId, daily_rate: { [Op.gt]: 0 } },
    attributes: ['assigned_at', 'returned_at', 'daily_rate', 'quantity'],
    raw: true,
  });
  let amount = 0;
  let days = 0;
  for (const r of rows) {
    const from = range.from && range.from > r.assigned_at ? range.from : r.assigned_at;
    const end = r.returned_at || today;
    const to = range.to && range.to < end ? range.to : end;
    if (to < from) continue;
    const d = usageDays(from, to);
    days += d * r.quantity;
    amount += d * Number(r.daily_rate) * r.quantity;
  }
  return { amount: round2(amount), unit_days: days, assignments: rows.length };
}

async function getAssignmentForActa(tenantId, assignmentId) {
  const a = await ToolAssignment.findOne({
    where: { id: assignmentId, tenant_id: tenantId },
    include: [
      { model: Tool, as: 'tool' },
      ...responsibleInclude,
      { model: User, as: 'deliverer', attributes: ['id', 'first_name', 'last_name'] },
      { model: User, as: 'receiver', attributes: ['id', 'first_name', 'last_name'] },
    ],
  });
  if (!a) throw httpError(404, 'Entrega no encontrada');
  return a;
}

module.exports = {
  listTools, getTool, createTool, updateTool, assignTool, returnAssignment, addEvent, setInService, retireTool,
  responsibleOptions, fixedAssetOptions, projectTools, projectUsageCost, getAssignmentForActa,
  // Para el lote de herramientas (toolBatches.service.js)
  nextNumber,
  // Para pruebas
  addMonths, usageDays, displayStatus, dueInfo,
};
