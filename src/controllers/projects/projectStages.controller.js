// backend/src/controllers/projects/projectStages.controller.js
//
// Etapas de obra y actas de despacho (Fase 4, req. 1.2). Lógica en
// services/projects/projectStages.service.js. Base: /api/projects/:id/...

const logger = require('../../config/logger');
const audit = require('../../utils/audit');
const { Tenant } = require('../../models');
const projectsService = require('../../services/projects/projects.service');
const svc = require('../../services/projects/projectStages.service');
const { generateDispatchActaPdf } = require('../../services/projects/projectDispatchActaPdf.service');

const handle = (where, fallback, fn) => async (req, res) => {
  try {
    const project = await projectsService.loadProject(req.user.tenant_id, req.params.id);
    await fn(req, res, project);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
    logger.error(`[project-stages] ${where}: ${error.message}`, { stack: error.stack });
    return res.status(500).json({ success: false, message: fallback });
  }
};
const logAudit = (req, action, project, changes) => audit({
  tenant_id: req.user.tenant_id, user_id: req.user.id, action, entity: 'project', entity_id: project.id, changes, req,
});

module.exports = {
  listStages: handle('listStages', 'Error consultando las etapas', async (req, res, project) => {
    res.json({ success: true, data: await svc.listStages(req.user.tenant_id, project) });
  }),
  createStage: handle('createStage', 'Error creando la etapa', async (req, res, project) => {
    const stage = await svc.createStage(req.user.tenant_id, req.user.id, project, req.body || {});
    logAudit(req, 'stage_create', project, { stage_id: stage.id, name: stage.name });
    res.status(201).json({ success: true, message: `Etapa ${stage.stage_no} creada`, data: await svc.listStages(req.user.tenant_id, project) });
  }),
  updateStage: handle('updateStage', 'Error actualizando la etapa', async (req, res, project) => {
    const stage = await svc.updateStage(req.user.tenant_id, project, req.params.stageId, req.body || {});
    logAudit(req, 'stage_update', project, { stage_id: stage.id });
    res.json({ success: true, message: 'Etapa actualizada', data: await svc.listStages(req.user.tenant_id, project) });
  }),
  deleteStage: handle('deleteStage', 'Error eliminando la etapa', async (req, res, project) => {
    await svc.deleteStage(req.user.tenant_id, project, req.params.stageId);
    logAudit(req, 'stage_delete', project, { stage_id: req.params.stageId });
    res.json({ success: true, message: 'Etapa eliminada', data: await svc.listStages(req.user.tenant_id, project) });
  }),

  listDispatches: handle('listDispatches', 'Error consultando los despachos', async (req, res, project) => {
    res.json({ success: true, data: await svc.listDispatches(req.user.tenant_id, project) });
  }),
  signDispatch: handle('signDispatch', 'Error registrando la firma', async (req, res, project) => {
    const r = await svc.signDispatch(req.user.tenant_id, req.user.id, project, req.params.dispatchId, req.body || {});
    logAudit(req, 'dispatch_sign', project, { dispatch_id: req.params.dispatchId, role: r.role });
    res.status(201).json({ success: true, message: `Firma registrada en ${r.dispatch_no}`, data: await svc.listDispatches(req.user.tenant_id, project) });
  }),
  acta: handle('acta', 'Error generando el acta de despacho', async (req, res, project) => {
    const data = await svc.getDispatchForActa(req.user.tenant_id, project, req.params.dispatchId);
    const tenant = await Tenant.findByPk(req.user.tenant_id, { attributes: ['company_name', 'tax_id', 'logo_url', 'primary_color'] });
    const pdf = await generateDispatchActaPdf({ data, project, tenant: tenant.toJSON() });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="acta-despacho-${data.dispatch.dispatch_no}.pdf"`);
    res.send(pdf);
  }),
};
