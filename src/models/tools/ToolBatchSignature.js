// backend/src/models/tools/ToolBatchSignature.js
// Firma dibujada en pantalla de un rol del acta de lote. Una por rol.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const ToolBatchSignature = sequelize.define('ToolBatchSignature', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
  batch_id: { type: DataTypes.UUID, allowNull: false },
  role: { type: DataTypes.STRING(20), allowNull: false, validate: { isIn: [['almacen', 'transportador', 'encargado_obra']] } },
  signed_name: { type: DataTypes.STRING(200), allowNull: false },
  signed_document: { type: DataTypes.STRING(30), allowNull: true },
  signature: { type: DataTypes.TEXT, allowNull: false },
  signed_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  registered_by: { type: DataTypes.UUID, allowNull: true },
}, { tableName: 'tool_batch_signatures', timestamps: false, underscored: true });

module.exports = ToolBatchSignature;
