// backend/src/models/projects/ProjectStageItem.js
// Cantidad planeada de una línea del BOM dentro de una etapa. Lo despachado
// no se guarda aquí: se deriva de los traslados (projectStages.service.js).
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const ProjectStageItem = sequelize.define('ProjectStageItem', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
  stage_id: { type: DataTypes.UUID, allowNull: false },
  bom_item_id: { type: DataTypes.UUID, allowNull: false },
  qty_planned: { type: DataTypes.DECIMAL(15, 4), allowNull: false },
}, { tableName: 'project_stage_items', timestamps: false, underscored: true });

module.exports = ProjectStageItem;
