// backend/src/controllers/inventory/costAlerts.controller.js
//
// Alertas de costo de compra: variación del último costo por encima del
// umbral del tenant y precios de venta retenidos (el sugerido por margen
// quedó por debajo del actual). Las genera services/inventory/purchaseCost.service.js.
// Base: /api/inventory/cost-alerts

const logger = require('../../config/logger');
const audit = require('../../utils/audit');
const { sequelize } = require('../../config/database');
const { CostAlert, Product, User } = require('../../models');

const productAttributes = ['id', 'sku', 'name', 'base_price', 'average_cost', 'last_purchase_cost', 'profit_margin_percentage'];

const getCostAlerts = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { status = 'active', limit = 200 } = req.query;
    const where = { tenant_id };
    if (status && status !== 'all') where.status = status;

    const alerts = await CostAlert.findAll({
      where,
      include: [
        { model: Product, as: 'product', attributes: productAttributes },
        { model: User, as: 'resolver', attributes: ['id', 'first_name', 'last_name', 'email'] },
      ],
      order: [['alert_date', 'DESC']],
      limit: Math.min(parseInt(limit, 10) || 200, 500),
    });

    res.json({ success: true, data: alerts });
  } catch (error) {
    logger.error('Error en getCostAlerts:', error);
    res.status(500).json({ success: false, message: 'Error al obtener las alertas de costo' });
  }
};

const getCostAlertsStats = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const [active, priceHeld] = await Promise.all([
      CostAlert.count({ where: { tenant_id, status: 'active' } }),
      CostAlert.count({ where: { tenant_id, status: 'active', price_held: true } }),
    ]);
    res.json({ success: true, data: { active, price_held: priceHeld } });
  } catch (error) {
    logger.error('Error en getCostAlertsStats:', error);
    res.status(500).json({ success: false, message: 'Error al obtener las estadísticas de alertas de costo' });
  }
};

/**
 * Resolver una alerta. Con apply_price = true, además aplica al producto el
 * precio sugerido que quedó retenido (la única forma de que el precio baje).
 */
const resolveCostAlert = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const tenant_id = req.user.tenant_id;
    const { id } = req.params;
    const { resolution_notes, apply_price } = req.body;

    const alert = await CostAlert.findOne({ where: { id, tenant_id }, transaction: t, lock: t.LOCK.UPDATE });
    if (!alert) {
      await t.rollback();
      return res.status(404).json({ success: false, message: 'Alerta no encontrada' });
    }
    if (alert.status !== 'active') {
      await t.rollback();
      return res.status(400).json({ success: false, message: 'La alerta ya fue resuelta o ignorada' });
    }

    let appliedPrice = null;
    if (apply_price) {
      const suggested = parseFloat(alert.suggested_price);
      if (!alert.price_held || !(suggested > 0)) {
        await t.rollback();
        return res.status(400).json({ success: false, message: 'Esta alerta no tiene un precio sugerido pendiente por aplicar' });
      }
      const product = await Product.findOne({ where: { id: alert.product_id, tenant_id }, transaction: t });
      if (!product) {
        await t.rollback();
        return res.status(404).json({ success: false, message: 'Producto no encontrado' });
      }
      await product.update({ base_price: suggested }, { transaction: t });
      appliedPrice = suggested;
    }

    await alert.update({
      status: 'resolved',
      resolved_date: new Date(),
      resolved_by: req.user.id,
      resolution_notes: resolution_notes || null,
      price_applied: appliedPrice !== null,
    }, { transaction: t });

    await t.commit();

    setImmediate(() => audit({
      tenant_id, user_id: req.user.id, action: 'COST_ALERT_RESOLVED',
      entity: 'cost_alert', entity_id: alert.id,
      changes: { product_id: alert.product_id, applied_price: appliedPrice },
      req,
    }));

    res.json({
      success: true,
      message: appliedPrice !== null ? 'Precio de venta actualizado y alerta resuelta' : 'Alerta marcada como revisada',
      data: alert,
    });
  } catch (error) {
    if (!t.finished) await t.rollback();
    logger.error('Error en resolveCostAlert:', error);
    res.status(500).json({ success: false, message: 'Error al resolver la alerta de costo' });
  }
};

const ignoreCostAlert = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const alert = await CostAlert.findOne({ where: { id: req.params.id, tenant_id } });
    if (!alert) return res.status(404).json({ success: false, message: 'Alerta no encontrada' });
    if (alert.status !== 'active') return res.status(400).json({ success: false, message: 'La alerta ya fue resuelta o ignorada' });

    await alert.update({
      status: 'ignored',
      resolved_date: new Date(),
      resolved_by: req.user.id,
      resolution_notes: req.body?.resolution_notes || null,
    });
    res.json({ success: true, message: 'Alerta ignorada', data: alert });
  } catch (error) {
    logger.error('Error en ignoreCostAlert:', error);
    res.status(500).json({ success: false, message: 'Error al ignorar la alerta de costo' });
  }
};

module.exports = { getCostAlerts, getCostAlertsStats, resolveCostAlert, ignoreCostAlert };
