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