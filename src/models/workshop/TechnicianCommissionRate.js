// backend/src/models/workshop/TechnicianCommissionRate.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

// Override de % de comisión por técnico dentro de una categoría. Si no hay
// fila acá, se usa CommissionCategory.default_percentage -- ver
// plan-comisiones-tecnicos-por-sistema.md sección 5, punto 1.
const TechnicianCommissionRate = sequelize.define('TechnicianCommissionRate', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  technician_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  commission_category_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  percentage: {
    type: DataTypes.DECIMAL(5, 2),
    allowNull: false,
  },
}, {
  tableName: 'technician_commission_rates',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['tenant_id'] },
    { fields: ['technician_id', 'commission_category_id'], unique: true },
  ],
});

module.exports = TechnicianCommissionRate;
