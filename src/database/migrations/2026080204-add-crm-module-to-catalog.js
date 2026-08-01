'use strict';

// CRM — último paso pendiente del roadmap (README Fase 3, punto "Umbral..." no,
// este es el otro pendiente: "sin esto, ningún tenant existente puede usar el
// módulo aunque el código ya esté completo").
//
// Sigue el mismo patrón que 2026070901-add-modules-to-plans-and-tenants.js:
//   effective_modules = (plan.modules ∪ tenant.modules_enabled) − modules_disabled
// `crm` depende de `sales` (ver modules.catalog.js), así que solo se agrega
// donde `sales` ya está presente — nunca se activa un módulo con su
// dependencia rota.
module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      // Planes conocidos: agregar 'crm' donde ya incluyen 'sales' y todavía
      // no tienen 'crm'. Cubre tenants nuevos que se creen desde ahora.
      await queryInterface.sequelize.query(`
        UPDATE "public"."subscription_plans"
        SET modules = modules || '["crm"]'::jsonb
        WHERE modules @> '["sales"]'::jsonb
          AND NOT modules @> '["crm"]'::jsonb;
      `, { transaction });

      // Backfill de tenants existentes: mismo criterio, sobre modules_enabled.
      // No se toca modules_disabled — si un tenant tenía 'crm' deshabilitado
      // explícitamente (no debería ser posible antes de esta migración, pero
      // por seguridad) ese override se respeta y moduleAccess.js lo sigue
      // excluyendo del cálculo efectivo.
      await queryInterface.sequelize.query(`
        UPDATE "public"."tenants"
        SET modules_enabled = modules_enabled || '["crm"]'::jsonb
        WHERE modules_enabled @> '["sales"]'::jsonb
          AND NOT modules_enabled @> '["crm"]'::jsonb;
      `, { transaction });

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      UPDATE "public"."subscription_plans"
      SET modules = modules - 'crm'
      WHERE modules @> '["crm"]'::jsonb;
    `);
    await queryInterface.sequelize.query(`
      UPDATE "public"."tenants"
      SET modules_enabled = modules_enabled - 'crm'
      WHERE modules_enabled @> '["crm"]'::jsonb;
    `);
  },
};
