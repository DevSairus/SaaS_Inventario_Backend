'use strict';

// Fase 1 del Asistente de IA (módulo independiente, no depende de accounting).
// Solo lectura por ahora: no hay tabla de "propuestas" todavía (eso es Fase 2,
// cuando el asistente pueda armar borradores de asientos/ajustes para aprobación).

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // ── ai_conversations ──────────────────────────────────────────────
    await queryInterface.createTable('ai_conversations', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenant_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: 'tenants', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
      },
      user_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: 'users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
      },
      branch_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'branches', key: 'id' } },
      title: { type: Sequelize.STRING(150), allowNull: true },
      status: {
        type: Sequelize.STRING(10), allowNull: false, defaultValue: 'active',
        comment: 'active | archived',
      },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
    await queryInterface.addIndex('ai_conversations', ['tenant_id', 'user_id']);

    // ── ai_messages ─────────────────────────────────────────────────
    await queryInterface.createTable('ai_messages', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      conversation_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: 'ai_conversations', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
      },
      // Duplicado de tenant_id aquí a propósito: permite filtrar/auditar
      // mensajes directamente sin JOIN, igual que el resto del esquema.
      tenant_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: 'tenants', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
      },
      role: {
        type: Sequelize.STRING(10), allowNull: false,
        comment: 'user | assistant | tool',
      },
      content: { type: Sequelize.TEXT, allowNull: true },
      tool_name: { type: Sequelize.STRING(100), allowNull: true },
      tool_args: { type: Sequelize.JSONB, allowNull: true },
      tool_result: { type: Sequelize.JSONB, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
    await queryInterface.addIndex('ai_messages', ['conversation_id']);
    await queryInterface.addIndex('ai_messages', ['tenant_id']);
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('ai_messages');
    await queryInterface.dropTable('ai_conversations');
  },
};
