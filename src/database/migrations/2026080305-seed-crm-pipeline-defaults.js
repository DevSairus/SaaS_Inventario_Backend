'use strict';

// CRM Fase B.4 — siembra las 6 etapas y 5 motivos de pérdida que ya existían
// como ENUM fijo, para que ningún tenant existente quede con oportunidades
// huérfanas tras 2026080304-alter-opportunities-stage-columns.js. Mismo
// patrón de context.tenantId que 2026070904-seed-accounting-for-existing-tenants.js:
// bajo aprovisionamiento por-schema solo se siembra el tenant dueño de ese schema.
const STAGES = [
  { key: 'nuevo', label: 'Nuevo', color: '#0284c7', sort_order: 0, stage_type: 'open', default_probability: 10 },
  { key: 'contactado', label: 'Contactado', color: '#4f46e5', sort_order: 1, stage_type: 'open', default_probability: 25 },
  { key: 'cotizado', label: 'Cotizado', color: '#16a34a', sort_order: 2, stage_type: 'open', default_probability: 50 },
  { key: 'negociacion', label: 'Negociación', color: '#d97706', sort_order: 3, stage_type: 'open', default_probability: 75 },
  { key: 'ganado', label: 'Ganado', color: '#059669', sort_order: 4, stage_type: 'won', default_probability: 100 },
  { key: 'perdido', label: 'Perdido', color: '#6b7280', sort_order: 5, stage_type: 'lost', default_probability: 0 },
];

const LOSS_REASONS = [
  { key: 'precio', label: 'Precio', sort_order: 0 },
  { key: 'tiempo', label: 'Tiempo', sort_order: 1 },
  { key: 'competencia', label: 'Competencia', sort_order: 2 },
  { key: 'no_respondio', label: 'No respondió', sort_order: 3 },
  { key: 'otro', label: 'Otro', sort_order: 4 },
];

module.exports = {
  up: async (queryInterface, Sequelize, context) => {
    const [tenants] = context?.tenantId
      ? await queryInterface.sequelize.query(
          `SELECT id FROM "public"."tenants" WHERE id = :tenantId`,
          { replacements: { tenantId: context.tenantId } }
        )
      : await queryInterface.sequelize.query(`SELECT id FROM "public"."tenants"`);

    for (const tenant of tenants) {
      for (const s of STAGES) {
        await queryInterface.sequelize.query(
          `INSERT INTO crm_pipeline_stages
             (id, tenant_id, key, label, color, sort_order, stage_type, default_probability, created_at, updated_at)
           VALUES
             (gen_random_uuid(), :tenantId, :key, :label, :color, :sort_order, :stage_type, :default_probability, NOW(), NOW())
           ON CONFLICT (tenant_id, key) DO NOTHING`,
          { replacements: { tenantId: tenant.id, ...s } }
        );
      }
      for (const r of LOSS_REASONS) {
        await queryInterface.sequelize.query(
          `INSERT INTO crm_loss_reasons (id, tenant_id, key, label, sort_order, created_at, updated_at)
           VALUES (gen_random_uuid(), :tenantId, :key, :label, :sort_order, NOW(), NOW())
           ON CONFLICT (tenant_id, key) DO NOTHING`,
          { replacements: { tenantId: tenant.id, ...r } }
        );
      }
    }
  },

  down: async () => {
    // No-op — un tenant pudo haber renombrado/reordenado sus etapas desde
    // entonces; borrar por key sería destructivo sobre datos ya personalizados.
  },
};
