'use strict';

// 4.2 del análisis contable: "Auditoría/log de cambios en mapeos de
// cuentas". Hoy account_mappings se puede sobreescribir (upsert) sin dejar
// rastro de quién cambió qué cuenta mapeaba a qué evento — si alguien
// cambia mal un mapeo, los asientos futuros se generan mal y no queda
// historial de cuándo ni quién lo hizo. Esta tabla guarda un registro por
// cada cambio (no por cada consulta), poblada desde
// accountMappings.controller.js#upsert.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('account_mapping_audits', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenant_id: { type: Sequelize.UUID, allowNull: false },
      event_type: { type: Sequelize.STRING(60), allowNull: false },
      previous_account_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'chart_of_accounts', key: 'id' } },
      new_account_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'chart_of_accounts', key: 'id' } },
      changed_by: { type: Sequelize.UUID, allowNull: true, references: { model: { tableName: 'users', schema: 'public' }, key: 'id' } },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('account_mapping_audits', ['tenant_id', 'event_type']);
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('account_mapping_audits');
  },
};
