// backend/src/models/crm/CrmPipelineStage.js
//
// CRM Fase B.4 — etapas de pipeline configurables por tenant. Reemplaza el
// ENUM fijo que tenía Opportunity.stage: cada tenant arma su propio embudo
// (nombre, color, orden), y `stage_type` le dice al resto del CRM (dashboard,
// scoring B.2, reglas de reapertura) si la etapa es abierta/ganada/perdida
// sin que el código tenga que conocer los nombres exactos.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const CrmPipelineStage = sequelize.define('CrmPipelineStage', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'tenants', key: 'id' },
    onDelete: 'CASCADE',
  },
  key: {
    type: DataTypes.STRING(50),
    allowNull: false,
  },
  label: {
    type: DataTypes.STRING(100),
    allowNull: false,
  },
  color: {
    type: DataTypes.STRING(20),
    allowNull: true,
  },
  sort_order: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  stage_type: {
    type: DataTypes.ENUM('open', 'won', 'lost'),
    allowNull: false,
    defaultValue: 'open',
  },
  default_probability: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
}, {
  tableName: 'crm_pipeline_stages',
  timestamps: true,
  underscored: true,

  indexes: [
    { unique: true, fields: ['tenant_id', 'key'] },
    { fields: ['tenant_id', 'sort_order'] },
  ],
});

module.exports = CrmPipelineStage;
