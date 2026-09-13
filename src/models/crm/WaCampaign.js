const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const WaCampaign = sequelize.define('WaCampaign', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false },
  name: { type: DataTypes.STRING(255), allowNull: false },
  template_name: { type: DataTypes.STRING(512), allowNull: false },
  language: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'es' },
  status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'draft' },
  audience_filter: { type: DataTypes.JSONB, allowNull: true },
  sent_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  failed_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  total_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  started_at: { type: DataTypes.DATE, allowNull: true },
  finished_at: { type: DataTypes.DATE, allowNull: true },
  created_by_user_id: { type: DataTypes.UUID, allowNull: true },
}, {
  tableName: 'wa_campaigns',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = WaCampaign;
