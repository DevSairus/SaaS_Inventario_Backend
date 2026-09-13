const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const WaCampaignRecipient = sequelize.define('WaCampaignRecipient', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false },
  campaign_id: { type: DataTypes.UUID, allowNull: false },
  customer_id: { type: DataTypes.UUID, allowNull: true },
  phone: { type: DataTypes.STRING(32), allowNull: false },
  status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending' },
  error_message: { type: DataTypes.TEXT, allowNull: true },
  meta_message_id: { type: DataTypes.STRING(128), allowNull: true },
  sent_at: { type: DataTypes.DATE, allowNull: true },
}, {
  tableName: 'wa_campaign_recipients',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = WaCampaignRecipient;
