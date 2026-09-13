// backend/src/models/payroll/PayrollSetting.js
//
// Una fila por tenant con los porcentajes "adicionales" de recargo para
// las 7 categorías de horas de novedad (HEDs, HENs, HRNs, HEDDFs, HRDDFs,
// HENDFs, HRNDFs) — ver NOVEDAD_FIELD_SCHEMAS en el frontend
// (constants/payroll.js), que usa estos valores como default editable al
// crear una novedad de esa categoría.
//
// Los valores por defecto (25/75/35/115/90/165/125) corresponden a los
// porcentajes vigentes desde el 1 de julio de 2026 bajo la Ley 2466 de
// 2025 (recargo dominical/festivo al 90%, con el siguiente incremento a
// 100% previsto para julio de 2027) — el administrador debe ajustarlos
// aquí cuando cambie la legislación, este modelo no las actualiza solo.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const PayrollSetting = sequelize.define('PayrollSetting', {
  tenant_id: {
    type: DataTypes.UUID,
    primaryKey: true,
    references: { model: 'tenants', key: 'id' },
    onDelete: 'CASCADE',
  },
  heds_percentage: { type: DataTypes.DECIMAL(6, 2), allowNull: false, defaultValue: 25 },
  hens_percentage: { type: DataTypes.DECIMAL(6, 2), allowNull: false, defaultValue: 75 },
  hrns_percentage: { type: DataTypes.DECIMAL(6, 2), allowNull: false, defaultValue: 35 },
  heddfs_percentage: { type: DataTypes.DECIMAL(6, 2), allowNull: false, defaultValue: 115 },
  hrddfs_percentage: { type: DataTypes.DECIMAL(6, 2), allowNull: false, defaultValue: 90 },
  hendfs_percentage: { type: DataTypes.DECIMAL(6, 2), allowNull: false, defaultValue: 165 },
  hrndfs_percentage: { type: DataTypes.DECIMAL(6, 2), allowNull: false, defaultValue: 125 },
  updated_by: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' },
    onDelete: 'SET NULL',
  },
}, {
  tableName: 'payroll_settings',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = PayrollSetting;
