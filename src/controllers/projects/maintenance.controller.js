// backend/src/controllers/projects/maintenance.controller.js
//
// Mantenimientos recurrentes (Fase 4, req. 1.3). Lógica en
// services/projects/maintenance.service.js. Base: /api/projects/...

const logger = require('../../config/logger');
const audit = require('../../utils/audit');
const { Tenant } = require('../../models');
const projectsService = require('../../services/projects/projects.service');
const svc = require('../../services/projects/maintenance.service');
const { generateMaintenanceVisitPdf } = require('../../services/projects/maintenanceVisitPdf.service');

const handle = (where, fallback, fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
    logger.error(`[maintenance] ${where}: ${error.message}`, { stack: error.stack });
    return res.status(500).json({ success: false, message: fallback });
  }
};
const tid = (req) => req.user.tenant_id;
const logAudit = (req, action, entityId, changes) => audit({
  tenant_id: tid(req), user_id: req.user.id, action, entity: 'maintenance', entity_id: entityId, changes, req,
});

module.exports = {
  // Instalaciones (con o sin proyecto de Pitbox)
  listInstallations: handle('listInstallations', 'Error consultando las instalaciones', async (req, res) => {
    res.json({ success: true, data: await svc.listInstallations(tid(req), req.query) });
  }),
  createInstallation: handle('createInstallation', 'Error creando la instalación', async (req, res) => {
    const inst = await svc.createInstallation(tid(req), req.user.id, req.body || {});
    logAudit(req, 'maintenance_installation_create', inst.id, { name: inst.name, customer_id: inst.customer_id });
    res.status(201).json({ success: true, message: `Instalación ${inst.name} creada`, data: inst });
  }),
  updateInstallation: handle('updateInstallation', 'Error actualizando la instalación', async (req, res) => {
    const inst = await svc.updateInstallation(tid(req), req.params.installationId, req.body || {});
    res.json({ success: true, message: 'Instalación actualizada', data: inst });
  }),
  installationDetail: handle('installationDetail', 'Error consultando la instalación', async (req, res) => {
    res.json({ success: true, data: await svc.installationDetail(tid(req), req.params.installationId) });
  }),
  importInstallations: handle('importInstallations', 'Error importando las instalaciones', async (req, res) => {
    const r = await svc.importInstallations(tid(req), req.user.id, req.body?.rows, { dryRun: req.body?.dry_run !== false });
    if (!r.dry_run) logAudit(req, 'maintenance_import', null, r.summary);
    res.json({
      success: true,
      message: r.dry_run ? 'Archivo revisado' : `Importadas ${r.summary.new_installations} instalación(es) y ${r.summary.plans} plan(es)`,
      data: r,
    });
  }),
  createEquipment: handle('createEquipment', 'Error registrando el equipo', async (req, res) => {
    const eq = await svc.createEquipment(tid(req), req.params.installationId, req.body || {});
    res.status(201).json({ success: true, message: 'Equipo registrado', data: eq });
  }),
  updateEquipment: handle('updateEquipment', 'Error actualizando el equipo', async (req, res) => {
    const eq = await svc.updateEquipment(tid(req), req.params.installationId, req.params.equipmentId, req.body || {});
    res.json({ success: true, message: 'Equipo actualizado', data: eq });
  }),
  createPlan: handle('createPlan', 'Error creando el plan', async (req, res) => {
    const plan = await svc.createPlan(tid(req), req.user.id, req.params.installationId, req.body || {});
    logAudit(req, 'maintenance_plan_create', plan.id, { name: plan.name, frequency_months: plan.frequency_months });
    res.status(201).json({ success: true, message: 'Plan creado y primera visita programada', data: plan });
  }),

  // Desde un proyecto de Pitbox
  projectInstallation: handle('projectInstallation', 'Error consultando el mantenimiento', async (req, res) => {
    const project = await projectsService.loadProject(tid(req), req.params.id);
    const inst = await svc.installationOfProject(tid(req), project.id);
    res.json({ success: true, data: inst ? await svc.installationDetail(tid(req), inst.id) : null });
  }),
  activateProject: handle('activateProject', 'Error activando el mantenimiento', async (req, res) => {
    const project = await projectsService.loadProject(tid(req), req.params.id);
    const inst = await svc.installationFromProject(tid(req), req.user.id, project);
    res.status(201).json({ success: true, message: 'Mantenimiento activado para la instalación del proyecto', data: await svc.installationDetail(tid(req), inst.id) });
  }),

  // Agenda, planes y visitas
  agenda: handle('agenda', 'Error consultando la agenda', async (req, res) => {
    res.json({ success: true, data: await svc.agenda(tid(req), req.query) });
  }),
  updatePlan: handle('updatePlan', 'Error actualizando el plan', async (req, res) => {
    const plan = await svc.updatePlan(tid(req), req.user.id, req.params.planId, req.body || {});
    logAudit(req, 'maintenance_plan_update', plan.id, req.body || {});
    res.json({ success: true, message: 'Plan actualizado', data: plan });
  }),
  rescheduleVisit: handle('rescheduleVisit', 'Error reprogramando la visita', async (req, res) => {
    const visit = await svc.rescheduleVisit(tid(req), req.params.visitId, req.body || {});
    res.json({ success: true, message: `Visita ${visit.visit_no} reprogramada`, data: visit });
  }),
  completeVisit: handle('completeVisit', 'Error cerrando la visita', async (req, res) => {
    const { visit, next } = await svc.completeVisit(tid(req), req.user.id, req.params.visitId, req.body || {});
    logAudit(req, 'maintenance_visit_done', visit.id, { visit_no: visit.visit_no });
    res.json({ success: true, message: `Visita ${visit.visit_no} cerrada${next ? `; la siguiente queda para el ${next.scheduled_date}` : ''}`, data: { visit_id: visit.id, next } });
  }),
  cancelVisit: handle('cancelVisit', 'Error cancelando la visita', async (req, res) => {
    const { visit, next } = await svc.cancelVisit(tid(req), req.user.id, req.params.visitId, req.body || {});
    logAudit(req, 'maintenance_visit_cancel', visit.id, { visit_no: visit.visit_no, reason: visit.cancel_reason });
    res.json({ success: true, message: `Visita ${visit.visit_no} cancelada${next ? `; la siguiente queda para el ${next.scheduled_date}` : ''}`, data: { visit_id: visit.id, next } });
  }),
  visitPdf: handle('visitPdf', 'Error generando el acta de la visita', async (req, res) => {
    const visit = await svc.getVisitForPdf(tid(req), req.params.visitId);
    const tenant = await Tenant.findByPk(tid(req), { attributes: ['company_name', 'tax_id', 'logo_url', 'primary_color'] });
    const pdf = await generateMaintenanceVisitPdf({ visit, tenant: tenant.toJSON() });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="mantenimiento-${visit.visit_no}.pdf"`);
    res.send(pdf);
  }),
};
