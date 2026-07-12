const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const AccountMappingAudit = sequelize.define(
  'AccountMappingAudit',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    event_type: { type: DataTypes.STRING(60), allowNull: false },
    previous_account_id: { type: DataTypes.UUID, allowNull: true },
    new_account_id: { type: DataTypes.UUID, allowNull: false },
    changed_by: { type: DataTypes.UUID, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: 'account_mapping_audits',
    timestamps: false,
    underscored: true,
  }
);

module.exports = AccountMappingAudit;
