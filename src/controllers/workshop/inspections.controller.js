// backend/src/controllers/workshop/inspections.controller.js
//
// Peritajes vehiculares. La lógica vive en services/workshop/inspections.service.js.
// Base: /api/workshop/inspections (permisos en routes/workshop/inspections.routes.js).
// El endpoint público de verificación (/api/public/inspections/:token) está
// al final y no usa req.user.

const logger = require('../../config/logger');
const audit = require('../../utils/audit');
const { Tenant, VehicleInspection, Vehicle, User, VehicleRuntSnapshot, VehicleInspectionItem } = require('../../models');
const svc = require('../../services/workshop/inspections.service');
const { generateInspectionPdfBuffer } = require('../../services/workshop/inspectionPdf.service');
const { BODY_ZONES, DAMAGE_TYPES, DAMAGE_SEVERITIES, REPAINT_MICRONS, FILLER_MICRONS, CONCEPTS } = require('../../constants/inspectionTemplates');
const { runWithTenantSchema } = require('../../config/tenantContext');
const { resolveRecordSchemaByToken } = require('../../utils/publicTokenResolver');
const { deliverWhatsApp, waResponse } = require('../../services/whatsappDelivery');
const { eventTemplate } = require('../../services/waEventTemplates');

const verifyUrlFor = (token) => `${process.env.FRONTEND_URL || 'https://tu-app.vercel.app'}/peritaje/${token}`;

const handler = (where, fallback, fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
    logger.error(`[inspections] ${where}: ${error.message}`, { stack: error.stack });
    return res.status(500).json({ success: false, message: fallback });
  }
};

const logAudit = (req, action, entityId, changes) => {
  audit({ tenant_id: req.user.tenant_id, user_id: req.user.id, action, entity: 'vehicle_inspection', entity_id: entityId, changes, req });
};

const withUrl = (insp) => {
  const json = insp.toJSON ? insp.toJSON() : insp;
  return { ...json, verify_url: json.status !== 'draft' ? verifyUrlFor(json.verify_token) : null };
};

// ── Catálogos ──
const meta = handler('meta', 'Error cargando datos del peritaje', async (req, res) => {
  res.json({
    success: true,
    data: {
      body_zones: BODY_ZONES, damage_types: DAMAGE_TYPES, damage_severities: DAMAGE_SEVERITIES,
      repaint_microns: REPAINT_MICRONS, filler_microns: FILLER_MICRONS, concepts: CONCEPTS,
      requester_types: VehicleInspection.REQUESTER_TYPES, purposes: VehicleInspection.PURPOSES,
    },
  });
});

// ── Plantillas ──
const listTemplates = handler('listTemplates', 'Error cargando plantillas', async (req, res) => {
  res.json({ success: true, data: await svc.listTemplates(req.user.tenant_id, { includeInactive: req.query.all === '1' }) });
});
const createTemplate = handler('createTemplate', 'Error creando la plantilla', async (req, res) => {
  const t = await svc.createTemplate(req.user.tenant_id, req.user.id, req.body);
  logAudit(req, 'create_template', t.id, { name: t.name });
  res.status(201).json({ success: true, data: t });
});
const updateTemplate = handler('updateTemplate', 'Error guardando la plantilla', async (req, res) => {
  const t = await svc.updateTemplate(req.user.tenant_id, req.params.id, req.body);
  logAudit(req, 'update_template', t.id, { name: t.name });
  res.json({ success: true, data: t });
});

// ── Peritajes ──
const list = handler('list', 'Error listando peritajes', async (req, res) => {
  const out = await svc.listInspections(req.user.tenant_id, req.query);
  res.json({ success: true, ...out });
});
const getById = handler('getById', 'Error cargando el peritaje', async (req, res) => {
  res.json({ success: true, data: withUrl(await svc.getInspection(req.user.tenant_id, req.params.id)) });
});
const create = handler('create', 'Error creando el peritaje', async (req, res) => {
  const insp = await svc.createInspection(req.user.tenant_id, req.user.id, req.body);
  logAudit(req, 'create', insp.id, { number: insp.number });
  res.status(201).json({ success: true, data: withUrl(await svc.getInspection(req.user.tenant_id, insp.id)) });
});
const update = handler('update', 'Error guardando el peritaje', async (req, res) => {
  const insp = await svc.updateInspection(req.user.tenant_id, req.params.id, req.body);
  res.json({ success: true, data: withUrl(insp) });
});
const finalize = handler('finalize', 'Error finalizando el peritaje', async (req, res) => {
  const insp = await svc.finalizeInspection(req.user.tenant_id, req.params.id, req.user.id, req.body || {});
  logAudit(req, 'finalize', insp.id, { number: insp.number, score: insp.score, concept: insp.concept });
  res.json({ success: true, message: `Peritaje ${insp.number} finalizado`, data: withUrl(insp) });
});
const cancel = handler('cancel', 'Error anulando el peritaje', async (req, res) => {
  const insp = await svc.cancelInspection(req.user.tenant_id, req.params.id, req.user.id, req.body?.reason);
  logAudit(req, 'cancel', insp.id, { number: insp.number, reason: insp.cancel_reason });
  res.json({ success: true, message: `Peritaje ${insp.number} anulado`, data: withUrl(insp) });
});
const remove = handler('remove', 'Error eliminando el peritaje', async (req, res) => {
  await svc.deleteDraft(req.user.tenant_id, req.params.id);
  logAudit(req, 'delete', req.params.id, {});
  res.json({ success: true, message: 'Borrador eliminado' });
});
const uploadPhotos = handler('uploadPhotos', 'Error subiendo fotos', async (req, res) => {
  const added = await svc.uploadPhotos(req.user.tenant_id, req.params.id, req.files, { itemId: req.query.item_id || null });
  res.json({ success: true, message: `${added.length} foto(s) subida(s)`, data: added });
});

const pdf = handler('pdf', 'Error generando el PDF', async (req, res) => {
  const inspection = await svc.getInspection(req.user.tenant_id, req.params.id);
  const tenant = await Tenant.findByPk(req.user.tenant_id);
  const buffer = await generateInspectionPdfBuffer({ inspection: inspection.toJSON(), tenant: tenant?.toJSON() || {}, verifyUrl: verifyUrlFor(inspection.verify_token) });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${inspection.number}.pdf"`);
  res.send(buffer);
});

// ── Facturación ──
const billingDefaults = handler('billingDefaults', 'Error cargando datos de facturación', async (req, res) => {
  res.json({ success: true, data: await svc.billingDefaults(req.user.tenant_id, req.params.id) });
});
const createSale = handler('createSale', 'Error creando la venta del peritaje', async (req, res) => {
  const out = await svc.createSaleForInspection(req, req.params.id, req.body || {});
  logAudit(req, 'create_sale', req.params.id, out);
  res.status(201).json({ success: true, message: 'Venta creada en borrador; confírmala como factura o remisión', data: out });
});

// ── WhatsApp ──
// Envía el enlace de verificación (con el PDF descargable) al solicitante.
// WhatsApp Cloud API con la plantilla "Certificado de peritaje" si la empresa
// la configuró; si no, enlace wa.me para que el usuario lo envíe.
const sendWhatsApp = handler('sendWhatsApp', 'Error enviando el certificado por WhatsApp', async (req, res) => {
  const tenantId = req.user.tenant_id;
  const insp = await VehicleInspection.findOne({
    where: { id: req.params.id, tenant_id: tenantId },
    include: [{ model: Vehicle, as: 'vehicle', attributes: ['plate'] }],
  });
  if (!insp) return res.status(404).json({ success: false, message: 'Peritaje no encontrado' });
  if (insp.status !== 'finalized') return res.status(400).json({ success: false, message: 'Solo se envía un peritaje finalizado' });

  const { normalizeWhatsAppPhone } = require('../../utils/customerWhatsappPhone');
  const recipient = await svc.certificateRecipient(tenantId, insp);
  const phone = req.body?.phone ? normalizeWhatsAppPhone(req.body.phone) : recipient.phone;
  if (!phone) return res.status(400).json({ success: false, message: 'El solicitante no tiene teléfono; escríbelo para enviar el certificado.' });

  const url = verifyUrlFor(insp.verify_token);
  const CONCEPT_TXT = { aprobado: 'Aprobado', aprobado_observaciones: 'Aprobado con observaciones', no_recomendado: 'No recomendado' };
  const firstName = String(recipient.name || '').trim().split(/\s+/)[0];
  const message = `${firstName ? `Hola ${firstName}!` : 'Hola!'} Te compartimos el certificado del peritaje *${insp.number}* del vehículo *${insp.vehicle?.plate || ''}*`
    + ` (concepto: ${CONCEPT_TXT[insp.concept] || '—'}, puntaje ${Number(insp.score).toLocaleString('es-CO')}/100).`
    + `\nAquí puedes verlo, verificarlo y descargar el PDF:\n${url}`;
  const tenant = await Tenant.findByPk(tenantId, { attributes: ['id', 'business_config'] });
  const template = eventTemplate(tenant, 'inspection_certificate', [firstName || 'cliente', insp.number, insp.vehicle?.plate || ''], insp.verify_token);
  const sent = await deliverWhatsApp({ tenantId, to: phone, body: message, template, userId: req.user.id });
  logAudit(req, 'send_whatsapp', insp.id, { channel: sent.channel });
  res.json({ success: true, ...waResponse(sent), verify_url: url });
});

// ── Público: verificación del certificado ─────────────────────────────
// Cualquiera con el QR del certificado puede verlo. Muestra el resultado
// técnico completo (es lo que certifica) pero NO los datos del solicitante
// ni del propietario, ni el precio.
async function loadPublicInspection(token) {
  const resolved = await resolveRecordSchemaByToken({ table: 'vehicle_inspections', column: 'verify_token', token });
  if (!resolved) return null;
  return runWithTenantSchema(resolved.schemaName, async () => {
    const insp = await VehicleInspection.findByPk(resolved.id, {
      include: [
        { model: Vehicle, as: 'vehicle', attributes: ['plate', 'brand', 'model', 'year', 'color', 'vehicle_type', 'vin', 'engine', 'engine_number'] },
        { model: User, as: 'inspector', attributes: ['first_name', 'last_name'] },
        { model: VehicleRuntSnapshot, as: 'runt_snapshot', attributes: ['consulted_at', 'estado', 'has_liens', 'has_pledges', 'soat_expiry', 'tecnomecanica_expiry'] },
        { model: VehicleInspectionItem, as: 'items', attributes: ['section_key', 'item_key', 'label', 'kind', 'unit', 'critical', 'sort_order', 'rating', 'measure', 'notes', 'photos'] },
      ],
      order: [[{ model: VehicleInspectionItem, as: 'items' }, 'sort_order', 'ASC']],
    });
    if (!insp || insp.status === 'draft') return null;
    const tenant = await Tenant.findByPk(insp.tenant_id, { attributes: ['company_name', 'tax_id', 'phone', 'email', 'address', 'logo_url', 'primary_color'] });
    return { insp, tenant };
  });
}

const PUBLIC_FIELDS = ['number', 'status', 'inspected_at', 'finalized_at', 'cancelled_at', 'mileage', 'meter_unit', 'score', 'concept',
  'section_scores', 'template_snapshot', 'template_name', 'conclusion', 'recommendations', 'body_marks', 'paint_readings', 'identity',
  'photos', 'requester_type', 'purpose'];

const publicVerify = async (req, res) => {
  try {
    const found = await loadPublicInspection(req.params.token);
    if (!found) return res.status(404).json({ success: false, message: 'Certificado no encontrado' });
    const { insp, tenant } = found;
    const data = {};
    for (const k of PUBLIC_FIELDS) data[k] = insp[k];
    const v = insp.vehicle?.toJSON() || {};
    // VIN y motor parcialmente ocultos: confirman la identidad sin publicarlos completos.
    const mask = (s) => (s && s.length > 6 ? `${'•'.repeat(s.length - 6)}${s.slice(-6)}` : s);
    data.vehicle = { ...v, vin: mask(v.vin), engine_number: mask(v.engine_number) };
    data.identity = { ...(insp.identity || {}), vin_expected: mask(insp.identity?.vin_expected), vin_read: mask(insp.identity?.vin_read),
      engine_expected: mask(insp.identity?.engine_expected), engine_read: mask(insp.identity?.engine_read) };
    data.inspector = insp.inspector ? `${insp.inspector.first_name || ''} ${(insp.inspector.last_name || '').slice(0, 1)}.`.trim() : null;
    data.runt = insp.runt_snapshot || null;
    data.items = insp.items;
    data.workshop = tenant ? { name: tenant.company_name, tax_id: tenant.tax_id, phone: tenant.phone, email: tenant.email, address: tenant.address, logo_url: tenant.logo_url, primary_color: tenant.primary_color || '#2563eb' } : null;
    res.json({ success: true, data });
  } catch (error) {
    logger.error('[inspections] publicVerify:', error);
    res.status(500).json({ success: false, message: 'Error consultando el certificado' });
  }
};

const publicPdf = async (req, res) => {
  try {
    const found = await loadPublicInspection(req.params.token);
    if (!found) return res.status(404).json({ success: false, message: 'Certificado no encontrado' });
    const { insp, tenant } = found;
    const json = insp.toJSON();
    // Mismo PDF, sin datos del solicitante.
    json.requester_name = null;
    json.requester_document = null;
    const buffer = await generateInspectionPdfBuffer({ inspection: json, tenant: tenant?.toJSON() || {}, verifyUrl: verifyUrlFor(req.params.token) });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${insp.number}.pdf"`);
    res.send(buffer);
  } catch (error) {
    logger.error('[inspections] publicPdf:', error);
    res.status(500).json({ success: false, message: 'Error generando el certificado' });
  }
};

module.exports = {
  meta, listTemplates, createTemplate, updateTemplate,
  list, getById, create, update, finalize, cancel, remove, uploadPhotos, pdf,
  billingDefaults, createSale, sendWhatsApp,
  publicVerify, publicPdf,
};
