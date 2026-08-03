'use strict';

// El tenant en modo "own" hasta ahora reusaba la App de Meta global de
// Pitbox (meta_config.app_id/app_secret) solo para la parte OAuth -- eso
// lo hacía depender de que Pitbox tuviera su propia App configurada, algo
// que no debería importarle a un tenant que quiere usar SU propia cuenta.
// Con estas columnas el tenant puede traer su propia App de Meta for
// Developers (app_id + app_secret) y su propio webhook_verify_token para
// el handshake de su Webhooks product -- ver metaIntegration.controller.js
// y metaWebhook.controller.js.

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('tenant_meta_configs', 'own_app_secret', {
      type: Sequelize.TEXT,
      allowNull: true,
    });
    await queryInterface.addColumn('tenant_meta_configs', 'own_webhook_verify_token', {
      type: Sequelize.STRING(255),
      allowNull: true,
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('tenant_meta_configs', 'own_webhook_verify_token');
    await queryInterface.removeColumn('tenant_meta_configs', 'own_app_secret');
  },
};
