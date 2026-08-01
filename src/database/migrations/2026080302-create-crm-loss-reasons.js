'use strict';

// CRM Fase B.4 — motivos de pérdida configurables por tenant, mismo patrón
// que crm_pipeline_stages. Reemplaza el ENUM fijo de opportunities.lost_reason.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const tables = await queryInterface.showAllTables();
    if (tables.includes('crm_loss_reasons')) return; // guard: ya existe

    await queryInterface.createTable('crm_loss_reasons', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      tenant_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: { tableName: 'tenants', schema: 'public' }, key: 'id' },
        onDelete: 'CASCADE',
      },
      key: {
        type: Sequelize.STRING(50),
        allowNull: false,
      },
      label: {
        type: Sequelize.STRING(100),
        allowNull: false,
      },
      sort_order: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    await queryInterface.addIndex('crm_loss_reasons', ['tenant_id', 'key'], {
      name: 'crm_loss_reasons_tenant_key_uq', unique: true,
    });
    await queryInterface.addIndex('crm_loss_reasons', ['tenant_id', 'sort_order'], {
      name: 'crm_loss_reasons_tenant_order_idx',
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('crm_loss_reasons');
  },
};
