// backend/src/controllers/workshop/laborTimes.controller.js
// Tempario (tiempos y tarifas de mano de obra) y productividad de técnicos —
// ver services/workshop/laborTimes.service.js.
const svc = require('../../services/workshop/laborTimes.service');

const tenantOf = (req) => req.tenant_id || req.user?.tenant_id;

const handle = (fn, label) => async (req, res) => {
  try {
    const data = await fn(req, res);
    if (data !== undefined) res.json({ success: true, data });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
    console.error(`[tempario] ${label}:`, error);
    res.status(500).json({ success: false, message: `Error en ${label}` });
  }
};

const sendXlsx = (res, buffer, filename) => {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(Buffer.from(buffer));
};

module.exports = {
  getSettings: handle((req) => svc.laborSettings(tenantOf(req)), 'configuración del tempario'),
  saveSettings: handle((req) => svc.saveSettings(tenantOf(req), req.body), 'guardar configuración del tempario'),

  listServices: handle((req) => svc.listServices(tenantOf(req), req.query), 'listar tempario'),
  updateService: handle((req) => svc.updateService(tenantOf(req), req.params.id, req.body), 'actualizar servicio del tempario'),

  template: handle(async (req, res) => { sendXlsx(res, await svc.buildTemplate(), 'Plantilla_Tempario_Pitbox.xlsx'); }, 'plantilla del tempario'),
  exportServices: handle(async (req, res) => { sendXlsx(res, await svc.exportServices(tenantOf(req)), 'Tempario.xlsx'); }, 'exportar tempario'),
  importServices: handle((req) => {
    if (!req.file) throw Object.assign(new Error('Adjunta el archivo Excel'), { statusCode: 400 });
    const flag = (name) => req.query[name] === 'true' || req.body?.[name] === 'true';
    return svc.importServices(tenantOf(req), req.file.buffer, { dryRun: flag('dry_run'), updateExisting: flag('update_existing') });
  }, 'importar tempario'),

  listSchedules: handle((req) => svc.listSchedules(tenantOf(req)), 'jornadas'),
  saveSchedule: handle((req) => svc.saveSchedule(tenantOf(req), req.params.userId, req.body), 'guardar jornada'),
  listAbsences: handle((req) => svc.listAbsences(tenantOf(req), req.query), 'ausencias'),
  createAbsence: handle((req) => svc.createAbsence(tenantOf(req), req.body, req.user?.id), 'registrar ausencia'),
  deleteAbsence: handle(async (req) => { await svc.deleteAbsence(tenantOf(req), req.params.id); return { deleted: true }; }, 'eliminar ausencia'),

  productivity: handle((req) => svc.productivity(tenantOf(req), req.query), 'productividad'),
  productivityDetail: handle((req) => svc.productivityDetail(tenantOf(req), req.params.userId, req.query), 'detalle de productividad'),
};
