// backend/src/models/crm/WaMessage.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const WaMessage = sequelize.define('WaMessage', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false },
  conversation_id: { type: DataTypes.UUID, allowNull: false },
  direction: { type: DataTypes.STRING(10), allowNull: false }, // in | out
  type: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'text' },
  body: { type: DataTypes.TEXT, allowNull: true },
  media_url: { type: DataTypes.TEXT, allowNull: true },
  meta_message_id: { type: DataTypes.STRING(128), allowNull: true },
  status: { type: DataTypes.STRING(20), allowNull: true },
  sent_by_user_id: { type: DataTypes.UUID, allowNull: true },
  source: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'api' },
  raw_payload: { type: DataTypes.JSONB, allowNull: true },
}, {
  tableName: 'wa_messages',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = WaMessage;
