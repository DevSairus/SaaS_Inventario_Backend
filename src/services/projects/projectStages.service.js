// backend/src/services/projects/projectStages.service.js
//
// Etapas de obra y actas de despacho (Fase 4, req. 1.2).
//
//   Etapa: agrupa cantidades de la lista de materiales (BOM) que se despachan
//   juntas ("Cimentación", "Estructura"...). Una línea del BOM puede repartirse
//   entre varias etapas; la suma planeada no pasa de qty_required.
//
//   Saldo de la etapa = planeado − despachado. Lo despachado NO se guarda: se
//   deriva de los traslados no cancelados que nacieron de un despacho de esa
//   etapa (cantidad recibida si ya se recibió, si no la enviada). Así cancelar
//   un traslado o recibirlo incompleto corrige el saldo sin tocar nada más.
//
//   Acta de despacho: toda salida de materiales a la obra (con o sin etapa)
//   deja un acta con consecutivo DSP-000001, apuntando al traslado, con la
//   firma dibujada en pantalla de cada rol (almacén, transportador, encargado
//   de obra). Las firmas son opcionales al despachar y se completan después.

const { Op, QueryTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { getCurrentSchema } = require('../../config/tenantContext');
const ProjectStage = require('../../models/projects/ProjectStage');
const ProjectStageItem = require('../../models/projects/ProjectStageItem');
const ProjectDispatch = require('../../models/projects/ProjectDispatch');
const ProjectDispatchSignature = require('../../models/projects/ProjectDispatchSignature');
const { ProjectBomItem, Warehouse, Transfer, TransferItem, Product, User } = require('../../models');
const { validateSignature } = require('../../utils/signature');
const { INACTIVE_STATUSES } = require('./projectStock.service');

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const num = (v) => Number(v) || 0;
const round4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;
const EPS = 0.00005;
const table = (name) => `"${getCurrentSchema() || 'public'}"."${name}"`;

const ROLES = ['almacen', 'transportador', 'encargado_obra'];
const ROLE_LABEL = { almacen: 'Almacén', transportador: 'Transportador', encargado_obra: 'Encargado de obra' };
const STAGE_STATUSES = ['open', 'closed'];

function assertProjectOpen(project) {
  if (INACTIVE_STATUSES.includes(project.status)) {
    throw httpError(400, `El proyecto está ${project.status === 'closed' ? 'cerrado' : 'cancelado'}`);
  }
}

// ── Validaciones puras (probadas en __tests__/projectStages.test.js) ───

/**
 * Valida las líneas de una etapa.
 *  items              [{ item_id, qty_planned }]
 *  lines              líneas del BOM del proyecto [{ id, line_no, qty_required }]
 *  plannedElsewhere   Map bom_item_id → cantidad planeada en OTRAS etapas
 *  dispatchedHere     Map bom_item_id → cantidad ya despachada en ESTA etapa
 * Devuelve [{ bom_item_id, qty_planned }].
 */
function validateStageItems(items, { lines, plannedElsewhere = new Map(), dispatchedHere = new Map() }) {
  if (!Array.isArray(items)) throw httpError(400, 'Las líneas de la etapa deben ser una lista');
  const byId = new Map(lines.map((l) => [l.id, l]));
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const line = byId.get(it?.item_id);
    if (!line) throw httpError(400, 'Hay una línea que no pertenece a la lista de materiales del proyecto');
    if (seen.has(line.id)) throw httpError(400, `La línea ${line.line_no} está repetida en la etapa`);
    seen.add(line.id);
    const qty = round4(num(it.qty_planned));
    if (!(qty > 0)) throw httpError(400, `Línea ${line.line_no}: la cantidad debe ser mayor que cero`);
    const elsewhere = num(plannedElsewhere.get(line.id));
    if (elsewhere + qty > num(line.qty_required) + EPS) {
      const free = Math.max(round4(num(line.qty_required) - elsewhere), 0);
      throw httpError(400, `Línea ${line.line_no}: solo quedan ${free} por asignar a etapas (se requieren ${num(line.qty_required)})`);
    }
    const done = num(dispatchedHere.get(line.id));
    if (qty < done - EPS) throw httpError(400, `Línea ${line.line_no}: ya se despacharon ${done} en esta etapa, no puede planearse menos`);
    out.push({ bom_item_id: line.id, qty_planned: qty });
  }
  // Una línea con despachos no puede salirse de la etapa.
  for (const [id, done] of dispatchedHere) {
    if (done > EPS && !seen.has(id)) {
      const line = byId.get(id);
      throw httpError(400, `Línea ${line ? line.line_no : ''}: ya tiene despachos en esta etapa, no puede quitarse`);
    }
  }
  return out;
}

/** Valida las firmas que llegan con el despacho: [{ role, name, document, signature }]. */
function normalizeSignatures(signatures) {
  if (signatures === undefined || signatures === null) return [];
  if (!Array.isArray(signatures)) throw httpError(400, 'Las firmas deben ser una lista');
  if (signatures.length > ROLES.length) throw httpError(400, 'Demasiadas firmas');
  const seen = new Set();
  return signatures.map((s) => {
    const role = String(s?.role || '');
    if (!ROLES.includes(role)) throw httpError(400, 'Rol de firma inválido');
    if (seen.has(role)) throw httpError(400, `El rol ${ROLE_LABEL[role]} firma una sola vez`);
    seen.add(role);
    const name = String(s.name || '').trim().slice(0, 200);
    if (!name) throw httpError(400, `Indica el nombre de quien firma como ${ROLE_LABEL[role]}`);
    const signature = validateSignature(s.signature, { required: true, label: `La firma de ${ROLE_LABEL[role]}` });
    return { role, name, document: String(s.document || '').trim().slice(0, 30) || null, signature };
  });
}

// ── Consecutivo ───────────────────────────────────────────────────────
async function nextDispatchNo(tenantId, transaction) {
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', {
    replacements: { key: `project_dispatches:${tenantId}` }, transaction,
  });
  const rows = await ProjectDispatch.findAll({
    where: { tenant_id: tenantId, dispatch_no: { [Op.like]: 'DSP-%' } }, attributes: ['dispatch_no'], transaction,
  });
  const max = rows.reduce((m, r) => Math.max(m, parseInt(String(r.dispatch_no).split('-')[1], 10) || 0), 0);
  return `DSP-${String(max + 1).padStart(6, '0')}`;
}

// ── Lectura ───────────────────────────────────────────────────────────
/** Map `${stage_id}:${bom_item_id}` → cantidad despachada (derivada de los traslados). */
async function dispatchedMap(tenantId, projectId, { stageId, transaction } = {}) {
  const rows = await sequelize.query(
    `SELECT d.stage_id, ti.project_bom_item_id AS bom_item_id,
            SUM(COALESCE(ti.quantity_received, ti.quantity_sent)) AS qty
       FROM ${table('project_dispatches')} d
       JOIN ${table('transfers')} t ON t.id = d.transfer_id AND t.status <> 'cancelled'
       JOIN ${table('transfer_items')} ti ON ti.transfer_id = t.id
      WHERE d.tenant_id = :tenantId AND d.project_id = :projectId
        AND d.stage_id IS NOT NULL AND ti.project_bom_item_id IS NOT NULL
        ${stageId ? 'AND d.stage_id = :stageId' : ''}
      GROUP BY d.stage_id, ti.project_bom_item_id`,
    { replacements: { tenantId, projectId, stageId: stageId || null }, type: QueryTypes.SELECT, transaction },
  );
  return new Map(rows.map((r) => [`${r.stage_id}:${r.bom_item_id}`, num(r.qty)]));
}

const lineLabel = (l) => l.input_description || l.input_code || `Línea ${l.line_no}`;

async function listStages(tenantId, project) {
  const [stages, lines] = await Promise.all([
    ProjectStage.findAll({ where: { tenant_id: tenantId, project_id: project.id }, order: [['stage_no', 'ASC']], raw: true }),
    ProjectBomItem.findAll({ where: { tenant_id: tenantId, project_id: project.id }, order: [['line_no', 'ASC']], raw: true }),
  ]);
  const items = stages.length
    ? await ProjectStageItem.findAll({ where: { tenant_id: tenantId, stage_id: stages.map((s) => s.id) }, raw: true })
    : [];
  const done = await dispatchedMap(tenantId, project.id);
  const lineById = new Map(lines.map((l) => [l.id, l]));
  const assigned = new Map();

  const out = stages.map((s) => {
    const rows = items
      .filter((i) => i.stage_id === s.id && lineById.has(i.bom_item_id))
      .map((i) => {
        const l = lineById.get(i.bom_item_id);
        const planned = num(i.qty_planned);
        const dispatched = done.get(`${s.id}:${i.bom_item_id}`) || 0;
        assigned.set(i.bom_item_id, round4((assigned.get(i.bom_item_id) || 0) + planned));
        return {
          bom_item_id: i.bom_item_id, line_no: l.line_no, description: lineLabel(l), unit: l.unit, product_id: l.product_id,
          qty_planned: planned, qty_dispatched: round4(dispatched), qty_pending: Math.max(round4(planned - dispatched), 0),
        };
      })
      .sort((a, b) => a.line_no - b.line_no);
    const planned = round4(rows.reduce((t, r) => t + r.qty_planned, 0));
    const dispatched = round4(rows.reduce((t, r) => t + Math.min(r.qty_dispatched, r.qty_planned), 0));
    return {
      id: s.id, stage_no: s.stage_no, name: s.name, description: s.description, planned_date: s.planned_date, status: s.status,
      items: rows,
      totals: { planned, dispatched, pending: Math.max(round4(planned - dispatched), 0), pct: planned > 0 ? Math.round((dispatched / planned) * 1000) / 10 : 0 },
    };
  });

  const unassigned = lines
    .map((l) => {
      const a = assigned.get(l.id) || 0;
      return {
        bom_item_id: l.id, line_no: l.line_no, description: lineLabel(l), unit: l.unit, product_id: l.product_id,
        qty_required: num(l.qty_required), qty_assigned: a, qty_unassigned: Math.max(round4(num(l.qty_required) - a), 0),
      };
    })
    .filter((l) => l.qty_unassigned > EPS);
  return { stages: out, unassigned };
}

async function loadStage(tenantId, project, stageId, { transaction, lock } = {}) {
  const stage = await ProjectStage.findOne({
    where: { id: stageId, tenant_id: tenantId, project_id: project.id }, transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  if (!stage) throw httpError(404, 'Etapa no encontrada');
  return stage;
}

/** Etapa abierta de un proyecto (para despachar). */
async function loadOpenStage(tenantId, project, stageId, transaction) {
  const stage = await loadStage(tenantId, project, stageId, { transaction });
  if (stage.status === 'closed') throw httpError(409, `La etapa ${stage.stage_no} · ${stage.name} está cerrada`);
  return stage;
}

/** Map bom_item_id → saldo por despachar de la etapa (planeado − despachado, mínimo 0). */
async function stageSaldoMap(tenantId, project, stage, transaction) {
  const items = await ProjectStageItem.findAll({ where: { tenant_id: tenantId, stage_id: stage.id }, transaction, raw: true });
  const done = await dispatchedMap(tenantId, project.id, { stageId: stage.id, transaction });
  return new Map(items.map((i) => [i.bom_item_id, Math.max(round4(num(i.qty_planned) - (done.get(`${stage.id}:${i.bom_item_id}`) || 0)), 0)]));
}

// ── Escritura de etapas ───────────────────────────────────────────────
async function plannedElsewhereMap(tenantId, projectId, excludeStageId, transaction) {
  const stages = await ProjectStage.findAll({ where: { tenant_id: tenantId, project_id: projectId }, attributes: ['id'], transaction, raw: true });
  const ids = stages.map((s) => s.id).filter((id) => id !== excludeStageId);
  const map = new Map();
  if (!ids.length) return map;
  const rows = await ProjectStageItem.findAll({ where: { tenant_id: tenantId, stage_id: ids }, transaction, raw: true });
  for (const r of rows) map.set(r.bom_item_id, round4((map.get(r.bom_item_id) || 0) + num(r.qty_planned)));
  return map;
}

const cleanName = (v) => String(v || '').trim().slice(0, 150);
function cleanDate(v) {
  if (v === undefined || v === null || v === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw httpError(400, 'Fecha inválida (usa AAAA-MM-DD)');
  return String(v);
}

async function createStage(tenantId, userId, project, body = {}) {
  assertProjectOpen(project);
  const name = cleanName(body.name);
  if (!name) throw httpError(400, 'Ponle un nombre a la etapa');
  const plannedDate = cleanDate(body.planned_date);
  return sequelize.transaction(async (t) => {
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `project_stages:${project.id}` }, transaction: t });
    const lines = await ProjectBomItem.findAll({ where: { tenant_id: tenantId, project_id: project.id }, transaction: t, raw: true });
    const items = validateStageItems(body.items || [], { lines, plannedElsewhere: await plannedElsewhereMap(tenantId, project.id, null, t) });
    const max = await ProjectStage.max('stage_no', { where: { project_id: project.id }, transaction: t });
    const stage = await ProjectStage.create({
      tenant_id: tenantId, project_id: project.id, stage_no: (max || 0) + 1, name,
      description: String(body.description || '').trim() || null, planned_date: plannedDate, created_by: userId,
    }, { transaction: t });
    if (items.length) await ProjectStageItem.bulkCreate(items.map((i) => ({ ...i, tenant_id: tenantId, stage_id: stage.id })), { transaction: t });
    return stage;
  });
}

async function updateStage(tenantId, project, stageId, body = {}) {
  assertProjectOpen(project);
  return sequelize.transaction(async (t) => {
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `project_stages:${project.id}` }, transaction: t });
    const stage = await loadStage(tenantId, project, stageId, { transaction: t, lock: true });
    const updates = {};
    if (body.name !== undefined) {
      updates.name = cleanName(body.name);
      if (!updates.name) throw httpError(400, 'Ponle un nombre a la etapa');
    }
    if (body.description !== undefined) updates.description = String(body.description || '').trim() || null;
    if (body.planned_date !== undefined) updates.planned_date = cleanDate(body.planned_date);
    if (body.status !== undefined) {
      if (!STAGE_STATUSES.includes(body.status)) throw httpError(400, 'Estado de etapa inválido');
      updates.status = body.status;
    }
    if (body.items !== undefined) {
      if (stage.status === 'closed' && updates.status !== 'open') throw httpError(409, 'La etapa está cerrada: reábrela para cambiar sus líneas');
      const lines = await ProjectBomItem.findAll({ where: { tenant_id: tenantId, project_id: project.id }, transaction: t, raw: true });
      const dispatchedHere = new Map();
      for (const [k, v] of await dispatchedMap(tenantId, project.id, { stageId: stage.id, transaction: t })) dispatchedHere.set(k.split(':')[1], v);
      const items = validateStageItems(body.items, {
        lines, plannedElsewhere: await plannedElsewhereMap(tenantId, project.id, stage.id, t), dispatchedHere,
      });
      await ProjectStageItem.destroy({ where: { tenant_id: tenantId, stage_id: stage.id }, transaction: t });
      if (items.length) await ProjectStageItem.bulkCreate(items.map((i) => ({ ...i, tenant_id: tenantId, stage_id: stage.id })), { transaction: t });
    }
    if (Object.keys(updates).length) await stage.update(updates, { transaction: t });
    return stage;
  });
}

async function deleteStage(tenantId, project, stageId) {
  assertProjectOpen(project);
  return sequelize.transaction(async (t) => {
    const stage = await loadStage(tenantId, project, stageId, { transaction: t, lock: true });
    const used = await ProjectDispatch.count({ where: { tenant_id: tenantId, stage_id: stage.id }, transaction: t });
    if (used) throw httpError(409, 'La etapa ya tiene despachos: ciérrala en vez de eliminarla');
    await stage.destroy({ transaction: t }); // las líneas se van en cascada
    return { deleted: true };
  });
}

// ── Actas de despacho ─────────────────────────────────────────────────
/** Crea el acta (y las firmas que lleguen) dentro de la transacción del despacho. */
async function createDispatchRecord({ tenantId, project, stage, transfer, fromWarehouseId, notes, userId, signatures = [], transaction }) {
  const dispatch = await ProjectDispatch.create({
    tenant_id: tenantId, project_id: project.id, stage_id: stage ? stage.id : null,
    dispatch_no: await nextDispatchNo(tenantId, transaction),
    transfer_id: transfer.id, from_warehouse_id: fromWarehouseId,
    notes: String(notes || '').trim() || null, dispatched_at: new Date(), created_by: userId,
  }, { transaction });
  if (signatures.length) {
    await ProjectDispatchSignature.bulkCreate(signatures.map((s) => ({
      tenant_id: tenantId, dispatch_id: dispatch.id, role: s.role, signed_name: s.name,
      signed_document: s.document, signature: s.signature, signed_at: new Date(), registered_by: userId,
    })), { transaction });
  }
  return dispatch;
}

async function listDispatches(tenantId, project) {
  const dispatches = await ProjectDispatch.findAll({
    where: { tenant_id: tenantId, project_id: project.id }, order: [['dispatched_at', 'DESC']], raw: true,
  });
  if (!dispatches.length) return [];
  const ids = dispatches.map((d) => d.id);
  const [sigs, stages, transfers, counts] = await Promise.all([
    ProjectDispatchSignature.findAll({ where: { tenant_id: tenantId, dispatch_id: ids }, attributes: ['dispatch_id', 'role', 'signed_name', 'signed_at'], raw: true }),
    ProjectStage.findAll({ where: { tenant_id: tenantId, project_id: project.id }, attributes: ['id', 'stage_no', 'name'], raw: true }),
    Transfer.findAll({ where: { id: dispatches.map((d) => d.transfer_id).filter(Boolean) }, attributes: ['id', 'transfer_number', 'status'], raw: true }),
    TransferItem.findAll({ where: { transfer_id: dispatches.map((d) => d.transfer_id).filter(Boolean) }, attributes: ['transfer_id'], raw: true }),
  ]);
  const stageById = new Map(stages.map((s) => [s.id, s]));
  const transferById = new Map(transfers.map((t) => [t.id, t]));
  return dispatches.map((d) => {
    const st = stageById.get(d.stage_id);
    const tr = transferById.get(d.transfer_id);
    const signed = sigs.filter((s) => s.dispatch_id === d.id);
    return {
      id: d.id, dispatch_no: d.dispatch_no, dispatched_at: d.dispatched_at, notes: d.notes,
      stage: st ? { id: st.id, stage_no: st.stage_no, name: st.name } : null,
      transfer: tr ? { id: tr.id, transfer_number: tr.transfer_number, status: tr.status } : null,
      lines: counts.filter((c) => c.transfer_id === d.transfer_id).length,
      signatures: ROLES.map((role) => {
        const s = signed.find((x) => x.role === role);
        return { role, label: ROLE_LABEL[role], signed: Boolean(s), signed_name: s?.signed_name || null, signed_at: s?.signed_at || null };
      }),
    };
  });
}

/** Todo lo que necesita el PDF del acta. */
async function getDispatchForActa(tenantId, project, dispatchId) {
  const dispatch = await ProjectDispatch.findOne({ where: { id: dispatchId, tenant_id: tenantId, project_id: project.id }, raw: true });
  if (!dispatch) throw httpError(404, 'Acta de despacho no encontrada');
  const [stage, transfer, fromWarehouse, toWarehouse, signatures, creator] = await Promise.all([
    dispatch.stage_id ? ProjectStage.findByPk(dispatch.stage_id, { raw: true }) : null,
    dispatch.transfer_id ? Transfer.findByPk(dispatch.transfer_id, { raw: true }) : null,
    dispatch.from_warehouse_id ? Warehouse.findByPk(dispatch.from_warehouse_id, { attributes: ['name'], raw: true }) : null,
    project.warehouse_id ? Warehouse.findByPk(project.warehouse_id, { attributes: ['name'], raw: true }) : null,
    ProjectDispatchSignature.findAll({ where: { tenant_id: tenantId, dispatch_id: dispatch.id }, raw: true }),
    dispatch.created_by ? User.findByPk(dispatch.created_by, { attributes: ['first_name', 'last_name'], raw: true }) : null,
  ]);
  const tItems = dispatch.transfer_id ? await TransferItem.findAll({ where: { transfer_id: dispatch.transfer_id }, raw: true }) : [];
  const products = tItems.length ? await Product.findAll({ where: { id: tItems.map((i) => i.product_id) }, attributes: ['id', 'sku', 'name', 'unit_of_measure'], raw: true }) : [];
  const bom = tItems.length ? await ProjectBomItem.findAll({ where: { id: tItems.map((i) => i.project_bom_item_id).filter(Boolean) }, attributes: ['id', 'line_no'], raw: true }) : [];
  const productById = new Map(products.map((p) => [p.id, p]));
  const lineNoById = new Map(bom.map((b) => [b.id, b.line_no]));
  const lines = tItems
    .map((i) => {
      const p = productById.get(i.product_id) || {};
      return {
        line_no: lineNoById.get(i.project_bom_item_id) ?? null, sku: p.sku || '', name: p.name || '—', unit: p.unit_of_measure || '',
        qty_sent: num(i.quantity_sent), qty_received: i.quantity_received === null ? null : num(i.quantity_received),
      };
    })
    .sort((a, b) => (a.line_no ?? 1e9) - (b.line_no ?? 1e9));

  let stageProgress = null;
  if (stage) {
    const { stages } = await listStages(tenantId, project);
    stageProgress = stages.find((s) => s.id === stage.id)?.totals || null;
  }
  return {
    dispatch, stage, stageProgress, transfer, lines, signatures,
    fromWarehouse: fromWarehouse?.name || null, toWarehouse: toWarehouse?.name || null,
    createdBy: creator ? [creator.first_name, creator.last_name].filter(Boolean).join(' ') : null,
  };
}

/** Registra la firma de un rol sobre un acta ya creada. No reemplaza una firma existente. */
async function signDispatch(tenantId, userId, project, dispatchId, body = {}) {
  const [s] = normalizeSignatures([body]);
  return sequelize.transaction(async (t) => {
    const dispatch = await ProjectDispatch.findOne({
      where: { id: dispatchId, tenant_id: tenantId, project_id: project.id }, transaction: t, lock: t.LOCK.UPDATE,
    });
    if (!dispatch) throw httpError(404, 'Acta de despacho no encontrada');
    const exists = await ProjectDispatchSignature.count({ where: { tenant_id: tenantId, dispatch_id: dispatch.id, role: s.role }, transaction: t });
    if (exists) throw httpError(409, `El acta ya tiene la firma de ${ROLE_LABEL[s.role]}`);
    await ProjectDispatchSignature.create({
      tenant_id: tenantId, dispatch_id: dispatch.id, role: s.role, signed_name: s.name,
      signed_document: s.document, signature: s.signature, signed_at: new Date(), registered_by: userId,
    }, { transaction: t });
    return { dispatch_no: dispatch.dispatch_no, role: s.role };
  });
}

module.exports = {
  ROLES, ROLE_LABEL,
  validateStageItems, normalizeSignatures,
  listStages, createStage, updateStage, deleteStage,
  loadStage, loadOpenStage, stageSaldoMap,
  createDispatchRecord, listDispatches, getDispatchForActa, signDispatch,
};
