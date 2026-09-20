// backend/src/models/accounting/FixedAssetDepreciationEntry.js
//
// Un registro por (activo, período) ya depreciado. `period` es 'YYYY-MM' —
// no lleva día, y comparar/ordenar strings 'YYYY-MM' es cronológicamente
// correcto (ver services/accounting/fixedAssetDepreciation.service.js).
//
// Único por (fixed_asset_id, period) a nivel de BD (ver migración) — evita
// doble depreciación del mismo mes si el job corre dos veces.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const FixedAssetDepreciationEntry = sequelize.define(
  'FixedAssetDepreciationEntry',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    fixed_asset_id: { type: DataTypes.UUID, allowNull: false },

    period: { type: DataTypes.STRING(7), allowNull: false },
    amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
    accumulated_after: { type: DataTypes.DECIMAL(15, 2), allowNull: false },

    // Nullable: la entrada de depreciación se guarda igual aunque falte el
    // mapeo contable de la cuenta de gasto (fire-and-forget, mismo criterio
    // que el resto del motor) — journal_entry_id se completa después si el
    // asiento se logra generar.
    journal_entry_id: { type: DataTypes.UUID, allowNull: true },
  },
  {
    tableName: 'fixed_asset_depreciation_entries',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['tenant_id'] },
      { fields: ['fixed_asset_id'] },
      { unique: true, fields: ['fixed_asset_id', 'period'] },
    ],
  }
);

module.exports = FixedAssetDepreciationEntry;
