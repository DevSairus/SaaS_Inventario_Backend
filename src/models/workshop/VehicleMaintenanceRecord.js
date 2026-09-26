// backend/src/models/workshop/VehicleMaintenanceRecord.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

// Un mantenimiento realizado a un vehículo (hoy siempre sale de una OT
// entregada) con su "próximo" ya calculado -- ver
// 00 - Documentación/plan-portal-mantenimiento-vehiculo.md sección 3.2.
const VehicleMaintenanceRecord = sequelize.define('VehicleMaintenanceRecord', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  vehicle_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  maintenance_type_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  // NULL solo si en el futuro se habilita el registro manual.
  work_order_id: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  performed_at: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  mileage_at_service: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  next_due_mileage: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  next_due_date: {
    type: DataTypes.DATEONLY,
    allowNull: true,
  },
}, {
  tableName: 'vehicle_maintenance_records',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['tenant_id', 'vehicle_id'] },
    { fields: ['work_order_id', 'maintenance_type_id'], unique: true, name: 'vehicle_maintenance_records_wo_type_unique' },
  ],
});

module.exports = VehicleMaintenanceRecord;
