const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const ChartOfAccount = sequelize.define(
  'ChartOfAccount',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    code: { type: DataTypes.STRING(20), allowNull: false },
    name: { type: DataTypes.STRING(150), allowNull: false },
    account_type: {
      type: DataTypes.STRING(20),
      allowNull: false,
      validate: { isIn: [['activo', 'pasivo', 'patrimonio', 'ingreso', 'gasto', 'costo']] },
    },
    parent_id: { type: DataTypes.UUID, allowNull: true },
    level: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    accepts_entries: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  {
    tableName: 'chart_of_accounts',
    timestamps: true,
    underscored: true,
    indexes: [{ unique: true, fields: ['tenant_id', 'code'] }],
  }
);

module.exports = ChartOfAccount;
