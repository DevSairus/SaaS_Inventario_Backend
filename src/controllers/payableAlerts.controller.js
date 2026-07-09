const { PayableAlert, Purchase, Supplier, User } = require('../models');
const { Op } = require('sequelize');
const { sequelize } = require('../config/database');
const { checkAllPayableAlerts } = require('../middleware/autoCheckPayableAlerts.middleware');

const includePurchase = {
  model: Purchase,
  as: 'purchase',
  required: false,
  attributes: [
    'id', 'purchase_number', 'purchase_date', 'due_date', 'invoice_number',
    'total_amount', 'paid_amount', 'payment_status', 'supplier_id'
  ],
  include: [
    {
      model: Supplier,
      as: 'supplier',
      required: false,
      attributes: ['id', 'name', 'tax_id', 'email', 'phone']
    }
  ]
};

/**
 * Obtener todas las alertas de cuentas por pagar con filtros y paginación
 */
const getPayableAlerts = async (req, res) => {
  try {
    if (!req.user?.tenant_id) {
      return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
    }

    const {
      alert_type,
      severity,
      status = 'active',
      sort_by = 'days_to_due',
      sort_order = 'ASC',
      page = 1,
      limit = 20
    } = req.query;

    const tenant_id = req.user.tenant_id;
    const maxLimit = Math.min(Math.max(1, parseInt(limit) || 20), 200);
    const offset = (page - 1) * maxLimit;

    const where = { tenant_id };
    if (status) where.status = status;
    if (alert_type) where.alert_type = alert_type;
    if (severity) where.severity = severity;

    const { count, rows } = await PayableAlert.findAndCountAll({
      where,
      include: [
        includePurchase,
        {
          model: User,
          as: 'resolver',
          required: false,
          attributes: ['id', 'first_name', 'last_name', 'email']
        }
      ],
      order: [[sort_by, sort_order.toUpperCase()]],
      limit: maxLimit,
      offset: parseInt(offset),
      distinct: true
    });

    res.json({
      success: true,
      data: rows,
      pagination: {
        total: count,
        page: parseInt(page),
        limit: maxLimit,
        pages: Math.ceil(count / maxLimit)
      }
    });
  } catch (error) {
    console.error('Error en getPayableAlerts:', error);
    res.status(500).json({ success: false, message: 'Error al obtener alertas de cuentas por pagar' });
  }
};

/**
 * Obtener una alerta por ID
 */
const getPayableAlertById = async (req, res) => {
  try {
    const { id } = req.params;
    const tenant_id = req.user.tenant_id;

    const alert = await PayableAlert.findOne({
      where: { id, tenant_id },
      include: [
        includePurchase,
        { model: User, as: 'resolver', attributes: ['id', 'first_name', 'last_name', 'email'] }
      ]
    });

    if (!alert) {
      return res.status(404).json({ success: false, message: 'Alerta no encontrada' });
    }

    res.json({ success: true, data: alert });
  } catch (error) {
    console.error('Error en getPayableAlertById:', error);
    res.status(500).json({ success: false, message: 'Error al obtener la alerta' });
  }
};

/**
 * Resolver una alerta manualmente (ej. ya se gestionó el pago fuera del flujo estándar)
 */
const resolvePayableAlert = async (req, res) => {
  try {
    const { id } = req.params;
    const { resolution_notes } = req.body;
    const tenant_id = req.user.tenant_id;
    const user_id = req.user.id;

    const alert = await PayableAlert.findOne({ where: { id, tenant_id } });
    if (!alert) {
      return res.status(404).json({ success: false, message: 'Alerta no encontrada' });
    }
    if (alert.status !== 'active') {
      return res.status(400).json({ success: false, message: 'La alerta ya fue resuelta o ignorada' });
    }

    await alert.update({
      status: 'resolved',
      resolved_date: new Date(),
      resolved_by: user_id,
      resolution_notes
    });

    const updatedAlert = await PayableAlert.findOne({
      where: { id },
      include: [includePurchase, { model: User, as: 'resolver', attributes: ['id', 'first_name', 'last_name'] }]
    });

    res.json({ success: true, message: 'Alerta resuelta exitosamente', data: updatedAlert });
  } catch (error) {
    console.error('Error en resolvePayableAlert:', error);
    res.status(500).json({ success: false, message: 'Error al resolver la alerta' });
  }
};

/**
 * Ignorar una alerta (silenciarla sin marcarla como resuelta/pagada)
 */
const ignorePayableAlert = async (req, res) => {
  try {
    const { id } = req.params;
    const { resolution_notes } = req.body;
    const tenant_id = req.user.tenant_id;
    const user_id = req.user.id;

    const alert = await PayableAlert.findOne({ where: { id, tenant_id } });
    if (!alert) {
      return res.status(404).json({ success: false, message: 'Alerta no encontrada' });
    }
    if (alert.status !== 'active') {
      return res.status(400).json({ success: false, message: 'La alerta ya fue resuelta o ignorada' });
    }

    await alert.update({
      status: 'ignored',
      resolved_date: new Date(),
      resolved_by: user_id,
      resolution_notes: resolution_notes || 'Ignorada manualmente'
    });

    res.json({ success: true, message: 'Alerta ignorada', data: alert });
  } catch (error) {
    console.error('Error en ignorePayableAlert:', error);
    res.status(500).json({ success: false, message: 'Error al ignorar la alerta' });
  }
};

/**
 * Reactivar una alerta previamente resuelta o ignorada
 */
const reactivatePayableAlert = async (req, res) => {
  try {
    const { id } = req.params;
    const tenant_id = req.user.tenant_id;

    const alert = await PayableAlert.findOne({ where: { id, tenant_id } });
    if (!alert) {
      return res.status(404).json({ success: false, message: 'Alerta no encontrada' });
    }

    await alert.update({
      status: 'active',
      resolved_date: null,
      resolved_by: null,
      resolution_notes: null
    });

    res.json({ success: true, message: 'Alerta reactivada', data: alert });
  } catch (error) {
    console.error('Error en reactivatePayableAlert:', error);
    res.status(500).json({ success: false, message: 'Error al reactivar la alerta' });
  }
};

/**
 * Eliminar una alerta
 */
const deletePayableAlert = async (req, res) => {
  try {
    const { id } = req.params;
    const tenant_id = req.user.tenant_id;

    const alert = await PayableAlert.findOne({ where: { id, tenant_id } });
    if (!alert) {
      return res.status(404).json({ success: false, message: 'Alerta no encontrada' });
    }

    await alert.destroy();
    res.json({ success: true, message: 'Alerta eliminada exitosamente' });
  } catch (error) {
    console.error('Error en deletePayableAlert:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar la alerta' });
  }
};

/**
 * Estadísticas de alertas de cuentas por pagar
 */
const getPayableAlertsStats = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;

    const totalActive = await PayableAlert.count({ where: { tenant_id, status: 'active' } });
    const overdueAlerts = await PayableAlert.count({
      where: { tenant_id, status: 'active', alert_type: 'overdue' }
    });
    const dueSoonAlerts = await PayableAlert.count({
      where: { tenant_id, status: 'active', alert_type: 'due_soon' }
    });

    const totalBalanceActive = await PayableAlert.sum('balance', {
      where: { tenant_id, status: 'active' }
    });

    const bySeverity = await PayableAlert.findAll({
      where: { tenant_id, status: 'active' },
      attributes: ['severity', [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
      group: ['severity'],
      raw: true
    });

    const severityStats = { info: 0, warning: 0, critical: 0 };
    bySeverity.forEach(item => {
      severityStats[item.severity] = parseInt(item.count);
    });

    res.json({
      success: true,
      data: {
        total_active: totalActive,
        overdue: overdueAlerts,
        due_soon: dueSoonAlerts,
        total_balance_active: parseFloat(totalBalanceActive) || 0,
        by_severity: severityStats
      }
    });
  } catch (error) {
    console.error('Error en getPayableAlertsStats:', error);
    res.status(500).json({ success: false, message: 'Error al obtener estadísticas de alertas' });
  }
};

/**
 * Verificar y crear/actualizar/resolver alertas manualmente (botón "Verificar alertas")
 */
const checkAndCreateAlerts = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const result = await checkAllPayableAlerts(tenant_id);

    res.json({
      success: true,
      message: 'Verificación de alertas de cuentas por pagar completada',
      data: result
    });
  } catch (error) {
    console.error('Error en checkAndCreateAlerts (payable):', error);
    res.status(500).json({ success: false, message: 'Error al verificar alertas' });
  }
};

module.exports = {
  getPayableAlerts,
  getPayableAlertById,
  resolvePayableAlert,
  ignorePayableAlert,
  reactivatePayableAlert,
  deletePayableAlert,
  getPayableAlertsStats,
  checkAndCreateAlerts
};
