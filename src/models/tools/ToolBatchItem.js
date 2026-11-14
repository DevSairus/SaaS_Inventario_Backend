// backend/src/models/tools/ToolBatchItem.js
// Asignación (entrega/devolución de una herramienta) incluida en un lote.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const ToolBatchItem = sequelize.define('ToolBatchItem', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
  batch_id: { type: DataTypes.UUID, allowNull: false },
  assignment_id: { type: DataTypes.UUID, allowNull: false },
}, { tableName: 'tool_batch_items', timestamps: false, underscored: true });

module.exports = ToolBatchItem;
