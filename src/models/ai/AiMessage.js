const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const AiMessage = sequelize.define(
  'AiMessage',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    conversation_id: { type: DataTypes.UUID, allowNull: false },
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    role: {
      type: DataTypes.STRING(10),
      allowNull: false,
      validate: { isIn: [['user', 'assistant', 'tool']] },
    },
    content: { type: DataTypes.TEXT, allowNull: true },
    tool_name: { type: DataTypes.STRING(100), allowNull: true },
    tool_args: { type: DataTypes.JSONB, allowNull: true },
    tool_result: { type: DataTypes.JSONB, allowNull: true },
  },
  {
    tableName: 'ai_messages',
    timestamps: true,
    updatedAt: false,
    underscored: true,
  }
);

module.exports = AiMessage;
