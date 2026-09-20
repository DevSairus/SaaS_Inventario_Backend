'use strict';

// Siembra una categoría "Otros" (is_default=true) por cada tenant existente,
// usando su business_config.default_labor_cost_percentage actual (o 40% si
// no lo configuró) -- así nadie queda en 0% el día del deploy. Ver
// plan-comisiones-tecnicos-por-sistema.md, Tanda 1.
//
// `tenants` vive SOLO en `public` (ver registerTenantSchemaHooks.js), así
// que el SELECT de abajo siempre lo califica explícito. Cuando esta
// migración corre DENTRO del schema de un tenant ya cortado (ver
// provisionTenantSchema.js, que pasa `{ tenantId }` como 3er argumento),
// solo se siembra la fila de ESE tenant -- si no, correr esta misma
// migración en cada schema de tenant terminaría insertando la categoría
// "Otros" de TODOS los tenants dentro de la tabla `commission_categories`
// de cada uno (mismo criterio que 2026081401-backfill-comisiones-tecnicos-mapping.js).

const DEFAULT_LABOR_COST_PCT = 40;

module.exports = {
  up: async (queryInterface, Sequelize, context = {}) => {
    const where = context.tenantId ? 'WHERE id = :tenantId' : '';
    const [tenants] = await queryInterface.sequelize.query(
      `SELECT id, business_config FROM public.tenants ${where}`,
      { replacements: { tenantId: context.tenantId } }
    );

    for (const tenant of tenants) {
      const [[existing]] = await queryInterface.sequelize.query(
        `SELECT id FROM commission_categories WHERE tenant_id = :tenantId AND is_default = true`,
        { replacements: { tenantId: tenant.id } }
      );
      if (existing) continue;

      let pct = DEFAULT_LABOR_COST_PCT;
      const cfg = tenant.business_config;
      const parsed = cfg && typeof cfg === 'object' ? cfg.default_labor_cost_percentage : null;
      if (parsed !== undefined && parsed !== null && !isNaN(parsed)) pct = parseFloat(parsed);

      await queryInterface.sequelize.query(
        `INSERT INTO commission_categories
           (id, tenant_id, name, code, default_percentage, is_default, is_active, created_at, updated_at)
         VALUES
           (gen_random_uuid(), :tenantId, 'Otros', 'otros', :pct, true, true, NOW(), NOW())`,
        { replacements: { tenantId: tenant.id, pct } }
      );
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(
      `DELETE FROM commission_categories WHERE is_default = true AND code = 'otros'`
    );
  },
};
