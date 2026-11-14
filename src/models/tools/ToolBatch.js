// backend/src/models/tools/ToolBatch.js
// Lote de herramientas: entrega o devolución masiva a una obra (y etapa).
// Ver services/tools/toolBatches.service.js.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const ToolBatch = sequelize.define('ToolBatch', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
  batch_no: { type: DataTypes.STRING(20), allowNull: false },
  kind: { type: DataTypes.STRING(10), allowNull: false, validate: { isIn: [['delivery', 'return']] } },
  project_id: { type: DataTypes.UUID, allowNull: false },
  stage_id: { type: DataTypes.UUID, allowNull: true },
  batch_date: { type: DataTypes.DATEONLY, allowNull: false },
  responsible_name: { type: DataTypes.STRING(200), allowNull: true },
  responsible_document: { type: DataTypes.STRING(30), allowNull: true },
  notes: { type: DataTypes.TEXT, allowNull: true },
  created_by: { type: DataTypes.UUID, allowNull: true },
}, { tableName: 'tool_batches', timestamps: true, underscored: true, createdAt: 'created_at', updatedAt: false });

module.exports = ToolBatch;
