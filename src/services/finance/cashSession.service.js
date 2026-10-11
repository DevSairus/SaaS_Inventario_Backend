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

/**
 * Para una SALIDA de dinero en efectivo de la caja abierta (devolución al
 * cliente, devolución de anticipo): lanza un error 400 si en la caja no hay
 * ese efectivo según el cuadre (base + entradas - salidas en efectivo de la
 * sesión). Otros medios no salen del cajón y no se validan.
 */
async function assertCashAvailable(session, amount, method) {
  if (!session) return;
  const { calculateExpected, normalizeMethod } = require('../../controllers/finance/cashSessions.controller');
  if (normalizeMethod(method || 'Efectivo') !== 'efectivo') return;
  const { expected } = await calculateExpected(session);
  const available = Math.round(Number(expected.efectivo || 0) * 100) / 100;
  if (Number(amount) > available + 0.009) {
    const fmt = (n) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n);
    const err = new Error(`En la caja hay ${fmt(Math.max(available, 0))} en efectivo y no alcanza para entregar ${fmt(Number(amount))}. Devuelve por transferencia u otro medio, o registra primero el ingreso de efectivo a la caja.`);
    err.status = 400;
    throw err;
  }
}

module.exports = { getOpenSession, isTreasuryEnabled, assertCashAvailable };
