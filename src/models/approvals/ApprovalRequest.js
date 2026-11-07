// backend/src/models/approvals/ApprovalRequest.js
// Solicitud de aprobación de un documento (migración 2026110604).
// steps: [{ sequence, rule_id, rule_name, approver_role, approver_user_id,
//           status: 'pending'|'approved'|'rejected', decided_by, decided_at,
//           comment, via: 'app'|'email' }]
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const ApprovalRequest = sequelize.define('ApprovalRequest', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
  document_type: { type: DataTypes.STRING(30), allowNull: false },
  document_id: { type: DataTypes.UUID, allowNull: false },
  document_number: { type: DataTypes.STRING(60), allowNull: true },
  amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  project_id: { type: DataTypes.UUID, allowNull: true },
  status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending', validate: { isIn: [['pending', 'approved', 'rejected', 'cancelled']] } },
  current_step: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  steps: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
  requested_by: { type: DataTypes.UUID, allowNull: true },
  decided_by: { type: DataTypes.UUID, allowNull: true },
  decided_at: { type: DataTypes.DATE, allowNull: true },
  comment: { type: DataTypes.TEXT, allowNull: true },
}, { tableName: 'approval_requests', timestamps: true, underscored: true, createdAt: 'created_at', updatedAt: 'updated_at' });

module.exports = ApprovalRequest;
