const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const AiConversation = sequelize.define(
  'AiConversation',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    user_id: { type: DataTypes.UUID, allowNull: false },
    branch_id: { type: DataTypes.UUID, allowNull: true },
    title: { type: DataTypes.STRING(150), allowNull: true },
    status: {
      type: DataTypes.STRING(10),
      allowNull: false,
      defaultValue: 'active',
      validate: { isIn: [['active', 'archived']] },
    },
  },
  {
    tableName: 'ai_conversations',
    timestamps: true,
    underscored: true,
  }
);

module.exports = AiConversation;
