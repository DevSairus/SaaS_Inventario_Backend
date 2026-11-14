// backend/src/controllers/projects/projectWorkHours.controller.js
//
// Horarios de obra (Fase 4, req. 1.1): turnos, planilla diaria y
// distribución de horas. Lógica en services/projects/projectWorkHours.service.js.

const logger = require('../../config/logger');
const projectsService = require('../../services/projects/projects.service');
const svc = require('../../services/projects/projectWorkHours.service');

const handle = (where, fallback, fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
    logger.error(`[work-hours] ${where}: ${error.message}`, { stack: error.stack });
    return res.status(500).json({ success: false, message: fallback });
  }
};

module.exports = {
  listShifts: handle('listShifts', 'Error consultando los turnos', async (req, res) => {
    res.json({ success: true, data: await svc.listShifts(req.user.tenant_id, { all: req.query.all === 'true' }) });
  }),
  createShift: handle('createShift', 'Error creando el turno', async (req, res) => {
    res.status(201).json({ success: true, message: 'Turno creado', data: await svc.createShift(req.user.tenant_id, req.body || {}) });
  }),
  updateShift: handle('updateShift', 'Error actualizando el turno', async (req, res) => {
    res.json({ success: true, message: 'Turno actualizado', data: await svc.updateShift(req.user.tenant_id, req.params.shiftId, req.body || {}) });
  }),
  distribution: handle('distribution', 'Error consultando la distribución de horas', async (req, res) => {
    res.json({ success: true, data: await svc.hoursDistribution(req.user.tenant_id, req.query) });
  }),
  saveSheet: handle('saveSheet', 'Error guardando la planilla', async (req, res) => {
    const project = await projectsService.loadProject(req.user.tenant_id, req.params.id);
    const r = await svc.saveDailySheet(req, project, req.body || {});
    res.status(201).json({ success: true, message: `Planilla del ${r.work_date}: ${r.workers} trabajador(es), ${r.hours} h`, data: r });
  }),
  projectDistribution: handle('projectDistribution', 'Error consultando las horas del proyecto', async (req, res) => {
    const project = await projectsService.loadProject(req.user.tenant_id, req.params.id);
    res.json({ success: true, data: await svc.hoursDistribution(req.user.tenant_id, { ...req.query, project_id: project.id }) });
  }),
};
