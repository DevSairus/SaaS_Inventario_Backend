// src/scripts/reconcilePayrollConceptsSeed.js
//
// Uso manual: node src/scripts/reconcilePayrollConceptsSeed.js
//
// seedPayrollConceptsForTenant se llama al CREAR un tenant (ver
// superadmin.routes.js POST /tenants), pero tenants que ya existían antes de
// que este seed se agregara se quedan sin catálogo de conceptos para
// siempre -- este script (mismo patrón que reconcileAccountingSeed.js)
// recorre todos los tenants y les crea el catálogo estándar si no tienen
// ninguno, sin duplicar nada en los que ya lo tienen.

require('dotenv').config();
const { sequelize } = require('../config/database');
const { runWithTenantSchema } = require('../config/tenantContext');
const { ensurePayrollConceptsSeeded } = require('../services/payroll/payrollConceptsSeed.service');

async function reconcilePayrollConceptsSeedAllTenants() {
  const [tenants] = await sequelize.query(
    `SELECT id, slug, schema_name FROM public.tenants ORDER BY slug ASC`
  );

  const results = { total: tenants.length, ok: [], failed: [] };

  for (const t of tenants) {
    try {
      const outcome = t.schema_name
        ? await runWithTenantSchema(t.schema_name, () => ensurePayrollConceptsSeeded(t.id))
        : await ensurePayrollConceptsSeeded(t.id);
      results.ok.push({ slug: t.slug, ...outcome });
    } catch (err) {
      results.failed.push({ slug: t.slug, schema: t.schema_name, error: err.message });
      console.error(`[reconcilePayrollConceptsSeed] Error en tenant "${t.slug}":`, err.message);
    }
  }

  return results;
}

if (require.main === module) {
  reconcilePayrollConceptsSeedAllTenants()
    .then((results) => {
      console.log(`✅ ${results.ok.length}/${results.total} tenants revisados. Fallidos: ${results.failed.length}`);
      console.log(JSON.stringify(results.ok.filter(r => r.created), null, 2));
      if (results.failed.length > 0) console.log(JSON.stringify(results.failed, null, 2));
      process.exit(results.failed.length > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error('❌ Error corriendo reconcilePayrollConceptsSeed:', err);
      process.exit(1);
    });
}

module.exports = { reconcilePayrollConceptsSeedAllTenants };
