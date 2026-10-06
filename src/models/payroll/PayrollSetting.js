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

  // ── Contabilidad de nómina (payrollAccountingService.js) ──
  // Cómo se contabiliza es decisión del encargado/contador del tenant; el
  // sistema solo ofrece las opciones.
  //   single: un solo comprobante por periodo (nómina + aportes/provisiones)
  //   split:  comprobante de nómina y comprobante de aportes/provisiones aparte
  accounting_voucher_mode: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'single', validate: { isIn: [['single', 'split']] } },
  // Cesantías e intereses se PAGAN una vez al año (intereses al empleado a
  // más tardar el 31-ene, cesantías al fondo a más tardar el 14-feb) y no
  // hacen parte del devengado mensual. Lo configurable es cuándo se CAUSAN:
  //   monthly:  provisión en cada periodo (gasto contra pasivo 2510/2515)
  //   year_end: un solo asiento de causación al 31-dic (ver causarCesantiasAnuales)
  cesantias_accrual_mode: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'monthly', validate: { isIn: [['monthly', 'year_end']] } },
  //   monthly:    provisión en cada periodo; el pago debita el pasivo
  //   on_payment: sin provisión; el pago va directo al gasto
  prima_accrual_mode: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'monthly', validate: { isIn: [['monthly', 'on_payment']] } },
  vacaciones_accrual_mode: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'monthly', validate: { isIn: [['monthly', 'on_payment']] } },
  // Exoneración Art. 114-1 E.T.: el empleador no aporta salud (8.5%), SENA
  // ni ICBF por los trabajadores que devenguen menos de 10 SMLMV.
  employer_exonerated_114_1: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  // Cómo llega a nómina la comisión de mano de obra de los técnicos (ver
  // commissionPayroll.service.js). Cada empleado puede tener su excepción
  // en Employee.commission_payroll_mode.
  //   salarial:    novedad "Comisiones" (integra IBC y prestaciones)
  //   no_salarial: novedad "Bonificaciones" no salarial (Art. 128 CST)
  //   no_reportar: no se reporta a nómina; queda como gasto operativo
  commission_payroll_mode: { type: DataTypes.STRING(15), allowNull: false, defaultValue: 'salarial', validate: { isIn: [['salarial', 'no_salarial', 'no_reportar']] } },
  // Fondos a nivel de empresa (proveedores). EPS/AFP/cesantías van por
  // empleado (ver Employee.js).
  arl_supplier_id: { type: DataTypes.UUID, allowNull: true },
  ccf_supplier_id: { type: DataTypes.UUID, allowNull: true },
  sena_supplier_id: { type: DataTypes.UUID, allowNull: true },
  icbf_supplier_id: { type: DataTypes.UUID, allowNull: true },
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
