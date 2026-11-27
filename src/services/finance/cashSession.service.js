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

// Ajuste por empresa (Configuración → Ventas): business_config.
// require_open_cash_session. Por defecto (sin definir) se exige, que es el
// comportamiento histórico. Solo tiene efecto con Tesorería activa.
async function isOpenCashSessionRequired(tenantId) {
  const { Tenant } = require('../../models');
  const tenant = await Tenant.findByPk(tenantId, { attributes: ['id', 'business_config'] });
  return tenant?.business_config?.require_open_cash_session !== false;
}

/**
 * Caja para un movimiento de dinero (cobro, anticipo, devolución…):
 *   - session: la caja abierta de la sede, si la hay, para ligar el
 *     movimiento al cuadre (aunque no se exija).
 *   - missing: true si la empresa exige caja abierta y no hay ninguna; el
 *     llamador responde 400 con su propio mensaje.
 * Sin Tesorería no hay cajas: { session: null, missing: false }.
 */
async function resolvePaymentSession(tenantId, branchId, transaction) {
  if (!(await isTreasuryEnabled(tenantId))) return { session: null, missing: false };
  const session = await getOpenSession(tenantId, branchId, transaction);
  if (session) return { session, missing: false };
  return { session: null, missing: await isOpenCashSessionRequired(tenantId) };
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

/**
 * Para una SALIDA de dinero (pago a proveedor, gasto): campos que ligan el
 * pago a la caja abierta de la sede, para que el cierre de caja lo muestre
 * como salida aunque la fecha del pago no sea la de apertura de la caja (caja
 * que quedó abierta varios días, compra con fecha de factura anterior). Nunca
 * bloquea: sin Tesorería, sin sede o sin caja abierta devuelve {} y el pago
 * sigue entrando al cuadre por fecha y sede como antes.
 */
async function outflowSessionLink(tenantId, branchId, transaction) {
  if (!branchId) return {};
  try {
    if (!(await isTreasuryEnabled(tenantId))) return {};
    const session = await getOpenSession(tenantId, branchId, transaction);
    return session ? { cash_session_id: session.id, branch_id: branchId } : {};
  } catch {
    return {};
  }
}

module.exports = { getOpenSession, isTreasuryEnabled, isOpenCashSessionRequired, resolvePaymentSession, assertCashAvailable, outflowSessionLink };
