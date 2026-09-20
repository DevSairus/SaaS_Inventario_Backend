'use strict';

// Catálogo de categorías de comisión (Frenos, Suspensión, Motor, Otros...),
// desacoplado del árbol de `categories` de inventario -- ver
// 00 - Documentación/plan-comisiones-tecnicos-por-sistema.md sección 2.
// `is_default` marca la categoría "Otros" que actúa de fallback cuando un
// producto/sistema de diagrama no tiene mapeo explícito (nunca "sin
// comisión" silencioso).

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.createTable('commission_categories', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        tenant_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'tenants', schema: 'public' }, key: 'id' },
          onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        name: { type: Sequelize.STRING(100), allowNull: false },
        code: { type: Sequelize.STRING(50), allowNull: true },
        default_percentage: { type: Sequelize.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
        is_default: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      }, { transaction });

      await queryInterface.addIndex('commission_categories', ['tenant_id'], { transaction });
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('commission_categories');
  },
};
