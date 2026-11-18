// backend/src/controllers/workshop/workshopBoard.controller.js
// Pantalla de taller: bahías por sede, enlace del TV, tablero (solo lectura)
// y asignación de bahía a una OT. Ver services/workshop/workshopBoard.service.js.
const crypto = require('crypto');
const logger = require('../../config/logger');
const { sequelize } = require('../../config/database');
const { WorkshopBay, WorkOrder, Branch } = require('../../models');
const { runWithTenantSchema } = require('../../config/tenantContext');
const board = require('../../services/workshop/workshopBoard.service');

const fail = (res, error, fallback) => {
  if (error.status) return res.status(error.status).json({ success: false, message: error.message });
  logger.error(`${fallback}:`, error);
  return res.status(500).json({ success: false, message: fallback });
};

// Admin/manager eligen la sede; los demás ven la suya (branchMiddleware).
function pickBranchId(req) {
  const canPick = ['admin', 'manager', 'super_admin'].includes(req.user?.role);
  return (canPick && (req.query.branch_id || req.body?.branch_id)) || req.branch_id || null;
}

async function findBranch(req, branchId) {
  if (!branchId) return null;
  return Branch.findOne({ where: { id: branchId, tenant_id: req.tenant_id } });
}

const cleanName = (s) => String(s || '').trim().slice(0, 60);

// ── Bahías ───────────────────────────────────────────────────────────────────

// GET /api/workshop/board/bays?branch_id=  (todas, incluidas inactivas, con su OT)
const listBays = async (req, res) => {
  try {
    const branchId = pickBranchId(req);
    if (!branchId) return res.json({ success: true, data: [] });
    const bays = await WorkshopBay.findAll({
      where: { tenant_id: req.tenant_id, branch_id: branchId },
      include: [{
        model: WorkOrder, as: 'work_orders', required: false,
        attributes: ['id', 'order_number', 'status'],
      }],
      order: [['sort_order', 'ASC'], ['name', 'ASC']],
    });
    res.json({
      success: true,
      data: bays.map((b) => ({
        id: b.id, branch_id: b.branch_id, name: b.name, kind: b.kind, sort_order: b.sort_order, is_active: b.is_active,
        occupied_by: b.work_orders?.[0] ? { id: b.work_orders[0].id, order_number: b.work_orders[0].order_number } : null,
      })),
    });
  } catch (error) {
    fail(res, error, 'Error al listar las bahías');
  }
};

// POST /api/workshop/board/bays { branch_id, name, kind, sort_order }
const createBay = async (req, res) => {
  try {
    const branch = await findBranch(req, req.body.branch_id || req.branch_id);
    if (!branch) return res.status(400).json({ success: false, message: 'Sede no encontrada' });
    const name = cleanName(req.body.name);
    if (!name) return res.status(400).json({ success: false, message: 'El nombre es requerido' });
    const kind = WorkshopBay.BAY_KINDS.includes(req.body.kind) ? req.body.kind : 'bahia';
    let sortOrder = parseInt(req.body.sort_order, 10);
    if (!Number.isFinite(sortOrder)) {
      sortOrder = ((await WorkshopBay.max('sort_order', { where: { tenant_id: req.tenant_id, branch_id: branch.id } })) || 0) + 1;
    }
    const bay = await WorkshopBay.create({ tenant_id: req.tenant_id, branch_id: branch.id, name, kind, sort_order: sortOrder });
    board.notifyBranch(req.tenant_id, branch.id);
    res.status(201).json({ success: true, data: bay });
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ success: false, message: 'Ya existe una bahía con ese nombre en la sede' });
    }
    fail(res, error, 'Error al crear la bahía');
  }
};

// PUT /api/workshop/board/bays/:id { name, kind, sort_order, is_active }
const updateBay = async (req, res) => {
  try {
    const bay = await WorkshopBay.findOne({ where: { id: req.params.id, tenant_id: req.tenant_id } });
    if (!bay) return res.status(404).json({ success: false, message: 'Bahía no encontrada' });
    const updates = {};
    if (req.body.name !== undefined) {
      updates.name = cleanName(req.body.name);
      if (!updates.name) return res.status(400).json({ success: false, message: 'El nombre es requerido' });
    }
    if (req.body.kind !== undefined && WorkshopBay.BAY_KINDS.includes(req.body.kind)) updates.kind = req.body.kind;
    if (req.body.sort_order !== undefined && Number.isFinite(parseInt(req.body.sort_order, 10))) updates.sort_order = parseInt(req.body.sort_order, 10);
    if (req.body.is_active !== undefined) {
      updates.is_active = !!req.body.is_active;
      if (!updates.is_active) {
        const occupant = await WorkOrder.findOne({ where: { tenant_id: req.tenant_id, bay_id: bay.id }, attributes: ['order_number'] });
        if (occupant) return res.status(409).json({ success: false, message: `No se puede desactivar: la ocupa la OT ${occupant.order_number}` });
      }
    }
    await bay.update(updates);
    board.notifyBranch(req.tenant_id, bay.branch_id);
    res.json({ success: true, data: bay });
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ success: false, message: 'Ya existe una bahía con ese nombre en la sede' });
    }
    fail(res, error, 'Error al actualizar la bahía');
  }
};

// DELETE /api/workshop/board/bays/:id  (solo si está libre)
const deleteBay = async (req, res) => {
  try {
    const bay = await WorkshopBay.findOne({ where: { id: req.params.id, tenant_id: req.tenant_id } });
    if (!bay) return res.status(404).json({ success: false, message: 'Bahía no encontrada' });
    const occupant = await WorkOrder.findOne({ where: { tenant_id: req.tenant_id, bay_id: bay.id }, attributes: ['order_number'] });
    if (occupant) return res.status(409).json({ success: false, message: `No se puede eliminar: la ocupa la OT ${occupant.order_number}` });
    await bay.destroy();
    board.notifyBranch(req.tenant_id, bay.branch_id);
    res.json({ success: true, message: 'Bahía eliminada' });
  } catch (error) {
    fail(res, error, 'Error al eliminar la bahía');
  }
};

// ── Asignar bahía a una OT ───────────────────────────────────────────────────

// PATCH /api/workshop/work-orders/:id/bay { bay_id | null }
// Aparte de PUT /work-orders/:id porque sacar el carro de la bahía se hace
// también con la OT en "Listo" (bloqueada para edición).
const setOrderBay = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const tenantId = req.user.tenant_id;
    const order = await WorkOrder.findOne({ where: { id: req.params.id, tenant_id: tenantId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!order) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Orden no encontrada' });
    }
    if (!board.ACTIVE_STATUSES.includes(order.status)) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: `La OT está ${order.status}: no se le puede asignar bahía` });
    }
    const bayId = req.body.bay_id || null;
    let bay = null;
    if (bayId) {
      bay = await board.assertBayAssignable({ tenantId, bayId, warehouseId: order.warehouse_id, orderId: order.id, transaction });
    }
    await order.update({ bay_id: bayId }, { transaction });
    await transaction.commit();
    res.json({
      success: true,
      message: bay ? `OT en ${bay.name}` : 'Bahía liberada',
      data: { id: order.id, bay_id: bayId, bay: bay ? { id: bay.id, name: bay.name, kind: bay.kind } : null },
    });
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ success: false, message: 'Esa bahía acaba de ser ocupada por otra OT' });
    }
    fail(res, error, 'Error al asignar la bahía');
  }
};

// ── Tablero ──────────────────────────────────────────────────────────────────

// GET /api/workshop/board?branch_id=
const getBoard = async (req, res) => {
  try {
    const branchId = pickBranchId(req);
    if (!branchId) return res.status(400).json({ success: false, message: 'Selecciona una sede' });
    const data = await board.buildBoard(req.tenant_id, branchId);
    if (!data) return res.status(404).json({ success: false, message: 'Sede no encontrada' });
    res.json({ success: true, data });
  } catch (error) {
    fail(res, error, 'Error al cargar el tablero');
  }
};

// GET /api/public/workshop-display/:token  (TV, sin login)
const getPublicBoard = async (req, res) => {
  try {
    const resolved = await board.resolveDisplayToken(req.params.token);
    if (!resolved) return res.status(404).json({ success: false, message: 'Enlace de pantalla inválido o revocado' });
    const data = await runWithTenantSchema(resolved.schemaName, () => board.buildBoard(resolved.tenantId, resolved.branchId));
    if (!data) return res.status(404).json({ success: false, message: 'Enlace de pantalla inválido o revocado' });
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, data });
  } catch (error) {
    fail(res, error, 'Error al cargar el tablero');
  }
};

// ── Enlace del TV ────────────────────────────────────────────────────────────

const displayPayload = (branch) => ({
  branch_id: branch.id,
  token: branch.workshop_display_token || null,
  path: branch.workshop_display_token ? `/pantalla-taller/${branch.workshop_display_token}` : null,
});

// GET /api/workshop/board/display?branch_id=
const getDisplay = async (req, res) => {
  try {
    const branch = await findBranch(req, pickBranchId(req));
    if (!branch) return res.status(400).json({ success: false, message: 'Sede no encontrada' });
    res.json({ success: true, data: displayPayload(branch) });
  } catch (error) {
    fail(res, error, 'Error al consultar el enlace de pantalla');
  }
};

// POST /api/workshop/board/display { branch_id }  — genera o regenera (el
// enlace anterior deja de funcionar).
const regenerateDisplay = async (req, res) => {
  try {
    const branch = await findBranch(req, pickBranchId(req));
    if (!branch) return res.status(400).json({ success: false, message: 'Sede no encontrada' });
    const previous = branch.workshop_display_token;
    await branch.update({ workshop_display_token: crypto.randomUUID() });
    if (previous) await revokeEffects(req.tenant_id, branch.id, previous);
    res.json({ success: true, data: displayPayload(branch) });
  } catch (error) {
    fail(res, error, 'Error al generar el enlace de pantalla');
  }
};

// DELETE /api/workshop/board/display?branch_id=
const revokeDisplay = async (req, res) => {
  try {
    const branch = await findBranch(req, pickBranchId(req));
    if (!branch) return res.status(400).json({ success: false, message: 'Sede no encontrada' });
    const previous = branch.workshop_display_token;
    await branch.update({ workshop_display_token: null });
    if (previous) await revokeEffects(req.tenant_id, branch.id, previous);
    res.json({ success: true, data: displayPayload(branch) });
  } catch (error) {
    fail(res, error, 'Error al revocar el enlace de pantalla');
  }
};

async function revokeEffects(tenantId, branchId, oldToken) {
  board.forgetDisplayToken(oldToken);
  const { disconnectDisplays } = require('../../services/workshopBoard.socket');
  await disconnectDisplays(tenantId, branchId);
}

module.exports = {
  listBays, createBay, updateBay, deleteBay,
  setOrderBay, getBoard, getPublicBoard,
  getDisplay, regenerateDisplay, revokeDisplay,
};
