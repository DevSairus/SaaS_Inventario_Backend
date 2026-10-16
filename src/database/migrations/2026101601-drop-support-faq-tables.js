'use strict';

// Se retira la FAQ del Centro de Soporte: duplicaba los manuales de usuario
// (frontend/src/content/manuals) y sus respuestas se desactualizaban (rutas de
// menú que no existen). El Centro de Ayuda ahora son los manuales. Las tablas
// nunca tuvieron contenido en producción. Corre en public y en cada schema de
// tenant (2026072401 también las creó ahí), por eso IF EXISTS.
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS support_faq_articles');
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS support_faq_categories');
  },

  // Recrea las tablas tal como las dejó 2026072401 (vacías).
  down: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.createTable('support_faq_categories', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        name: { type: Sequelize.STRING(150), allowNull: false },
        order: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      }, { transaction });

      await queryInterface.createTable('support_faq_articles', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        category_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: 'support_faq_categories', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        question: { type: Sequelize.STRING(500), allowNull: false },
        answer: { type: Sequelize.TEXT, allowNull: false },
        order: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        helpful_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        not_helpful_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      }, { transaction });
      await queryInterface.addIndex('support_faq_articles', ['category_id'], { transaction });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
