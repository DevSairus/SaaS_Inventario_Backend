'use strict';

// Historial de mantenimientos por vehículo -- se genera automáticamente al
// entregar una OT cuyos ítems coinciden con un maintenance_type (ver
// services/workshop/maintenance.service.js). Ver
// 00 - Documentación/plan-portal-mantenimiento-vehiculo.md sección 3.2.
//
// next_due_mileage / next_due_date se guardan ya calculados: si el tenant
// cambia el intervalo después, no se reescribe retroactivamente cuándo le
// tocaba al vehículo el mantenimiento anterior.
//
// El índice único (work_order_id, maintenance_type_id) hace idempotente la
// generación: changeStatus y generateSale pueden dispararla sobre la misma OT.

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.createTable('vehicle_maintenance_records', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        tenant_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'tenants', schema: 'public' }, key: 'id' },
          onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        // vehicles / maintenance_types / work_orders son tablas de TENANT --
        // sin calificar schema, para que resuelvan por search_path dentro de
        // cada schema (ver 2026091704-fix-crm-crossschema-fks.js).
        vehicle_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: 'vehicles', key: 'id' }, onDelete: 'CASCADE',
        },
        maintenance_type_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: 'maintenance_types', key: 'id' }, onDelete: 'CASCADE',
        },
        work_order_id: {
          type: Sequelize.UUID, allowNull: true,
          references: { model: 'work_orders', key: 'id' }, onDelete: 'CASCADE',
        },
        performed_at: { type: Sequelize.DATEONLY, allowNull: false },
        mileage_at_service: { type: Sequelize.INTEGER, allowNull: true },
        next_due_mileage: { type: Sequelize.INTEGER, allowNull: true },
        next_due_date: { type: Sequelize.DATEONLY, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      }, { transaction });

      await queryInterface.addIndex('vehicle_maintenance_records', ['tenant_id', 'vehicle_id'], { transaction });
      await queryInterface.addIndex(
        'vehicle_maintenance_records',
        ['work_order_id', 'maintenance_type_id'],
        { unique: true, name: 'vehicle_maintenance_records_wo_type_unique', transaction }
      );
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('vehicle_maintenance_records');
  },
};
