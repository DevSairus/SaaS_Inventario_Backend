// backend/src/services/accounting/accountingSeed.service.js
const { PUC_COLOMBIA_STANDARD, DEFAULT_ACCOUNT_MAPPINGS } = require('../../data/puc-colombia-standard');

/**
 * Crea el plan de cuentas PUC estándar y los account_mappings por defecto
 * para un tenant. Idempotente: si el tenant ya tiene cuentas, no hace nada.
 *
 * @param {string} tenantId
 * @param {import('sequelize').Transaction} [transaction]
 */
async function seedChartOfAccountsForTenant(tenantId, transaction) {
  const { ChartOfAccount, AccountMapping } = require('../../models');

  const existingCount = await ChartOfAccount.count({ where: { tenant_id: tenantId }, transaction });
  if (existingCount > 0) {
    return { created: false, reason: 'El tenant ya tiene plan de cuentas' };
  }

  // Crear cuentas en orden (padres antes que hijos, ya vienen ordenadas en el catálogo)
  const codeToId = {};
  for (const acc of PUC_COLOMBIA_STANDARD) {
    const parent_id = acc.parent_code ? codeToId[acc.parent_code] || null : null;
    const level = acc.code.length <= 1 ? 1 : Math.ceil(acc.code.length / 2) + 1;

    const created = await ChartOfAccount.create(
      {
        tenant_id: tenantId,
        code: acc.code,
        name: acc.name,
        account_type: acc.type,
        parent_id,
        level,
        accepts_entries: acc.accepts_entries,
        is_active: true,
      },
      { transaction }
    );
    codeToId[acc.code] = created.id;
  }

  // Crear los account_mappings por defecto, resolviendo código -> id recién creado
  for (const [eventType, code] of Object.entries(DEFAULT_ACCOUNT_MAPPINGS)) {
    const account_id = codeToId[code];
    if (!account_id) continue; // por seguridad, si el código no existe en el catálogo
    await AccountMapping.create(
      { tenant_id: tenantId, event_type: eventType, account_id },
      { transaction }
    );
  }

  return { created: true, accounts: Object.keys(codeToId).length };
}

module.exports = { seedChartOfAccountsForTenant };
