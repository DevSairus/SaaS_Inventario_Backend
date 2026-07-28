'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('payable_alerts', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true
      },
      tenant_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: { tableName: 'tenants', schema: 'public' }, key: 'id' },
        onDelete: 'CASCADE'
      },
      purchase_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'purchases', key: 'id' },
        onDelete: 'CASCADE'
      },
      alert_type: {
        type: Sequelize.STRING(20),
        allowNull: false
        // 'due_soon' | 'overdue'
      },
      severity: {
        type: Sequelize.STRING(20),
        allowNull: false,
        defaultValue: 'warning'
        // 'info' | 'warning' | 'critical'
      },
      due_date: { type: Sequelize.DATEONLY, allowNull: true },
      balance: { type: Sequelize.DECIMAL(15, 2), allowNull: false },
      days_to_due: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: 'Negativo = días vencido, positivo = días para vencer'
      },
      status: {
        type: Sequelize.STRING(20),
        allowNull: false,
        defaultValue: 'active'
        // 'active' | 'resolved' | 'ignored'
      },
      alert_date: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      resolved_date: { type: Sequelize.DATE, allowNull: true },
      resolved_by: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: { tableName: 'users', schema: 'public' }, key: 'id' },
        onDelete: 'SET NULL'
      },
      resolution_notes: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW }
    });

    await queryInterface.addIndex('payable_alerts', ['tenant_id']);
    await queryInterface.addIndex('payable_alerts', ['tenant_id', 'status']);
    await queryInterface.addIndex('payable_alerts', ['purchase_id']);
    await queryInterface.addIndex('payable_alerts', ['tenant_id', 'purchase_id', 'alert_type', 'status'], {
      name: 'payable_alerts_unique_active_lookup'
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('payable_alerts');
  },
};
