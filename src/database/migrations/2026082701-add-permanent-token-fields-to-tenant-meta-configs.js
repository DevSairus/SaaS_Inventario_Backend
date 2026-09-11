'use strict';

// Conexión de WhatsApp Cloud API con token PERMANENTE de System User, además
// del flujo Embedded Signup (que entrega tokens con vencimiento).
//
// Un token de System User de Meta Business no expira mientras el usuario del
// sistema exista y conserve permisos sobre el WABA -- es la forma soportada
// de dejar un número conectado en producción sin que un asesor tenga que
// reautenticar cada 60 días. `own_token_is_permanent` distingue ambos casos
// para poder avisar de vencimiento solo cuando aplica.

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('tenant_meta_configs');

    if (!table.own_token_is_permanent) {
      await queryInterface.addColumn('tenant_meta_configs', 'own_token_is_permanent', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      });
    }

    if (!table.own_token_source) {
      await queryInterface.addColumn('tenant_meta_configs', 'own_token_source', {
        type: Sequelize.STRING(30),
        allowNull: true,
      });
    }

    if (!table.own_business_id) {
      await queryInterface.addColumn('tenant_meta_configs', 'own_business_id', {
        type: Sequelize.STRING(100),
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('tenant_meta_configs');
    if (table.own_business_id) {
      await queryInterface.removeColumn('tenant_meta_configs', 'own_business_id');
    }
    if (table.own_token_source) {
      await queryInterface.removeColumn('tenant_meta_configs', 'own_token_source');
    }
    if (table.own_token_is_permanent) {
      await queryInterface.removeColumn('tenant_meta_configs', 'own_token_is_permanent');
    }
  },
};
