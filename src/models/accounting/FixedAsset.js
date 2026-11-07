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
      validate: { isIn: [['vehiculo', 'maquinaria', 'equipo_computo', 'equipo_comunicacion', 'muebles_enseres', 'construcciones', 'terrenos', 'otro']] },
    },

    acquisition_cost: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
    acquisition_date: { type: DataTypes.DATEONLY, allowNull: false },
    useful_life_months: { type: DataTypes.INTEGER, allowNull: false },
    salvage_value: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },

    // linea_recta | saldos_decrecientes (doble saldo, pasa a línea recta) |
    // unidades_produccion (uso mensual) | menor_cuantia (≤ 50 UVT: todo en el
    // mes de compra) | no_deprecia (terrenos). Ver fixedAssetDepreciation.service.js.
    depreciation_method: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'linea_recta',
      validate: { isIn: [['linea_recta', 'saldos_decrecientes', 'unidades_produccion', 'menor_cuantia', 'no_deprecia']] },
    },

    asset_account_id: { type: DataTypes.UUID, allowNull: false },
    accumulated_depreciation_account_id: { type: DataTypes.UUID, allowNull: false },

    status: {
      type: DataTypes.STRING(30), // 'totalmente_depreciado' = 21 (migración 2026110704)
      allowNull: false,
      defaultValue: 'activo',
      validate: { isIn: [['activo', 'totalmente_depreciado', 'dado_de_baja']] },
    },

    disposal_date: { type: DataTypes.DATEONLY, allowNull: true },
    disposal_reason: { type: DataTypes.TEXT, allowNull: true },

    // Saldo inicial (migración 2026110701): depreciación que ya traía hasta
    // opening_period ('YYYY-MM') inclusive; Pitbox sigue desde el mes siguiente.
    opening_accumulated_depreciation: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
    opening_period: { type: DataTypes.STRING(7), allowNull: true },
    // Cuota hacia adelante desde basis_period: basis_amount / basis_months
    // (saldo inicial y cambios de vida útil o valor residual).
    basis_period: { type: DataTypes.STRING(7), allowNull: true },
    basis_amount: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
    basis_months: { type: DataTypes.INTEGER, allowNull: true },
    estimate_changes: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    // Baja: 'retiro' (sin valor) o 'venta', con su asiento.
    disposal_type: { type: DataTypes.STRING(10), allowNull: true, validate: { isIn: [['retiro', 'venta']] } },
    sale_amount: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
    sale_account_id: { type: DataTypes.UUID, allowNull: true },
    disposal_journal_entry_id: { type: DataTypes.UUID, allowNull: true },

    // Migración 2026110702: proyecto (dimensión de los asientos), unidades de
    // producción y libro fiscal (tasa anual máxima del art. 137 E.T.).
    project_id: { type: DataTypes.UUID, allowNull: true },
    total_units: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
    unit_label: { type: DataTypes.STRING(20), allowNull: true },
    fiscal_max_rate: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    fiscal_opening_accumulated: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
    // Base fiscal cuando difiere de la contable (migración 2026110705); vacío = la contable.
    fiscal_cost: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
    fiscal_salvage_value: { type: DataTypes.DECIMAL(15, 2), allowNull: true },

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
