// backend/src/models/workshop/VehicleInspectionItem.js
// Resultado de un punto de la plantilla en un peritaje (migración 2026112701).
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const VehicleInspectionItem = sequelize.define('VehicleInspectionItem', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
  inspection_id: { type: DataTypes.UUID, allowNull: false },
  section_key: { type: DataTypes.STRING(50), allowNull: false },
  item_key: { type: DataTypes.STRING(50), allowNull: false },
  label: { type: DataTypes.STRING(150), allowNull: false },
  kind: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'rating' },
  unit: { type: DataTypes.STRING(10), allowNull: true },
  critical: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  rating: { type: DataTypes.STRING(10), allowNull: true, validate: { isIn: [['bueno', 'regular', 'malo', 'na']] } },
  measure: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
  notes: { type: DataTypes.STRING(1000), allowNull: true },
  photos: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
}, { tableName: 'vehicle_inspection_items', timestamps: true, underscored: true });

module.exports = VehicleInspectionItem;
