// backend/src/models/approvals/ApprovalRule.js
// Regla de aprobación de la empresa (migración 2026110604).
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const ApprovalRule = sequelize.define('ApprovalRule', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
  document_type: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'purchase', validate: { isIn: [['purchase']] } },
  name: { type: DataTypes.STRING(120), allowNull: false },
  min_amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  max_amount: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
  project_id: { type: DataTypes.UUID, allowNull: true },
  approver_role: { type: DataTypes.STRING(30), allowNull: true },
  approver_user_id: { type: DataTypes.UUID, allowNull: true },
  sequence: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  created_by: { type: DataTypes.UUID, allowNull: true },
}, { tableName: 'approval_rules', timestamps: true, underscored: true, createdAt: 'created_at', updatedAt: 'updated_at' });

module.exports = ApprovalRule;
