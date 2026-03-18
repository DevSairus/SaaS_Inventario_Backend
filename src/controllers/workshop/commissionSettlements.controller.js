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
} = require('../../models');
const logger = require('../../config/logger');

// Tipos de ítem que cuentan como mano de obra (servicios)
const SERVICE_TYPES = ['service', 'servicio', 'mano_obra'];
// Tipos de ítem que cuentan como producto/repuesto
const PRODUCT_TYPES = ['product', 'repuesto'];

// ── Helpers ───────────────────────────────────────────────────────────────────

const addTenantScope = (where, req) => ({ ...where, tenant_id: req.user.tenant_id });

async function generateSettlementNumber(tenant_id, transaction) {
  const year = new Date().getFullYear();
  const last = await CommissionSettlement.findOne({
    where: { tenant_id, settlement_number: { [Op.like]: `LIQ-${year}-%` } },
    order: [['created_at', 'DESC']],
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
    order: [['created_at', 'DESC']],
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

    // ── OTs ──────────────────────────────────────────────────
    const woWhere = { tenant_id };
    if (user_id) woWhere.created_by = user_id;
    if (show_settled !== 'true') woWhere.product_settled_at = null;
    if (date_from || date_to) {
      woWhere.received_at = {};
      if (date_from) woWhere.received_at[Op.gte] = new Date(date_from);
      if (date_to)   woWhere.received_at[Op.lte] = new Date(date_to + 'T23:59:59');
    }
    const orders = await WorkOrder.findAll({
      where: woWhere,
      include: [
        { model: WorkOrderItem, as: 'items', attributes: ['item_type', 'product_name', 'quantity', 'unit_price', 'total'] },
        { model: User, as: 'creator_wo', attributes: ['id', 'first_name', 'last_name', 'role'] },
      ],
      order: [['received_at', 'DESC']],
    });

    // ── Ventas directas ───────────────────────────────────────
    const directSales = await getDirectSales({
      tenant_id, user_id, date_from, date_to,
      product_settled_field: show_settled !== 'true' ? 'null' : null,
    });

    // ── Agrupar por usuario ───────────────────────────────────
    const byUser = {};
    const ensureUser = (uid, label, role) => {
      if (!byUser[uid]) byUser[uid] = {
        user_id: uid === '__sin__' ? null : uid,
        user_name: label, role,
        orders: [], total_products: 0, total_labor: 0, total_grand: 0,
      };
    };

    for (const o of orders) {
      const uid = o.created_by || '__sin__';
      const label = o.creator_wo ? `${o.creator_wo.first_name} ${o.creator_wo.last_name}` : 'Sin usuario';
      ensureUser(uid, label, o.creator_wo?.role || '—');
      const { labor_amount, product_amount } = calcAmountsFromOrder(o);
      if (product_amount === 0 && labor_amount === 0) continue;
      byUser[uid].orders.push({ source: 'ot', order_number: o.order_number, received_at: o.received_at, status: o.status, labor_amount, product_amount, total_amount: labor_amount + product_amount });
      byUser[uid].total_products += product_amount;
      byUser[uid].total_labor    += labor_amount;
      byUser[uid].total_grand    += labor_amount + product_amount;
    }
    for (const s of directSales) {
      const uid = s.technician_id || '__sin__';
      const label = s.technician ? `${s.technician.first_name} ${s.technician.last_name}` : 'Sin técnico';
      ensureUser(uid, label, s.technician?.role || 'technician');
      const { labor_amount, product_amount } = calcAmountsFromSale(s);
      if (product_amount === 0 && labor_amount === 0) continue;
      byUser[uid].orders.push({ source: 'sale', order_number: s.sale_number, received_at: s.sale_date, status: s.status, labor_amount, product_amount, total_amount: labor_amount + product_amount });
      byUser[uid].total_products += product_amount;
      byUser[uid].total_labor    += labor_amount;
      byUser[uid].total_grand    += labor_amount + product_amount;
    }

    const pct = parseFloat(commission_percentage) || 0;
    const result = Object.values(byUser)
      .filter(u => u.orders.length > 0)
      .map(u => ({ ...u, commission_percentage: pct, commission_on_products: Math.round(u.total_products * pct / 100) }))
      .sort((a, b) => b.total_products - a.total_products);

    const summary = {
      total_users:    result.length,
      total_orders:   result.reduce((s, u) => s + u.orders.length, 0),
      total_products: result.reduce((s, u) => s + u.total_products, 0),
      total_labor:    result.reduce((s, u) => s + u.total_labor, 0),
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

    // OTs no liquidadas en productos
    const woWhere = { tenant_id, created_by: user_id, product_settled_at: null };
    if (date_from || date_to) {
      woWhere.received_at = {};
      if (date_from) woWhere.received_at[Op.gte] = new Date(date_from);
      if (date_to)   woWhere.received_at[Op.lte] = new Date(date_to + 'T23:59:59');
    }
    const orders = await WorkOrder.findAll({
      where: woWhere,
      include: [{ model: WorkOrderItem, as: 'items', attributes: ['item_type', 'product_name', 'total'] }],
      order: [['received_at', 'DESC']],
    });

    // Ventas directas no liquidadas en productos
    const directSales = await getDirectSales({
      tenant_id, user_id, date_from, date_to,
      product_settled_field: 'null',
    });

    const items = [
      ...orders
        .map(o => ({ source: 'ot', id: o.id, order_number: o.order_number, received_at: o.received_at, status: o.status, product_amount: calcAmountsFromOrder(o).product_amount }))
        .filter(o => o.product_amount > 0),
      ...directSales
        .map(s => ({ source: 'sale', id: s.id, order_number: s.sale_number, received_at: s.sale_date, status: s.status, product_amount: calcAmountsFromSale(s).product_amount }))
        .filter(s => s.product_amount > 0),
    ];

    const base_amount = items.reduce((s, i) => s + i.product_amount, 0);
    const pct = parseFloat(commission_percentage) || 0;

    res.json({ success: true, data: {
      user_id, date_from, date_to, commission_percentage: pct,
      base_amount, commission_amount: Math.round(base_amount * pct / 100),
      orders: items, total_orders: items.length,
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

    // OTs no liquidadas en productos
    const woWhere = { tenant_id, created_by: user_id, product_settled_at: null };
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

    // Ventas directas no liquidadas en productos
    const directSales = await getDirectSales({
      tenant_id, user_id, date_from, date_to,
      product_settled_field: 'null', transaction,
    });

    const eligibleOrders = orders.map(o => ({ order: o, product: calcAmountsFromOrder(o).product_amount })).filter(e => e.product > 0);
    const eligibleSales  = directSales.map(s => ({ sale: s, product: calcAmountsFromSale(s).product_amount })).filter(e => e.product > 0);

    if (eligibleOrders.length === 0 && eligibleSales.length === 0) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'No hay órdenes con productos pendientes de liquidar en el período' });
    }

    const base_amount = [...eligibleOrders.map(e => e.product), ...eligibleSales.map(e => e.product)].reduce((s, v) => s + v, 0);
    const pct = parseFloat(commission_percentage);
    const commission_amount = Math.round(base_amount * pct / 100);
    const settlement_number = await generateProductSettlementNumber(tenant_id, transaction);

    const settlement = await ProductCommissionSettlement.create({
      tenant_id, settlement_number, user_id,
      date_from: date_from || null, date_to: date_to || null,
      commission_percentage: pct, base_amount, commission_amount,
      notes: notes || null, created_by: req.user.id,
    }, { transaction });

    for (const { order, product } of eligibleOrders) {
      await ProductCommissionSettlementItem.create({
        settlement_id: settlement.id, work_order_id: order.id,
        order_number: order.order_number, product_amount: product,
      }, { transaction });
      await WorkOrder.update(
        { product_settled_at: new Date(), product_settlement_id: settlement.id },
        { where: { id: order.id }, transaction }
      );
    }
    for (const { sale, product } of eligibleSales) {
      await ProductCommissionSettlementItem.create({
        settlement_id: settlement.id, sale_id: sale.id,
        sale_number: sale.sale_number, product_amount: product,
      }, { transaction });
      await Sale.update(
        { product_settled_at: new Date(), product_settlement_id: settlement.id },
        { where: { id: sale.id }, transaction }
      );
    }

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