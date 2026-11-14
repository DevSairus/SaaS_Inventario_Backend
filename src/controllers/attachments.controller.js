// backend/src/controllers/attachments.controller.js
//
// Adjuntos de documentos ("cero papel"). Base: /api/attachments
//   GET    /?entity_type=&entity_id=   lista
//   POST   /  (multipart: file, entity_type, entity_id, kind?, description?)
//   GET    /:id/download               el archivo (pasa por el backend: nunca
//                                       se entrega una URL pública)
//   DELETE /:id                        con 'attachments.delete', o quien lo
//                                       subió durante las primeras 24 h

const { Attachment, User } = require('../models');
const audit = require('../utils/audit');
const { can } = require('../services/tenantPermissions.service');
const { storeAttachment, readAttachment, removeAttachment } = require('../services/attachments/attachmentStorage');

// Roles con acceso a los documentos de proveedores (mismos que escriben proveedores
// en routes/inventory/suppliers.routes.js): el RUT puede traer datos personales.
const SUPPLIER_DOC_ROLES = ['admin', 'manager', 'warehouse_keeper', 'accountant', 'super_admin'];

// Documentos que admiten adjuntos: modelo + permiso extra para verlos (los
// gastos solo los ve quien ve gastos).
const ENTITIES = {
  purchase: { model: 'Purchase', label: 'compra' },
  expense: { model: 'Expense', label: 'gasto', readPermission: 'expenses.write' },
  transfer: { model: 'Transfer', label: 'traslado' },
  project: { model: 'Project', label: 'proyecto' },
  tool: { model: 'Tool', label: 'herramienta' },
  sale: { model: 'Sale', label: 'venta' },
  payment_batch: { model: 'PaymentBatch', label: 'lote de pago', readPermission: 'payments.schedule' },
  supplier: { model: 'Supplier', label: 'proveedor', roles: SUPPLIER_DOC_ROLES },
};
const OWN_DELETE_WINDOW_MS = 24 * 60 * 60 * 1000;

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const sendError = (res, error, fallback) => {
  if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
  console.error('[attachments]', error);
  return res.status(500).json({ success: false, message: fallback });
};

async function assertEntity(req, entityType, entityId) {
  const def = ENTITIES[entityType];
  if (!def) throw httpError(400, 'Tipo de documento no admite adjuntos');
  if (!/^[0-9a-f-]{36}$/i.test(String(entityId || ''))) throw httpError(400, 'Documento inválido');
  if (def.roles && !def.roles.includes(req.user.role)) {
    throw httpError(403, `No tienes acceso a los adjuntos de este ${def.label}`);
  }
  if (def.readPermission && !(await can(req.user.tenant_id, req.user.role, def.readPermission))) {
    throw httpError(403, `No tienes acceso a los adjuntos de este ${def.label}`);
  }
  const Model = require('../models')[def.model];
  if (!Model) throw httpError(400, 'Tipo de documento no disponible');
  const exists = await Model.count({ where: { id: entityId, tenant_id: req.user.tenant_id } });
  if (!exists) throw httpError(404, `No se encontró el ${def.label}`);
}

// 'YYYY-MM-DD' real (rechaza 2026-02-31) o null si viene vacío; lanza 400 si es inválida.
const parseValidUntil = (value) => {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T00:00:00Z`) : null;
  if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw httpError(400, 'La fecha de vigencia no es válida (use AAAA-MM-DD)');
  }
  return text;
};
const todayISO = () => new Date().toISOString().slice(0, 10);

const serialize = (a) => ({
  id: a.id, entity_type: a.entity_type, entity_id: a.entity_id, kind: a.kind, description: a.description,
  valid_until: a.valid_until || null,
  is_expired: !!a.valid_until && a.valid_until < todayISO(),
  file_name: a.file_name, mime_type: a.mime_type, size_bytes: a.size_bytes, created_at: a.created_at,
  uploaded_by: a.uploaded_by,
  uploader: a.uploader ? { id: a.uploader.id, name: [a.uploader.first_name, a.uploader.last_name].filter(Boolean).join(' ') || a.uploader.email } : null,
});

const list = async (req, res) => {
  try {
    const { entity_type, entity_id } = req.query;
    await assertEntity(req, entity_type, entity_id);
    const rows = await Attachment.findAll({
      where: { tenant_id: req.user.tenant_id, entity_type, entity_id },
      include: [{ model: User, as: 'uploader', attributes: ['id', 'first_name', 'last_name', 'email'] }],
      order: [['created_at', 'DESC']],
    });
    res.json({ success: true, data: rows.map(serialize) });
  } catch (error) {
    sendError(res, error, 'Error al obtener los adjuntos');
  }
};

const upload = async (req, res) => {
  try {
    if (!req.file) throw httpError(400, 'Selecciona un archivo');
    const { entity_type, entity_id } = req.body || {};
    await assertEntity(req, entity_type, entity_id);
    await assertWritable(req, entity_type, entity_id);
    const kind = Attachment.KINDS.includes(req.body.kind) ? req.body.kind : 'other';
    // La vigencia solo aplica a la Cámara de Comercio; en otros tipos se ignora.
    const validUntil = kind === 'chamber_of_commerce' ? parseValidUntil(req.body.valid_until) : null;
    const stored = await storeAttachment({ tenantId: req.user.tenant_id, file: req.file });
    const att = await Attachment.create({
      ...stored,
      tenant_id: req.user.tenant_id,
      entity_type,
      entity_id,
      kind,
      description: String(req.body.description || '').trim().slice(0, 255) || null,
      valid_until: validUntil,
      uploaded_by: req.user.id,
    });
    audit({ tenant_id: req.user.tenant_id, user_id: req.user.id, action: 'attach', entity: entity_type, entity_id, changes: { file: att.file_name, kind, valid_until: validUntil }, req });
    res.status(201).json({ success: true, message: 'Archivo adjuntado', data: serialize(att) });
  } catch (error) {
    sendError(res, error, 'Error al adjuntar el archivo');
  }
};

// Un traslado cerrado queda congelado: no se le agregan ni quitan soportes.
async function assertWritable(req, entityType, entityId) {
  if (entityType !== 'transfer') return;
  const t = await require('../models').Transfer.findOne({ where: { id: entityId, tenant_id: req.user.tenant_id }, attributes: ['status'] });
  if (t?.status === 'closed') throw httpError(400, 'El traslado está cerrado: sus soportes ya no se modifican');
}

async function loadOwned(req) {
  const att = await Attachment.findOne({ where: { id: req.params.id, tenant_id: req.user.tenant_id } });
  if (!att) throw httpError(404, 'Adjunto no encontrado');
  await assertEntity(req, att.entity_type, att.entity_id);
  return att;
}

const download = async (req, res) => {
  try {
    const att = await loadOwned(req);
    const file = await readAttachment(att);
    const name = encodeURIComponent(att.file_name);
    res.setHeader('Content-Type', att.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `${req.query.inline === '1' ? 'inline' : 'attachment'}; filename*=UTF-8''${name}`);
    res.setHeader('Cache-Control', 'private, no-store');
    if (file.localPath) return res.sendFile(file.localPath);
    return res.send(file.buffer);
  } catch (error) {
    sendError(res, error, 'Error al descargar el adjunto');
  }
};

const remove = async (req, res) => {
  try {
    const att = await loadOwned(req);
    await assertWritable(req, att.entity_type, att.entity_id);
    const own = att.uploaded_by === req.user.id && Date.now() - new Date(att.created_at).getTime() < OWN_DELETE_WINDOW_MS;
    if (!own && !(await can(req.user.tenant_id, req.user.role, 'attachments.delete'))) {
      throw httpError(403, 'No tienes permiso para eliminar adjuntos (solo puedes quitar los tuyos durante las primeras 24 horas)');
    }
    await att.destroy();
    await removeAttachment(att);
    audit({ tenant_id: req.user.tenant_id, user_id: req.user.id, action: 'detach', entity: att.entity_type, entity_id: att.entity_id, changes: { file: att.file_name }, req });
    res.json({ success: true, message: 'Adjunto eliminado' });
  } catch (error) {
    sendError(res, error, 'Error al eliminar el adjunto');
  }
};

module.exports = { list, upload, download, remove, ENTITIES, parseValidUntil };
