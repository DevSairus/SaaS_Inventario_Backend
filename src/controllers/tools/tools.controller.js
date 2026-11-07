// backend/src/controllers/tools/tools.controller.js
//
// Herramientas (Fase 3 del módulo Proyectos). La lógica vive en
// services/tools/tools.service.js; aquí solo se adaptan request/response.
// Base: /api/tools (permisos en routes/tools.routes.js).

const logger = require('../../config/logger');
const audit = require('../../utils/audit');
const { Tenant } = require('../../models');
const svc = require('../../services/tools/tools.service');
const { generateToolActaPdf } = require('../../services/tools/toolActaPdf.service');

const sendError = (res, error, fallback, where) => {
  if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
  logger.error(`[tools] ${where}: ${error.message}`, { stack: error.stack });
  return res.status(500).json({ success: false, message: fallback });
};

const logAudit = (req, action, entityId, changes) => {
  audit({ tenant_id: req.user.tenant_id, user_id: req.user.id, action, entity: 'tool', entity_id: entityId, changes, req });
};

const handler = (where, fallback, fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    sendError(res, error, fallback, where);
  }
};

const list = handler('list', 'Error listando herramientas', async (req, res) => {
  res.json({ success: true, data: await svc.listTools(req.user.tenant_id, req.query) });
});

const getById = handler('getById', 'Error consultando la herramienta', async (req, res) => {
  res.json({ success: true, data: await svc.getTool(req.user.tenant_id, req.params.id) });
});

const create = handler('create', 'Error creando la herramienta', async (req, res) => {
  const tool = await svc.createTool(req.user.tenant_id, req.user.id, req.body || {});
  logAudit(req, 'create', tool.id, { code: tool.code, name: tool.name });
  res.status(201).json({ success: true, message: `Herramienta ${tool.code} creada`, data: tool });
});

const update = handler('update', 'Error actualizando la herramienta', async (req, res) => {
  const tool = await svc.updateTool(req.user.tenant_id, req.user.id, req.params.id, req.body || {});
  logAudit(req, 'update', tool.id, req.body);
  res.json({ success: true, message: 'Herramienta actualizada', data: tool });
});

const assign = handler('assign', 'Error entregando la herramienta', async (req, res) => {
  const a = await svc.assignTool(req.user.tenant_id, req.user.id, req.params.id, req.body || {});
  logAudit(req, 'assign', req.params.id, { number: a.number, responsible: a.responsible_name, project_id: a.project_id, quantity: a.quantity });
  res.status(201).json({ success: true, message: `Entrega ${a.number} registrada`, data: { id: a.id, number: a.number } });
});

const returnAssignment = handler('return', 'Error registrando la devolución', async (req, res) => {
  const a = await svc.returnAssignment(req.user.tenant_id, req.user.id, req.params.assignmentId, req.body || {});
  logAudit(req, 'return', a.tool_id, { number: a.number, condition: a.return_condition, lost: a.lost_quantity });
  res.json({ success: true, message: `Devolución de ${a.number} registrada`, data: { id: a.id, number: a.number } });
});

const addEvent = handler('addEvent', 'Error registrando el evento', async (req, res) => {
  const ev = await svc.addEvent(req.user.tenant_id, req.user.id, req.params.id, req.body || {});
  logAudit(req, `event:${ev.event_type}`, req.params.id, { date: ev.event_date, cost: ev.cost });
  res.status(201).json({ success: true, message: 'Registro agregado a la hoja de vida', data: ev });
});

const setService = handler('setService', 'Error cambiando el estado', async (req, res) => {
  const inService = Boolean(req.body?.in_service);
  const tool = await svc.setInService(req.user.tenant_id, req.user.id, req.params.id, inService, req.body?.reason);
  logAudit(req, inService ? 'in_service' : 'out_of_service', tool.id, {});
  res.json({ success: true, message: inService ? 'La herramienta vuelve a servicio' : 'La herramienta queda en mantenimiento', data: tool });
});

const retire = handler('retire', 'Error dando de baja la herramienta', async (req, res) => {
  const { tool, asset_disposed, asset_error } = await svc.retireTool(req.user.tenant_id, req.user.id, req.params.id, req.body || {});
  logAudit(req, 'retire', tool.id, { reason: tool.retirement_reason, asset_disposed });
  res.json({
    success: true,
    message: asset_disposed
      ? 'Herramienta dada de baja. El activo fijo también, con su asiento de retiro (en borrador).'
      : asset_error
        ? `Herramienta dada de baja. El activo fijo no se pudo retirar (${asset_error}): retíralo desde Contabilidad → Activos fijos.`
        : 'Herramienta dada de baja',
    data: tool,
  });
});

const responsibles = handler('responsibles', 'Error consultando responsables', async (req, res) => {
  res.json({ success: true, data: await svc.responsibleOptions(req.user.tenant_id) });
});

const fixedAssets = handler('fixedAssets', 'Error consultando activos fijos', async (req, res) => {
  res.json({ success: true, data: await svc.fixedAssetOptions(req.user.tenant_id) });
});

const projectTools = handler('projectTools', 'Error consultando herramientas del proyecto', async (req, res) => {
  res.json({ success: true, data: await svc.projectTools(req.user.tenant_id, req.params.projectId) });
});

const actaPdf = handler('actaPdf', 'Error generando el acta', async (req, res) => {
  const kind = req.params.kind === 'devolucion' ? 'return' : 'delivery';
  const a = await svc.getAssignmentForActa(req.user.tenant_id, req.params.assignmentId);
  if (kind === 'return' && a.status !== 'returned') {
    return res.status(409).json({ success: false, message: 'La herramienta todavía no se ha devuelto' });
  }
  const tenant = await Tenant.findByPk(req.user.tenant_id, {
    attributes: ['id', 'company_name', 'business_name', 'tax_id', 'address', 'phone', 'email', 'logo_url', 'primary_color'],
  });
  const pdf = await generateToolActaPdf(a, tenant.toJSON(), kind);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${kind === 'return' ? 'devolucion' : 'entrega'}-${a.number}.pdf"`);
  return res.send(pdf);
});

module.exports = {
  list, getById, create, update, assign, returnAssignment, addEvent, setService, retire,
  responsibles, fixedAssets, projectTools, actaPdf,
};
