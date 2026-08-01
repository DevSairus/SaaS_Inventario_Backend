'use strict';

// CRM Fase 2 — pipeline comercial. Es la capa de PROCESO sobre la Sale
// documental: una Opportunity puede existir sin cotización (recién nace el
// lead) y luego vincularse a una Sale cuando se cotiza formalmente.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const tables = await queryInterface.showAllTables();
    if (tables.includes('opportunities')) return; // guard: ya existe

    await queryInterface.createTable('opportunities', {
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
      branch_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'branches', key: 'id' },
        onDelete: 'SET NULL',
      },
      customer_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'customers', key: 'id' },
        onDelete: 'CASCADE',
      },
      owner_user_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: { tableName: 'users', schema: 'public' }, key: 'id' },
        onDelete: 'SET NULL',
        comment: 'Asesor responsable — base del scoping de visibilidad (§5-bis)',
      },
      source: {
        type: Sequelize.ENUM('walk_in', 'whatsapp', 'llamada', 'referido', 'redes', 'web', 'recompra_recurrente'),
        allowNull: false,
        defaultValue: 'walk_in',
      },
      stage: {
        type: Sequelize.ENUM('nuevo', 'contactado', 'cotizado', 'negociacion', 'ganado', 'perdido'),
        allowNull: false,
        defaultValue: 'nuevo',
      },
      stage_changed_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
      },
      lost_reason: {
        type: Sequelize.ENUM('precio', 'tiempo', 'competencia', 'no_respondio', 'otro'),
        allowNull: true,
        comment: 'Obligatorio cuando stage=perdido',
      },
      expected_value: {
        type: Sequelize.DECIMAL(15, 2),
        allowNull: true,
      },
      probability: {
        type: Sequelize.INTEGER,
        allowNull: true,
        comment: '0-100, editable o inferido por etapa',
      },
      quote_sale_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'sales', key: 'id' },
        onDelete: 'SET NULL',
      },
      work_order_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'work_orders', key: 'id' },
        onDelete: 'SET NULL',
        comment: 'Se completa automáticamente al convertir la cotización a OT',
      },
      expected_close_date: {
        type: Sequelize.DATEONLY,
        allowNull: true,
      },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    await queryInterface.addIndex('opportunities', ['tenant_id', 'stage'], { name: 'opportunities_tenant_stage_idx' });
    await queryInterface.addIndex('opportunities', ['tenant_id', 'owner_user_id'], { name: 'opportunities_tenant_owner_idx' });
    await queryInterface.addIndex('opportunities', ['tenant_id', 'customer_id'], { name: 'opportunities_tenant_customer_idx' });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('opportunities');
  },
};