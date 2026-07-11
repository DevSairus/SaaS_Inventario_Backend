const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const AccountMapping = sequelize.define(
  'AccountMapping',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    event_type: { type: DataTypes.STRING(60), allowNull: false },
    account_id: { type: DataTypes.UUID, allowNull: false },
  },
  {
    tableName: 'account_mappings',
    timestamps: true,
    underscored: true,
    indexes: [{ unique: true, fields: ['tenant_id', 'event_type'] }],
  }
);

module.exports = AccountMapping;
