// backend/src/models/projects/ProjectStage.js
// Etapa de obra: agrupa cantidades del BOM que se despachan juntas.
// Ver services/projects/projectStages.service.js.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const ProjectStage = sequelize.define('ProjectStage', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
  project_id: { type: DataTypes.UUID, allowNull: false },
  stage_no: { type: DataTypes.INTEGER, allowNull: false },
  name: { type: DataTypes.STRING(150), allowNull: false },
  description: { type: DataTypes.TEXT, allowNull: true },
  planned_date: { type: DataTypes.DATEONLY, allowNull: true },
  status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'open', validate: { isIn: [['open', 'closed']] } },
  created_by: { type: DataTypes.UUID, allowNull: true },
}, { tableName: 'project_stages', timestamps: true, underscored: true, createdAt: 'created_at', updatedAt: 'updated_at' });

module.exports = ProjectStage;
