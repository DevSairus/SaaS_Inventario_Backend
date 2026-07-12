const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const AccountMapping = sequelize.define(
  'AccountMapping',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    event_type: { type: DataTypes.STRING(60), allowNull: false },
    account_id: { type: DataTypes.UUID, allowNull: false },
    label: { type: DataTypes.STRING(150), allowNull: true },
    category: { type: DataTypes.STRING(60), allowNull: true },
    is_custom: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  },
  {
    tableName: 'account_mappings',
    timestamps: true,
    underscored: true,
    indexes: [{ unique: true, fields: ['tenant_id', 'event_type'] }],
  }
);

module.exports = AccountMapping;
