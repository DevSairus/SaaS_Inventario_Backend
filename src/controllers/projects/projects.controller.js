// backend/src/controllers/projects/projects.controller.js
//
// Módulo Proyectos (Fase 1). La lógica vive en services/projects/*; aquí solo
// se adaptan request/response. Base: /api/projects (roles en
// routes/projects/projects.routes.js).

const { Op } = require('sequelize');
const logger = require('../../config/logger');
const audit = require('../../utils/audit');
const { Project, Customer, User, Warehouse } = require('../../models');
const projectsService = require('../../services/projects/projects.service');
const bomService = require('../../services/projects/projectBom.service');
const { getProjectPnl } = require('../../services/projects/projectPnl.service');
const laborService = require('../../services/projects/projectLabor.service');

// Quién ve márgenes y costos: permiso 'projects.pnl' de la empresa
// (por defecto gerencia y contabilidad; los técnicos y vendedores no).
const { can } = require('../../services/tenantPermissions.service');
const canSeePnl = (req) => can(req.user.tenant_id, req.user.role, 'projects.pnl');

const sendError = (res, error, fallback, where) => {
  if (error.statusCode) {
    return res.status(error.statusCode).json({ success: false, message: error.message, code: error.code, data: error.data });
  }
  logger.error(`[projects] ${where}: ${error.message}`, { stack: error.stack });
  return res.status(500).json({ success: false, message: fallback });
};

// audit() nunca lanza (registra y sigue); no se espera para no demorar la respuesta.
const logAudit = (req, action, project, changes) => {
  audit({ tenant_id: req.user.tenant_id, user_id: req.user.id, action, entity: 'project', entity_id: project.id, changes, req });
};

const list = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { status, customer_id, search, active } = req.query;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const where = { tenant_id };
    if (status) where.status = String(status).split(',');
    else if (active === 'true') where.status = { [Op.notIn]: ['closed', 'cancelled'] };
    if (customer_id) where.customer_id = customer_id;
    if (search && String(search).trim()) {
      const q = `%${String(search).trim()}%`;
      where[Op.or] = [
        { code: { [Op.iLike]: q } },
        { name: { [Op.iLike]: q } },
        { city: { [Op.iLike]: q } },
        { '$customer.business_name$': { [Op.iLike]: q } },
        { '$customer.first_name$': { [Op.iLike]: q } },
        { '$customer.last_name$': { [Op.iLike]: q } },
      ];
    }
    const { rows, count } = await Project.findAndCountAll({
      where,
      include: [
        { model: Customer, as: 'customer', attributes: ['id', 'first_name', 'last_name', 'business_name'] },
        { model: User, as: 'manager', attributes: ['id', 'first_name', 'last_name', 'email'] },
        { model: Warehouse, as: 'warehouse', attributes: ['id', 'code', 'name'] },
      ],
      order: [['created_at', 'DESC']],
      limit,
      offset: (page - 1) * limit,
      distinct: true,
      subQuery: false,
    });
    const counts = await Project.count({ where: { tenant_id }, group: ['status'] });
    // Alertas de sobrecosto abiertas por proyecto (solo para quien ve costos).
    if (rows.length && (await canSeePnl(req))) {
      const { ProjectBudgetAlert } = require('../../models');
      const alerts = await ProjectBudgetAlert.findAll({
        where: { tenant_id, project_id: rows.map((r) => r.id), status: 'open' },
        attributes: ['project_id', 'level'],
        raw: true,
      });
      const worst = new Map();
      for (const a of alerts) if (worst.get(a.project_id) !== 'critical') worst.set(a.project_id, a.level);
      for (const r of rows) r.setDataValue('budget_alert', worst.get(r.id) || null);
    }
    res.json({
      success: true,
      data: rows,
      pagination: { page, limit, total: count, pages: Math.ceil(count / limit) },
      meta: { status_counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.count)])) },
    });
  } catch (error) {
    sendError(res, error, 'Error al obtener los proyectos', 'list');
  }
};

// Selector liviano (compras, gastos, ventas): proyectos abiertos.
const options = async (req, res) => {
  try {
    const where = { tenant_id: req.user.tenant_id, status: { [Op.notIn]: ['closed', 'cancelled'] } };
    if (req.query.search && String(req.query.search).trim()) {
      const q = `%${String(req.query.search).trim()}%`;
      where[Op.or] = [{ code: { [Op.iLike]: q } }, { name: { [Op.iLike]: q } }];
    }
    const rows = await Project.findAll({
      where,
      attributes: ['id', 'code', 'name', 'status', 'warehouse_id', 'customer_id'],
      order: [['code', 'DESC']],
      limit: 100,
    });
    res.json({ success: true, data: rows });
  } catch (error) {
    sendError(res, error, 'Error al obtener los proyectos', 'options');
  }
};

const getById = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const data = await projectsService.getProjectDetail(tenant_id, req.params.id);
    const seePnl = await canSeePnl(req);
    if (seePnl) {
      const pnl = await getProjectPnl(tenant_id, data);
      // Alertas de sobrecosto: se evalúan al abrir el proyecto (y cada día por job).
      data.budget_alerts = await require('../../services/projects/projectAlerts.service').evaluateProject(tenant_id, data, pnl).catch((e) => {
        logger.warn(`[projects] Alertas de ${data.code}: ${e.message}`);
        return [];
      });
      data.summary = {
        revenue: pnl.revenue.net,
        costs: pnl.costs.total,
        gross_margin: pnl.gross_margin,
        margin_pct: pnl.margin_pct,
        budget_total: pnl.budget.total,
        budget_executed_pct: pnl.budget.executed_pct,
        materials_in_transit: pnl.costs.materials.in_transit,
      };
    } else {
      // Sin permiso de rentabilidad: sin valores de presupuesto ni contrato.
      data.contract_amount = null;
      data.budget_lines = [];
    }
    data.can_see_pnl = seePnl;
    res.json({ success: true, data });
  } catch (error) {
    sendError(res, error, 'Error al obtener el proyecto', 'getById');
  }
};

const create = async (req, res) => {
  try {
    const project = await projectsService.createProject(req, req.body || {});
    logAudit(req, 'create', project, { code: project.code, name: project.name });
    res.status(201).json({ success: true, message: `Proyecto ${project.code} creado`, data: project });
  } catch (error) {
    sendError(res, error, 'Error al crear el proyecto', 'create');
  }
};

const update = async (req, res) => {
  try {
    const project = await projectsService.loadProject(req.user.tenant_id, req.params.id);
    await projectsService.updateProject(req, project, req.body || {});
    logAudit(req, 'update', project, req.body);
    res.json({ success: true, message: 'Proyecto actualizado', data: project });
  } catch (error) {
    sendError(res, error, 'Error al actualizar el proyecto', 'update');
  }
};

const changeStatus = async (req, res) => {
  try {
    const project = await projectsService.loadProject(req.user.tenant_id, req.params.id);
    const from = project.status;
    await projectsService.changeStatus(req, project, req.body?.status);
    logAudit(req, 'status_change', project, { from, to: project.status });
    res.json({ success: true, message: `Proyecto ${projectsService.STATUS_LABELS[project.status].toLowerCase()}`, data: project });
  } catch (error) {
    sendError(res, error, 'Error al cambiar el estado', 'changeStatus');
  }
};

const createWarehouse = async (req, res) => {
  try {
    const project = await projectsService.loadProject(req.user.tenant_id, req.params.id);
    if (['closed', 'cancelled'].includes(project.status)) {
      return res.status(400).json({ success: false, message: 'El proyecto está cerrado o cancelado' });
    }
    if (project.warehouse_id) return res.status(409).json({ success: false, message: 'El proyecto ya tiene bodega' });
    const warehouse = await projectsService.createProjectWarehouse(project, { branchId: req.branch_id });
    res.status(201).json({ success: true, message: `Bodega ${warehouse.name} creada`, data: warehouse });
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ success: false, message: 'Ya existe una bodega con ese código o nombre' });
    }
    sendError(res, error, 'Error al crear la bodega del proyecto', 'createWarehouse');
  }
};

const getPnl = async (req, res) => {
  try {
    const project = await projectsService.loadProject(req.user.tenant_id, req.params.id);
    const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
    const range = { from: isDate(req.query.from) ? req.query.from : undefined, to: isDate(req.query.to) ? req.query.to : undefined };
    const data = await getProjectPnl(req.user.tenant_id, project, range);
    // Comparación con contabilidad (dimensión de proyecto en los asientos).
    const { getEffectiveModulesForTenantId } = require('../../services/moduleAccess');
    if ((await getEffectiveModulesForTenantId(req.user.tenant_id)).includes('accounting')) {
      const { projectLedgerSummary } = require('../../services/accounting/projectAccounting.service');
      const opts = { from: range.from, to: range.to, projectId: project.id };
      const [posted, all] = await Promise.all([
        projectLedgerSummary(req.user.tenant_id, opts),
        projectLedgerSummary(req.user.tenant_id, { ...opts, includeDrafts: true }),
      ]);
      const pick = (r) => r.projects[0] || { ingresos: 0, costos: 0, gastos: 0, utilidad: 0, accounts: [] };
      data.accounting = { posted: pick(posted), with_drafts: pick(all) };
    }
    res.json({ success: true, data });
  } catch (error) {
    sendError(res, error, 'Error al calcular el estado de resultados', 'getPnl');
  }
};

const getDocuments = async (req, res) => {
  try {
    const project = await projectsService.loadProject(req.user.tenant_id, req.params.id);
    const data = await projectsService.getProjectDocuments(req.user.tenant_id, project);
    if (!(await canSeePnl(req))) {
      // Montos fuera para quien no ve rentabilidad.
      for (const k of ['sales', 'purchases', 'expenses']) {
        data[k] = data[k].map((d) => ({ ...d.toJSON(), total_amount: null, subtotal: null, tax_amount: null }));
      }
    }
    res.json({ success: true, data });
  } catch (error) {
    sendError(res, error, 'Error al obtener los documentos', 'getDocuments');
  }
};

// ── Sobrante en la obra ──────────────────────────────────────────────────
const getSiteStock = async (req, res) => {
  try {
    const project = await projectsService.loadProject(req.user.tenant_id, req.params.id);
    const data = await projectsService.getSiteStock(req.user.tenant_id, project);
    // Sin permiso de rentabilidad: cantidades sí, valores no.
    res.json({ success: true, data: (await canSeePnl(req)) ? data : data.map((d) => ({ ...d, value: null, average_cost: null })) });
  } catch (error) {
    sendError(res, error, 'Error al consultar la bodega de la obra', 'getSiteStock');
  }
};

const returnSurplus = async (req, res) => {
  try {
    const project = await projectsService.loadProject(req.user.tenant_id, req.params.id);
    const r = await projectsService.returnSurplus(req, project, req.body || {});
    logAudit(req, 'return_surplus', project, r);
    res.status(201).json({
      success: true,
      message: r.status === 'received'
        ? `Traslado ${r.transfer_number} recibido: el sobrante volvió a la bodega`
        : `Traslado ${r.transfer_number} en tránsito: recíbelo en la bodega de destino`,
      data: r,
    });
  } catch (error) {
    if (/Stock insuficiente/i.test(error.message || '')) return res.status(400).json({ success: false, message: error.message });
    sendError(res, error, 'Error al reintegrar el sobrante', 'returnSurplus');
  }
};

// ── Mano de obra: horas y reparto de nómina ──────────────────────────────
const getTimeEntries = async (req, res) => {
  try {
    const project = await projectsService.loadProject(req.user.tenant_id, req.params.id);
    const seeCosts = await canSeePnl(req);
    const [entries, allocations, pending] = await Promise.all([
      laborService.listTimeEntries(req.user.tenant_id, project.id, req.query),
      seeCosts ? laborService.projectAllocations(req.user.tenant_id, project.id) : [],
      seeCosts ? laborService.estimatePendingLabor(req.user.tenant_id, project.id) : null,
    ]);
    res.json({ success: true, data: { entries, allocations, pending } });
  } catch (error) {
    sendError(res, error, 'Error al obtener las horas', 'getTimeEntries');
  }
};

const addTimeEntry = async (req, res) => {
  try {
    const project = await projectsService.loadProject(req.user.tenant_id, req.params.id);
    const entry = await laborService.addTimeEntry(req, project, req.body || {});
    res.status(201).json({ success: true, message: 'Horas registradas', data: entry });
  } catch (error) {
    sendError(res, error, 'Error al registrar las horas', 'addTimeEntry');
  }
};

const deleteTimeEntry = async (req, res) => {
  try {
    const project = await projectsService.loadProject(req.user.tenant_id, req.params.id);
    await laborService.deleteTimeEntry(req.user.tenant_id, project, req.params.entryId);
    res.json({ success: true, message: 'Registro eliminado' });
  } catch (error) {
    sendError(res, error, 'Error al eliminar el registro', 'deleteTimeEntry');
  }
};

const employeeOptions = async (req, res) => {
  try {
    res.json({ success: true, data: await laborService.employeeOptions(req.user.tenant_id) });
  } catch (error) {
    sendError(res, error, 'Error al obtener los empleados', 'employeeOptions');
  }
};

const laborPeriods = async (req, res) => {
  try {
    res.json({ success: true, data: await laborService.allocatablePeriods(req.user.tenant_id) });
  } catch (error) {
    sendError(res, error, 'Error al obtener los periodos de nómina', 'laborPeriods');
  }
};

const allocatePeriod = async (req, res) => {
  try {
    const r = await laborService.allocatePeriod(req, req.params.periodId);
    audit({ tenant_id: req.user.tenant_id, user_id: req.user.id, action: 'allocate_labor', entity: 'payroll_period', entity_id: req.params.periodId, changes: r, req });
    res.json({ success: true, message: `Nómina repartida: ${r.projects} proyecto(s), ${r.employees} empleado(s)`, data: r });
  } catch (error) {
    sendError(res, error, 'Error al repartir la nómina', 'allocatePeriod');
  }
};

// ── Presupuesto ──────────────────────────────────────────────────────────
const addBudgetLine = async (req, res) => {
  try {
    const project = await projectsService.loadProject(req.user.tenant_id, req.params.id);
    const line = await projectsService.addBudgetLine(req, project, req.body || {});
    res.status(201).json({ success: true, data: line });
  } catch (error) {
    sendError(res, error, 'Error al agregar la línea de presupuesto', 'addBudgetLine');
  }
};

const updateBudgetLine = async (req, res) => {
  try {
    const project = await projectsService.loadProject(req.user.tenant_id, req.params.id);
    const line = await projectsService.updateBudgetLine(project, req.params.lineId, req.body || {});
    res.json({ success: true, data: line });
  } catch (error) {
    sendError(res, error, 'Error al actualizar la línea de presupuesto', 'updateBudgetLine');
  }
};

const deleteBudgetLine = async (req, res) => {
  try {
    const project = await projectsService.loadProject(req.user.tenant_id, req.params.id);
    await projectsService.deleteBudgetLine(project, req.params.lineId);
    res.json({ success: true, message: 'Línea eliminada' });
  } catch (error) {
    sendError(res, error, 'Error al eliminar la línea de presupuesto', 'deleteBudgetLine');
  }
};

// ── Lista de materiales (BOM) ────────────────────────────────────────────
const getBom = async (req, res) => {
  try {
    const project = await projectsService.loadProject(req.user.tenant_id, req.params.id);
    res.json({ success: true, data: await bomService.getBom(req.user.tenant_id, project) });
  } catch (error) {
    sendError(res, error, 'Error al obtener la lista de materiales', 'getBom');
  }
};

const previewBom = async (req, res) => {
  try {
    const project = await projectsService.loadProject(req.user.tenant_id, req.params.id);
    const text = String(req.body?.text || '');
    if (!text.trim()) return res.status(400).json({ success: false, message: 'Pega las filas copiadas desde Excel' });
    res.json({ success: true, data: await bomService.previewBom(req.user.tenant_id, project, text) });
  } catch (error) {
    sendError(res, error, 'Error al leer la lista de materiales', 'previewBom');
  }
};

const saveBom = async (req, res) => {
  try {
    const project = await projectsService.loadProject(req.user.tenant_id, req.params.id);
    const result = await bomService.saveBom(req.user.tenant_id, project, req.body || {}, req.user.id);
    logAudit(req, 'bom_save', project, { mode: req.body?.mode, lines: result.created });
    res.status(201).json({ success: true, message: `${result.created} línea(s) guardada(s)`, data: result });
  } catch (error) {
    sendError(res, error, 'Error al guardar la lista de materiales', 'saveBom');
  }
};

const updateBomItem = async (req, res) => {
  try {
    const project = await projectsService.loadProject(req.user.tenant_id, req.params.id);
    const line = await bomService.updateBomItem(req.user.tenant_id, project, req.params.itemId, req.body || {});
    res.json({ success: true, data: line });
  } catch (error) {
    sendError(res, error, 'Error al actualizar la línea', 'updateBomItem');
  }
};

const deleteBomItem = async (req, res) => {
  try {
    const project = await projectsService.loadProject(req.user.tenant_id, req.params.id);
    await bomService.deleteBomItem(req.user.tenant_id, project, req.params.itemId);
    res.json({ success: true, message: 'Línea eliminada' });
  } catch (error) {
    sendError(res, error, 'Error al eliminar la línea', 'deleteBomItem');
  }
};

const reserveBom = async (req, res) => {
  try {
    const project = await projectsService.loadProject(req.user.tenant_id, req.params.id);
    const r = await bomService.reserveBom(req.user.tenant_id, project, req.body || {});
    logAudit(req, 'bom_reserve', project, r);
    const parts = [`${r.reserved_lines} línea(s) reservada(s)`];
    if (r.short_lines) parts.push(`${r.short_lines} sin stock suficiente`);
    res.json({ success: true, message: parts.join(' · '), data: r });
  } catch (error) {
    sendError(res, error, 'Error al reservar', 'reserveBom');
  }
};

const releaseBom = async (req, res) => {
  try {
    const project = await projectsService.loadProject(req.user.tenant_id, req.params.id);
    const r = await bomService.releaseBom(req.user.tenant_id, project, req.body || {});
    logAudit(req, 'bom_release', project, r);
    res.json({ success: true, message: `Reserva liberada en ${r.released_lines} línea(s)`, data: r });
  } catch (error) {
    sendError(res, error, 'Error al liberar la reserva', 'releaseBom');
  }
};

const orderShortages = async (req, res) => {
  try {
    const project = await projectsService.loadProject(req.user.tenant_id, req.params.id);
    const r = await bomService.createOrderLists(req.user.tenant_id, project, req.body || {}, req.user.id);
    logAudit(req, 'bom_order_lists', project, { lists: r.lists.map((l) => l.list_number) });
    const msg = r.lists.length
      ? `Faltantes anotados en ${r.lists.length} pedido(s) a proveedor`
      : 'No hay faltantes con proveedor para pedir';
    res.json({ success: true, message: r.without_supplier.length ? `${msg} · ${r.without_supplier.length} línea(s) sin proveedor` : msg, data: r });
  } catch (error) {
    sendError(res, error, 'Error al generar los pedidos', 'orderShortages');
  }
};

const dispatchBom = async (req, res) => {
  try {
    const project = await projectsService.loadProject(req.user.tenant_id, req.params.id);
    const r = await bomService.dispatchBom(req, project, req.body || {});
    logAudit(req, 'bom_dispatch', project, r);
    res.status(201).json({ success: true, message: `Traslado ${r.transfer_number} enviado a la obra (${r.lines} línea(s))`, data: r });
  } catch (error) {
    if (/Stock insuficiente/i.test(error.message || '')) {
      return res.status(400).json({ success: false, message: error.message });
    }
    sendError(res, error, 'Error al despachar', 'dispatchBom');
  }
};

module.exports = {
  list,
  options,
  getById,
  create,
  update,
  changeStatus,
  createWarehouse,
  getPnl,
  getDocuments,
  addBudgetLine,
  updateBudgetLine,
  deleteBudgetLine,
  getBom,
  previewBom,
  saveBom,
  updateBomItem,
  deleteBomItem,
  reserveBom,
  releaseBom,
  orderShortages,
  dispatchBom,
  getSiteStock,
  returnSurplus,
  getTimeEntries,
  addTimeEntry,
  deleteTimeEntry,
  employeeOptions,
  laborPeriods,
  allocatePeriod,
};
