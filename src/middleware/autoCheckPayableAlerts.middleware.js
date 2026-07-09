// backend/src/middleware/autoCheckPayableAlerts.middleware.js
const { PayableAlert, Purchase } = require('../models');
const { Op } = require('sequelize');

/**
 * Middleware para verificar y crear alertas automáticamente
 * sobre cuentas por pagar próximas a vencer o vencidas.
 *
 * Umbral de "próxima a vencer": configurable via PAYABLE_ALERT_DUE_SOON_DAYS
 * (por defecto 3 días antes del vencimiento).
 */

const DUE_SOON_DAYS = parseInt(process.env.PAYABLE_ALERT_DUE_SOON_DAYS, 10) || 3;

function calcDaysToDue(dueDate) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);
  return Math.round((due - today) / (1000 * 60 * 60 * 24));
}

/**
 * Verificar alertas para una compra (cuenta por pagar) específica
 */
async function checkAlertsForPurchase(purchase_id, tenant_id) {
  try {
    const purchase = await Purchase.findOne({
      where: { id: purchase_id, tenant_id },
      attributes: [
        'id', 'due_date', 'total_amount', 'paid_amount',
        'payment_status', 'status'
      ]
    });

    if (!purchase) return;

    const balance = parseFloat(purchase.total_amount) - parseFloat(purchase.paid_amount || 0);

    // Ya pagada, en borrador o cancelada, o sin fecha de vencimiento: resolver cualquier alerta activa
    const isFormalized = ['confirmed', 'received'].includes(purchase.status);
    const isPending = ['pending', 'partial'].includes(purchase.payment_status);

    if (!purchase.due_date || balance <= 0 || !isFormalized || !isPending) {
      await PayableAlert.update(
        {
          status: 'resolved',
          resolved_date: new Date(),
          resolution_notes: 'Cuenta pagada o ya no aplica'
        },
        {
          where: { tenant_id, purchase_id: purchase.id, status: 'active' }
        }
      );
      return;
    }

    const daysToDue = calcDaysToDue(purchase.due_date);

    let alertType = null;
    let severity = null;

    if (daysToDue < 0) {
      alertType = 'overdue';
      severity = 'critical';
    } else if (daysToDue <= DUE_SOON_DAYS) {
      alertType = 'due_soon';
      severity = daysToDue === 0 ? 'critical' : 'warning';
    }

    if (alertType) {
      // Si existe alerta activa del otro tipo (ej. pasó de due_soon a overdue), resolverla
      const otherType = alertType === 'overdue' ? 'due_soon' : 'overdue';
      await PayableAlert.update(
        {
          status: 'resolved',
          resolved_date: new Date(),
          resolution_notes: 'Reemplazada por alerta actualizada'
        },
        {
          where: { tenant_id, purchase_id: purchase.id, alert_type: otherType, status: 'active' }
        }
      );

      const existingAlert = await PayableAlert.findOne({
        where: { tenant_id, purchase_id: purchase.id, alert_type: alertType, status: 'active' }
      });

      if (!existingAlert) {
        await PayableAlert.create({
          tenant_id,
          purchase_id: purchase.id,
          alert_type: alertType,
          severity,
          due_date: purchase.due_date,
          balance,
          days_to_due: daysToDue,
          status: 'active'
        });
      } else {
        await existingAlert.update({ balance, days_to_due: daysToDue, severity });
      }
    } else {
      // Aún no está en rango de alerta: resolver cualquier alerta activa previa
      await PayableAlert.update(
        {
          status: 'resolved',
          resolved_date: new Date(),
          resolution_notes: 'Fuera del rango de vencimiento próximo'
        },
        {
          where: { tenant_id, purchase_id: purchase.id, status: 'active' }
        }
      );
    }
  } catch (error) {
    console.error('Error en checkAlertsForPurchase:', error);
    // No lanzar error para no interrumpir la operación principal
  }
}

/**
 * Verificar alertas de TODAS las cuentas por pagar (todos los tenants).
 * Pensado como red de seguridad para un cron job periódico y para el
 * botón "Verificar alertas" en el frontend.
 */
async function checkAllPayableAlerts(tenant_id = null) {
  const where = {
    status: { [Op.in]: ['confirmed', 'received'] },
    payment_status: { [Op.in]: ['pending', 'partial'] },
    due_date: { [Op.not]: null }
  };
  if (tenant_id) where.tenant_id = tenant_id;

  const purchases = await Purchase.findAll({
    where,
    attributes: ['id', 'tenant_id']
  });

  for (const purchase of purchases) {
    await checkAlertsForPurchase(purchase.id, purchase.tenant_id);
  }

  return { purchases_checked: purchases.length };
}

/**
 * Función helper para marcar una compra que necesita verificación,
 * ejecutada fuera del ciclo del request (setImmediate), igual que
 * markForAlertCheck en autoCheckAlerts.middleware.js
 */
function markPurchaseForAlertCheck(res, purchase_id, tenant_id) {
  setImmediate(async () => {
    try {
      await checkAlertsForPurchase(purchase_id, tenant_id);
    } catch (err) {
      console.error('[PayableAlertCheck] Error verificando alerta:', err.message);
    }
  });
}

module.exports = {
  checkAlertsForPurchase,
  checkAllPayableAlerts,
  markPurchaseForAlertCheck
};
