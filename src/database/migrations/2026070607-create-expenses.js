'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('expenses', {
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
      branch_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'branches', key: 'id' },
        onDelete: 'SET NULL'
      },
      expense_number: { type: Sequelize.STRING(50), allowNull: false },
      category: { type: Sequelize.STRING(50), allowNull: false },
      description: { type: Sequelize.STRING(255), allowNull: false },
      supplier_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'suppliers', key: 'id' },
        onDelete: 'SET NULL'
      },
      expense_date: { type: Sequelize.DATEONLY, allowNull: false, defaultValue: Sequelize.NOW },
      due_date: { type: Sequelize.DATEONLY, allowNull: true },
      total_amount: { type: Sequelize.DECIMAL(15, 2), allowNull: false },
      payment_method: { type: Sequelize.STRING(50), allowNull: true },
      payment_status: { type: Sequelize.STRING(20), defaultValue: 'pending' },
      paid_amount: { type: Sequelize.DECIMAL(15, 2), defaultValue: 0 },
      payment_history: { type: Sequelize.JSONB, defaultValue: [] },
      is_recurring: { type: Sequelize.BOOLEAN, defaultValue: false },
      receipt_url: { type: Sequelize.STRING(500), allowNull: true },
      notes: { type: Sequelize.TEXT, allowNull: true },
      created_by: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: { tableName: 'users', schema: 'public' }, key: 'id' },
        onDelete: 'SET NULL'
      },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW }
    });

    await queryInterface.addIndex('expenses', ['tenant_id']);
    await queryInterface.addIndex('expenses', ['tenant_id', 'branch_id']);
    await queryInterface.addIndex('expenses', ['tenant_id', 'expense_date']);
    await queryInterface.addIndex('expenses', ['tenant_id', 'payment_status']);
    await queryInterface.addIndex('expenses', ['tenant_id', 'expense_number'], {
      unique: true,
      name: 'expenses_tenant_id_expense_number_unique'
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('expenses');
  },
};
