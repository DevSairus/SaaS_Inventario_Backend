// backend/src/services/payments/paymentBatches.service.js
//
// Programación de pagos a proveedores (Fase 2 del módulo Proyectos):
//   1. Se arma un lote con compras y gastos por pagar, desde una cuenta
//      bancaria de la empresa (permiso 'payments.schedule').
//   2. Se envía a aprobación; lo aprueba alguien con 'payments.approve' que
//      no sea quien lo armó (segregación de funciones).
//   3. Aprobado, se genera el archivo plano del banco
//      (services/payments/bankFileFormats.js) para cargarlo en su portal.
//   4. Cuando el banco confirma, se marca pagado: cada línea se registra
//      como un abono normal (services/payments/documentPayments.service.js),
//      con su asiento, en la cuenta bancaria del lote.

const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { getCurrentSchema } = require('../../config/tenantContext');
const {
  PaymentBatch, PaymentBatchItem, BankPaymentTemplate, Purchase, Expense, Supplier, BankAccount, Tenant, User, Project,
} = require('../../models');
const { purchaseBalance } = require('../../utils/purchaseAmounts');
const { expenseBalance } = require('../../utils/expenseAmounts');
const { PRESETS, buildBankFile, fromCustomTemplate } = require('./bankFileFormats');
const { registerPurchasePayment, registerExpensePayment } = require('./documentPayments.service');
const { can } = require('../tenantPermissions.service');

const httpError = (statusCode, message, extra) => Object.assign(new Error(message), { statusCode }, extra || {});
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const OPEN_STATUSES = ['draft', 'pending_approval', 'approved', 'exported'];
const supplierName = (s) => (s ? s.business_name || s.name : null);

async function nextBatchNumber(tenantId, transaction) {
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `payment_batches:${tenantId}` }, transaction });
  const rows = await PaymentBatch.findAll({ where: { tenant_id: tenantId, batch_number: { [Op.like]: 'LP-%' } }, attributes: ['batch_number'], transaction });
  const max = rows.reduce((m, r) => Math.max(m, parseInt(String(r.batch_number).split('-')[1], 10) || 0), 0);
  return `LP-${String(max + 1).padStart(6, '0')}`;
}

// Saldo ya comprometido en lotes abiertos, por documento.
async function committedInOpenBatches(tenantId, { excludeBatchId, transaction } = {}) {
  const rows = await PaymentBatchItem.findAll({
    where: { tenant_id: tenantId },
    include: [{
      model: PaymentBatch, as: 'batch', attributes: [], required: true,
      where: { status: OPEN_STATUSES, ...(excludeBatchId ? { id: { [Op.ne]: excludeBatchId } } : {}) },
    }],
    attributes: ['document_type', 'document_id', 'amount'],
    raw: true,
    transaction,
  });
  const map = new Map();
  for (const r of rows) {
    const k = `${r.document_type}:${r.document_id}`;
    map.set(k, round2((map.get(k) || 0) + Number(r.amount)));
  }
  return map;
}

/**
 * Compras y gastos con saldo por pagar (descontando lo que ya está en otros
 * lotes abiertos), con los datos bancarios del proveedor.
 */
async function listPayables(tenantId, { supplier_id, project_id, due_until } = {}) {
  const purchaseWhere = {
    tenant_id: tenantId,
    status: { [Op.notIn]: ['draft', 'cancelled'] },
    payment_status: { [Op.in]: ['pending', 'partial'] },
  };
  const expenseWhere = { tenant_id: tenantId, payment_status: { [Op.in]: ['pending', 'partial'] } };
  if (supplier_id) { purchaseWhere.supplier_id = supplier_id; expenseWhere.supplier_id = supplier_id; }
  if (project_id) { purchaseWhere.project_id = project_id; expenseWhere.project_id = project_id; }
  if (due_until) {
    purchaseWhere.due_date = { [Op.lte]: due_until };
    expenseWhere.due_date = { [Op.lte]: due_until };
  }
  const supplierAttrs = ['id', 'name', 'business_name', 'tax_id', 'document_type', 'bank_name', 'account_type', 'account_number', 'email'];
  const [purchases, expenses, committed] = await Promise.all([
    Purchase.findAll({
      where: purchaseWhere,
      include: [{ model: Supplier, as: 'supplier', attributes: supplierAttrs }, { model: Project, as: 'project', attributes: ['id', 'code'] }],
      order: [['due_date', 'ASC NULLS LAST'], ['purchase_date', 'ASC']],
      limit: 500,
    }),
    Expense.findAll({
      where: expenseWhere,
      include: [{ model: Supplier, as: 'supplier', attributes: supplierAttrs }, { model: Project, as: 'project', attributes: ['id', 'code'] }],
      order: [['due_date', 'ASC NULLS LAST'], ['expense_date', 'ASC']],
      limit: 500,
    }),
    committedInOpenBatches(tenantId),
  ]);
  const row = (type, doc, number, date, balance) => {
    const inBatches = committed.get(`${type}:${doc.id}`) || 0;
    const s = doc.supplier;
    return {
      document_type: type,
      document_id: doc.id,
      document_number: number,
      date,
      due_date: doc.due_date || null,
      supplier_id: s?.id || null,
      supplier_name: supplierName(s) || doc.supplier_name || null,
      supplier_tax_id: s?.tax_id || null,
      project: doc.project ? doc.project.code : null,
      balance,
      in_open_batches: inBatches,
      available: round2(Math.max(balance - inBatches, 0)),
      bank_ready: Boolean(s?.bank_name && s?.account_number && s?.account_type && s?.tax_id),
      bank: s ? { bank_name: s.bank_name, account_type: s.account_type, account_number: s.account_number } : null,
    };
  };
  return [
    ...purchases.map((p) => row('purchase', p, p.invoice_number ? `${p.purchase_number} · Fact. ${p.invoice_number}` : p.purchase_number, p.purchase_date, purchaseBalance(p))),
    ...expenses.map((e) => row('expense', e, `${e.expense_number} · ${e.description}`.slice(0, 60), e.expense_date, expenseBalance(e))),
  ].filter((r) => r.balance > 0)
    .sort((a, b) => String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')));
}

/** Formatos disponibles: los predefinidos + las plantillas propias. */
async function listFormats(tenantId) {
  const custom = await BankPaymentTemplate.findAll({ where: { tenant_id: tenantId }, order: [['name', 'ASC']] });
  return [
    ...Object.values(PRESETS).map((p) => ({ key: p.key, label: p.label, bank: p.bank, preset: true })),
    ...custom.map((c) => ({ key: `custom:${c.id}`, label: c.name, bank: c.bank_name, preset: false, template: c })),
  ];
}

async function resolveFormat(tenantId, key) {
  if (PRESETS[key]) return PRESETS[key];
  if (String(key).startsWith('custom:')) {
    const row = await BankPaymentTemplate.findOne({ where: { id: key.slice(7), tenant_id: tenantId } });
    if (row) return fromCustomTemplate(row);
  }
  throw httpError(400, 'Formato de archivo no encontrado');
}

async function loadBatch(tenantId, id, { transaction, lock = false } = {}) {
  const batch = await PaymentBatch.findOne({
    where: { id, tenant_id: tenantId },
    include: lock ? [] : [
      { model: PaymentBatchItem, as: 'items' },
      { model: BankAccount, as: 'bankAccount', attributes: ['id', 'bank_name', 'account_number', 'account_alias'] },
      { model: User, as: 'creator', attributes: ['id', 'first_name', 'last_name', 'email'] },
      { model: User, as: 'approver', attributes: ['id', 'first_name', 'last_name', 'email'] },
      { model: User, as: 'payer', attributes: ['id', 'first_name', 'last_name', 'email'] },
    ],
    order: lock ? undefined : [[{ model: PaymentBatchItem, as: 'items' }, 'beneficiary_name', 'ASC']],
    transaction,
    lock: lock && transaction ? transaction.LOCK.UPDATE : undefined,
  });
  if (!batch) throw httpError(404, 'Lote no encontrado');
  return batch;
}

// Valida y arma las líneas del lote a partir de los documentos elegidos.
async function buildItems(tenantId, items, { excludeBatchId, transaction }) {
  if (!Array.isArray(items) || !items.length) throw httpError(400, 'Elige al menos un documento para pagar');
  const committed = await committedInOpenBatches(tenantId, { excludeBatchId, transaction });
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = `${it.document_type}:${it.document_id}`;
    if (seen.has(key)) throw httpError(400, 'Un documento está repetido en el lote');
    seen.add(key);
    const isPurchase = it.document_type === 'purchase';
    if (!isPurchase && it.document_type !== 'expense') throw httpError(400, 'Tipo de documento inválido');
    const Model = isPurchase ? Purchase : Expense;
    const doc = await Model.findOne({ where: { id: it.document_id, tenant_id: tenantId }, include: [{ model: Supplier, as: 'supplier' }], transaction });
    if (!doc) throw httpError(404, 'Documento no encontrado');
    const number = isPurchase ? doc.purchase_number : doc.expense_number;
    if (isPurchase && ['draft', 'cancelled'].includes(doc.status)) throw httpError(400, `${number}: la compra no está confirmada`);
    const balance = isPurchase ? purchaseBalance(doc) : expenseBalance(doc);
    const available = round2(balance - (committed.get(key) || 0));
    const amount = round2(it.amount === undefined || it.amount === null || it.amount === '' ? available : Number(it.amount));
    if (!(amount > 0)) throw httpError(400, `${number}: no tiene saldo disponible para pagar`);
    if (amount > available + 0.009) throw httpError(400, `${number}: el saldo disponible es ${available}${committed.get(key) ? ' (parte ya está en otro lote abierto)' : ''}`);
    const s = doc.supplier;
    if (!s) throw httpError(400, `${number}: no tiene proveedor`);
    out.push({
      tenant_id: tenantId,
      document_type: it.document_type,
      document_id: doc.id,
      document_number: number,
      supplier_id: s.id,
      beneficiary_name: supplierName(s),
      beneficiary_tax_id: s.tax_id || null,
      beneficiary_doc_type: s.document_type || null,
      beneficiary_email: s.email || s.contact_email || null,
      bank_name: s.bank_name || null,
      account_type: s.account_type || null,
      account_number: s.account_number || null,
      amount,
    });
  }
  return out;
}

async function createBatch(req, body) {
  const tenantId = req.user.tenant_id;
  const { bank_account_id, payment_date, format_key, debit_account_type = 'savings', notes, items } = body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(payment_date || ''))) throw httpError(400, 'Indica la fecha de pago');
  if (!['savings', 'checking'].includes(debit_account_type)) throw httpError(400, 'Tipo de cuenta a debitar inválido');
  const account = await BankAccount.findOne({ where: { id: bank_account_id, tenant_id: tenantId, is_active: true } });
  if (!account) throw httpError(400, 'Elige la cuenta bancaria desde la que se paga');
  await resolveFormat(tenantId, format_key);

  return sequelize.transaction(async (t) => {
    const rows = await buildItems(tenantId, items, { transaction: t });
    const batch = await PaymentBatch.create({
      tenant_id: tenantId,
      batch_number: await nextBatchNumber(tenantId, t),
      bank_account_id,
      debit_account_type,
      format_key,
      payment_date,
      status: 'draft',
      total_amount: round2(rows.reduce((s, r) => s + r.amount, 0)),
      notes: String(notes || '').trim() || null,
      created_by: req.user.id,
    }, { transaction: t });
    await PaymentBatchItem.bulkCreate(rows.map((r) => ({ ...r, batch_id: batch.id })), { transaction: t });
    return batch;
  });
}

async function updateBatch(req, id, body) {
  const tenantId = req.user.tenant_id;
  return sequelize.transaction(async (t) => {
    const batch = await loadBatch(tenantId, id, { transaction: t, lock: true });
    if (batch.status !== 'draft') throw httpError(400, 'Solo se edita un lote en borrador');
    const updates = {};
    if (body.payment_date !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.payment_date))) throw httpError(400, 'Fecha inválida');
      updates.payment_date = body.payment_date;
    }
    if (body.format_key !== undefined) { await resolveFormat(tenantId, body.format_key); updates.format_key = body.format_key; }
    if (body.debit_account_type !== undefined) updates.debit_account_type = body.debit_account_type;
    if (body.notes !== undefined) updates.notes = String(body.notes || '').trim() || null;
    if (body.items !== undefined) {
      const rows = await buildItems(tenantId, body.items, { excludeBatchId: batch.id, transaction: t });
      await PaymentBatchItem.destroy({ where: { batch_id: batch.id }, transaction: t });
      await PaymentBatchItem.bulkCreate(rows.map((r) => ({ ...r, batch_id: batch.id })), { transaction: t });
      updates.total_amount = round2(rows.reduce((s, r) => s + r.amount, 0));
    }
    await batch.update(updates, { transaction: t });
    return batch;
  });
}

async function transition(req, id, from, apply) {
  return sequelize.transaction(async (t) => {
    const batch = await loadBatch(req.user.tenant_id, id, { transaction: t, lock: true });
    if (!from.includes(batch.status)) throw httpError(400, `El lote está ${STATUS_LABELS[batch.status].toLowerCase()}: no se puede hacer eso`);
    await apply(batch, t);
    return batch;
  });
}

const STATUS_LABELS = {
  draft: 'En borrador', pending_approval: 'Pendiente de aprobación', approved: 'Aprobado',
  exported: 'Archivo generado', paid: 'Pagado', cancelled: 'Anulado',
};

const submitBatch = (req, id) => transition(req, id, ['draft'], (b, t) => b.update({ status: 'pending_approval', submitted_at: new Date(), rejection_reason: null }, { transaction: t }));

const approveBatch = (req, id) => transition(req, id, ['pending_approval'], async (b, t) => {
  if (b.created_by === req.user.id && req.user.role !== 'super_admin') throw httpError(403, 'No puedes aprobar un lote que armaste tú');
  await b.update({ status: 'approved', approved_by: req.user.id, approved_at: new Date() }, { transaction: t });
});

const rejectBatch = (req, id, reason) => transition(req, id, ['pending_approval'], async (b, t) => {
  if (!String(reason || '').trim()) throw httpError(400, 'Indica el motivo del rechazo');
  await b.update({ status: 'draft', rejection_reason: String(reason).trim(), submitted_at: null }, { transaction: t });
});

const cancelBatch = (req, id) => transition(req, id, OPEN_STATUSES, (b, t) => b.update({ status: 'cancelled', cancelled_at: new Date() }, { transaction: t }));

/** Archivo del banco. Solo para lotes aprobados (o ya generados: se puede volver a bajar). */
async function exportBatch(req, id) {
  const tenantId = req.user.tenant_id;
  const batch = await loadBatch(tenantId, id);
  if (!['approved', 'exported'].includes(batch.status)) throw httpError(400, 'El archivo se genera cuando el lote está aprobado');
  const tpl = await resolveFormat(tenantId, batch.format_key);
  const tenant = await Tenant.findByPk(tenantId, { attributes: ['tax_id', 'business_name', 'company_name'] });
  const { content, filename, problems } = buildBankFile(tpl, {
    company: { tax_id: tenant?.tax_id, name: tenant?.business_name || tenant?.company_name },
    batch: { batch_number: batch.batch_number, payment_date: batch.payment_date, debit_account: batch.bankAccount?.account_number, debit_account_type: batch.debit_account_type },
    items: batch.items.map((i) => ({
      reference: i.document_number, name: i.beneficiary_name, tax_id: i.beneficiary_tax_id, doc_type: i.beneficiary_doc_type,
      bank_name: i.bank_name, account_type: i.account_type, account_number: i.account_number, amount: Number(i.amount), email: i.beneficiary_email,
    })),
  });
  if (problems.length) {
    throw httpError(400, `Faltan datos bancarios de ${problems.length} proveedor(es). Complétalos en la ficha del proveedor y vuelve a armar el lote.`, { code: 'MISSING_BANK_DATA', data: problems });
  }
  if (batch.status === 'approved') await batch.update({ status: 'exported', exported_at: new Date(), exported_by: req.user.id });
  return { content, filename, preset: Boolean(PRESETS[batch.format_key]) };
}

/**
 * El banco confirmó el pago: cada línea se registra como abono en su compra
 * o gasto, desde la cuenta del lote. Todo o nada: si una línea ya no se puede
 * pagar (alguien la pagó por otro lado), no se registra ninguna.
 */
async function markPaid(req, id, { paid_date } = {}) {
  const tenantId = req.user.tenant_id;
  const after = [];
  const batch = await sequelize.transaction(async (t) => {
    const b = await loadBatch(tenantId, id, { transaction: t, lock: true });
    // Se paga con el archivo: primero hay que generarlo (y cargarlo en el banco).
    if (b.status !== 'exported') throw httpError(400, b.status === 'approved' ? 'Genera primero el archivo del banco y cárgalo en su portal' : 'Solo se marca pagado un lote aprobado con su archivo generado');
    const items = await PaymentBatchItem.findAll({ where: { batch_id: b.id }, transaction: t });
    const date = paid_date || b.payment_date;
    for (const it of items) {
      const args = {
        tenantId, userId: req.user.id, amount: Number(it.amount), method: 'Transferencia', date,
        notes: `Lote de pagos ${b.batch_number}`, bankAccountId: b.bank_account_id, extra: { payment_batch_id: b.id },
      };
      try {
        const r = it.document_type === 'purchase'
          ? await registerPurchasePayment({ ...args, purchaseId: it.document_id }, t)
          : await registerExpensePayment({ ...args, expenseId: it.document_id }, t);
        if (Math.abs(r.amount - Number(it.amount)) > 0.009) {
          throw httpError(409, `${it.document_number}: el saldo cambió (quedaban ${r.amount}); ajusta el lote antes de marcarlo pagado`);
        }
        after.push(r.afterCommit);
      } catch (e) {
        if (e.statusCode) throw httpError(e.statusCode, `${it.document_number}: ${e.message}`);
        throw e;
      }
    }
    await b.update({ status: 'paid', paid_at: new Date(), paid_by: req.user.id }, { transaction: t });
    return b;
  });
  for (const fn of after) await fn();
  return batch;
}

async function listBatches(tenantId, { status } = {}) {
  const where = { tenant_id: tenantId };
  if (status) where.status = String(status).split(',');
  return PaymentBatch.findAll({
    where,
    include: [
      { model: BankAccount, as: 'bankAccount', attributes: ['id', 'bank_name', 'account_number', 'account_alias'] },
      { model: User, as: 'creator', attributes: ['id', 'first_name', 'last_name', 'email'] },
    ],
    attributes: { include: [[sequelize.literal(`(SELECT COUNT(*) FROM "${getCurrentSchema() || 'public'}"."payment_batch_items" i WHERE i.batch_id = "PaymentBatch"."id")`), 'items_count']] },
    order: [['created_at', 'DESC']],
    limit: 200,
  });
}

/** ¿Este usuario puede aprobar este lote? (para la pantalla) */
async function canApprove(req, batch) {
  if (batch.status !== 'pending_approval') return false;
  if (batch.created_by === req.user.id && req.user.role !== 'super_admin') return false;
  return can(req.user.tenant_id, req.user.role, 'payments.approve');
}

module.exports = {
  STATUS_LABELS,
  listPayables,
  listFormats,
  createBatch,
  updateBatch,
  submitBatch,
  approveBatch,
  rejectBatch,
  cancelBatch,
  exportBatch,
  markPaid,
  listBatches,
  loadBatch,
  canApprove,
};
