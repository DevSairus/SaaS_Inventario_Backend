// backend/src/middleware/autoCheckAdvanceAlerts.middleware.js
//
// Verifica y crea/actualiza/resuelve alertas de antigüedad sobre Anticipos
// de Clientes sin aplicar. Los anticipos no vencen (decisión de negocio,
// ver Anticipos-Clientes-Analisis-y-Plan.md §11.2), pero uno con mucho
// tiempo sin aplicarse es una señal operativa, no financiera -- el mismo
// espíritu que PayableAlert (vencimiento) y StockAlert (nivel de stock),
// solo que acá el disparador es "tiempo transcurrido" en vez de una fecha
// límite o un umbral de cantidad.
//
// Umbrales configurables:
//   CUSTOMER_ADVANCE_ALERT_STALE_DAYS       (default 60)  -> alert_type 'stale', severity 'warning'
//   CUSTOMER_ADVANCE_ALERT_VERY_STALE_DAYS  (default 120) -> alert_type 'very_stale', severity 'critical'
const { CustomerAdvanceAlert, CustomerAdvance } = require('../models');
const { Op } = require('sequelize');

const STALE_DAYS = parseInt(process.env.CUSTOMER_ADVANCE_ALERT_STALE_DAYS, 10) || 60;
const VERY_STALE_DAYS = parseInt(process.env.CUSTOMER_ADVANCE_ALERT_VERY_STALE_DAYS, 10) || 120;

function calcDaysSinceReceived(receivedDate) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const received = new Date(receivedDate);
  received.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((today - received) / (1000 * 60 * 60 * 24)));
}

/**
 * Verificar la alerta de antigüedad de un anticipo específico.
 * Se llama después de crear, aplicar, devolver o anular un anticipo,
 * y también desde el barrido periódico (checkAllAdvanceAlerts).
 */
async function checkAlertsForAdvance(advance_id, tenant_id) {
  try {
    const advance = await CustomerAdvance.findOne({
      where: { id: advance_id, tenant_id },
      attributes: ['id', 'customer_id', 'balance', 'status', 'received_date'],
    });

    if (!advance) return;

    const balance = parseFloat(advance.balance);

    // Ya no está activo (aplicado, devuelto, anulado) o sin saldo: resolver cualquier alerta activa.
    if (advance.status !== 'active' || balance <= 0) {
      await CustomerAdvanceAlert.update(
        {
          status: 'resolved',
          resolved_date: new Date(),
          resolution_notes: 'El anticipo ya no está activo o no tiene saldo disponible',
        },
        { where: { tenant_id, advance_id: advance.id, status: 'active' } }
      );
      return;
    }

    const daysSinceReceived = calcDaysSinceReceived(advance.received_date);

    let alertType = null;
    let severity = null;

    if (daysSinceReceived >= VERY_STALE_DAYS) {
      alertType = 'very_stale';
      severity = 'critical';
    } else if (daysSinceReceived >= STALE_DAYS) {
      alertType = 'stale';
      severity = 'warning';
    }

    if (alertType) {
      // Si pasó de 'stale' a 'very_stale', resolver la alerta anterior.
      const otherType = alertType === 'very_stale' ? 'stale' : 'very_stale';
      await CustomerAdvanceAlert.update(
        {
          status: 'resolved',
          resolved_date: new Date(),
          resolution_notes: 'Reemplazada por alerta actualizada',
        },
        { where: { tenant_id, advance_id: advance.id, alert_type: otherType, status: 'active' } }
      );

      const existingAlert = await CustomerAdvanceAlert.findOne({
        where: { tenant_id, advance_id: advance.id, alert_type: alertType, status: 'active' },
      });

      if (!existingAlert) {
        await CustomerAdvanceAlert.create({
          tenant_id,
          advance_id: advance.id,
          customer_id: advance.customer_id,
          alert_type: alertType,
          severity,
          balance,
          days_since_received: daysSinceReceived,
          status: 'active',
        });
      } else {
        await existingAlert.update({ balance, days_since_received: daysSinceReceived, severity });
      }
    } else {
      // Aún no llega al umbral: resolver cualquier alerta activa previa (por si se ajustó el umbral).
      await CustomerAdvanceAlert.update(
        {
          status: 'resolved',
          resolved_date: new Date(),
          resolution_notes: 'Fuera del rango de antigüedad configurado',
        },
        { where: { tenant_id, advance_id: advance.id, status: 'active' } }
      );
    }
  } catch (error) {
    console.error('Error en checkAlertsForAdvance:', error);
    // No lanzar error para no interrumpir la operación principal (crear/aplicar/devolver/anular).
  }
}

/**
 * Verificar antigüedad de TODOS los anticipos activos con saldo (todos los
 * tenants, o uno solo si se pasa tenant_id). Pensado para el cron job diario
 * y para el botón "Verificar alertas" del frontend.
 */
async function checkAllAdvanceAlerts(tenant_id = null) {
  const where = {
    status: 'active',
    balance: { [Op.gt]: 0 },
  };
  if (tenant_id) where.tenant_id = tenant_id;

  const advances = await CustomerAdvance.findAll({
    where,
    attributes: ['id', 'tenant_id'],
  });

  for (const advance of advances) {
    await checkAlertsForAdvance(advance.id, advance.tenant_id);
  }

  return { advances_checked: advances.length };
}

/**
 * Helper para verificar un anticipo puntual fuera del ciclo del request
 * (setImmediate), igual que markPurchaseForAlertCheck /
 * markForAlertCheck ya usados en el resto del proyecto.
 */
function markAdvanceForAlertCheck(advance_id, tenant_id) {
  setImmediate(async () => {
    try {
      await checkAlertsForAdvance(advance_id, tenant_id);
    } catch (err) {
      console.error('[CustomerAdvanceAlertCheck] Error verificando alerta:', err.message);
    }
  });
}

module.exports = {
  checkAlertsForAdvance,
  checkAllAdvanceAlerts,
  markAdvanceForAlertCheck,
};
