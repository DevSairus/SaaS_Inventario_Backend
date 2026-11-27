// backend/src/models/workshop/VehicleOwner.js
// Historial de propietarios del vehículo (migración 2026112701).
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const VehicleOwner = sequelize.define('VehicleOwner', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
  vehicle_id: { type: DataTypes.UUID, allowNull: false },
  customer_id: { type: DataTypes.UUID, allowNull: true },
  started_at: { type: DataTypes.DATEONLY, allowNull: false },
  ended_at: { type: DataTypes.DATEONLY, allowNull: true },
  source: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'cambio', validate: { isIn: [['inicial', 'cambio', 'manual']] } },
  notes: { type: DataTypes.STRING(500), allowNull: true },
  created_by: { type: DataTypes.UUID, allowNull: true },
}, { tableName: 'vehicle_owners', timestamps: true, underscored: true });

module.exports = VehicleOwner;
