const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const FiscalPeriod = sequelize.define(
  'FiscalPeriod',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    year: { type: DataTypes.INTEGER, allowNull: false },
    month: { type: DataTypes.INTEGER, allowNull: false, validate: { min: 1, max: 12 } },
    status: {
      type: DataTypes.STRING(10),
      allowNull: false,
      defaultValue: 'open',
      validate: { isIn: [['open', 'closed']] },
    },
    closed_at: { type: DataTypes.DATE, allowNull: true },
    closed_by: { type: DataTypes.UUID, allowNull: true },
    reopened_at: { type: DataTypes.DATE, allowNull: true },
    reopened_by: { type: DataTypes.UUID, allowNull: true },
    reopen_reason: { type: DataTypes.TEXT, allowNull: true },
  },
  {
    tableName: 'fiscal_periods',
    timestamps: true,
    underscored: true,
    indexes: [{ unique: true, fields: ['tenant_id', 'year', 'month'] }],
  }
);

module.exports = FiscalPeriod;
