'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('opening_balances', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenant_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: 'tenants', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
      },
      branch_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'branches', key: 'id' } },
      type: {
        type: Sequelize.STRING(10), allowNull: false,
        comment: 'receivable (cartera por cobrar) | payable (cuentas por pagar)',
      },
      customer_id: {
        type: Sequelize.UUID, allowNull: true,
        references: { model: 'customers', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      supplier_id: {
        type: Sequelize.UUID, allowNull: true,
        references: { model: 'suppliers', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      reference: { type: Sequelize.STRING(100), allowNull: true, comment: 'Folio/número del documento original (factura vieja, etc.)' },
      description: { type: Sequelize.STRING(500), allowNull: true },
      issue_date: { type: Sequelize.DATEONLY, allowNull: false, comment: 'Fecha original de la deuda, para el cálculo de antigüedad' },
      due_date: { type: Sequelize.DATEONLY, allowNull: true },
      total_amount: { type: Sequelize.DECIMAL(15, 2), allowNull: false },
      paid_amount: { type: Sequelize.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
      payment_status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'pending' }, // pending | partial | paid
      payment_history: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
      journal_entry_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: 'journal_entries', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT',
        comment: 'Asiento de apertura que registró este saldo contra la cuenta puente',
      },
      status: { type: Sequelize.STRING(10), allowNull: false, defaultValue: 'active' }, // active | voided
      voided_at: { type: Sequelize.DATE, allowNull: true },
      voided_by: { type: Sequelize.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
      void_reason: { type: Sequelize.TEXT, allowNull: true },
      created_by: { type: Sequelize.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    await queryInterface.addIndex('opening_balances', ['tenant_id']);
    await queryInterface.addIndex('opening_balances', ['tenant_id', 'type']);
    await queryInterface.addIndex('opening_balances', ['customer_id']);
    await queryInterface.addIndex('opening_balances', ['supplier_id']);
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('opening_balances');
  },
};
