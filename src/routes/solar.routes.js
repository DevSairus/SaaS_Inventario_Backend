// backend/src/routes/solar.routes.js
//
// Cotizador solar (Fase 3 del módulo Proyectos). Base: /api/solar
// (requireModule('projects') en server.js). Lógica en services/solar/*.
//   Estudios, cotización y PDF: 'solar.quote'. Parámetros: 'solar.configure'.
//   Proyecto desde el estudio: además 'projects.manage'.

const express = require('express');
const multer = require('multer');
const router = express.Router();
const logger = require('../config/logger');
const audit = require('../utils/audit');
const { Tenant } = require('../models');
const { requirePermission } = require('../middleware/requirePermission');
const { keepTenantContext } = require('../middleware/keepTenantContext');
const svc = require('../services/solar/solar.service');
const { generateSolarProposalPdf } = require('../services/solar/solarProposalPdf.service');

const quote = requirePermission('solar.quote');
const configure = requirePermission('solar.configure');

const BILL_MIMES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const uploadBill = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // igual a OCR_MAX_BYTES del servicio OCR
  fileFilter: (req, file, cb) => cb(null, BILL_MIMES.includes(file.mimetype)),
});

const handle = (where, fallback, fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
    logger.error(`[solar] ${where}: ${error.message}`, { stack: error.stack });
    return res.status(500).json({ success: false, message: fallback });
  }
};
const tenantOf = (req) => req.user.tenant_id;

router.get('/settings', quote, handle('getSettings', 'Error consultando los parámetros', async (req, res) => {
  res.json({ success: true, data: await svc.getSettings(tenantOf(req)) });
}));
router.put('/settings', configure, handle('updateSettings', 'Error guardando los parámetros', async (req, res) => {
  const data = await svc.updateSettings(tenantOf(req), req.user.id, req.body || {});
  audit({ tenant_id: tenantOf(req), user_id: req.user.id, action: 'update', entity: 'solar_settings', entity_id: tenantOf(req), changes: req.body, req });
  res.json({ success: true, message: 'Parámetros del cotizador guardados', data });
}));

router.get('/geocode', quote, handle('geocode', 'Error buscando la ubicación', async (req, res) => {
  res.json({ success: true, data: await svc.geocode(req.query.q) });
}));
router.get('/irradiance', quote, handle('irradiance', 'Error consultando la radiación', async (req, res) => {
  res.json({ success: true, data: await svc.irradiance(req.query.lat, req.query.lon) });
}));
router.post('/ocr', quote, keepTenantContext(uploadBill.single('file')), handle('ocr', 'Error leyendo la factura', async (req, res) => {
  res.json({ success: true, data: await svc.ocrBill(tenantOf(req), req.file) });
}));

// Cálculo sin guardar (vista previa mientras se llena el estudio).
router.post('/calculate', quote, handle('calculate', 'Error calculando el sistema', async (req, res) => {
  const { results, warnings } = await svc.computeStudy(tenantOf(req), req.body || {});
  res.json({ success: true, data: { results, warnings } });
}));

router.get('/studies', quote, handle('list', 'Error listando estudios', async (req, res) => {
  res.json({ success: true, data: await svc.listStudies(tenantOf(req), req.query) });
}));
router.post('/studies', quote, handle('create', 'Error guardando el estudio', async (req, res) => {
  const study = await svc.saveStudy(tenantOf(req), req.user.id, null, req.body || {});
  res.status(201).json({ success: true, message: `Estudio ${study.number} guardado`, data: study });
}));
router.get('/studies/:id', quote, handle('get', 'Error consultando el estudio', async (req, res) => {
  const study = await svc.getStudy(tenantOf(req), req.params.id);
  const { warnings } = await svc.computeStudy(tenantOf(req), {
    ...study.inputs, monthly_kwh: study.monthly_kwh, tariff_kwh: study.tariff_kwh, hsp: study.hsp, hsp_monthly: study.hsp_monthly,
  }).catch(() => ({ warnings: [] }));
  res.json({ success: true, data: { ...study.toJSON(), warnings } });
}));
router.put('/studies/:id', quote, handle('update', 'Error guardando el estudio', async (req, res) => {
  const study = await svc.saveStudy(tenantOf(req), req.user.id, req.params.id, req.body || {});
  res.json({ success: true, message: `Estudio ${study.number} guardado`, data: study });
}));
router.get('/studies/:id/quote-payload', quote, handle('quotePayload', 'Error preparando la cotización', async (req, res) => {
  res.json({ success: true, data: await svc.quotePayload(tenantOf(req), req.params.id) });
}));
router.post('/studies/:id/link-quote', quote, handle('linkQuote', 'Error vinculando la cotización', async (req, res) => {
  const study = await svc.linkQuote(tenantOf(req), req.params.id, req.body?.quote_id);
  res.json({ success: true, data: study });
}));
router.post('/studies/:id/project', quote, requirePermission('projects.manage'), handle('project', 'Error creando el proyecto', async (req, res) => {
  const r = await svc.createProjectFromStudy(req, req.params.id);
  audit({ tenant_id: tenantOf(req), user_id: req.user.id, action: 'create_from_solar', entity: 'project', entity_id: r.project.id, changes: { study: req.params.id }, req });
  res.status(201).json({ success: true, message: `Proyecto ${r.project.code} creado con ${r.bom_lines} línea(s) de materiales y su presupuesto`, data: { id: r.project.id, code: r.project.code, budget: r.budget } });
}));
router.get('/studies/:id/pdf', quote, handle('pdf', 'Error generando la propuesta', async (req, res) => {
  const study = await svc.getStudy(tenantOf(req), req.params.id);
  const [tenant, settings] = await Promise.all([
    Tenant.findByPk(tenantOf(req), { attributes: ['company_name', 'tax_id', 'phone', 'email', 'logo_url', 'primary_color'] }),
    svc.getSettings(tenantOf(req)),
  ]);
  const pdf = await generateSolarProposalPdf(study.toJSON(), tenant.toJSON(), settings);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="propuesta-${study.number}.pdf"`);
  res.send(pdf);
}));

// Interesados captados por el simulador público.
const LEAD_STATUSES = ['new', 'contacted', 'quoted', 'won', 'discarded'];
router.get('/leads', quote, handle('leads', 'Error listando interesados', async (req, res) => {
  const { SolarLead, SolarStudy, Customer } = require('../models');
  const where = { tenant_id: tenantOf(req) };
  if (LEAD_STATUSES.includes(req.query.status)) where.status = req.query.status;
  const rows = await SolarLead.findAll({
    where,
    attributes: { exclude: ['consent_text', 'user_agent'] },
    include: [
      { model: SolarStudy, as: 'study', attributes: ['id', 'number', 'status', 'quote_id', 'project_id'] },
      { model: Customer, as: 'customer', attributes: ['id', 'first_name', 'last_name', 'business_name'] },
    ],
    order: [['created_at', 'DESC']],
    limit: 300,
  });
  res.json({ success: true, data: rows });
}));
router.put('/leads/:leadId', quote, handle('updateLead', 'Error actualizando el interesado', async (req, res) => {
  const { SolarLead } = require('../models');
  const lead = await SolarLead.findOne({ where: { id: req.params.leadId, tenant_id: tenantOf(req) } });
  if (!lead) return res.status(404).json({ success: false, message: 'Interesado no encontrado' });
  const data = {};
  if (req.body?.status !== undefined) {
    if (!LEAD_STATUSES.includes(req.body.status)) return res.status(400).json({ success: false, message: 'Estado inválido' });
    data.status = req.body.status;
  }
  if (req.body?.notes !== undefined) data.notes = String(req.body.notes || '').trim().slice(0, 5000) || null;
  await lead.update(data);
  res.json({ success: true, message: 'Interesado actualizado', data: lead });
}));

module.exports = router;
