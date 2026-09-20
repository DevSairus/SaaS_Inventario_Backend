'use strict';

// Override de % de comisión por técnico dentro de una categoría (ej. técnico
// senior certificado cobra más en "Eléctrico" que uno junior). Si un técnico
// no tiene fila acá para una categoría, se usa
// commission_categories.default_percentage -- ver
// 00 - Documentación/plan-comisiones-tecnicos-por-sistema.md sección 5, punto 1.

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.createTable('technician_commission_rates', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        tenant_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'tenants', schema: 'public' }, key: 'id' },
          onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        technician_id: {
          type: Sequelize.UUID, allowNull: false,
          // `users` vive SOLO en `public` (ver registerTenantSchemaHooks.js,
          // PUBLIC_SCHEMA_MODELS) -- hay que calificar el schema explícito,
          // igual que con `tenants` arriba, o falla dentro del search_path
          // de cada schema de tenant (no existe la relación «users»).
          references: { model: { tableName: 'users', schema: 'public' }, key: 'id' }, onDelete: 'CASCADE',
        },
        commission_category_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: 'commission_categories', key: 'id' }, onDelete: 'CASCADE',
        },
        percentage: { type: Sequelize.DECIMAL(5, 2), allowNull: false },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      }, { transaction });

      await queryInterface.addIndex('technician_commission_rates', ['tenant_id'], { transaction });
      await queryInterface.addIndex(
        'technician_commission_rates',
        ['technician_id', 'commission_category_id'],
        { unique: true, name: 'technician_commission_rates_tech_category_unique', transaction }
      );
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('technician_commission_rates');
  },
};
