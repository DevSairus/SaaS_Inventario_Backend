'use strict';

// Fase 2 del Asistente de IA: tabla de propuestas de acción.
// NEXA nunca escribe directo en la base de datos — cada acción de escritura
// (registrar un gasto, registrar un pago, etc.) queda guardada aquí como
// "pending" hasta que un humano la aprueba o la rechaza explícitamente desde
// la pantalla de Aprobaciones NEXA (nunca desde el chat mismo).

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('ai_proposals', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenant_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: 'tenants', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
      },
      conversation_id: {
        type: Sequelize.UUID, allowNull: true,
        references: { model: 'ai_conversations', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      created_by: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: 'users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
      },
      branch_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'branches', key: 'id' } },
      action_type: {
        type: Sequelize.STRING(50), allowNull: false,
        comment: 'create_expense | register_expense_payment',
      },
      summary: { type: Sequelize.STRING(300), allowNull: false },
      payload: { type: Sequelize.JSONB, allowNull: false },
      status: {
        type: Sequelize.STRING(10), allowNull: false, defaultValue: 'pending',
        comment: 'pending | approved | rejected | executed | failed',
      },
      reviewed_by: {
        type: Sequelize.UUID, allowNull: true,
        references: { model: 'users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      reviewed_at: { type: Sequelize.DATE, allowNull: true },
      executed_at: { type: Sequelize.DATE, allowNull: true },
      result: { type: Sequelize.JSONB, allowNull: true },
      error_message: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    await queryInterface.addIndex('ai_proposals', ['tenant_id', 'status']);
    await queryInterface.addIndex('ai_proposals', ['conversation_id']);
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('ai_proposals');
  },
};
