// backend/src/models/accounting/FixedAssetImpairment.js
//
// Deterioro de valor de un activo fijo (NIIF para Pymes, Sección 27): baja el
// valor en libros con un gasto contra el deterioro acumulado, y la
// depreciación siguiente se recalcula sobre el nuevo valor. Migración 2026110702.
// La reversión (Sección 27.30) se guarda con monto negativo.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const FixedAssetImpairment = sequelize.define('FixedAssetImpairment', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false },
  fixed_asset_id: { type: DataTypes.UUID, allowNull: false },
  impairment_date: { type: DataTypes.DATEONLY, allowNull: false },
  amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  reason: { type: DataTypes.TEXT, allowNull: true },
  journal_entry_id: { type: DataTypes.UUID, allowNull: true },
  created_by: { type: DataTypes.UUID, allowNull: true },
}, { tableName: 'fixed_asset_impairments', timestamps: true, underscored: true });

module.exports = FixedAssetImpairment;
