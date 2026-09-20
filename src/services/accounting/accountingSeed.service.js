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
 * Paso de reconciliación: garantiza la cuenta puente 380505 / mapping
 * opening_balance_suspense que "saldos iniciales" necesita. Idempotente.
 *
 * @param {string} tenantId
 * @param {import('sequelize').Transaction} [transaction]
 */
async function ensureOpeningBalanceSuspenseAccount(tenantId, transaction) {
  const { ChartOfAccount, AccountMapping } = require('../../models');

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

// Categorías del enum FixedAsset.category (ver models/accounting/FixedAsset.js).
// Duplicado a propósito en vez de importar el modelo acá: este servicio se
// llama desde scripts/migraciones que a veces corren antes de que
// models/index.js esté completamente inicializado, y esta lista cambia con
// mucha menos frecuencia que el modelo.
const FIXED_ASSET_CATEGORIES = ['vehiculo', 'maquinaria', 'equipo_computo', 'muebles_enseres', 'otro'];

/**
 * Backfill del mapeo de gasto de depreciación de Activos Fijos (Fase 1,
 * Contabilidad-Plan-Ejecucion-Fases-1-4.md) para tenants que ya tenían plan
 * de cuentas ANTES de que este mapeo se agregara al catálogo. Los tenants
 * nuevos lo reciben directo vía DEFAULT_ACCOUNT_MAPPINGS
 * (data/puc-colombia-standard.js) en seedChartOfAccountsForTenant.
 *
 * Da a las 5 categorías un único mapeo base (cuenta 516005 "Depreciación")
 * si falta -- "por lo menos un mapeo base", igual que el resto del motor;
 * el tenant puede luego separar por subcuenta y remapear cada categoría
 * individualmente desde Mapeo de Cuentas si quiere más detalle en el
 * estado de resultados.
 */
async function ensureFixedAssetDepreciationMappings(tenantId, transaction) {
  const { ChartOfAccount, AccountMapping } = require('../../models');

  const eventTypes = FIXED_ASSET_CATEGORIES.map((c) => `fixed_asset_depreciation_expense:${c}`);
  const existing = await AccountMapping.findAll({
    where: { tenant_id: tenantId, event_type: eventTypes },
    transaction,
  });
  const existingEventTypes = new Set(existing.map((m) => m.event_type));
  const missing = eventTypes.filter((e) => !existingEventTypes.has(e));
  if (missing.length === 0) {
    return { created: false, reason: 'El tenant ya tiene el mapeo de depreciación de activos fijos' };
  }

  let account = await ChartOfAccount.findOne({ where: { tenant_id: tenantId, code: '516005' }, transaction });
  if (!account) {
    const parent51 = await ChartOfAccount.findOne({ where: { tenant_id: tenantId, code: '51' }, transaction });
    account = await ChartOfAccount.create(
      {
        tenant_id: tenantId, code: '516005', name: 'Depreciación', account_type: 'gasto',
        parent_id: parent51?.id || null, level: 4, accepts_entries: true, is_active: true,
      },
      { transaction }
    );
  }

  for (const eventType of missing) {
    await AccountMapping.create({ tenant_id: tenantId, event_type: eventType, account_id: account.id }, { transaction });
  }

  return { created: true, reason: `Cuenta 516005 + ${missing.length} mapeo(s) de depreciación creados` };
}

/**
 * Backfill de los 6 mapeos de retenciones practicadas (Fase 0 de
 * Declaraciones Periódicas / Formulario 350) para tenants que ya tenían
 * plan de cuentas ANTES de que este mapeo se agregara al catálogo. Las
 * cuentas 236505/236710/236805 ya venían sembradas en el PUC estándar
 * (existían para otro fin, sin mapear) -- si faltan por lo que sea también
 * se crean aquí, mismo criterio defensivo que ensureFixedAssetDepreciationMappings.
 */
async function ensureRetentionPayableMappings(tenantId, transaction) {
  const { ChartOfAccount, AccountMapping } = require('../../models');

  const RETENTION_MAPPINGS = [
    { event: 'purchase_retefuente_payable', code: '236505', name: 'Retención en la Fuente por Pagar' },
    { event: 'purchase_reteiva_payable', code: '236710', name: 'IVA Retenido por Pagar' },
    { event: 'purchase_reteica_payable', code: '236805', name: 'Retención de ICA por Pagar' },
    { event: 'expense_retefuente_payable', code: '236505', name: 'Retención en la Fuente por Pagar' },
    { event: 'expense_reteiva_payable', code: '236710', name: 'IVA Retenido por Pagar' },
    { event: 'expense_reteica_payable', code: '236805', name: 'Retención de ICA por Pagar' },
  ];

  const eventTypes = RETENTION_MAPPINGS.map((m) => m.event);
  const existing = await AccountMapping.findAll({ where: { tenant_id: tenantId, event_type: eventTypes }, transaction });
  const existingEventTypes = new Set(existing.map((m) => m.event_type));
  const missing = RETENTION_MAPPINGS.filter((m) => !existingEventTypes.has(m.event));
  if (missing.length === 0) {
    return { created: false, reason: 'El tenant ya tiene el mapeo de retenciones por pagar' };
  }

  const parent23 = await ChartOfAccount.findOne({ where: { tenant_id: tenantId, code: '23' }, transaction });

  for (const m of missing) {
    let account = await ChartOfAccount.findOne({ where: { tenant_id: tenantId, code: m.code }, transaction });
    if (!account) {
      account = await ChartOfAccount.create(
        { tenant_id: tenantId, code: m.code, name: m.name, account_type: 'pasivo', parent_id: parent23?.id || null, level: 3, accepts_entries: true, is_active: true },
        { transaction }
      );
    }
    await AccountMapping.create({ tenant_id: tenantId, event_type: m.event, account_id: account.id }, { transaction });
  }

  return { created: true, reason: `${missing.length} mapeo(s) de retenciones por pagar creados` };
}

/**
 * Reconciliación idempotente, corrible en cualquier momento (no depende de
 * migration bookkeeping): garantiza que un tenant tenga plan de cuentas +
 * mappings por defecto. Se corre automáticamente al arrancar el servidor
 * (ver scripts/reconcileAccountingSeed.js) y también vía ese script a mano.
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
 * Estructura: cada "ensureX" de arriba es un paso de reconciliación
 * independiente e idempotente (chequea su propio estado, no le importa el
 * resultado de los demás). Acá se corren TODOS en secuencia -- a propósito
 * no se corta apenas uno resuelve que no había nada que hacer, porque eso
 * fue justo el bug que tenía la versión anterior de esta función (un solo
 * paso con return temprano): un tenant que ya tenía la cuenta puente de
 * saldos iniciales nunca llegaba a evaluarse para el mapeo de depreciación
 * agregado después. Al agregar un paso nuevo en el futuro, se agrega a la
 * lista `steps`, no se reemplaza el patrón por otro return temprano.
 *
 * @param {string} tenantId
 * @param {import('sequelize').Transaction} [transaction]
 */
async function ensureAccountingSeeded(tenantId, transaction) {
  const { ChartOfAccount } = require('../../models');

  const existingCount = await ChartOfAccount.count({ where: { tenant_id: tenantId }, transaction });
  if (existingCount === 0) {
    return seedChartOfAccountsForTenant(tenantId, transaction);
  }

  const steps = {
    opening_balance_suspense: await ensureOpeningBalanceSuspenseAccount(tenantId, transaction),
    fixed_asset_depreciation: await ensureFixedAssetDepreciationMappings(tenantId, transaction),
    retention_payable: await ensureRetentionPayableMappings(tenantId, transaction),
  };

  return { created: Object.values(steps).some((s) => s.created), steps };
}

module.exports = {
  seedChartOfAccountsForTenant,
  ensureAccountingSeeded,
  ensureOpeningBalanceSuspenseAccount,
  ensureFixedAssetDepreciationMappings,
  ensureRetentionPayableMappings,
};
