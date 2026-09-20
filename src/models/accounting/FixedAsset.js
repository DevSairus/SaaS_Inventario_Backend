// backend/src/models/accounting/FixedAsset.js
//
// Activo Fijo — Fase 1 del plan de Contabilidad Pitbox. Ver
// Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 1.
//
// `asset_account_id` / `accumulated_depreciation_account_id` se eligen por
// activo (no vía AccountMapping global): la cuenta del activo bruto varía
// por categoría/subcuenta y hoy no existe un homólogo de 1592 por categoría
// en el plan de cuentas base, así que se resuelve dejando que el usuario
// elija la subcuenta correcta al dar de alta cada activo.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const FixedAsset = sequelize.define(
  'FixedAsset',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    branch_id: { type: DataTypes.UUID, allowNull: true },

    name: { type: DataTypes.STRING(150), allowNull: false },
    category: {
      type: DataTypes.STRING(30),
      allowNull: false,
      defaultValue: 'otro',
      validate: { isIn: [['vehiculo', 'maquinaria', 'equipo_computo', 'muebles_enseres', 'otro']] },
    },

    acquisition_cost: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
    acquisition_date: { type: DataTypes.DATEONLY, allowNull: false },
    useful_life_months: { type: DataTypes.INTEGER, allowNull: false },
    salvage_value: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },

    // Único valor por ahora a propósito: deja el campo listo para
    // 'saldos_decrecientes'/'unidades_producidas' después sin migrar de nuevo.
    depreciation_method: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'linea_recta',
      validate: { isIn: [['linea_recta']] },
    },

    asset_account_id: { type: DataTypes.UUID, allowNull: false },
    accumulated_depreciation_account_id: { type: DataTypes.UUID, allowNull: false },

    status: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'activo',
      validate: { isIn: [['activo', 'totalmente_depreciado', 'dado_de_baja']] },
    },

    disposal_date: { type: DataTypes.DATEONLY, allowNull: true },
    disposal_reason: { type: DataTypes.TEXT, allowNull: true },

    created_by: { type: DataTypes.UUID, allowNull: true },
  },
  {
    tableName: 'fixed_assets',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['tenant_id'] },
      { fields: ['tenant_id', 'status'] },
    ],
  }
);

module.exports = FixedAsset;
