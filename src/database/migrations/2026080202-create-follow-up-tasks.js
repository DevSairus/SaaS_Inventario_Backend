'use strict';

// CRM Fase 2 — bandeja de seguimiento explícita. Distinta de
// customer_interactions.follow_up_at (que es un recordatorio suelto de una
// interacción puntual): esto es la lista accionable de "qué tengo pendiente
// con quién y para cuándo".
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const tables = await queryInterface.showAllTables();
    if (tables.includes('follow_up_tasks')) return; // guard: ya existe

    await queryInterface.createTable('follow_up_tasks', {
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
      opportunity_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'opportunities', key: 'id' },
        onDelete: 'SET NULL',
      },
      assigned_to_user_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: { tableName: 'users', schema: 'public' }, key: 'id' },
        onDelete: 'CASCADE',
      },
      created_by_user_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: { tableName: 'users', schema: 'public' }, key: 'id' },
        onDelete: 'SET NULL',
      },
      title: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      due_at: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      status: {
        type: Sequelize.ENUM('pendiente', 'hecha', 'vencida', 'cancelada'),
        allowNull: false,
        defaultValue: 'pendiente',
      },
      completed_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    await queryInterface.addIndex('follow_up_tasks', ['tenant_id', 'assigned_to_user_id', 'status'], {
      name: 'follow_up_tasks_tenant_assignee_status_idx',
    });
    await queryInterface.addIndex('follow_up_tasks', ['tenant_id', 'due_at'], {
      name: 'follow_up_tasks_tenant_due_idx',
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('follow_up_tasks');
  },
};