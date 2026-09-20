'use strict';

// Mapea diagram_templates.system (frenos_delanteros, suspension_delantera, ...)
// a una commission_category del tenant. Varios `system` pueden apuntar a la
// misma categoría (ej. frenos_delanteros y frenos_traseros -> "Frenos") --
// ver plan-comisiones-tecnicos-por-sistema.md sección 2, punto 2.

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.createTable('diagram_system_commission_map', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        tenant_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'tenants', schema: 'public' }, key: 'id' },
          onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        system: { type: Sequelize.STRING(50), allowNull: false },
        commission_category_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: 'commission_categories', key: 'id' }, onDelete: 'CASCADE',
        },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      }, { transaction });

      await queryInterface.addIndex(
        'diagram_system_commission_map',
        ['tenant_id', 'system'],
        { unique: true, name: 'diagram_system_commission_map_tenant_system_unique', transaction }
      );
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('diagram_system_commission_map');
  },
};
