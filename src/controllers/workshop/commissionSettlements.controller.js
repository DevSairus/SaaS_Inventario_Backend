const audit = require('../../utils/audit');
const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const {
  CommissionSettlement,
  CommissionSettlementItem,
  ProductCommissionSettlement,
  ProductCommissionSettlementItem,
  WorkOrder,
  WorkOrderItem,
  Sale,
  SaleItem,
  User,
  Expense,
} = require('../../models');
const { generateExpenseNumber } = require('../finance/expenses.controller');
const logger = require('../../config/logger');

// Tipos de ítem que cuentan como mano de obra (servicios)
const SERVICE_TYPES = ['service', 'servicio', 'mano_obra'];
// Tipos de ítem que cuentan como producto/repuesto
const PRODUCT_TYPES = ['product', 'repuesto'];

// ── Helper: Items de productos por técnico (ítem-level con fallback a orden/venta) ─────────────
// Devuelve array de { uid, user_name, role, source, ref_number, ref_date, ref_id,
//                    product_name, product_sku, quantity, unit_price, subtotal, total }
async function getProductItemsByTechnician({ tenant_id, user_id, date_from, date_to, not_settled = false }) {
  const dateFilter = {};
  if (date_from) dateFilter[Op.gte] = new Date(date_from);
  if (date_to)   dateFilter[Op.lte] = new Date(date_to + 'T23:59:59');

  // ── 1. WorkOrderItems con technician_id a nivel de ítem ──────────────────
  const woItemWhere = { tenant_id, item_type: { [Op.in]: PRODUCT_TYPES } };
  if (user_id) woItemWhere.technician_id = user_id;
  else woItemWhere.technician_id = { [Op.not]: null };

  const woDateFilter = {};
  if (date_from || date_to) woDateFilter.received_at = dateFilter;
  if (not_settled) woDateFilter.product_settled_at = null;

  const woItemsWithTech = await WorkOrderItem.findAll({
    where: woItemWhere,
    include: [
      { model: WorkOrder, as: 'work_order', where: woDateFilter, required: true,
        attributes: ['id', 'order_number', 'received_at', 'status', 'created_by', 'product_settled_at'] },
      { model: User, as: 'item_technician', attributes: ['id', 'first_name', 'last_name', 'role'], required: true },
    ],
  });

  // ── 2. WorkOrders donde los items NO tienen technician_id (fallback orden) ─
  const fallbackWoWhere = { tenant_id, ...woDateFilter };
  if (user_id) fallbackWoWhere.created_by = user_id;

  const fallbackOrders = await WorkOrder.findAll({
    where: fallbackWoWhere,
    include: [
      { model: WorkOrderItem, as: 'items',
        where: { item_type: { [Op.in]: PRODUCT_TYPES }, technician_id: null },
        required: false },
      { model: User, as: 'creator_wo', attributes: ['id', 'first_name', 'last_name', 'role'] },
    ],
  });

  // ── 3. SaleItems con technician_id a nivel de ítem ────────────────────────
  const saleItemWhere = { tenant_id, item_type: { [Op.in]: ['product', 'service', 'free_line'] } };
  if (user_id) saleItemWhere.technician_id = user_id;
  else saleItemWhere.technician_id = { [Op.not]: null };

  const saleDateFilter = {};
  if (date_from || date_to) saleDateFilter.sale_date = dateFilter;
  if (not_settled) saleDateFilter.product_settled_at = null;
  // Solo ventas directas (no ligadas a OT) — se filtra abajo

  const woSaleIds = (await WorkOrder.findAll({ where: { tenant_id, sale_id: { [Op.not]: null } }, attributes: ['sale_id'], raw: true })).map(r => r.sale_id).filter(Boolean);

  const saleItemsWithTech = await SaleItem.findAll({
    where: { ...saleItemWhere, item_type: { [Op.in]: PRODUCT_TYPES } },
    include: [
      { model: Sale, as: 'sale', where: {
          ...saleDateFilter,
          status: { [Op.in]: ['completed', 'pending'] },
          document_type: { [Op.in]: ['remision', 'factura'] },
          ...(woSaleIds.length ? { id: { [Op.notIn]: woSaleIds } } : {}),
        }, required: true,
        attributes: ['id', 'sale_number', 'sale_date', 'status', 'product_settled_at'] },
      { model: User, as: 'item_technician', attributes: ['id', 'first_name', 'last_name', 'role'], required: true },
    ],
  });

  // ── 4. Ventas directas donde los items NO tienen technician_id (fallback venta) ─
  const directSalesWhere = {
    tenant_id,
    status: { [Op.in]: ['completed', 'pending'] },
    document_type: { [Op.in]: ['remision', 'factura'] },
    ...(not_settled ? { product_settled_at: null } : {}),
    ...(date_from || date_to ? { sale_date: dateFilter } : {}),
    ...(woSaleIds.length ? { id: { [Op.notIn]: woSaleIds } } : {}),
    ...(user_id ? { technician_id: user_id } : { technician_id: { [Op.not]: null } }),
  };

  const fallbackSales = await Sale.findAll({
    where: directSalesWhere,
    include: [
      { model: SaleItem, as: 'items',
        where: { item_type: { [Op.in]: PRODUCT_TYPES }, technician_id: null }, required: false },
      { model: User, as: 'technician', attributes: ['id', 'first_name', 'last_name', 'role'] },
    ],
  });

  // ── Consolidar en una lista plana ──────────────────────────────────────────
  const rows = [];

  for (const woi of woItemsWithTech) {
    const tech = woi.item_technician;
    rows.push({
      uid: tech.id, user_name: `${tech.first_name} ${tech.last_name}`, role: tech.role,
      source: 'ot', ref_number: woi.work_order.order_number, ref_date: woi.work_order.received_at,
      ref_id: woi.work_order.id, ref_settled: woi.work_order.product_settled_at,
      product_name: woi.product_name, product_sku: woi.product_sku,
      quantity: parseFloat(woi.quantity), unit_price: parseFloat(woi.unit_price),
      subtotal: parseFloat(woi.subtotal || 0), total: parseFloat(woi.total || 0),
    });
  }

  for (const order of fallbackOrders) {
    if (!order.creator_wo) continue;
    const tech = order.creator_wo;
    for (const item of (order.items || [])) {
      if (!PRODUCT_TYPES.includes(item.item_type)) continue;
      rows.push({
        uid: tech.id, user_name: `${tech.first_name} ${tech.last_name}`, role: tech.role,
        source: 'ot', ref_number: order.order_number, ref_date: order.received_at,
        ref_id: order.id, ref_settled: order.product_settled_at,
        product_name: item.product_name, product_sku: item.product_sku,
        quantity: parseFloat(item.quantity), unit_price: parseFloat(item.unit_price),
        subtotal: parseFloat(item.subtotal || 0), total: parseFloat(item.total || 0),
      });
    }
  }

  for (const si of saleItemsWithTech) {
    const tech = si.item_technician;
    rows.push({
      uid: tech.id, user_name: `${tech.first_name} ${tech.last_name}`, role: tech.role,
      source: 'sale', ref_number: si.sale.sale_number, ref_date: si.sale.sale_date,
      ref_id: si.sale.id, ref_settled: si.sale.product_settled_at,
      product_name: si.product_name, product_sku: si.product_sku,
      quantity: parseFloat(si.quantity), unit_price: parseFloat(si.unit_price),
      subtotal: parseFloat(si.subtotal || 0), total: parseFloat(si.total || 0),
    });
  }

  for (const sale of fallbackSales) {
    if (!sale.technician) continue;
    const tech = sale.technician;
    for (const item of (sale.items || [])) {
      if (!PRODUCT_TYPES.includes(item.item_type)) continue;
      rows.push({
        uid: tech.id, user_name: `${tech.first_name} ${tech.last_name}`, role: tech.role,
        source: 'sale', ref_number: sale.sale_number, ref_date: sale.sale_date,
        ref_id: sale.id, ref_settled: sale.product_settled_at,
        product_name: item.product_name, product_sku: item.product_sku,
        quantity: parseFloat(item.quantity), unit_price: parseFloat(item.unit_price),
        subtotal: parseFloat(item.subtotal || 0), total: parseFloat(item.total || 0),
      });
    }
  }

  return rows;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const addTenantScope = (where, req) => ({ ...where, tenant_id: req.user.tenant_id });

async function generateSettlementNumber(tenant_id, transaction) {
  const year = new Date().getFullYear();
  const last = await CommissionSettlement.findOne({
    where: { tenant_id, settlement_number: { [Op.like]: `LIQ-${year}-%` } },
    order: [['settlement_number', 'DESC']],
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
    transaction,
  });
  const next = last
    ? parseInt(last.settlement_number.split('-')[2], 10) + 1
    : 1;
  return `LIQ-${year}-${String(next).padStart(4, '0')}`;
}

async function generateProductSettlementNumber(tenant_id, transaction) {
  const year = new Date().getFullYear();
  const last = await ProductCommissionSettlement.findOne({
    where: { tenant_id, settlement_number: { [Op.like]: `LIQP-${year}-%` } },
    order: [['settlement_number', 'DESC']],
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
    transaction,
  });
  const next = last ? parseInt(last.settlement_number.split('-')[2], 10) + 1 : 1;
  return `LIQP-${year}-${String(next).padStart(4, '0')}`;
}

// ── Helper: ventas directas (sin OT) para un usuario ─────────────────────────
// Una venta directa = Sale que NO aparece como sale_id en ninguna WorkOrder del tenant
async function getDirectSales({ tenant_id, user_id, date_from, date_to, product_settled_field, labor_settled_field, transaction }) {
  // IDs de ventas que SÍ provienen de una OT (para excluirlas)
  const woRows = await WorkOrder.findAll({
    where: { tenant_id, sale_id: { [Op.not]: null } },
    attributes: ['sale_id'], raw: true, transaction,
  });
  const excludedIds = woRows.map(r => r.sale_id).filter(Boolean);

  const where = {
    tenant_id,
    // Ventas directas se atribuyen al TÉCNICO asignado, no al creador
    ...(user_id ? { technician_id: user_id } : { technician_id: { [Op.not]: null } }),
    status: { [Op.in]: ['completed', 'pending'] },
    document_type: { [Op.in]: ['remision', 'factura'] }, // excluir cotizaciones
    ...(excludedIds.length ? { id: { [Op.notIn]: excludedIds } } : {}),
  };

  // Filtro de fecha
  if (date_from || date_to) {
    where.sale_date = {};
    if (date_from) where.sale_date[Op.gte] = new Date(date_from);
    if (date_to)   where.sale_date[Op.lte] = new Date(date_to + 'T23:59:59');
  }

  // Excluir las ya liquidadas si se pide
  if (product_settled_field === 'null') where.product_settled_at = null;
  if (labor_settled_field   === 'null') where.labor_settled_at   = null;

  return Sale.findAll({
    where,
    include: [
      { model: SaleItem, as: 'items', attributes: ['item_type', 'product_name', 'total'] },
      { model: User, as: 'technician', attributes: ['id', 'first_name', 'last_name', 'role'] },
    ],
    order: [['sale_date', 'DESC']],
    transaction,
  });
}

function calcAmountsFromSale(sale) {
  let labor_amount = 0, product_amount = 0;
  for (const item of (sale.items || [])) {
    const total = parseFloat(item.total || 0);
    if (SERVICE_TYPES.includes(item.item_type))  labor_amount   += total;
    if (PRODUCT_TYPES.includes(item.item_type))  product_amount += total;
  }
  return { labor_amount, product_amount };
}

function calcAmountsFromOrder(order) {
  let labor_amount   = 0;
  let product_amount = 0;
  for (const item of (order.items || [])) {
    const total = parseFloat(item.total || 0);
    if (SERVICE_TYPES.includes(item.item_type))  labor_amount   += total;
    if (PRODUCT_TYPES.includes(item.item_type))  product_amount += total;
  }
  return { labor_amount, product_amount, total_amount: labor_amount + product_amount };
}

// ── INFORME DE COMISIONES POR PRODUCTOS (sin liquidar) ───────────────────────
const productCommissionReport = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { user_id, date_from, date_to, commission_percentage, show_settled } = req.query;
    const not_settled = show_settled !== 'true';

    const rows = await getProductItemsByTechnician({ tenant_id, user_id, date_from, date_to, not_settled });

    // ── Agrupar por técnico ───────────────────────────────────
    const byUser = {};
    for (const row of rows) {
      if (!byUser[row.uid]) byUser[row.uid] = {
        user_id: row.uid, user_name: row.user_name, role: row.role,
        items: [], total_products: 0, total_grand: 0,
      };
      byUser[row.uid].items.push({
        source: row.source, ref_number: row.ref_number, ref_date: row.ref_date,
        ref_id: row.ref_id, ref_settled: row.ref_settled,
        product_name: row.product_name, product_sku: row.product_sku,
        quantity: row.quantity, unit_price: row.unit_price,
        subtotal: row.subtotal, total: row.total,
      });
      byUser[row.uid].total_products += row.total;
      byUser[row.uid].total_grand    += row.total;
    }

    const pct = parseFloat(commission_percentage) || 0;
    const result = Object.values(byUser)
      .filter(u => u.items.length > 0)
      .map(u => ({
        ...u,
        commission_percentage: pct,
        commission_on_products: Math.round(u.total_products * pct / 100),
        // Para compatibilidad frontend: exponer también "orders" con agregado por OT/Venta
        orders: Object.values(
          u.items.reduce((acc, i) => {
            const key = `${i.source}::${i.ref_number}`;
            if (!acc[key]) acc[key] = { source: i.source, order_number: i.ref_number, received_at: i.ref_date, ref_id: i.ref_id, ref_settled: i.ref_settled, product_amount: 0, labor_amount: 0 };
            acc[key].product_amount += i.total;
            acc[key].total_amount = acc[key].product_amount + acc[key].labor_amount;
            return acc;
          }, {})
        ),
      }))
      .sort((a, b) => b.total_products - a.total_products);

    const summary = {
      total_users:    result.length,
      total_items:    result.reduce((s, u) => s + u.items.length, 0),
      total_products: result.reduce((s, u) => s + u.total_products, 0),
      total_labor:    0,
      commission_on_products: result.reduce((s, u) => s + u.commission_on_products, 0),
    };

    res.json({ success: true, data: result, summary, period: { date_from, date_to } });
  } catch (error) {
    logger.error('Error en informe de comisiones por productos:', error);
    res.status(500).json({ success: false, message: 'Error al generar informe' });
  }
};

// ── PREVIEW (calcular sin liquidar — mano de obra, incluye ventas directas) ────
const preview = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { technician_id, date_from, date_to, commission_percentage } = req.query;
    if (!technician_id)
      return res.status(400).json({ success: false, message: 'El técnico es requerido' });

    // OTs del técnico no liquidadas
    const woWhere = { tenant_id, technician_id, settled_at: null };
    if (date_from || date_to) {
      woWhere.received_at = {};
      if (date_from) woWhere.received_at[Op.gte] = new Date(date_from);
      if (date_to)   woWhere.received_at[Op.lte] = new Date(date_to + 'T23:59:59');
    }
    const orders = await WorkOrder.findAll({
      where: woWhere,
      include: [{ model: WorkOrderItem, as: 'items', attributes: ['item_type', 'total'] }],
      order: [['received_at', 'DESC']],
    });

    // Ventas directas del mismo usuario no liquidadas en labor
    const directSales = await getDirectSales({
      tenant_id, user_id: technician_id, date_from, date_to,
      labor_settled_field: 'null',
    });

    const items = [
      ...orders
        .map(o => ({ source: 'ot', id: o.id, ref: o.order_number, date: o.received_at, status: o.status, labor_amount: calcAmountsFromOrder(o).labor_amount }))
        .filter(o => o.labor_amount > 0),
      ...directSales
        .map(s => ({ source: 'sale', id: s.id, ref: s.sale_number, date: s.sale_date, status: s.status, labor_amount: calcAmountsFromSale(s).labor_amount }))
        .filter(s => s.labor_amount > 0),
    ];

    const base_amount = items.reduce((s, i) => s + i.labor_amount, 0);
    const pct = parseFloat(commission_percentage) || 0;

    res.json({ success: true, data: {
      technician_id, date_from, date_to, commission_percentage: pct,
      base_amount, commission_amount: Math.round(base_amount * pct / 100),
      orders: items, total_orders: items.length,
    }});
  } catch (error) {
    logger.error('Error en preview de comisión:', error);
    res.status(500).json({ success: false, message: 'Error al calcular preview' });
  }
};

// ── CREATE (liquidar mano de obra — OTs + ventas directas) ────────────────────
const create = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const tenant_id = req.user.tenant_id;
    const { technician_id, date_from, date_to, commission_percentage, notes } = req.body;
    if (!technician_id || !commission_percentage) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Técnico y porcentaje son requeridos' });
    }

    const technician = await User.findOne({ where: { id: technician_id, tenant_id }, transaction });
    if (!technician) { await transaction.rollback(); return res.status(404).json({ success: false, message: 'Técnico no encontrado' }); }

    // OTs no liquidadas
    const woWhere = { tenant_id, technician_id, settled_at: null };
    if (date_from || date_to) {
      woWhere.received_at = {};
      if (date_from) woWhere.received_at[Op.gte] = new Date(date_from);
      if (date_to)   woWhere.received_at[Op.lte] = new Date(date_to + 'T23:59:59');
    }
    const orders = await WorkOrder.findAll({
      where: woWhere,
      include: [{ model: WorkOrderItem, as: 'items', attributes: ['item_type', 'total'] }],
      transaction,
    });

    // Ventas directas no liquidadas en labor
    const directSales = await getDirectSales({
      tenant_id, user_id: technician_id, date_from, date_to,
      labor_settled_field: 'null', transaction,
    });

    const eligibleOrders = orders.map(o => ({ order: o, labor: calcAmountsFromOrder(o).labor_amount })).filter(e => e.labor > 0);
    const eligibleSales  = directSales.map(s => ({ sale: s, labor: calcAmountsFromSale(s).labor_amount })).filter(e => e.labor > 0);

    if (eligibleOrders.length === 0 && eligibleSales.length === 0) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'No hay mano de obra pendiente de liquidar en el período' });
    }

    const base_amount = [...eligibleOrders.map(e => e.labor), ...eligibleSales.map(e => e.labor)].reduce((s, v) => s + v, 0);
    const pct = parseFloat(commission_percentage);
    const commission_amount = Math.round(base_amount * pct / 100);
    const settlement_number = await generateSettlementNumber(tenant_id, transaction);

    const settlement = await CommissionSettlement.create({
      tenant_id, settlement_number, technician_id,
      date_from: date_from || null, date_to: date_to || null,
      commission_percentage: pct, base_amount, commission_amount,
      notes: notes || null, created_by: req.user.id,
    }, { transaction });

    for (const { order, labor } of eligibleOrders) {
      await CommissionSettlementItem.create({ settlement_id: settlement.id, work_order_id: order.id, order_number: order.order_number, labor_amount: labor }, { transaction });
      await WorkOrder.update({ settled_at: new Date(), settlement_id: settlement.id }, { where: { id: order.id }, transaction });
    }
    for (const { sale, labor } of eligibleSales) {
      await CommissionSettlementItem.create({ settlement_id: settlement.id, sale_id: sale.id, sale_number: sale.sale_number, labor_amount: labor }, { transaction });
      await Sale.update({ labor_settled_at: new Date(), labor_settlement_id: settlement.id }, { where: { id: sale.id }, transaction });
    }

    await transaction.commit();

    setImmediate(() => audit({ tenant_id, user_id: req.user?.id, action: 'COMMISSION_SETTLEMENT',
      entity: 'settlement', entity_id: String(Date.now()),
      changes: { technician_id }, req }));

    // Gasto operativo automático por la comisión pagada -- cierra el loop
    // financiero: antes de esto, el costo de mano de obra liquidado quedaba
    // aislado del motor de gastos/contabilidad (ver plan de rentabilidad).
    // Se crea DESPUÉS del commit del settlement (no en la misma transacción):
    // si esto falla, el settlement ya quedó registrado -- solo se loguea, no
    // se bloquea el pago real al técnico. Se reconcilia manualmente si hace falta.
    if (commission_amount > 0) {
      try {
        const expenseNumber = await generateExpenseNumber(tenant_id);
        const expense = await Expense.create({
          tenant_id,
          expense_number: expenseNumber,
          category: 'comisiones_tecnicos',
          description: `Comisión mano de obra — ${technician.first_name} ${technician.last_name} (${settlement.settlement_number})`,
          expense_date: date_to || new Date(),
          total_amount: commission_amount,
          payment_status: 'pending',
          created_by: req.user.id,
        });
        await settlement.update({ expense_id: expense.id });

        setImmediate(async () => {
          try {
            const { generateExpenseEntry } = require('../../services/accounting/autoEntries.service');
            await generateExpenseEntry(expense, tenant_id, req.user.id);
          } catch (err) {
            logger.warn(`[accounting] Error generando asiento de comisión ${settlement.id}: ${err.message}`);
          }
        });
      } catch (err) {
        logger.warn(`[finance] Error generando gasto automático de liquidación ${settlement.id}: ${err.message}`);
      }
    }

    const full = await CommissionSettlement.findByPk(settlement.id, {
      include: [
        { model: User, as: 'technician', attributes: ['id', 'first_name', 'last_name'] },
        { model: CommissionSettlementItem, as: 'items' },
      ],
    });
    res.status(201).json({ success: true, message: 'Liquidación creada correctamente', data: full });
  } catch (error) {
    await transaction.rollback();
    logger.error('Error creando liquidación:', error);
    res.status(500).json({ success: false, message: 'Error al crear la liquidación' });
  }
};

// ── LIST ──────────────────────────────────────────────────────────────────────
const list = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { page = 1, limit = 20, technician_id, date_from, date_to } = req.query;
    const offset = (page - 1) * limit;

    const where = { tenant_id };
    if (technician_id) where.technician_id = technician_id;
    if (date_from || date_to) {
      where.created_at = {};
      if (date_from) where.created_at[Op.gte] = new Date(date_from);
      if (date_to)   where.created_at[Op.lte] = new Date(date_to + 'T23:59:59');
    }

    const { count, rows } = await CommissionSettlement.findAndCountAll({
      where,
      include: [
        { model: User, as: 'technician', attributes: ['id', 'first_name', 'last_name'] },
      ],
      order: [['created_at', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset),
    });

    res.json({ success: true, data: rows, total: count, page: parseInt(page), pages: Math.ceil(count / limit) });
  } catch (error) {
    logger.error('Error listando liquidaciones:', error);
    res.status(500).json({ success: false, message: 'Error al obtener liquidaciones' });
  }
};

// ── GET BY ID ─────────────────────────────────────────────────────────────────
const getById = async (req, res) => {
  try {
    const settlement = await CommissionSettlement.findOne({
      where: { id: req.params.id, tenant_id: req.user.tenant_id },
      include: [
        { model: User, as: 'technician', attributes: ['id', 'first_name', 'last_name', 'phone'] },
        { model: User, as: 'creator_cs', attributes: ['id', 'first_name', 'last_name'] },
        {
          model: CommissionSettlementItem, as: 'items',
          include: [{ model: WorkOrder, as: 'work_order', attributes: ['id', 'order_number', 'received_at', 'status'] }],
        },
      ],
    });
    if (!settlement) return res.status(404).json({ success: false, message: 'Liquidación no encontrada' });
    res.json({ success: true, data: settlement });
  } catch (error) {
    logger.error('Error obteniendo liquidación:', error);
    res.status(500).json({ success: false, message: 'Error al obtener la liquidación' });
  }
};

// ── USERS LIST (para el selector de liquidación — todos los roles) ────────────
const getTechnicians = async (req, res) => {
  try {
    const { role } = req.query; // opcional: filtrar por rol específico

    const where = {
      tenant_id: req.user.tenant_id,
      is_active: true,
    };
    if (role) where.role = role;

    const users = await User.findAll({
      where,
      attributes: ['id', 'first_name', 'last_name', 'phone', 'role'],
      order: [['first_name', 'ASC']],
    });
    res.json({ success: true, data: users });
  } catch (error) {
    logger.error('Error obteniendo usuarios:', error);
    res.status(500).json({ success: false, message: 'Error al obtener usuarios' });
  }
};


// ── PRODUCT PREVIEW (calcular sin liquidar — incluye ventas directas) ──────────
const productPreview = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { user_id, date_from, date_to, commission_percentage } = req.query;
    if (!user_id) return res.status(400).json({ success: false, message: 'El usuario es requerido' });

    const rows = await getProductItemsByTechnician({ tenant_id, user_id, date_from, date_to, not_settled: true });

    // Agrupar por OT/Venta para mostrar en preview (compatible con UI anterior)
    const byRef = {};
    for (const row of rows) {
      const key = `${row.source}::${row.ref_number}`;
      if (!byRef[key]) byRef[key] = {
        source: row.source, id: row.ref_id, order_number: row.ref_number,
        received_at: row.ref_date, product_amount: 0, items: [],
      };
      byRef[key].product_amount += row.total;
      byRef[key].items.push({
        product_name: row.product_name, product_sku: row.product_sku,
        quantity: row.quantity, unit_price: row.unit_price, total: row.total,
      });
    }

    const items = Object.values(byRef).filter(o => o.product_amount > 0);
    const base_amount = items.reduce((s, i) => s + i.product_amount, 0);
    const pct = parseFloat(commission_percentage) || 0;

    res.json({ success: true, data: {
      user_id, date_from, date_to, commission_percentage: pct,
      base_amount, commission_amount: Math.round(base_amount * pct / 100),
      orders: items, total_orders: items.length,
      // Detalle plano por producto para la tabla del modal
      product_items: rows.map(r => ({
        source: r.source, ref_number: r.ref_number, ref_date: r.ref_date,
        product_name: r.product_name, product_sku: r.product_sku,
        quantity: r.quantity, unit_price: r.unit_price, total: r.total,
        commission: Math.round(r.total * pct / 100),
      })),
    }});
  } catch (error) {
    logger.error('Error en productPreview:', error);
    res.status(500).json({ success: false, message: 'Error al calcular preview' });
  }
};

// ── CREATE PRODUCT SETTLEMENT (liquidar productos — OTs + ventas directas) ────
const createProductSettlement = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const tenant_id = req.user.tenant_id;
    const { user_id, date_from, date_to, commission_percentage, notes } = req.body;
    if (!user_id || !commission_percentage) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Usuario y porcentaje son requeridos' });
    }

    const user = await User.findOne({ where: { id: user_id, tenant_id }, transaction });
    if (!user) { await transaction.rollback(); return res.status(404).json({ success: false, message: 'Usuario no encontrado' }); }

    // Obtener todos los ítems de producto pendientes del técnico
    const rows = await getProductItemsByTechnician({ tenant_id, user_id, date_from, date_to, not_settled: true });

    if (rows.length === 0) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'No hay productos pendientes de liquidar en el período' });
    }

    const base_amount = rows.reduce((s, r) => s + r.total, 0);
    const pct = parseFloat(commission_percentage);
    const commission_amount = Math.round(base_amount * pct / 100);
    const settlement_number = await generateProductSettlementNumber(tenant_id, transaction);

    const settlement = await ProductCommissionSettlement.create({
      tenant_id, settlement_number, user_id,
      date_from: date_from || null, date_to: date_to || null,
      commission_percentage: pct, base_amount, commission_amount,
      notes: notes || null, created_by: req.user.id,
    }, { transaction });

    // Registrar cada ítem individual con detalle de producto
    for (const row of rows) {
      await ProductCommissionSettlementItem.create({
        settlement_id:  settlement.id,
        work_order_id:  row.source === 'ot'   ? row.ref_id : null,
        order_number:   row.source === 'ot'   ? row.ref_number : null,
        sale_id:        row.source === 'sale' ? row.ref_id : null,
        sale_number:    row.source === 'sale' ? row.ref_number : null,
        product_amount: row.total,
        product_name:   row.product_name,
        product_sku:    row.product_sku,
        quantity:       row.quantity,
        unit_price:     row.unit_price,
      }, { transaction });
    }

    // Marcar los documentos padre (OT / Venta) como liquidados en productos
    const settledOtIds   = [...new Set(rows.filter(r => r.source === 'ot').map(r => r.ref_id))];
    const settledSaleIds = [...new Set(rows.filter(r => r.source === 'sale').map(r => r.ref_id))];

    if (settledOtIds.length)
      await WorkOrder.update(
        { product_settled_at: new Date(), product_settlement_id: settlement.id },
        { where: { id: { [Op.in]: settledOtIds } }, transaction }
      );
    if (settledSaleIds.length)
      await Sale.update(
        { product_settled_at: new Date(), product_settlement_id: settlement.id },
        { where: { id: { [Op.in]: settledSaleIds } }, transaction }
      );

    await transaction.commit();

    const full = await ProductCommissionSettlement.findByPk(settlement.id, {
      include: [
        { model: User, as: 'user_pcs', attributes: ['id', 'first_name', 'last_name'] },
        { model: ProductCommissionSettlementItem, as: 'items' },
      ],
    });
    res.status(201).json({ success: true, message: 'Liquidación de productos creada correctamente', data: full });
  } catch (error) {
    await transaction.rollback();
    logger.error('Error creando liquidación de productos:', error);
    res.status(500).json({ success: false, message: 'Error al crear la liquidación' });
  }
};

// ── LIST PRODUCT SETTLEMENTS ──────────────────────────────────────────────────
const listProductSettlements = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { page = 1, limit = 20, user_id, date_from, date_to } = req.query;
    const where = { tenant_id };
    if (user_id) where.user_id = user_id;
    if (date_from || date_to) {
      where.created_at = {};
      if (date_from) where.created_at[Op.gte] = new Date(date_from);
      if (date_to)   where.created_at[Op.lte] = new Date(date_to + 'T23:59:59');
    }
    const { count, rows } = await ProductCommissionSettlement.findAndCountAll({
      where,
      include: [{ model: User, as: 'user_pcs', attributes: ['id', 'first_name', 'last_name'] }],
      order: [['created_at', 'DESC']],
      limit: parseInt(limit), offset: (page - 1) * parseInt(limit),
    });
    res.json({ success: true, data: rows, total: count, page: parseInt(page), pages: Math.ceil(count / limit) });
  } catch (error) {
    logger.error('Error listando liquidaciones de productos:', error);
    res.status(500).json({ success: false, message: 'Error al obtener liquidaciones' });
  }
};

// ── GET PRODUCT SETTLEMENT BY ID ──────────────────────────────────────────────
const getProductSettlementById = async (req, res) => {
  try {
    const s = await ProductCommissionSettlement.findOne({
      where: { id: req.params.id, tenant_id: req.user.tenant_id },
      include: [
        { model: User, as: 'user_pcs', attributes: ['id', 'first_name', 'last_name'] },
        { model: User, as: 'creator_pcs', attributes: ['id', 'first_name', 'last_name'] },
        { model: ProductCommissionSettlementItem, as: 'items',
          include: [{ model: WorkOrder, as: 'work_order', attributes: ['id', 'order_number', 'received_at', 'status'] }] },
      ],
    });
    if (!s) return res.status(404).json({ success: false, message: 'Liquidación no encontrada' });
    res.json({ success: true, data: s });
  } catch (error) {
    logger.error('Error obteniendo liquidación de productos:', error);
    res.status(500).json({ success: false, message: 'Error al obtener la liquidación' });
  }
};

module.exports = { preview, create, list, getById, getTechnicians, productCommissionReport, productPreview, createProductSettlement, listProductSettlements, getProductSettlementById };