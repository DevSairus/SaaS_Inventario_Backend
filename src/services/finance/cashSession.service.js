// backend/src/services/finance/cashSession.service.js
// Única fuente de verdad para "¿hay una caja abierta en esta sede?" — antes
// esta misma consulta estaba duplicada e inline en cashSessions.controller.js.
// La reutilizan también sales.controller.js y workOrders.controller.js para
// exigir caja abierta antes de aceptar cualquier pago.

async function getOpenSession(tenantId, branchId, transaction) {
  const { CashSession } = require('../../models');
  return CashSession.findOne({
    where: { tenant_id: tenantId, branch_id: branchId, status: 'open' },
    transaction,
  });
}

module.exports = { getOpenSession };
