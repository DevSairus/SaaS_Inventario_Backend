// backend/src/services/tools/toolBatches.service.js
//
// Checklist masivo de herramientas por lote y etapa (Fase 4, req. 1.5; cubre 2.5).
//
//   Un lote entrega (delivery) o recibe (return) varias herramientas de una obra
//   en un solo paso, opcionalmente dentro de una etapa del proyecto (1.2). Cada
//   herramienta conserva su propia asignación (tool_assignments) con su cargo
//   por uso y su historial; el lote las agrupa bajo un acta LOT-000001 con la
//   firma dibujada en pantalla de cada rol: almacén, transportador y encargado
//   de obra. Todo el lote es una transacción: si una herramienta falla (ya está
//   asignada, en mantenimiento...) no se registra ninguna.
//
//   Las firmas son opcionales al crear el lote y se completan después, una por
//   rol, sin reemplazar las ya registradas (mismo criterio que el acta de
//   despacho de materiales).

const { sequelize } = require('../../config/database');
const { Tool, ToolAssignment, Project, User } = require('../../models');
const ProjectStage = require('../../models/projects/ProjectStage');
const ToolBatch = require('../../models/tools/ToolBatch');
const ToolBatchItem = require('../../models/tools/ToolBatchItem');
const ToolBatchSignature = require('../../models/tools/ToolBatchSignature');
const toolsSvc = require('./tools.service');
const stagesSvc = require('../projects/projectStages.service');

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const todayLocal = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const clean = (v, max) => {
  const s = v === null || v === undefined ? '' : String(v).trim();
  return s ? s.slice(0, max) : null;
};

const KINDS = ['delivery', 'return'];
const MAX_ITEMS = 200;

// Orden y rótulo de las firmas en el acta según el tipo de lote.
const SIGN_ROLES = {
  delivery: [['almacen', 'Almacén (entrega)'], ['transportador', 'Transportador (lleva)'], ['encargado_obra', 'Encargado de obra (recibe)']],
  return: [['encargado_obra', 'Encargado de obra (devuelve)'], ['transportador', 'Transportador (lleva)'], ['almacen', 'Almacén (recibe)']],
};
const KIND_LABEL = { delivery: 'Entrega', return: 'Devolución' };

// ── Validaciones puras (probadas en __tests__/toolBatches.test.js) ─────
/**
 * Valida la lista de ítems de un lote.
 *  delivery: [{ tool_id, quantity?, delivery_condition?, delivery_notes? }]
 *  return:   [{ assignment_id, return_condition?, lost_quantity?, return_notes? }]
 */
function normalizeBatchItems(kind, items) {
  if (!KINDS.includes(kind)) throw httpError(400, 'El lote debe ser de entrega o de devolución');
  if (!Array.isArray(items) || !items.length) throw httpError(400, 'Marca al menos una herramienta');
  if (items.length > MAX_ITEMS) throw httpError(400, `Un lote admite hasta ${MAX_ITEMS} herramientas`);
  const seen = new Set();
  return items.map((it, idx) => {
    const n = idx + 1;
    const key = kind === 'delivery' ? it?.tool_id : it?.assignment_id;
    if (!key || typeof key !== 'string') throw httpError(400, `Ítem ${n}: falta la ${kind === 'delivery' ? 'herramienta' : 'entrega'}`);
    if (seen.has(key)) throw httpError(400, `Ítem ${n}: la ${kind === 'delivery' ? 'herramienta' : 'entrega'} está repetida en el lote`);
    seen.add(key);

    if (kind === 'delivery') {
      const quantity = it.quantity === undefined || it.quantity === null || it.quantity === '' ? 1 : Number(it.quantity);
      if (!Number.isInteger(quantity) || quantity < 1) throw httpError(400, `Ítem ${n}: la cantidad debe ser un entero mayor que cero`);
      const condition = it.delivery_condition || 'good';
      if (!['good', 'damaged'].includes(condition)) throw httpError(400, `Ítem ${n}: estado de entrega inválido`);
      return { tool_id: key, quantity, delivery_condition: condition, delivery_notes: clean(it.delivery_notes, 500) };
    }

    const condition = it.return_condition || 'good';
    if (!['good', 'damaged', 'lost'].includes(condition)) throw httpError(400, `Ítem ${n}: estado de devolución inválido`);
    const lost = it.lost_quantity === undefined || it.lost_quantity === null || it.lost_quantity === '' ? 0 : Number(it.lost_quantity);
    if (!Number.isInteger(lost) || lost < 0) throw httpError(400, `Ítem ${n}: las unidades perdidas deben ser un entero desde 0`);
    return { assignment_id: key, return_condition: condition, lost_quantity: lost, return_notes: clean(it.return_notes, 500) };
  });
}

// Antepone la herramienta al mensaje de un error de negocio para que, en un
// lote de 40, se sepa cuál falló.
function labelError(error, label) {
  if (!error?.statusCode) return error;
  return httpError(error.statusCode, `${label}: ${error.message}`);
}

// ── Crear lote ────────────────────────────────────────────────────────
async function loadProject(tenantId, projectId) {
  const project = await Project.findOne({ where: { id: projectId, tenant_id: tenantId } });
  if (!project) throw httpError(404, 'Proyecto no encontrado');
  return project;
}

/**
 * body: {
 *   kind: 'delivery' | 'return', stage_id?, batch_date?, notes?,
 *   // entrega: quién recibe en obra (encargado) — employee_id | user_id | responsible_name (+ responsible_document)
 *   expected_return_date?, items: [...],
 *   signatures?: [{ role, name, document?, signature }]
 * }
 */
async function createBatch(tenantId, userId, projectId, body = {}) {
  const project = await loadProject(tenantId, projectId);
  const kind = body.kind;
  const items = normalizeBatchItems(kind, body.items);
  const signatures = stagesSvc.normalizeSignatures(body.signatures);
  const batchDate = body.batch_date || todayLocal();
  if (!isDate(batchDate)) throw httpError(400, 'Fecha inválida');

  return sequelize.transaction(async (t) => {
    let stage = null;
    if (body.stage_id) {
      stage = await stagesSvc.loadStage(tenantId, project, body.stage_id, { transaction: t });
      // Se pueden devolver herramientas de una etapa ya cerrada; entregar no.
      if (kind === 'delivery' && stage.status === 'closed') throw httpError(409, `La etapa ${stage.stage_no} · ${stage.name} está cerrada`);
    }

    let header = { name: clean(body.responsible_name, 200), document: clean(body.responsible_document, 30) };
    const assignments = [];

    if (kind === 'delivery') {
      const tools = await Tool.findAll({ where: { id: items.map((i) => i.tool_id), tenant_id: tenantId }, attributes: ['id', 'code', 'name'], transaction: t, raw: true });
      const toolById = new Map(tools.map((x) => [x.id, x]));
      for (const it of items) {
        const tool = toolById.get(it.tool_id);
        if (!tool) throw httpError(404, 'Hay una herramienta que no existe');
        let a;
        try {
          // eslint-disable-next-line no-await-in-loop
          a = await toolsSvc.assignTool(tenantId, userId, it.tool_id, {
            employee_id: body.employee_id, user_id: body.user_id,
            responsible_name: body.responsible_name, responsible_document: body.responsible_document,
            project_id: project.id, assigned_at: batchDate, expected_return_date: body.expected_return_date || undefined,
            quantity: it.quantity, delivery_condition: it.delivery_condition, delivery_notes: it.delivery_notes,
          }, { transaction: t });
        } catch (e) { throw labelError(e, `${tool.code} · ${tool.name}`); }
        assignments.push(a);
      }
      // Todas las entregas del lote van al mismo responsable.
      header = { name: assignments[0].responsible_name, document: assignments[0].responsible_document };
    } else {
      const found = await ToolAssignment.findAll({
        where: { id: items.map((i) => i.assignment_id), tenant_id: tenantId },
        include: [{ model: Tool, as: 'tool', attributes: ['id', 'code', 'name'] }], transaction: t,
      });
      const byId = new Map(found.map((a) => [a.id, a]));
      for (const it of items) {
        const a = byId.get(it.assignment_id);
        if (!a) throw httpError(404, 'Hay una entrega que no existe');
        const label = `${a.tool?.code || a.number} · ${a.tool?.name || 'Herramienta'}`;
        if (a.project_id !== project.id) throw httpError(400, `${label}: la entrega no pertenece a este proyecto`);
        let r;
        try {
          // eslint-disable-next-line no-await-in-loop
          r = await toolsSvc.returnAssignment(tenantId, userId, it.assignment_id, {
            returned_at: batchDate, return_condition: it.return_condition,
            lost_quantity: it.lost_quantity, return_notes: it.return_notes,
          }, { transaction: t });
        } catch (e) { throw labelError(e, label); }
        assignments.push(r);
      }
    }

    const batch = await ToolBatch.create({
      tenant_id: tenantId, kind, project_id: project.id, stage_id: stage ? stage.id : null, batch_date: batchDate,
      batch_no: await toolsSvc.nextNumber(ToolBatch, 'batch_no', 'LOT', 6, tenantId, t),
      responsible_name: header.name, responsible_document: header.document,
      notes: clean(body.notes, 1000), created_by: userId,
    }, { transaction: t });
    await ToolBatchItem.bulkCreate(assignments.map((a) => ({ tenant_id: tenantId, batch_id: batch.id, assignment_id: a.id })), { transaction: t });
    if (signatures.length) {
      await ToolBatchSignature.bulkCreate(signatures.map((s) => ({
        tenant_id: tenantId, batch_id: batch.id, role: s.role, signed_name: s.name,
        signed_document: s.document, signature: s.signature, signed_at: new Date(), registered_by: userId,
      })), { transaction: t });
    }
    return { id: batch.id, batch_no: batch.batch_no, kind, items: assignments.length };
  });
}

// ── Lectura ───────────────────────────────────────────────────────────
async function listBatches(tenantId, projectId) {
  const project = await loadProject(tenantId, projectId);
  const batches = await ToolBatch.findAll({ where: { tenant_id: tenantId, project_id: project.id }, order: [['created_at', 'DESC']], raw: true });
  if (!batches.length) return [];
  const ids = batches.map((b) => b.id);
  const stageIds = batches.map((b) => b.stage_id).filter(Boolean);
  const [items, sigs, stages] = await Promise.all([
    ToolBatchItem.findAll({ where: { tenant_id: tenantId, batch_id: ids }, attributes: ['batch_id'], raw: true }),
    ToolBatchSignature.findAll({ where: { tenant_id: tenantId, batch_id: ids }, attributes: ['batch_id', 'role', 'signed_name', 'signed_at'], raw: true }),
    stageIds.length ? ProjectStage.findAll({ where: { id: stageIds }, attributes: ['id', 'stage_no', 'name'], raw: true }) : [],
  ]);
  const stageById = new Map(stages.map((s) => [s.id, s]));
  return batches.map((b) => {
    const st = stageById.get(b.stage_id);
    const signed = sigs.filter((s) => s.batch_id === b.id);
    return {
      id: b.id, batch_no: b.batch_no, kind: b.kind, batch_date: b.batch_date, notes: b.notes,
      responsible_name: b.responsible_name, stage: st ? { id: st.id, stage_no: st.stage_no, name: st.name } : null,
      items_count: items.filter((i) => i.batch_id === b.id).length,
      signatures: SIGN_ROLES[b.kind].map(([role, label]) => {
        const s = signed.find((x) => x.role === role);
        return { role, label, signed: Boolean(s), signed_name: s?.signed_name || null, signed_at: s?.signed_at || null };
      }),
    };
  });
}

/** Todo lo que necesita el PDF del acta de lote. */
async function getBatchForActa(tenantId, batchId) {
  const batch = await ToolBatch.findOne({ where: { id: batchId, tenant_id: tenantId }, raw: true });
  if (!batch) throw httpError(404, 'Acta de lote no encontrada');
  const [project, stage, creator, itemRows, signatures] = await Promise.all([
    Project.findByPk(batch.project_id, { attributes: ['id', 'code', 'name'], raw: true }),
    batch.stage_id ? ProjectStage.findByPk(batch.stage_id, { raw: true }) : null,
    batch.created_by ? User.findByPk(batch.created_by, { attributes: ['first_name', 'last_name'], raw: true }) : null,
    ToolBatchItem.findAll({ where: { tenant_id: tenantId, batch_id: batch.id }, attributes: ['assignment_id'], raw: true }),
    ToolBatchSignature.findAll({ where: { tenant_id: tenantId, batch_id: batch.id }, raw: true }),
  ]);
  const assignments = itemRows.length ? await ToolAssignment.findAll({
    where: { id: itemRows.map((i) => i.assignment_id), tenant_id: tenantId },
    attributes: { exclude: ['delivery_signature', 'return_signature'] },
    include: [{ model: Tool, as: 'tool', attributes: ['code', 'name', 'serial_number', 'tracking'] }],
  }) : [];
  const lines = assignments.map((a) => ({
    code: a.tool?.code || '', name: a.tool?.name || '—', serial: a.tool?.serial_number || '', quantity: a.quantity,
    delivery_condition: a.delivery_condition, delivery_notes: a.delivery_notes,
    return_condition: a.return_condition, lost_quantity: a.lost_quantity, return_notes: a.return_notes,
    number: a.number,
  })).sort((x, y) => String(x.code).localeCompare(String(y.code), 'es'));
  return {
    batch, project, stage, lines, signatures,
    createdBy: creator ? [creator.first_name, creator.last_name].filter(Boolean).join(' ') : null,
  };
}

/** Registra la firma de un rol sobre un lote ya creado. No reemplaza una firma existente. */
async function signBatch(tenantId, userId, batchId, body = {}) {
  const [s] = stagesSvc.normalizeSignatures([body]);
  return sequelize.transaction(async (t) => {
    const batch = await ToolBatch.findOne({ where: { id: batchId, tenant_id: tenantId }, transaction: t, lock: t.LOCK.UPDATE });
    if (!batch) throw httpError(404, 'Acta de lote no encontrada');
    const exists = await ToolBatchSignature.count({ where: { tenant_id: tenantId, batch_id: batch.id, role: s.role }, transaction: t });
    if (exists) throw httpError(409, `El acta ya tiene la firma de ${stagesSvc.ROLE_LABEL[s.role]}`);
    await ToolBatchSignature.create({
      tenant_id: tenantId, batch_id: batch.id, role: s.role, signed_name: s.name,
      signed_document: s.document, signature: s.signature, signed_at: new Date(), registered_by: userId,
    }, { transaction: t });
    return { batch_no: batch.batch_no, project_id: batch.project_id, role: s.role };
  });
}

module.exports = {
  SIGN_ROLES, KIND_LABEL,
  normalizeBatchItems, labelError,
  createBatch, listBatches, getBatchForActa, signBatch,
};
