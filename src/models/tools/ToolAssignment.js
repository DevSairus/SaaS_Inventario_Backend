// backend/src/models/tools/ToolAssignment.js
// Entrega de una herramienta a un responsable, con acta de entrega y de
// devolución (migración 2026110608).
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const ToolAssignment = sequelize.define('ToolAssignment', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
  number: { type: DataTypes.STRING(30), allowNull: false },
  tool_id: { type: DataTypes.UUID, allowNull: false },
  quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  employee_id: { type: DataTypes.UUID, allowNull: true },
  user_id: { type: DataTypes.UUID, allowNull: true },
  responsible_name: { type: DataTypes.STRING(200), allowNull: false },
  responsible_document: { type: DataTypes.STRING(30), allowNull: true },
  project_id: { type: DataTypes.UUID, allowNull: true },
  status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'active', validate: { isIn: [['active', 'returned']] } },
  assigned_at: { type: DataTypes.DATEONLY, allowNull: false },
  expected_return_date: { type: DataTypes.DATEONLY, allowNull: true },
  daily_rate: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  delivery_condition: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'good' },
  delivery_notes: { type: DataTypes.STRING(500), allowNull: true },
  delivery_signature: { type: DataTypes.TEXT, allowNull: true },
  delivery_signed_name: { type: DataTypes.STRING(200), allowNull: true },
  delivered_by: { type: DataTypes.UUID, allowNull: true },
  returned_at: { type: DataTypes.DATEONLY, allowNull: true },
  return_condition: { type: DataTypes.STRING(20), allowNull: true, validate: { isIn: [['good', 'damaged', 'lost']] } },
  lost_quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  return_notes: { type: DataTypes.STRING(500), allowNull: true },
  return_signature: { type: DataTypes.TEXT, allowNull: true },
  return_signed_name: { type: DataTypes.STRING(200), allowNull: true },
  received_by: { type: DataTypes.UUID, allowNull: true },
}, { tableName: 'tool_assignments', timestamps: true, underscored: true, createdAt: 'created_at', updatedAt: 'updated_at' });

module.exports = ToolAssignment;
