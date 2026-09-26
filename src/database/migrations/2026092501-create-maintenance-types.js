'use strict';

// Catálogo de tipos de mantenimiento (Cambio de aceite, Filtro de aire...)
// por tenant Y por tipo de vehículo -- el mismo tenant define "cada 3.000 km"
// para motocicleta y "cada 5.000 km" para automovil. Ver
// 00 - Documentación/plan-portal-mantenimiento-vehiculo.md sección 3.1.
//
// vehicle_type va como STRING (no ENUM de Postgres) a propósito: los valores
// válidos son los mismos de Vehicle.vehicle_type y se validan en el modelo
// (MaintenanceType.js), sin tener que crear/sincronizar un tipo ENUM propio
// dentro de cada schema de tenant.
//
// match_keywords: palabras que, si aparecen en product_name de un ítem de la
// OT, disparan el registro automático de este mantenimiento al entregarla.

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.createTable('maintenance_types', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        tenant_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'tenants', schema: 'public' }, key: 'id' },
          onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        name: { type: Sequelize.STRING(100), allowNull: false },
        vehicle_type: { type: Sequelize.STRING(20), allowNull: false },
        interval_km: { type: Sequelize.INTEGER, allowNull: true },
        interval_months: { type: Sequelize.INTEGER, allowNull: true },
        match_keywords: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
        is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      }, { transaction });

      await queryInterface.addIndex('maintenance_types', ['tenant_id', 'vehicle_type'], { transaction });
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('maintenance_types');
  },
};
