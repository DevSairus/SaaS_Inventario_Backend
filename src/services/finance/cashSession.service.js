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

// Exigir caja abierta solo tiene sentido para tenants que contrataron
// Tesorería — un tenant sin ese módulo no tiene dónde abrir una caja, y
// bloquearle ventas/abonos por eso les impediría operar en un módulo que ni
// siquiera tienen habilitado.
async function isTreasuryEnabled(tenantId) {
  const { getEffectiveModulesForTenantId } = require('../moduleAccess');
  const modules = await getEffectiveModulesForTenantId(tenantId);
  return modules.includes('treasury');
}

module.exports = { getOpenSession, isTreasuryEnabled };
