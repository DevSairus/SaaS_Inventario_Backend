'use strict';

module.exports = {
  up: async (queryInterface) => {
    // PostgreSQL: ampliar enum de action_type
    await queryInterface.sequelize.query(`
      DO $$ BEGIN
        ALTER TYPE "enum_crm_automation_rules_action_type" ADD VALUE IF NOT EXISTS 'send_whatsapp_template';
      EXCEPTION WHEN duplicate_object THEN null;
      END $$;
    `).catch(async () => {
      // Algunos schemas usan nombre distinto; intentar variantes
      await queryInterface.sequelize.query(`
        ALTER TYPE enum_crm_automation_rules_action_type ADD VALUE IF NOT EXISTS 'send_whatsapp_template';
      `).catch(() => {});
    });
  },
  down: async () => {
    // No se puede quitar valores de ENUM en Postgres de forma segura
  },
};
