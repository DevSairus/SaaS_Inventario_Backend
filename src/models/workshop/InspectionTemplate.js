// backend/src/models/workshop/InspectionTemplate.js
// Plantilla de peritaje de la empresa (migración 2026112701). Las de Pitbox
// viven en constants/inspectionTemplates.js y no son filas.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const InspectionTemplate = sequelize.define('InspectionTemplate', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
  name: { type: DataTypes.STRING(150), allowNull: false },
  base_key: { type: DataTypes.STRING(30), allowNull: true },
  vehicle_types: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
  sections: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
  is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  created_by: { type: DataTypes.UUID, allowNull: true },
}, { tableName: 'inspection_templates', timestamps: true, underscored: true });

module.exports = InspectionTemplate;
