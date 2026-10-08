// backend/src/services/accounting/bankAccountSelection.js
//
// Cuenta bancaria elegida al registrar un cobro o pago (ventas, abonos,
// gastos): con ella el asiento va a la subcuenta PUC propia de esa cuenta
// (resolvePaymentAccount en autoEntries.service.js).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isCashMethod = (method) => {
  const pm = String(method || '').toLowerCase();
  return pm.includes('efectivo') || pm.includes('cash');
};

/**
 * Normaliza el bank_account_id que llega en el body: null si no viene o si
 * el pago es en efectivo; lanza un error con status 400 si no es una cuenta
 * activa del tenant.
 */
async function resolveSelectedBankAccountId(tenantId, bankAccountId, method, transaction) {
  if (!bankAccountId || isCashMethod(method)) return null;
  const { BankAccount } = require('../../models');
  const bank = UUID_RE.test(String(bankAccountId)) && await BankAccount.findOne({
    where: { id: bankAccountId, tenant_id: tenantId, is_active: true },
    attributes: ['id'],
    transaction,
  });
  if (!bank) {
    const err = new Error('La cuenta bancaria seleccionada no existe o está inactiva');
    err.status = 400;
    throw err;
  }
  return bank.id;
}

module.exports = { resolveSelectedBankAccountId };
