// backend/src/services/approvals/approvals.service.js
//
// Motor de aprobaciones parametrizable (Fase 2 del módulo Proyectos). Primer
// documento: la orden de compra. Si ninguna regla de la empresa aplica, nada
// cambia: la compra se confirma y recibe como siempre.
//
//   - Al confirmar (o recibir directo desde borrador) una compra cuyas reglas
//     aplican y que no está aprobada, se crea la solicitud, la compra queda
//     approval_status='pending' y la acción responde 409 APPROVAL_REQUIRED.
//   - Cada regla que aplica es un paso, en orden de `sequence`. Aprueba quien
//     tenga el rol de la regla (o el usuario de la regla); nunca quien pidió
//     la aprobación (segregación de funciones).
//   - A cada aprobador del paso le llega un correo con un enlace de un solo
//     uso para aprobar o rechazar desde el celular (/aprobar/:token).
//   - Editar el monto, el proveedor o el proyecto de una compra pendiente o
//     aprobada anula la aprobación: hay que pedirla de nuevo.

const crypto = require('crypto');
const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const logger = require('../../config/logger');
const {
  ApprovalRule, ApprovalRequest, ApprovalToken, User, Purchase, Supplier, Project, Tenant,
} = require('../../models');
const { ROLE_LABELS } = require('../../config/permissions.catalog');

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const httpError = (statusCode, message, extra) => Object.assign(new Error(message), { statusCode }, extra || {});
const num = (v) => Number(v) || 0;
const userName = (u) => (u ? [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email : null);
const money = (n) => `$${Math.round(num(n)).toLocaleString('es-CO')}`;

// Documentos aprobables. load() devuelve la instancia (con lock si hay transacción).
const DOCUMENTS = {
  purchase: {
    label: 'Orden de compra',
    load: (tenantId, id, transaction) => Purchase.findOne({ where: { id, tenant_id: tenantId }, transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined }),
    amount: (doc) => num(doc.total_amount),
    number: (doc) => doc.purchase_number,
    projectId: (doc) => doc.project_id || null,
    path: (doc) => `/purchases/${doc.id}`,
    async summary(tenantId, doc) {
      const [supplier, project] = await Promise.all([
        doc.supplier_id ? Supplier.findOne({ where: { id: doc.supplier_id, tenant_id: tenantId }, attributes: ['name', 'business_name', 'tax_id'] }) : null,
        doc.project_id ? Project.findOne({ where: { id: doc.project_id, tenant_id: tenantId }, attributes: ['code', 'name'] }) : null,
      ]);
      const items = await doc.getItems?.({ attributes: ['product_name', 'product_sku', 'quantity', 'unit_cost', 'total'] }).catch(() => []) || [];
      return {
        number: doc.purchase_number,
        date: doc.purchase_date,
        supplier: supplier ? (supplier.business_name || supplier.name) : (doc.supplier_name || null),
        supplier_tax_id: supplier?.tax_id || null,
        project: project ? `${project.code} · ${project.name}` : null,
        subtotal: num(doc.subtotal),
        tax: num(doc.tax_amount),
        total: num(doc.total_amount),
        notes: doc.notes || null,
        items: items.map((i) => ({ name: i.product_name, sku: i.product_sku, quantity: num(i.quantity), unit_cost: num(i.unit_cost), total: num(i.total) })),
      };
    },
    setStatus: (doc, status, userId, transaction) => doc.update({
      approval_status: status,
      ...(status === 'approved' ? { approved_by: userId, approved_at: new Date() } : {}),
      ...(status !== 'approved' ? { approved_by: null, approved_at: null } : {}),
    }, { transaction }),
  },
};

const docDef = (type) => {
  const d = DOCUMENTS[type];
  if (!d) throw httpError(400, 'Tipo de documento no aprobable');
  return d;
};

/** Reglas activas que aplican a un monto/proyecto, en orden de paso. */
async function matchingRules(tenantId, documentType, { amount, projectId }, transaction) {
  const rules = await ApprovalRule.findAll({
    where: {
      tenant_id: tenantId,
      document_type: documentType,
      is_active: true,
      min_amount: { [Op.lte]: amount },
      [Op.and]: [
        { [Op.or]: [{ max_amount: null }, { max_amount: { [Op.gte]: amount } }] },
        { [Op.or]: [{ project_id: null }, ...(projectId ? [{ project_id: projectId }] : [])] },
      ],
    },
    order: [['sequence', 'ASC'], ['min_amount', 'ASC'], ['created_at', 'ASC']],
    transaction,
  });
  return rules;
}

const latestRequest = (tenantId, documentType, documentId, transaction) => ApprovalRequest.findOne({
  where: { tenant_id: tenantId, document_type: documentType, document_id: documentId, status: { [Op.ne]: 'cancelled' } },
  order: [['created_at', 'DESC']],
  transaction,
});

// ¿Puede este usuario decidir el paso actual?
function canDecideStep(request, user) {
  if (request.status !== 'pending') return false;
  const step = request.steps[request.current_step];
  if (!step) return false;
  if (request.requested_by && request.requested_by === user.id) return false; // no se aprueba lo propio
  if (step.approver_user_id) return step.approver_user_id === user.id;
  return step.approver_role === user.role || user.role === 'super_admin';
}

// Usuarios del tenant que pueden decidir un paso (para avisarles).
async function stepApprovers(tenantId, step, requestedBy) {
  const where = { tenant_id: tenantId, is_active: true };
  if (step.approver_user_id) where.id = step.approver_user_id;
  else where.role = step.approver_role;
  const users = await User.findAll({ where, attributes: ['id', 'first_name', 'last_name', 'email', 'role'] });
  return users.filter((u) => u.id !== requestedBy && u.email);
}

const frontendBase = () => (process.env.FRONTEND_URL || '').split(',')[0].trim().replace(/\/$/, '');

// Correo a los aprobadores del paso actual, cada uno con su enlace.
async function notifyStep(tenantId, request) {
  try {
    const step = request.steps[request.current_step];
    if (!step || request.status !== 'pending') return;
    const approvers = await stepApprovers(tenantId, step, request.requested_by);
    if (!approvers.length) {
      logger.warn(`[approvals] Paso ${request.current_step + 1} de ${request.document_number} sin aprobadores con correo`);
      return;
    }
    const def = docDef(request.document_type);
    const tenant = await Tenant.findByPk(tenantId, { attributes: ['company_name', 'business_name'] });
    const requester = request.requested_by ? await User.findByPk(request.requested_by, { attributes: ['first_name', 'last_name', 'email'] }) : null;
    const base = frontendBase();
    const emailService = require('../emailService');
    for (const u of approvers) {
      const token = crypto.randomUUID();
      await ApprovalToken.create({
        tenant_id: tenantId, request_id: request.id, step: request.current_step, user_id: u.id, token,
        expires_at: new Date(Date.now() + TOKEN_TTL_MS),
      });
      const link = base ? `${base}/aprobar/${token}` : null;
      await emailService.sendEmail({
        to: u.email,
        subject: `Aprobación pendiente: ${def.label} ${request.document_number} por ${money(request.amount)}`,
        html: `
          <p>Hola ${u.first_name || ''},</p>
          <p>${userName(requester) || 'Un usuario'} pide tu aprobación para la <strong>${def.label.toLowerCase()} ${request.document_number}</strong>
          por <strong>${money(request.amount)}</strong>${tenant ? ` en ${tenant.business_name || tenant.company_name}` : ''}.</p>
          <p>Regla: ${step.rule_name}${request.steps.length > 1 ? ` (paso ${request.current_step + 1} de ${request.steps.length})` : ''}.</p>
          ${link ? `<p><a href="${link}" style="display:inline-block;padding:10px 18px;background:#ea580c;color:#fff;border-radius:8px;text-decoration:none">Revisar y aprobar</a></p>
          <p style="color:#6b7280;font-size:12px">El enlace sirve una sola vez y vence en 7 días. También puedes aprobar en la plataforma, en Aprobaciones.</p>`
            : '<p>Apruébala en la plataforma, en Aprobaciones.</p>'}
        `,
      });
    }
  } catch (err) {
    // El aviso no bloquea la solicitud: queda en la bandeja de Aprobaciones.
    logger.warn(`[approvals] No se pudo avisar a los aprobadores de ${request.document_number}: ${err.message}`);
  }
}

/**
 * Exige aprobación antes de avanzar el documento (confirmar/recibir una
 * compra). Si no hay reglas que apliquen o ya está aprobado, no hace nada.
 * Si falta, crea (o reutiliza) la solicitud y lanza 409 APPROVAL_REQUIRED.
 */
async function assertApproved(req, documentType, doc) {
  const def = docDef(documentType);
  const tenantId = req.user.tenant_id;
  const amount = def.amount(doc);
  const rules = await matchingRules(tenantId, documentType, { amount, projectId: def.projectId(doc) });
  if (!rules.length) return null;

  const existing = await latestRequest(tenantId, documentType, doc.id);
  if (existing && existing.status === 'approved' && num(existing.amount) === amount) return existing;

  let request = existing && existing.status === 'pending' && num(existing.amount) === amount ? existing : null;
  if (!request) {
    request = await sequelize.transaction(async (t) => {
      if (existing && existing.status === 'pending') await existing.update({ status: 'cancelled' }, { transaction: t });
      const created = await ApprovalRequest.create({
        tenant_id: tenantId,
        document_type: documentType,
        document_id: doc.id,
        document_number: def.number(doc),
        amount,
        project_id: def.projectId(doc),
        status: 'pending',
        current_step: 0,
        steps: rules.map((r) => ({
          sequence: r.sequence, rule_id: r.id, rule_name: r.name,
          approver_role: r.approver_role || null, approver_user_id: r.approver_user_id || null,
          status: 'pending', decided_by: null, decided_at: null, comment: null, via: null,
        })),
        requested_by: req.user.id,
      }, { transaction: t });
      await def.setStatus(doc, 'pending', null, t);
      return created;
    });
    notifyStep(tenantId, request);
  }
  const step = request.steps[request.current_step];
  const who = step.approver_user_id
    ? userName(await User.findByPk(step.approver_user_id, { attributes: ['first_name', 'last_name', 'email'] }))
    : (ROLE_LABELS[step.approver_role] || step.approver_role);
  throw httpError(409, `Esta ${def.label.toLowerCase()} por ${money(amount)} requiere aprobación (${step.rule_name}: ${who}). Se envió la solicitud; cuando la aprueben podrás continuar.`, {
    code: 'APPROVAL_REQUIRED',
    data: { request_id: request.id, status: request.status },
  });
}

/**
 * Decisión sobre el paso actual. via: 'app' | 'email'.
 * Aprobado el último paso, el documento queda approval_status='approved'.
 */
async function decide({ tenantId, requestId, user, decision, comment, via = 'app' }) {
  if (!['approve', 'reject'].includes(decision)) throw httpError(400, 'Decisión inválida');
  if (decision === 'reject' && !String(comment || '').trim()) throw httpError(400, 'Indica el motivo del rechazo');
  const result = await sequelize.transaction(async (t) => {
    const request = await ApprovalRequest.findOne({ where: { id: requestId, tenant_id: tenantId }, transaction: t, lock: t.LOCK.UPDATE });
    if (!request) throw httpError(404, 'Solicitud no encontrada');
    if (request.status !== 'pending') throw httpError(409, 'Esta solicitud ya fue decidida');
    if (!canDecideStep(request, user)) {
      throw httpError(403, request.requested_by === user.id ? 'No puedes aprobar tu propia solicitud' : 'Este paso le corresponde a otro aprobador');
    }
    const def = docDef(request.document_type);
    const doc = await def.load(tenantId, request.document_id, t);
    if (!doc) throw httpError(404, 'El documento ya no existe');

    const decidedStep = request.current_step;
    const steps = request.steps.map((s) => ({ ...s }));
    Object.assign(steps[request.current_step], {
      status: decision === 'approve' ? 'approved' : 'rejected',
      decided_by: user.id, decided_by_name: userName(user), decided_at: new Date().toISOString(),
      comment: String(comment || '').trim() || null, via,
    });
    const last = request.current_step >= steps.length - 1;
    const updates = { steps };
    if (decision === 'reject') {
      Object.assign(updates, { status: 'rejected', decided_by: user.id, decided_at: new Date(), comment: String(comment).trim() });
      await def.setStatus(doc, 'rejected', user.id, t);
    } else if (last) {
      Object.assign(updates, { status: 'approved', decided_by: user.id, decided_at: new Date(), comment: String(comment || '').trim() || null });
      await def.setStatus(doc, 'approved', user.id, t);
    } else {
      updates.current_step = request.current_step + 1;
    }
    await request.update(updates, { transaction: t });
    // Los enlaces del paso decidido dejan de servir (también los de los demás aprobadores).
    await ApprovalToken.update({ used_at: new Date() }, { where: { request_id: request.id, step: decidedStep, used_at: null }, transaction: t });
    return request;
  });
  if (result.status === 'pending') notifyStep(tenantId, result);
  else notifyRequester(tenantId, result);
  return result;
}

// Aviso al solicitante cuando su solicitud se aprueba o rechaza.
async function notifyRequester(tenantId, request) {
  try {
    if (!request.requested_by) return;
    const u = await User.findByPk(request.requested_by, { attributes: ['first_name', 'email'] });
    if (!u?.email) return;
    const def = docDef(request.document_type);
    const ok = request.status === 'approved';
    await require('../emailService').sendEmail({
      to: u.email,
      subject: `${def.label} ${request.document_number} ${ok ? 'aprobada' : 'rechazada'}`,
      html: `<p>Hola ${u.first_name || ''},</p><p>La ${def.label.toLowerCase()} <strong>${request.document_number}</strong> por ${money(request.amount)} fue <strong>${ok ? 'aprobada' : 'rechazada'}</strong>.${request.comment ? ` Comentario: ${String(request.comment).replace(/</g, '&lt;')}` : ''}</p>${ok ? '<p>Ya puedes confirmarla en la plataforma.</p>' : ''}`,
    });
  } catch (err) {
    logger.warn(`[approvals] No se pudo avisar al solicitante: ${err.message}`);
  }
}

/**
 * El documento cambió (monto, proveedor, proyecto): la aprobación vigente o
 * pendiente deja de valer. Llamar dentro de la transacción del cambio.
 */
async function invalidate(tenantId, documentType, documentId, transaction) {
  const [count] = await ApprovalRequest.update(
    { status: 'cancelled', comment: 'Anulada: el documento cambió después de pedir la aprobación' },
    { where: { tenant_id: tenantId, document_type: documentType, document_id: documentId, status: { [Op.in]: ['pending', 'approved'] } }, transaction },
  );
  return count;
}

// ── Lecturas ─────────────────────────────────────────────────────────────
const requestAttrs = ['id', 'document_type', 'document_id', 'document_number', 'amount', 'project_id', 'status', 'current_step', 'steps', 'requested_by', 'decided_at', 'comment', 'created_at'];

async function serialize(tenantId, request, user) {
  const json = request.toJSON ? request.toJSON() : request;
  const def = DOCUMENTS[json.document_type];
  return {
    ...json,
    document_label: def?.label || json.document_type,
    document_path: def ? `/${json.document_type === 'purchase' ? 'purchases' : json.document_type}/${json.document_id}` : null,
    current_step_label: json.status === 'pending' ? json.steps[json.current_step]?.rule_name : null,
    current_approver: json.status === 'pending'
      ? (json.steps[json.current_step]?.approver_user_id ? 'usuario' : ROLE_LABELS[json.steps[json.current_step]?.approver_role] || null)
      : null,
    can_decide: user ? canDecideStep(request, user) : false,
  };
}

/** Bandeja: pendientes que el usuario puede decidir + las suyas recientes. */
async function inbox(tenantId, user) {
  const pending = await ApprovalRequest.findAll({
    where: { tenant_id: tenantId, status: 'pending' },
    include: [{ model: User, as: 'requester', attributes: ['id', 'first_name', 'last_name', 'email'] }, { model: Project, as: 'project', attributes: ['id', 'code', 'name'] }],
    order: [['created_at', 'ASC']],
    limit: 200,
  });
  const mine = await ApprovalRequest.findAll({
    where: { tenant_id: tenantId, requested_by: user.id },
    include: [{ model: User, as: 'decider', attributes: ['id', 'first_name', 'last_name', 'email'] }, { model: Project, as: 'project', attributes: ['id', 'code', 'name'] }],
    order: [['created_at', 'DESC']],
    limit: 50,
  });
  return {
    to_decide: await Promise.all(pending.filter((r) => canDecideStep(r, user)).map((r) => serialize(tenantId, r, user))),
    mine: await Promise.all(mine.map((r) => serialize(tenantId, r, user))),
  };
}

async function countToDecide(tenantId, user) {
  const pending = await ApprovalRequest.findAll({ where: { tenant_id: tenantId, status: 'pending' }, attributes: ['id', 'status', 'current_step', 'steps', 'requested_by'] });
  return pending.filter((r) => canDecideStep(r, user)).length;
}

async function forDocument(tenantId, documentType, documentId, user) {
  const rows = await ApprovalRequest.findAll({
    where: { tenant_id: tenantId, document_type: documentType, document_id: documentId },
    include: [{ model: User, as: 'requester', attributes: ['id', 'first_name', 'last_name', 'email'] }],
    order: [['created_at', 'DESC']],
  });
  return Promise.all(rows.map((r) => serialize(tenantId, r, user)));
}

// ── Enlace del correo (/aprobar/:token, sin sesión) ──────────────────────
async function loadByToken(token) {
  const row = await ApprovalToken.findOne({ where: { token }, include: [{ model: User, as: 'user', attributes: ['id', 'first_name', 'last_name', 'email', 'role', 'tenant_id', 'is_active'] }] });
  if (!row) throw httpError(404, 'Enlace no válido');
  if (row.used_at) throw httpError(410, 'Este enlace ya se usó');
  if (new Date(row.expires_at) < new Date()) throw httpError(410, 'Este enlace venció. Aprueba desde la plataforma.');
  if (!row.user?.is_active) throw httpError(403, 'Tu usuario ya no está activo');
  const request = await ApprovalRequest.findOne({ where: { id: row.request_id, tenant_id: row.tenant_id } });
  if (!request) throw httpError(404, 'Solicitud no encontrada');
  if (request.status !== 'pending' || request.current_step !== row.step) throw httpError(409, 'Esta solicitud ya fue decidida o pasó a otro aprobador');
  return { row, request };
}

async function publicView(token) {
  const { row, request } = await loadByToken(token);
  const def = docDef(request.document_type);
  const doc = await def.load(row.tenant_id, request.document_id);
  if (!doc) throw httpError(404, 'El documento ya no existe');
  const [tenant, requester] = await Promise.all([
    Tenant.findByPk(row.tenant_id, { attributes: ['company_name', 'business_name'] }),
    request.requested_by ? User.findByPk(request.requested_by, { attributes: ['first_name', 'last_name', 'email'] }) : null,
  ]);
  return {
    company: tenant?.business_name || tenant?.company_name || null,
    approver: userName(row.user),
    document_label: def.label,
    requested_by: userName(requester),
    requested_at: request.created_at,
    amount: num(request.amount),
    step: request.current_step + 1,
    steps: request.steps.length,
    rule: request.steps[request.current_step]?.rule_name,
    previous: request.steps.slice(0, request.current_step).map((s) => ({ rule: s.rule_name, by: s.decided_by_name, at: s.decided_at, comment: s.comment })),
    document: await def.summary(row.tenant_id, doc),
  };
}

async function publicDecide(token, { decision, comment }) {
  const { row, request } = await loadByToken(token);
  const updated = await decide({ tenantId: row.tenant_id, requestId: request.id, user: row.user, decision, comment, via: 'email' });
  await row.update({ used_at: new Date() });
  return updated;
}

module.exports = {
  DOCUMENTS,
  matchingRules,
  assertApproved,
  decide,
  invalidate,
  inbox,
  countToDecide,
  forDocument,
  publicView,
  publicDecide,
  canDecideStep,
};
