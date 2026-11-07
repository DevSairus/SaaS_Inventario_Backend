// backend/src/models/projects/ProjectCutItem.js
// Línea de un corte de obra: avance de una línea del contrato (migración 2026110612).
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const ProjectCutItem = sequelize.define('ProjectCutItem', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
  cut_id: { type: DataTypes.UUID, allowNull: false },
  sale_item_id: { type: DataTypes.UUID, allowNull: false },
  description: { type: DataTypes.STRING(500), allowNull: false },
  qty_contract: { type: DataTypes.DECIMAL(15, 4), allowNull: false },
  qty_previous: { type: DataTypes.DECIMAL(15, 4), allowNull: false, defaultValue: 0 },
  qty_cumulative: { type: DataTypes.DECIMAL(15, 4), allowNull: false },
  qty_this: { type: DataTypes.DECIMAL(15, 4), allowNull: false },
  unit_price: { type: DataTypes.DECIMAL(15, 4), allowNull: false },
  tax_pct: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
  amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
}, { tableName: 'project_cut_items', timestamps: false, underscored: true });

module.exports = ProjectCutItem;
