const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const CommissionSettlement = sequelize.define('CommissionSettlement', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  settlement_number: {
    type: DataTypes.STRING(50),
    allowNull: false,
  },
  technician_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  date_from: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  date_to: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  commission_percentage: {
    type: DataTypes.DECIMAL(5, 2),
    allowNull: false,
  },
  base_amount: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0,
  },
  commission_amount: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0,
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  created_by: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  // Gasto operativo generado automáticamente al liquidar (categoría
  // comisiones_tecnicos) -- ver commissionSettlements.controller.js#create.
  // Permite trazabilidad y evita doble conteo en reportes de rentabilidad.
  expense_id: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  // Cruce automático con nómina (categoría DIAN "Comisiones"), calcado del
  // mismo patrón usado por CrmReward -- ver
  // services/workshop/commissionPayroll.service.js.
  employee_id: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  payroll_novedad_id: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  payroll_status: {
    type: DataTypes.STRING(30),
    allowNull: false,
    defaultValue: 'not_applicable',
    // no_reporta_nomina: el empleado (o el tenant) está configurado para que
    // la comisión no vaya a nómina -- ver commission_payroll_mode.
    validate: { isIn: [['not_applicable', 'sin_empleado_vinculado', 'pendiente_periodo', 'cargada_nomina', 'no_reporta_nomina']] },
  },
  payroll_error: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
}, {
  tableName: 'commission_settlements',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['tenant_id'] },
    { fields: ['technician_id'] },
  ],
});

module.exports = CommissionSettlement;