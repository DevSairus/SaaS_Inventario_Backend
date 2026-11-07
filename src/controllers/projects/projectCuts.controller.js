// backend/src/controllers/projects/projectCuts.controller.js
//
// Cortes de obra y facturación parcial. Lógica en
// services/projects/projectCuts.service.js. Base: /api/projects/:id/...

const logger = require('../../config/logger');
const audit = require('../../utils/audit');
const { Tenant } = require('../../models');
const projectsService = require('../../services/projects/projects.service');
const svc = require('../../services/projects/projectCuts.service');
const { generateCutActaPdf } = require('../../services/projects/projectCutActaPdf.service');

const handle = (where, fallback, fn) => async (req, res) => {
  try {
    const project = await projectsService.loadProject(req.user.tenant_id, req.params.id);
    await fn(req, res, project);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
    logger.error(`[project-cuts] ${where}: ${error.message}`, { stack: error.stack });
    return res.status(500).json({ success: false, message: fallback });
  }
};
const logAudit = (req, action, project, changes) => audit({
  tenant_id: req.user.tenant_id, user_id: req.user.id, action, entity: 'project', entity_id: project.id, changes, req,
});

module.exports = {
  billing: handle('billing', 'Error consultando la facturación del proyecto', async (req, res, project) => {
    res.json({ success: true, data: await svc.billingSummary(req.user.tenant_id, project) });
  }),
  preview: handle('preview', 'Error calculando el corte', async (req, res, project) => {
    res.json({ success: true, data: await svc.previewCut(req.user.tenant_id, project, req.body || {}, req.body?.cut_id || null) });
  }),
  create: handle('create', 'Error guardando el corte', async (req, res, project) => {
    const cut = await svc.saveCut(req.user.tenant_id, req.user.id, project, null, req.body || {});
    logAudit(req, 'cut_create', project, { cut_no: cut.cut_no, total: cut.total_amount });
    res.status(201).json({ success: true, message: `Corte ${cut.cut_no} guardado`, data: cut });
  }),
  update: handle('update', 'Error guardando el corte', async (req, res, project) => {
    const cut = await svc.saveCut(req.user.tenant_id, req.user.id, project, req.params.cutId, req.body || {});
    res.json({ success: true, message: `Corte ${cut.cut_no} guardado`, data: cut });
  }),
  remove: handle('remove', 'Error eliminando el corte', async (req, res, project) => {
    const r = await svc.deleteCut(req.user.tenant_id, project, req.params.cutId);
    logAudit(req, r.deleted ? 'cut_delete' : 'cut_cancel', project, { cut_id: req.params.cutId });
    res.json({ success: true, message: r.deleted ? 'Corte eliminado' : 'Corte anulado' });
  }),
  approve: handle('approve', 'Error aprobando el corte', async (req, res, project) => {
    const cut = await svc.approveCut(req.user.tenant_id, req.user.id, project, req.params.cutId, req.body || {});
    logAudit(req, 'cut_approve', project, { cut_no: cut.cut_no, by: cut.approved_by_name });
    res.json({ success: true, message: `Corte ${cut.cut_no} aprobado por ${cut.approved_by_name}` });
  }),
  invoicePayload: handle('invoicePayload', 'Error preparando la factura', async (req, res, project) => {
    res.json({ success: true, data: await svc.invoicePayload(req.user.tenant_id, project, req.params.cutId) });
  }),
  linkDraft: handle('linkDraft', 'Error vinculando la factura', async (req, res, project) => {
    await svc.linkDraft(req.user.tenant_id, project, req.params.cutId, req.body?.sale_id);
    res.json({ success: true });
  }),
  finalize: handle('finalize', 'Error cerrando la facturación del corte', async (req, res, project) => {
    const cut = await svc.finalizeInvoice(req.user.tenant_id, req.user.id, project, req.params.cutId);
    logAudit(req, 'cut_invoiced', project, { cut_no: cut.cut_no, sale_id: cut.sale_id, total: cut.total_amount });
    res.json({ success: true, message: `Corte ${cut.cut_no} facturado`, data: cut });
  }),
  releaseRetention: handle('releaseRetention', 'Error liberando la retención', async (req, res, project) => {
    const r = await svc.releaseRetention(req.user.tenant_id, req.user.id, project);
    logAudit(req, 'retention_release', project, r);
    res.json({ success: true, message: `Retención de garantía liberada: ${r.invoices} factura(s), $ ${Math.round(r.amount).toLocaleString('es-CO')} ya se pueden cobrar`, data: r });
  }),
  acta: handle('acta', 'Error generando el acta', async (req, res, project) => {
    const data = await svc.getCutForActa(req.user.tenant_id, project, req.params.cutId);
    const tenant = await Tenant.findByPk(req.user.tenant_id, { attributes: ['company_name', 'tax_id', 'logo_url', 'primary_color'] });
    const pdf = await generateCutActaPdf({ ...data, project, tenant: tenant.toJSON() });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="acta-corte-${project.code}-${data.cut.cut_no}.pdf"`);
    res.send(pdf);
  }),
};
