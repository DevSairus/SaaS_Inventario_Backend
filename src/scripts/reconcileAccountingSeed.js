// src/scripts/reconcileAccountingSeed.js
//
// Uso manual: node src/scripts/reconcileAccountingSeed.js
// También se corre automáticamente al arrancar el servidor (ver server.js),
// justo después de propagar migraciones a los schemas de tenant.
//
// Por qué hace falta además de las migraciones: seedChartOfAccountsForTenant
// se llama al CREAR un tenant, pero tenants que la iniciativa contable no
// alcanzó a cubrir en su momento (o que se fueron desalineando por un bug
// en la migración de backfill, ver 2026071502-seed-opening-balance-account-
// existing-tenants.js) se quedan sin plan de cuentas o sin la cuenta puente
// 380505/opening_balance_suspense para siempre -- una migración one-shot no
// se reintenta sola aunque se arregle el código. ensureAccountingSeeded()
// SÍ chequea el estado real cada vez, así que este script (y su llamada
// automática en server.js) autocorrige tenants viejos y nuevos por igual.

require('dotenv').config();
const { sequelize } = require('../config/database');
const { runWithTenantSchema } = require('../config/tenantContext');
const { ensureAccountingSeeded } = require('../services/accounting/accountingSeed.service');

async function reconcileAccountingSeedAllTenants() {
  const [tenants] = await sequelize.query(
    `SELECT id, slug, schema_name FROM public.tenants ORDER BY slug ASC`
  );

  const results = { total: tenants.length, ok: [], failed: [] };

  for (const t of tenants) {
    try {
      const outcome = t.schema_name
        ? await runWithTenantSchema(t.schema_name, () => ensureAccountingSeeded(t.id))
        : await ensureAccountingSeeded(t.id);
      results.ok.push({ slug: t.slug, ...outcome });
    } catch (err) {
      results.failed.push({ slug: t.slug, schema: t.schema_name, error: err.message });
      console.error(`[reconcileAccountingSeed] Error en tenant "${t.slug}":`, err.message);
    }
  }

  return results;
}

if (require.main === module) {
  reconcileAccountingSeedAllTenants()
    .then((results) => {
      console.log(`✅ ${results.ok.length}/${results.total} tenants revisados. Fallidos: ${results.failed.length}`);
      console.log(JSON.stringify(results.ok.filter(r => r.created), null, 2));
      if (results.failed.length > 0) console.log(JSON.stringify(results.failed, null, 2));
      process.exit(results.failed.length > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error('❌ Error corriendo reconcileAccountingSeed:', err);
      process.exit(1);
    });
}

module.exports = { reconcileAccountingSeedAllTenants };
