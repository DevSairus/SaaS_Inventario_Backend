// backend/src/services/workshop/workshopBoard.service.js
// Pantalla de taller: mapa de ocupación por bahía de una sede, solo lectura.
//
//   - buildBoard: datos del tablero (bahías con su OT + OTs activas sin
//     bahía). Lo usan la vista interna (/workshop/board, con login) y la
//     pantalla del TV (/pantalla-taller/:token, sin login).
//   - resolveDisplayToken: token del TV → { tenantId, branchId, schemaName }.
//     Branches vive en el schema de cada tenant, así que se busca igual que
//     resolveWorkOrderSchemaByToken (public legado + cada schema cortado),
//     con caché corta porque el TV consulta cada minuto.
//   - registerBoardHooks: avisa en vivo (socket /workshop-board) cuando una
//     OT se crea o cambia de estado, técnico o bahía, o cambia el técnico de
//     una línea. Hooks del modelo para no depender de cada endpoint; el aviso
//     sale después del commit.
//
// La pantalla NO muestra datos del cliente (nombre, teléfono, valores): queda
// a la vista de cualquiera en el taller.
const { Op } = require('sequelize');

const ACTIVE_STATUSES = ['recibido', 'en_proceso', 'en_espera', 'listo'];

// ── Datos del tablero ────────────────────────────────────────────────────────

const fullName = (u) => (u ? `${u.first_name || ''} ${u.last_name || ''}`.trim() : null);

function toCard(o) {
  const technicians = [];
  const main = fullName(o.technician);
  if (main) technicians.push(main);
  for (const it of o.items || []) {
    const n = fullName(it.item_technician);
    if (n && !technicians.includes(n)) technicians.push(n);
  }
  const v = o.vehicle;
  return {
    id: o.id,
    order_number: o.order_number,
    status: o.status,
    status_since: o.status_changed_at || o.received_at || o.created_at,
    received_at: o.received_at,
    promised_at: o.promised_at,
    plate: v?.plate || null,
    vehicle: v ? [v.brand, v.model, v.year].filter(Boolean).join(' ') : null,
    color: v?.color || null,
    technicians,
    // Ronda de cotización enviada al cliente y aún sin respuesta.
    awaiting_quote: (o.quote_requests || []).some((q) => q.status === 'enviada'),
    bay_id: o.bay_id || null,
  };
}

async function buildBoard(tenantId, branchId) {
  const { WorkOrder, WorkOrderItem, WorkOrderQuoteRequest, Vehicle, User, WorkshopBay, Branch } = require('../../models');
  const { getBranchWarehouseIds } = require('../../utils/branchFilter');

  const [branch, bays, warehouseIds] = await Promise.all([
    Branch.findOne({ where: { id: branchId, tenant_id: tenantId }, attributes: ['id', 'name', 'code'] }),
    WorkshopBay.findAll({
      where: { tenant_id: tenantId, branch_id: branchId, is_active: true },
      order: [['sort_order', 'ASC'], ['name', 'ASC']],
    }),
    getBranchWarehouseIds(tenantId, branchId),
  ]);
  if (!branch) return null;

  const bayIds = bays.map((b) => b.id);
  const or = [];
  if (warehouseIds.length) or.push({ warehouse_id: { [Op.in]: warehouseIds } });
  if (bayIds.length) or.push({ bay_id: { [Op.in]: bayIds } });

  const orders = or.length ? await WorkOrder.findAll({
    where: { tenant_id: tenantId, status: { [Op.in]: ACTIVE_STATUSES }, [Op.or]: or },
    attributes: ['id', 'order_number', 'status', 'status_changed_at', 'received_at', 'created_at', 'promised_at', 'bay_id', 'technician_id'],
    include: [
      { model: Vehicle, as: 'vehicle', attributes: ['plate', 'brand', 'model', 'year', 'color'] },
      { model: User, as: 'technician', attributes: ['first_name', 'last_name'] },
      {
        model: WorkOrderItem, as: 'items', attributes: ['id'], required: false,
        include: [{ model: User, as: 'item_technician', attributes: ['first_name', 'last_name'], required: false }],
      },
      { model: WorkOrderQuoteRequest, as: 'quote_requests', attributes: ['status'], required: false },
    ],
    order: [['received_at', 'ASC']],
  }) : [];

  const cards = orders.map(toCard);
  const byBay = new Map();
  for (const c of cards) if (c.bay_id && bayIds.includes(c.bay_id) && !byBay.has(c.bay_id)) byBay.set(c.bay_id, c);
  const placed = new Set([...byBay.values()].map((c) => c.id));

  const counts = Object.fromEntries(ACTIVE_STATUSES.map((s) => [s, 0]));
  for (const c of cards) counts[c.status] += 1;

  return {
    branch: { id: branch.id, name: branch.name, code: branch.code },
    server_time: new Date().toISOString(),
    bays: bays.map((b) => ({ id: b.id, name: b.name, kind: b.kind, order: byBay.get(b.id) || null })),
    unassigned: cards.filter((c) => !placed.has(c.id)),
    counts,
    total_active: cards.length,
  };
}

// ── Asignación de bahía ──────────────────────────────────────────────────────

const httpError = (status, message) => Object.assign(new Error(message), { status });

/**
 * Valida que la bahía se pueda asignar a la OT: del tenant, activa, de la
 * misma sede que la bodega de la OT y libre (otra OT activa no la ocupa).
 * El índice único uq_work_orders_bay respalda esto ante dos asignaciones
 * simultáneas. Lanza error con .status (400/404/409).
 */
async function assertBayAssignable({ tenantId, bayId, warehouseId, orderId = null, transaction }) {
  const { WorkshopBay, Warehouse, WorkOrder } = require('../../models');
  const bay = await WorkshopBay.findOne({ where: { id: bayId, tenant_id: tenantId }, transaction });
  if (!bay) throw httpError(404, 'Bahía no encontrada');
  if (!bay.is_active) throw httpError(400, `La bahía "${bay.name}" está desactivada`);
  if (warehouseId) {
    const wh = await Warehouse.findByPk(warehouseId, { attributes: ['branch_id'], transaction });
    if (wh?.branch_id && wh.branch_id !== bay.branch_id) {
      throw httpError(400, `La bahía "${bay.name}" es de otra sede que la bodega de la OT`);
    }
  }
  const where = { tenant_id: tenantId, bay_id: bayId };
  if (orderId) where.id = { [Op.ne]: orderId };
  const occupant = await WorkOrder.findOne({ where, attributes: ['order_number'], transaction });
  if (occupant) throw httpError(409, `La bahía "${bay.name}" está ocupada por la OT ${occupant.order_number}`);
  return bay;
}

// ── Token del TV ─────────────────────────────────────────────────────────────

const TOKEN_TTL_MS = 60 * 1000;
const tokenCache = new Map(); // token → { at, value }

async function resolveDisplayToken(token) {
  if (!/^[0-9a-f-]{36}$/i.test(String(token || ''))) return null;
  const hit = tokenCache.get(token);
  if (hit && Date.now() - hit.at < TOKEN_TTL_MS) return hit.value;

  const { sequelize } = require('../../config/database');
  let value = null;
  const [publicRows] = await sequelize.query(
    `SELECT id, tenant_id FROM "public"."branches"
      WHERE workshop_display_token = :token
        AND tenant_id IN (SELECT id FROM "public"."tenants" WHERE schema_name IS NULL AND is_active = TRUE)
      LIMIT 1`,
    { replacements: { token } }
  ).catch(() => [[]]);
  if (publicRows[0]) {
    value = { tenantId: publicRows[0].tenant_id, branchId: publicRows[0].id, schemaName: null };
  } else {
    const [tenants] = await sequelize.query(
      'SELECT schema_name FROM "public"."tenants" WHERE schema_name IS NOT NULL AND is_active = TRUE'
    );
    for (const { schema_name } of tenants) {
      const [rows] = await sequelize.query(
        `SELECT id, tenant_id FROM "${schema_name}"."branches" WHERE workshop_display_token = :token LIMIT 1`,
        { replacements: { token } }
      ).catch(() => [[]]);
      if (rows[0]) { value = { tenantId: rows[0].tenant_id, branchId: rows[0].id, schemaName: schema_name }; break; }
    }
  }
  tokenCache.set(token, { at: Date.now(), value });
  return value;
}

function forgetDisplayToken(token) {
  if (token) tokenCache.delete(token);
}

// ── Avisos en vivo ───────────────────────────────────────────────────────────

async function branchIdOfOrder(order, transaction) {
  const { Warehouse, WorkshopBay } = require('../../models');
  if (order.warehouse_id) {
    const wh = await Warehouse.findByPk(order.warehouse_id, { attributes: ['branch_id'], transaction });
    if (wh?.branch_id) return wh.branch_id;
  }
  if (order.bay_id) {
    const bay = await WorkshopBay.findByPk(order.bay_id, { attributes: ['branch_id'], transaction });
    if (bay?.branch_id) return bay.branch_id;
  }
  return null;
}

// Emite después del commit (si hay transacción): un rollback no debe sonar
// en el TV.
function afterCommit(options, fn) {
  const run = () => { Promise.resolve().then(fn).catch((e) => console.warn('[workshop-board] aviso:', e.message)); };
  if (options?.transaction) options.transaction.afterCommit(run);
  else run();
}

async function notifyOrder(order, kind, options, extraBranchIds = []) {
  const { emitBoardEvent } = require('../workshopBoard.socket');
  const branchId = await branchIdOfOrder(order, options?.transaction);
  const branchIds = [...new Set([branchId, ...extraBranchIds].filter(Boolean))];
  if (!branchIds.length) return;
  const payload = { kind, work_order_id: order.id, order_number: order.order_number, status: order.status };
  afterCommit(options, () => branchIds.forEach((b) => emitBoardEvent(order.tenant_id, b, payload)));
}

// Cambió la configuración de bahías de la sede: refrescar sin sonido.
function notifyBranch(tenantId, branchId) {
  try {
    require('../workshopBoard.socket').emitBoardEvent(tenantId, branchId, { kind: 'refresh' });
  } catch (e) { console.warn('[workshop-board] aviso:', e.message); }
}

const safe = (fn) => async (...args) => {
  try { await fn(...args); } catch (e) { console.warn('[workshop-board] hook:', e.message); }
};

let hooksRegistered = false;
function registerBoardHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  const { WorkOrder, WorkOrderItem, WorkshopBay } = require('../../models');

  WorkOrder.addHook('afterCreate', 'workshopBoard', safe((order, options) => notifyOrder(order, 'created', options)));

  WorkOrder.addHook('afterUpdate', 'workshopBoard', safe(async (order, options) => {
    const was = (f) => order.previous(f);
    let kind = null;
    if (was('status') !== undefined && was('status') !== order.status) kind = 'status';
    else if (was('bay_id') !== undefined && (was('bay_id') || null) !== (order.bay_id || null)) kind = 'bay';
    else if (was('technician_id') !== undefined && (was('technician_id') || null) !== (order.technician_id || null)) kind = 'technician';
    else if (was('warehouse_id') !== undefined && (was('warehouse_id') || null) !== (order.warehouse_id || null)) kind = 'refresh';
    if (!kind) return;
    // Si la OT salió de una bahía o cambió de bodega, la sede anterior
    // también tiene que refrescar.
    const extra = [];
    const prevBay = was('bay_id');
    if (prevBay && prevBay !== order.bay_id) {
      const bay = await WorkshopBay.findByPk(prevBay, { attributes: ['branch_id'], transaction: options?.transaction });
      if (bay) extra.push(bay.branch_id);
    }
    await notifyOrder(order, kind, options, extra);
  }));

  const onItem = (kindFor) => safe(async (item, options) => {
    const kind = kindFor(item);
    if (!kind) return;
    const order = await WorkOrder.findByPk(item.work_order_id, {
      attributes: ['id', 'tenant_id', 'order_number', 'status', 'warehouse_id', 'bay_id'],
      transaction: options?.transaction,
    });
    if (order && ACTIVE_STATUSES.includes(order.status)) await notifyOrder(order, kind, options);
  });
  WorkOrderItem.addHook('afterCreate', 'workshopBoard', onItem((it) => (it.technician_id ? 'technician' : null)));
  WorkOrderItem.addHook('afterUpdate', 'workshopBoard', onItem((it) => {
    const prev = it.previous('technician_id');
    return prev !== undefined && (prev || null) !== (it.technician_id || null) ? 'technician' : null;
  }));
  WorkOrderItem.addHook('afterDestroy', 'workshopBoard', onItem((it) => (it.technician_id ? 'refresh' : null)));
}

module.exports = {
  ACTIVE_STATUSES,
  buildBoard,
  assertBayAssignable,
  resolveDisplayToken,
  forgetDisplayToken,
  notifyOrder,
  notifyBranch,
  registerBoardHooks,
};
