// backend/src/models/accounting/FixedAssetUsage.js
//
// Uso mensual de un activo depreciado por unidades de producción (horas,
// kilómetros, unidades): la depreciación del mes = (costo − residual) × uso /
// unidades totales. Migración 2026110702.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const FixedAssetUsage = sequelize.define('FixedAssetUsage', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false },
  fixed_asset_id: { type: DataTypes.UUID, allowNull: false },
  period: { type: DataTypes.STRING(7), allowNull: false },
  units: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  notes: { type: DataTypes.STRING(255), allowNull: true },
  created_by: { type: DataTypes.UUID, allowNull: true },
}, { tableName: 'fixed_asset_usage', timestamps: true, underscored: true });

module.exports = FixedAssetUsage;
