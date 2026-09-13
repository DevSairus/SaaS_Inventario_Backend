// backend/src/models/payroll/PayrollPeriod.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const PayrollPeriod = sequelize.define('PayrollPeriod', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'tenants', key: 'id' },
    onDelete: 'CASCADE',
  },
  branch_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'branches', key: 'id' },
    onDelete: 'SET NULL',
  },
  period_type: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'mensual',
    // 'liquidacion' = periodo de UN solo empleado generado por
    // payrollTerminationService.js (mejora #7, liquidación definitiva) --
    // ver migración 20260903010000. No se crea manualmente desde
    // createPayrollPeriod (ver esa validación en payrollPeriods.controller.js).
    validate: { isIn: [['mensual', 'quincenal', 'liquidacion']] },
  },
  start_date: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  end_date: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  payment_date: {
    type: DataTypes.DATEONLY,
    allowNull: true,
  },
  status: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'abierto',
    validate: { isIn: [['abierto', 'liquidado', 'emitido', 'cerrado']] },
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  // Snapshot de lo que calcularía payrollService.js#liquidarEmpleado para
  // cada empleado activo de este periodo/periodicidad, generado al pasar a
  // 'liquidado' — puramente informativo (NO se firma ni se envía a la
  // DIAN); 'emitido' vuelve a calcular por su cuenta con las novedades que
  // existan en ese momento, así que este snapshot puede quedar desactualizado
  // si se agregan/borran novedades después de liquidar. Ver
  // payrollPeriodEmissionService.js#previewPayrollPeriod.
  liquidation_preview: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
  liquidation_preview_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  closed_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  closed_by: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' },
    onDelete: 'SET NULL',
  },
  created_by: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' },
    onDelete: 'SET NULL',
  },
}, {
  tableName: 'payroll_periods',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  validate: {
    endAfterStart() {
      if (this.start_date && this.end_date && this.end_date < this.start_date) {
        throw new Error('La fecha de fin no puede ser anterior a la fecha de inicio');
      }
    },
  },
});

module.exports = PayrollPeriod;
