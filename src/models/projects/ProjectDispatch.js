// backend/src/models/projects/ProjectDispatch.js
// Acta de despacho: una por salida de materiales a la obra (con o sin etapa).
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const ProjectDispatch = sequelize.define('ProjectDispatch', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
  project_id: { type: DataTypes.UUID, allowNull: false },
  stage_id: { type: DataTypes.UUID, allowNull: true },
  dispatch_no: { type: DataTypes.STRING(20), allowNull: false },
  transfer_id: { type: DataTypes.UUID, allowNull: true },
  from_warehouse_id: { type: DataTypes.UUID, allowNull: true },
  notes: { type: DataTypes.TEXT, allowNull: true },
  dispatched_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  created_by: { type: DataTypes.UUID, allowNull: true },
}, { tableName: 'project_dispatches', timestamps: true, underscored: true, createdAt: 'created_at', updatedAt: false });

module.exports = ProjectDispatch;
