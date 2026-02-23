const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const {
  CommissionSettlement,
  CommissionSettlementItem,
  WorkOrder,
  WorkOrderItem,
  User,
} = require('../../models');
const logger = require('../../config/logger');

const SERVICE_TYPES = ['service', 'servicio', 'mano_obra'];

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

function calcLaborFromOrder(order) {
  return (order.items || []).reduce((sum, item) => {
    if (SERVICE_TYPES.includes(item.item_type)) {
      return sum + parseFloat(item.total || 0);
    }
    return sum;
  }, 0);
}

// ── PREVIEW (calcular sin liquidar) ──────────────────────────────────────────
const preview = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { technician_id, date_from, date_to, commission_percentage } = req.query;

    if (!technician_id) {
      return res.status(400).json({ success: false, message: 'El técnico es requerido' });
    }

    const where = {
      tenant_id,
      technician_id,
      settled_at: null, // Solo OTs NO liquidadas previamente
    };

    if (date_from || date_to) {
      where.received_at = {};
      if (date_from) where.received_at[Op.gte] = new Date(date_from);
      if (date_to)   where.received_at[Op.lte] = new Date(date_to + 'T23:59:59');
    }

    const orders = await WorkOrder.findAll({
      where,
      include: [
        { model: WorkOrderItem, as: 'items', attributes: ['item_type', 'total'] },
      ],
      order: [['received_at', 'DESC']],
    });

    const orderSummary = orders.map(o => ({
      id: o.id,
      order_number: o.order_number,
      received_at: o.received_at,
      status: o.status,
      labor_amount: calcLaborFromOrder(o),
    })).filter(o => o.labor_amount > 0);

    const base_amount = orderSummary.reduce((s, o) => s + o.labor_amount, 0);
    const pct = parseFloat(commission_percentage) || 0;
    const commission_amount = Math.round(base_amount * pct / 100);

    res.json({
      success: true,
      data: {
        technician_id,
        date_from,
        date_to,
        commission_percentage: pct,
        base_amount,
        commission_amount,
        orders: orderSummary,
        total_orders: orderSummary.length,
      },
    });
  } catch (error) {
    logger.error('Error en preview de comisión:', error);
    res.status(500).json({ success: false, message: 'Error al calcular preview' });
  }
};

// ── CREATE (liquidar) ─────────────────────────────────────────────────────────
const create = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const tenant_id = req.user.tenant_id;
    const {
      technician_id,
      date_from,
      date_to,
      commission_percentage,
      notes,
    } = req.body;

    if (!technician_id || !commission_percentage) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Técnico y porcentaje son requeridos' });
    }

    // Verificar que el técnico existe y pertenece al tenant
    const technician = await User.findOne({ where: { id: technician_id, tenant_id }, transaction });
    if (!technician) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Técnico no encontrado' });
    }

    // Buscar OTs no liquidadas del técnico en el período
    const where = {
      tenant_id,
      technician_id,
      settled_at: null,
    };
    if (date_from || date_to) {
      where.received_at = {};
      if (date_from) where.received_at[Op.gte] = new Date(date_from);
      if (date_to)   where.received_at[Op.lte] = new Date(date_to + 'T23:59:59');
    }

    const orders = await WorkOrder.findAll({
      where,
      include: [{ model: WorkOrderItem, as: 'items', attributes: ['item_type', 'total'] }],
      transaction,
    });

    const eligibleOrders = orders
      .map(o => ({ order: o, labor: calcLaborFromOrder(o) }))
      .filter(e => e.labor > 0);

    if (eligibleOrders.length === 0) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: 'No hay órdenes con mano de obra pendiente de liquidar en el período',
      });
    }

    const base_amount = eligibleOrders.reduce((s, e) => s + e.labor, 0);
    const pct = parseFloat(commission_percentage);
    const commission_amount = Math.round(base_amount * pct / 100);
    const settlement_number = await generateSettlementNumber(tenant_id, transaction);

    // Crear liquidación
    const settlement = await CommissionSettlement.create({
      tenant_id,
      settlement_number,
      technician_id,
      date_from: date_from || null,
      date_to: date_to || null,
      commission_percentage: pct,
      base_amount,
      commission_amount,
      notes: notes || null,
      created_by: req.user.id,
    }, { transaction });

    // Crear items y marcar OTs como liquidadas
    for (const { order, labor } of eligibleOrders) {
      await CommissionSettlementItem.create({
        settlement_id: settlement.id,
        work_order_id: order.id,
        order_number: order.order_number,
        labor_amount: labor,
      }, { transaction });

      await WorkOrder.update(
        { settled_at: new Date(), settlement_id: settlement.id },
        { where: { id: order.id }, transaction }
      );
    }

    await transaction.commit();

    // Devolver liquidación completa
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

// ── TECHNICIANS LIST (para el selector) ──────────────────────────────────────
const getTechnicians = async (req, res) => {
  try {
    const technicians = await User.findAll({
      where: {
        tenant_id: req.user.tenant_id,
        role: 'technician',
        is_active: true,
      },
      attributes: ['id', 'first_name', 'last_name', 'phone'],
      order: [['first_name', 'ASC']],
    });
    res.json({ success: true, data: technicians });
  } catch (error) {
    logger.error('Error obteniendo técnicos:', error);
    res.status(500).json({ success: false, message: 'Error al obtener técnicos' });
  }
};

module.exports = { preview, create, list, getById, getTechnicians };