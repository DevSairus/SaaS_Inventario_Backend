// backend/src/models/payroll/PayrollPayment.js
//
// Comprobante de desembolso de nómina -- el registro del pago desde el
// banco (ver payrollAccountingService.js#registrarPago):
//   net_pay:         neto a los empleados (debita 250505 por empleado)
//   social_security: aportes a los fondos (debita los pasivos de EPS/AFP/
//                    ARL/parafiscales por fondo de destino)
//   severance_fund:  consignación anual de cesantías al fondo (debita 2510
//                    por empleado) -- no tiene periodo, va por fiscal_year
// Anular un pago (status='voided') reversa su asiento y libera los
// documentos que había pagado.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const PayrollPayment = sequelize.define('PayrollPayment', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  payroll_period_id: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  fiscal_year: {
    type: DataTypes.SMALLINT,
    allowNull: true,
  },
  payment_type: {
    type: DataTypes.STRING(20),
    allowNull: false,
    validate: { isIn: [['net_pay', 'social_security', 'severance_fund']] },
  },
  payment_date: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  // null = cuenta mapeada en payroll_payment_bank (sin cuenta bancaria registrada)
  bank_account_id: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  amount: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0,
  },
  reference: {
    type: DataTypes.STRING(100),
    allowNull: true,
  },
  journal_entry_id: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  status: {
    type: DataTypes.STRING(10),
    allowNull: false,
    defaultValue: 'active',
    validate: { isIn: [['active', 'voided']] },
  },
  created_by: {
    type: DataTypes.UUID,
    allowNull: true,
  },
}, {
  tableName: 'payroll_payments',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = PayrollPayment;
