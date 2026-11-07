// backend/src/models/approvals/ApprovalToken.js
// Enlace de un solo uso para aprobar desde el correo (migración 2026110604).
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const ApprovalToken = sequelize.define('ApprovalToken', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
  request_id: { type: DataTypes.UUID, allowNull: false },
  step: { type: DataTypes.INTEGER, allowNull: false },
  user_id: { type: DataTypes.UUID, allowNull: false },
  token: { type: DataTypes.UUID, allowNull: false },
  expires_at: { type: DataTypes.DATE, allowNull: false },
  used_at: { type: DataTypes.DATE, allowNull: true },
}, { tableName: 'approval_tokens', timestamps: true, underscored: true, createdAt: 'created_at', updatedAt: 'updated_at' });

module.exports = ApprovalToken;
