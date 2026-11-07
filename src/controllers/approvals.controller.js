// backend/src/controllers/approvals.controller.js
//
// Aprobaciones (services/approvals/approvals.service.js).
//   /api/approvals            bandeja, decisiones y reglas (con sesión)
//   /api/public/approvals/:token  enlace del correo (sin sesión)

const { Op } = require('sequelize');
const { ApprovalRule, User, Project } = require('../models');
const service = require('../services/approvals/approvals.service');
const audit = require('../utils/audit');
const { TENANT_ROLES } = require('../config/permissions.catalog');

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const sendError = (res, error, fallback) => {
  if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message, code: error.code, data: error.data });
  console.error('[approvals]', error);
  return res.status(500).json({ success: false, message: fallback });
};

const inbox = async (req, res) => {
  try {
    res.json({ success: true, data: await service.inbox(req.user.tenant_id, req.user) });
  } catch (error) {
    sendError(res, error, 'Error al obtener las aprobaciones');
  }
};

const count = async (req, res) => {
  try {
    res.json({ success: true, data: { to_decide: await service.countToDecide(req.user.tenant_id, req.user) } });
  } catch (error) {
    sendError(res, error, 'Error al contar las aprobaciones');
  }
};

const forDocument = async (req, res) => {
  try {
    res.json({ success: true, data: await service.forDocument(req.user.tenant_id, req.params.type, req.params.id, req.user) });
  } catch (error) {
    sendError(res, error, 'Error al obtener las aprobaciones del documento');
  }
};

const decide = async (req, res) => {
  try {
    const { decision, comment } = req.body || {};
    const r = await service.decide({ tenantId: req.user.tenant_id, requestId: req.params.id, user: req.user, decision, comment, via: 'app' });
    audit({ tenant_id: req.user.tenant_id, user_id: req.user.id, action: decision === 'approve' ? 'approve' : 'reject', entity: r.document_type, entity_id: r.document_id, changes: { request_id: r.id, status: r.status, comment: comment || null }, req });
    res.json({
      success: true,
      message: r.status === 'approved' ? 'Aprobado' : r.status === 'rejected' ? 'Rechazado' : 'Aprobado: pasa al siguiente aprobador',
      data: r,
    });
  } catch (error) {
    sendError(res, error, 'Error al registrar la decisión');
  }
};

// ── Reglas ───────────────────────────────────────────────────────────────
function rulePayload(body) {
  const name = String(body.name || '').trim().slice(0, 120);
  if (!name) throw httpError(400, 'Ponle un nombre a la regla');
  const min = Number(body.min_amount ?? 0);
  const max = body.max_amount === '' || body.max_amount === null || body.max_amount === undefined ? null : Number(body.max_amount);
  if (!Number.isFinite(min) || min < 0) throw httpError(400, 'Monto mínimo inválido');
  if (max !== null && (!Number.isFinite(max) || max < min)) throw httpError(400, 'El monto máximo debe ser mayor o igual al mínimo');
  const approverRole = body.approver_user_id ? null : (body.approver_role || null);
  if (!approverRole && !body.approver_user_id) throw httpError(400, 'Elige quién aprueba: un rol o un usuario');
  if (approverRole && !TENANT_ROLES.includes(approverRole)) throw httpError(400, 'Rol inválido');
  const sequence = Math.max(parseInt(body.sequence, 10) || 1, 1);
  return {
    document_type: 'purchase', name, min_amount: min, max_amount: max,
    project_id: body.project_id || null, approver_role: approverRole, approver_user_id: body.approver_user_id || null,
    sequence, is_active: body.is_active !== false,
  };
}

async function validateRuleRefs(tenantId, data) {
  if (data.approver_user_id) {
    const u = await User.findOne({ where: { id: data.approver_user_id, tenant_id: tenantId, is_active: true }, attributes: ['id'] });
    if (!u) throw httpError(400, 'Usuario aprobador no encontrado');
  }
  if (data.project_id) {
    const p = await Project.findOne({ where: { id: data.project_id, tenant_id: tenantId }, attributes: ['id'] });
    if (!p) throw httpError(400, 'Proyecto no encontrado');
  }
}

const listRules = async (req, res) => {
  try {
    const rows = await ApprovalRule.findAll({
      where: { tenant_id: req.user.tenant_id },
      include: [
        { model: User, as: 'approver', attributes: ['id', 'first_name', 'last_name', 'email'] },
        { model: Project, as: 'project', attributes: ['id', 'code', 'name'] },
      ],
      order: [['document_type', 'ASC'], ['sequence', 'ASC'], ['min_amount', 'ASC']],
    });
    res.json({ success: true, data: rows });
  } catch (error) {
    sendError(res, error, 'Error al obtener las reglas');
  }
};

const createRule = async (req, res) => {
  try {
    const data = rulePayload(req.body || {});
    await validateRuleRefs(req.user.tenant_id, data);
    const rule = await ApprovalRule.create({ ...data, tenant_id: req.user.tenant_id, created_by: req.user.id });
    audit({ tenant_id: req.user.tenant_id, user_id: req.user.id, action: 'create', entity: 'approval_rule', entity_id: rule.id, changes: data, req });
    res.status(201).json({ success: true, message: 'Regla creada', data: rule });
  } catch (error) {
    sendError(res, error, 'Error al crear la regla');
  }
};

const updateRule = async (req, res) => {
  try {
    const rule = await ApprovalRule.findOne({ where: { id: req.params.id, tenant_id: req.user.tenant_id } });
    if (!rule) throw httpError(404, 'Regla no encontrada');
    const data = rulePayload({ ...rule.toJSON(), ...req.body });
    await validateRuleRefs(req.user.tenant_id, data);
    await rule.update(data);
    audit({ tenant_id: req.user.tenant_id, user_id: req.user.id, action: 'update', entity: 'approval_rule', entity_id: rule.id, changes: data, req });
    res.json({ success: true, message: 'Regla actualizada', data: rule });
  } catch (error) {
    sendError(res, error, 'Error al actualizar la regla');
  }
};

const deleteRule = async (req, res) => {
  try {
    const n = await ApprovalRule.destroy({ where: { id: req.params.id, tenant_id: req.user.tenant_id } });
    if (!n) throw httpError(404, 'Regla no encontrada');
    audit({ tenant_id: req.user.tenant_id, user_id: req.user.id, action: 'delete', entity: 'approval_rule', entity_id: req.params.id, req });
    res.json({ success: true, message: 'Regla eliminada' });
  } catch (error) {
    sendError(res, error, 'Error al eliminar la regla');
  }
};

// ── Público (enlace del correo) ──────────────────────────────────────────
// Corre dentro del schema del tenant dueño del token.
async function inTokenSchema(token, fn) {
  const { resolveRecordSchemaByToken } = require('../utils/publicTokenResolver');
  const { runWithTenantSchema } = require('../config/tenantContext');
  const resolved = await resolveRecordSchemaByToken({ table: 'approval_tokens', column: 'token', token });
  if (!resolved) throw httpError(404, 'Enlace no válido');
  return runWithTenantSchema(resolved.schemaName, fn);
}

const publicView = async (req, res) => {
  try {
    const data = await inTokenSchema(req.params.token, () => service.publicView(req.params.token));
    res.json({ success: true, data });
  } catch (error) {
    sendError(res, error, 'Error al cargar la solicitud');
  }
};

const publicDecide = async (req, res) => {
  try {
    const { decision, comment } = req.body || {};
    const r = await inTokenSchema(req.params.token, () => service.publicDecide(req.params.token, { decision, comment }));
    res.json({ success: true, message: decision === 'approve' ? 'Aprobado. Gracias.' : 'Rechazado. Se avisó al solicitante.', data: { status: r.status } });
  } catch (error) {
    sendError(res, error, 'Error al registrar la decisión');
  }
};

module.exports = { inbox, count, forDocument, decide, listRules, createRule, updateRule, deleteRule, publicView, publicDecide };
