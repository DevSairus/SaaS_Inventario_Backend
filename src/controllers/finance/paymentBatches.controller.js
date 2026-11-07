// backend/src/controllers/finance/paymentBatches.controller.js
//
// Lotes de pago a proveedores con archivo plano del banco
// (services/payments/paymentBatches.service.js). Base: /api/payment-batches

const service = require('../../services/payments/paymentBatches.service');
const { FIELD_SOURCES } = require('../../services/payments/bankFileFormats');
const { BankPaymentTemplate } = require('../../models');
const audit = require('../../utils/audit');

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const sendError = (res, error, fallback) => {
  if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message, code: error.code, data: error.data });
  console.error('[paymentBatches]', error);
  return res.status(500).json({ success: false, message: fallback });
};
const logAudit = (req, action, batch, changes) => audit({
  tenant_id: req.user.tenant_id, user_id: req.user.id, action, entity: 'payment_batch', entity_id: batch.id, changes: { batch_number: batch.batch_number, ...changes }, req,
});

const payables = async (req, res) => {
  try {
    res.json({ success: true, data: await service.listPayables(req.user.tenant_id, req.query) });
  } catch (error) {
    sendError(res, error, 'Error al obtener las cuentas por pagar');
  }
};

const formats = async (req, res) => {
  try {
    res.json({ success: true, data: { formats: await service.listFormats(req.user.tenant_id), fields: FIELD_SOURCES } });
  } catch (error) {
    sendError(res, error, 'Error al obtener los formatos');
  }
};

const list = async (req, res) => {
  try {
    res.json({ success: true, data: await service.listBatches(req.user.tenant_id, req.query) });
  } catch (error) {
    sendError(res, error, 'Error al obtener los lotes');
  }
};

const getById = async (req, res) => {
  try {
    const batch = await service.loadBatch(req.user.tenant_id, req.params.id);
    res.json({ success: true, data: { ...batch.toJSON(), can_approve: await service.canApprove(req, batch) } });
  } catch (error) {
    sendError(res, error, 'Error al obtener el lote');
  }
};

const create = async (req, res) => {
  try {
    const batch = await service.createBatch(req, req.body);
    logAudit(req, 'create', batch, { total: batch.total_amount });
    res.status(201).json({ success: true, message: `Lote ${batch.batch_number} creado`, data: batch });
  } catch (error) {
    sendError(res, error, 'Error al crear el lote');
  }
};

const update = async (req, res) => {
  try {
    const batch = await service.updateBatch(req, req.params.id, req.body || {});
    res.json({ success: true, message: 'Lote actualizado', data: batch });
  } catch (error) {
    sendError(res, error, 'Error al actualizar el lote');
  }
};

const action = (fn, verb, message) => async (req, res) => {
  try {
    const batch = await fn(req, req.params.id, req.body?.reason);
    logAudit(req, verb, batch, req.body?.reason ? { reason: req.body.reason } : {});
    res.json({ success: true, message: message(batch), data: batch });
  } catch (error) {
    sendError(res, error, 'Error al actualizar el lote');
  }
};

const exportFile = async (req, res) => {
  try {
    const { content, filename } = await service.exportBatch(req, req.params.id);
    audit({ tenant_id: req.user.tenant_id, user_id: req.user.id, action: 'export', entity: 'payment_batch', entity_id: req.params.id, changes: { filename }, req });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(content);
  } catch (error) {
    sendError(res, error, 'Error al generar el archivo');
  }
};

const markPaid = async (req, res) => {
  try {
    const batch = await service.markPaid(req, req.params.id, req.body || {});
    logAudit(req, 'paid', batch, { total: batch.total_amount });
    res.json({ success: true, message: `Lote ${batch.batch_number} pagado: se registraron los abonos y sus asientos`, data: batch });
  } catch (error) {
    sendError(res, error, 'Error al registrar los pagos del lote');
  }
};

// ── Plantillas propias (columnas separadas por delimitador) ──────────────
function templatePayload(body) {
  const name = String(body.name || '').trim().slice(0, 120);
  if (!name) throw httpError(400, 'Ponle un nombre al formato');
  const delimiter = [',', ';', '|', '\t'].includes(body.delimiter) ? body.delimiter : ',';
  const columns = (Array.isArray(body.columns) ? body.columns : [])
    .filter((c) => c && (c.source === 'const' || FIELD_SOURCES[c.source]))
    .map((c) => ({ source: c.source, label: String(c.label || '').slice(0, 60) || undefined, value: c.source === 'const' ? String(c.value ?? '').slice(0, 60) : undefined, format: ['upper', 'decimal_dot', 'decimal_comma', 'integer', 'cents', 'yyyymmdd', 'ddmmyyyy', 'dd/mm/yyyy'].includes(c.format) ? c.format : undefined }));
  if (!columns.length) throw httpError(400, 'Agrega al menos una columna');
  return {
    name,
    bank_name: String(body.bank_name || '').trim().slice(0, 100) || null,
    delimiter,
    extension: ['csv', 'txt'].includes(body.extension) ? body.extension : 'csv',
    include_header: body.include_header !== false,
    savings_code: String(body.savings_code || '').trim().slice(0, 20) || null,
    checking_code: String(body.checking_code || '').trim().slice(0, 20) || null,
    columns,
  };
}

const saveTemplate = async (req, res) => {
  try {
    const data = templatePayload(req.body || {});
    let row;
    if (req.params.templateId) {
      row = await BankPaymentTemplate.findOne({ where: { id: req.params.templateId, tenant_id: req.user.tenant_id } });
      if (!row) throw httpError(404, 'Formato no encontrado');
      await row.update(data);
    } else {
      row = await BankPaymentTemplate.create({ ...data, tenant_id: req.user.tenant_id, created_by: req.user.id });
    }
    res.status(req.params.templateId ? 200 : 201).json({ success: true, message: 'Formato guardado', data: row });
  } catch (error) {
    sendError(res, error, 'Error al guardar el formato');
  }
};

const deleteTemplate = async (req, res) => {
  try {
    const n = await BankPaymentTemplate.destroy({ where: { id: req.params.templateId, tenant_id: req.user.tenant_id } });
    if (!n) throw httpError(404, 'Formato no encontrado');
    res.json({ success: true, message: 'Formato eliminado' });
  } catch (error) {
    sendError(res, error, 'Error al eliminar el formato');
  }
};

module.exports = {
  payables, formats, list, getById, create, update, exportFile, markPaid, saveTemplate, deleteTemplate,
  submit: action(service.submitBatch, 'submit', (b) => `Lote ${b.batch_number} enviado a aprobación`),
  approve: action(service.approveBatch, 'approve', (b) => `Lote ${b.batch_number} aprobado: ya puedes generar el archivo del banco`),
  reject: action(service.rejectBatch, 'reject', (b) => `Lote ${b.batch_number} devuelto a borrador`),
  cancel: action(service.cancelBatch, 'cancel', (b) => `Lote ${b.batch_number} anulado`),
};
