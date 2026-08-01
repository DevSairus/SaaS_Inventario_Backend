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

/**
 * Reconciliación idempotente, corrible en cualquier momento (no depende de
 * migration bookkeeping): garantiza que un tenant tenga plan de cuentas +
 * mappings por defecto, y en particular la cuenta puente 380505 /
 * opening_balance_suspense que "saldos iniciales" necesita.
 *
 * Por qué no basta con una migración one-shot: una migración queda marcada
 * como "ya corrida" en sequelize_migrations aunque su lógica interna decida
 * no insertar nada esa vez (ej. por una condición de datos que en ese
 * momento resultó distinta a la esperada) -- después de eso, ningún fix al
 * código de la migración la hace reintentar sola. Esta función, en cambio,
 * chequea el estado real (¿existe la cuenta? ¿existe el mapping?) cada vez
 * que se llama, así que autocorrige tenants viejos Y sirve de red de
 * seguridad para tenants nuevos si por lo que sea seedChartOfAccountsForTenant
 * no llegó a correr en su creación.
 *
 * @param {string} tenantId
 * @param {import('sequelize').Transaction} [transaction]
 */
async function ensureAccountingSeeded(tenantId, transaction) {
  const { ChartOfAccount, AccountMapping } = require('../../models');

  const existingCount = await ChartOfAccount.count({ where: { tenant_id: tenantId }, transaction });
  if (existingCount === 0) {
    return seedChartOfAccountsForTenant(tenantId, transaction);
  }

  const hasSuspenseMapping = await AccountMapping.findOne({
    where: { tenant_id: tenantId, event_type: 'opening_balance_suspense' },
    transaction,
  });
  if (hasSuspenseMapping) {
    return { created: false, reason: 'El tenant ya tiene la cuenta puente de saldos iniciales' };
  }

  let group = await ChartOfAccount.findOne({ where: { tenant_id: tenantId, code: '38' }, transaction });
  if (!group) {
    const parent3 = await ChartOfAccount.findOne({ where: { tenant_id: tenantId, code: '3' }, transaction });
    group = await ChartOfAccount.create(
      {
        tenant_id: tenantId, code: '38', name: 'Superávit de Capital', account_type: 'patrimonio',
        parent_id: parent3?.id || null, level: 2, accepts_entries: false, is_active: true,
      },
      { transaction }
    );
  }

  const account = await ChartOfAccount.create(
    {
      tenant_id: tenantId, code: '380505', name: 'Cuenta Puente — Saldos de Apertura', account_type: 'patrimonio',
      parent_id: group.id, level: 4, accepts_entries: true, is_active: true,
    },
    { transaction }
  );

  await AccountMapping.create(
    { tenant_id: tenantId, event_type: 'opening_balance_suspense', account_id: account.id },
    { transaction }
  );

  return { created: true, reason: 'Cuenta puente 380505 + mapping creados' };
}

module.exports = { seedChartOfAccountsForTenant, ensureAccountingSeeded };
