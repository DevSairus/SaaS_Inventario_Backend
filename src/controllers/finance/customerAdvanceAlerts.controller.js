// backend/src/controllers/finance/customerAdvanceAlerts.controller.js
//
// Alertas de antigüedad de Anticipos de Clientes sin aplicar (Fase 4,
// punto 2 de Anticipos-Clientes-Analisis-y-Plan.md §10). Mismo patrón que
// controllers/payableAlerts.controller.js y controllers/stockAlerts.controller.js.
const { CustomerAdvanceAlert, CustomerAdvance, Customer, User } = require('../../models');
const { sequelize } = require('../../config/database');
const { checkAllAdvanceAlerts } = require('../../middleware/autoCheckAdvanceAlerts.middleware');

const includeAdvance = {
  model: CustomerAdvance,
  as: 'advance',
  required: false,
  attributes: ['id', 'advance_number', 'amount', 'balance', 'received_date', 'method', 'reference_note'],
};

const includeCustomer = {
  model: Customer,
  as: 'customer',
  required: false,
  attributes: ['id', 'first_name', 'last_name', 'business_name', 'tax_id', 'phone'],
};

// GET /customer-advance-alerts
const getAdvanceAlerts = async (req, res) => {
  try {
    if (!req.tenant_id) {
      return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
    }

    const {
      alert_type,
      severity,
      status = 'active',
      sort_by = 'days_since_received',
      sort_order = 'DESC',
      page = 1,
      limit = 20,
    } = req.query;

    const tenant_id = req.tenant_id;
    const maxLimit = Math.min(Math.max(1, parseInt(limit) || 20), 200);
    const offset = (page - 1) * maxLimit;

    const where = { tenant_id };
    if (status) where.status = status;
    if (alert_type) where.alert_type = alert_type;
    if (severity) where.severity = severity;

    const { count, rows } = await CustomerAdvanceAlert.findAndCountAll({
      where,
      include: [
        includeAdvance,
        includeCustomer,
        { model: User, as: 'resolver', required: false, attributes: ['id', 'first_name', 'last_name', 'email'] },
      ],
      order: [[sort_by, sort_order.toUpperCase()]],
      limit: maxLimit,
      offset: parseInt(offset),
      distinct: true,
    });

    res.json({
      success: true,
      data: rows,
      pagination: {
        total: count,
        page: parseInt(page),
        limit: maxLimit,
        pages: Math.ceil(count / maxLimit),
      },
    });
  } catch (error) {
    console.error('Error en getAdvanceAlerts:', error);
    res.status(500).json({ success: false, message: 'Error al obtener alertas de anticipos' });
  }
};

// GET /customer-advance-alerts/:id
const getAdvanceAlertById = async (req, res) => {
  try {
    const { id } = req.params;
    const tenant_id = req.tenant_id;

    const alert = await CustomerAdvanceAlert.findOne({
      where: { id, tenant_id },
      include: [
        includeAdvance,
        includeCustomer,
        { model: User, as: 'resolver', attributes: ['id', 'first_name', 'last_name', 'email'] },
      ],
    });

    if (!alert) {
      return res.status(404).json({ success: false, message: 'Alerta no encontrada' });
    }

    res.json({ success: true, data: alert });
  } catch (error) {
    console.error('Error en getAdvanceAlertById:', error);
    res.status(500).json({ success: false, message: 'Error al obtener la alerta' });
  }
};

// PATCH /customer-advance-alerts/:id/resolve
const resolveAdvanceAlert = async (req, res) => {
  try {
    const { id } = req.params;
    const { resolution_notes } = req.body;
    const tenant_id = req.tenant_id;
    const user_id = req.user_id || req.user?.id;

    const alert = await CustomerAdvanceAlert.findOne({ where: { id, tenant_id } });
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
      resolution_notes,
    });

    const updatedAlert = await CustomerAdvanceAlert.findOne({
      where: { id },
      include: [includeAdvance, includeCustomer, { model: User, as: 'resolver', attributes: ['id', 'first_name', 'last_name'] }],
    });

    res.json({ success: true, message: 'Alerta resuelta exitosamente', data: updatedAlert });
  } catch (error) {
    console.error('Error en resolveAdvanceAlert:', error);
    res.status(500).json({ success: false, message: 'Error al resolver la alerta' });
  }
};

// PATCH /customer-advance-alerts/:id/ignore
const ignoreAdvanceAlert = async (req, res) => {
  try {
    const { id } = req.params;
    const { resolution_notes } = req.body;
    const tenant_id = req.tenant_id;
    const user_id = req.user_id || req.user?.id;

    const alert = await CustomerAdvanceAlert.findOne({ where: { id, tenant_id } });
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
      resolution_notes: resolution_notes || 'Ignorada manualmente',
    });

    res.json({ success: true, message: 'Alerta ignorada', data: alert });
  } catch (error) {
    console.error('Error en ignoreAdvanceAlert:', error);
    res.status(500).json({ success: false, message: 'Error al ignorar la alerta' });
  }
};

// PATCH /customer-advance-alerts/:id/reactivate
const reactivateAdvanceAlert = async (req, res) => {
  try {
    const { id } = req.params;
    const tenant_id = req.tenant_id;

    const alert = await CustomerAdvanceAlert.findOne({ where: { id, tenant_id } });
    if (!alert) {
      return res.status(404).json({ success: false, message: 'Alerta no encontrada' });
    }

    await alert.update({
      status: 'active',
      resolved_date: null,
      resolved_by: null,
      resolution_notes: null,
    });

    res.json({ success: true, message: 'Alerta reactivada', data: alert });
  } catch (error) {
    console.error('Error en reactivateAdvanceAlert:', error);
    res.status(500).json({ success: false, message: 'Error al reactivar la alerta' });
  }
};

// GET /customer-advance-alerts/stats
const getAdvanceAlertsStats = async (req, res) => {
  try {
    const tenant_id = req.tenant_id;

    const totalActive = await CustomerAdvanceAlert.count({ where: { tenant_id, status: 'active' } });
    const staleAlerts = await CustomerAdvanceAlert.count({
      where: { tenant_id, status: 'active', alert_type: 'stale' },
    });
    const veryStaleAlerts = await CustomerAdvanceAlert.count({
      where: { tenant_id, status: 'active', alert_type: 'very_stale' },
    });
    const totalBalanceActive = await CustomerAdvanceAlert.sum('balance', {
      where: { tenant_id, status: 'active' },
    });

    const bySeverity = await CustomerAdvanceAlert.findAll({
      where: { tenant_id, status: 'active' },
      attributes: ['severity', [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
      group: ['severity'],
      raw: true,
    });

    const severityStats = { info: 0, warning: 0, critical: 0 };
    bySeverity.forEach((item) => {
      severityStats[item.severity] = parseInt(item.count);
    });

    res.json({
      success: true,
      data: {
        total_active: totalActive,
        stale: staleAlerts,
        very_stale: veryStaleAlerts,
        total_balance_active: parseFloat(totalBalanceActive) || 0,
        by_severity: severityStats,
      },
    });
  } catch (error) {
    console.error('Error en getAdvanceAlertsStats:', error);
    res.status(500).json({ success: false, message: 'Error al obtener estadísticas de alertas' });
  }
};

// GET /customer-advance-alerts/aging — informe de antigüedad de saldos por rango de días
const getAdvancesAging = async (req, res) => {
  try {
    const tenant_id = req.tenant_id;

    const buckets = await CustomerAdvance.findAll({
      where: { tenant_id, status: 'active' },
      attributes: [
        'id', 'customer_id', 'advance_number', 'balance', 'received_date',
      ],
      include: [{ model: Customer, as: 'customer', attributes: ['id', 'first_name', 'last_name', 'business_name'] }],
      order: [['received_date', 'ASC']],
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const ranges = { '0-30': [], '31-60': [], '61-90': [], '90+': [] };
    for (const advance of buckets) {
      const received = new Date(advance.received_date);
      received.setHours(0, 0, 0, 0);
      const days = Math.max(0, Math.round((today - received) / (1000 * 60 * 60 * 24)));
      const bucket = days <= 30 ? '0-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : '90+';
      ranges[bucket].push({ ...advance.toJSON(), days_since_received: days });
    }

    const summary = Object.fromEntries(
      Object.entries(ranges).map(([key, items]) => [
        key,
        { count: items.length, total_balance: items.reduce((sum, a) => sum + parseFloat(a.balance), 0) },
      ])
    );

    res.json({ success: true, data: ranges, summary });
  } catch (error) {
    console.error('Error en getAdvancesAging:', error);
    res.status(500).json({ success: false, message: 'Error al obtener la antigüedad de saldos' });
  }
};

// POST /customer-advance-alerts/check
const checkAndCreateAlerts = async (req, res) => {
  try {
    const tenant_id = req.tenant_id;
    const result = await checkAllAdvanceAlerts(tenant_id);

    res.json({
      success: true,
      message: 'Verificación de alertas de anticipos completada',
      data: result,
    });
  } catch (error) {
    console.error('Error en checkAndCreateAlerts (customer advances):', error);
    res.status(500).json({ success: false, message: 'Error al verificar alertas' });
  }
};

module.exports = {
  getAdvanceAlerts,
  getAdvanceAlertById,
  resolveAdvanceAlert,
  ignoreAdvanceAlert,
  reactivateAdvanceAlert,
  getAdvanceAlertsStats,
  getAdvancesAging,
  checkAndCreateAlerts,
};
