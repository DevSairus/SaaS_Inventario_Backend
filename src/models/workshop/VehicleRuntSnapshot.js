// backend/src/models/workshop/VehicleRuntSnapshot.js
// Consulta RUNT guardada desde la ficha o el peritaje (migración 2026112701).
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const VehicleRuntSnapshot = sequelize.define('VehicleRuntSnapshot', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
  vehicle_id: { type: DataTypes.UUID, allowNull: false },
  consulted_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  consulted_by: { type: DataTypes.UUID, allowNull: true },
  estado: { type: DataTypes.STRING(60), allowNull: true },
  has_liens: { type: DataTypes.BOOLEAN, allowNull: true, comment: 'Gravámenes / limitaciones a la propiedad' },
  has_pledges: { type: DataTypes.BOOLEAN, allowNull: true, comment: 'Prendas' },
  soat_expiry: { type: DataTypes.DATEONLY, allowNull: true },
  tecnomecanica_expiry: { type: DataTypes.DATEONLY, allowNull: true },
  data: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
}, { tableName: 'vehicle_runt_snapshots', timestamps: true, updatedAt: false, underscored: true, createdAt: 'created_at' });

module.exports = VehicleRuntSnapshot;
