'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // ── chart_of_accounts ──────────────────────────────────────────
    await queryInterface.createTable('chart_of_accounts', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenant_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: 'tenants', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
      },
      code: { type: Sequelize.STRING(20), allowNull: false },
      name: { type: Sequelize.STRING(150), allowNull: false },
      account_type: {
        type: Sequelize.STRING(20), allowNull: false,
        comment: 'activo | pasivo | patrimonio | ingreso | gasto | costo',
      },
      parent_id: {
        type: Sequelize.UUID, allowNull: true,
        references: { model: 'chart_of_accounts', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      level: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      accepts_entries: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
    await queryInterface.addIndex('chart_of_accounts', ['tenant_id']);
    await queryInterface.addIndex('chart_of_accounts', ['tenant_id', 'code'], { unique: true, name: 'chart_of_accounts_tenant_code_unique' });

    // ── fiscal_periods ──────────────────────────────────────────────
    await queryInterface.createTable('fiscal_periods', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenant_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: 'tenants', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
      },
      year: { type: Sequelize.INTEGER, allowNull: false },
      month: { type: Sequelize.INTEGER, allowNull: false },
      status: { type: Sequelize.STRING(10), allowNull: false, defaultValue: 'open' }, // open | closed
      closed_at: { type: Sequelize.DATE, allowNull: true },
      closed_by: { type: Sequelize.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
    await queryInterface.addIndex('fiscal_periods', ['tenant_id', 'year', 'month'], { unique: true, name: 'fiscal_periods_tenant_year_month_unique' });

    // ── journal_entries ──────────────────────────────────────────────
    await queryInterface.createTable('journal_entries', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenant_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: 'tenants', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
      },
      branch_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'branches', key: 'id' } },
      entry_number: { type: Sequelize.STRING(50), allowNull: false },
      entry_date: { type: Sequelize.DATEONLY, allowNull: false },
      period_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'fiscal_periods', key: 'id' } },
      source_type: {
        type: Sequelize.STRING(20), allowNull: false, defaultValue: 'manual',
        comment: 'sale | purchase | expense | cash_session | manual | adjustment',
      },
      source_id: { type: Sequelize.UUID, allowNull: true, comment: 'FK genérica al documento origen (sale.id, purchase.id, expense.id, etc.)' },
      description: { type: Sequelize.STRING(500), allowNull: true },
      status: { type: Sequelize.STRING(10), allowNull: false, defaultValue: 'draft' }, // draft | posted | voided
      total_debit: { type: Sequelize.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
      total_credit: { type: Sequelize.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
      created_by: { type: Sequelize.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
      posted_by: { type: Sequelize.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
      posted_at: { type: Sequelize.DATE, allowNull: true },
      voided_by: { type: Sequelize.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
      voided_at: { type: Sequelize.DATE, allowNull: true },
      void_reason: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
    await queryInterface.addIndex('journal_entries', ['tenant_id']);
    await queryInterface.addIndex('journal_entries', ['tenant_id', 'entry_number'], { unique: true, name: 'journal_entries_tenant_number_unique' });
    await queryInterface.addIndex('journal_entries', ['tenant_id', 'entry_date']);
    await queryInterface.addIndex('journal_entries', ['tenant_id', 'status']);
    await queryInterface.addIndex('journal_entries', ['source_type', 'source_id']);

    // ── journal_entry_lines ────────────────────────────────────────
    await queryInterface.createTable('journal_entry_lines', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      entry_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: 'journal_entries', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
      },
      account_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: 'chart_of_accounts', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT',
      },
      debit: { type: Sequelize.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
      credit: { type: Sequelize.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
      description: { type: Sequelize.STRING(255), allowNull: true },
      third_party_id: { type: Sequelize.UUID, allowNull: true, comment: 'Cliente/proveedor opcional, para auxiliares' },
      line_order: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
    await queryInterface.addIndex('journal_entry_lines', ['entry_id']);
    await queryInterface.addIndex('journal_entry_lines', ['account_id']);

    // ── account_mappings ─────────────────────────────────────────────
    await queryInterface.createTable('account_mappings', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenant_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: 'tenants', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
      },
      event_type: { type: Sequelize.STRING(60), allowNull: false, comment: 'ej: sale_revenue_product, expense_category:arriendo' },
      account_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: 'chart_of_accounts', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT',
      },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
    await queryInterface.addIndex('account_mappings', ['tenant_id', 'event_type'], { unique: true, name: 'account_mappings_tenant_event_unique' });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('account_mappings');
    await queryInterface.dropTable('journal_entry_lines');
    await queryInterface.dropTable('journal_entries');
    await queryInterface.dropTable('fiscal_periods');
    await queryInterface.dropTable('chart_of_accounts');
  },
};
