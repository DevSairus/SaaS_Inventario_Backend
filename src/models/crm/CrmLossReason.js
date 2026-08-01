// backend/src/models/crm/CrmLossReason.js
//
// CRM Fase B.4 — motivos de pérdida configurables por tenant, mismo patrón
// que CrmPipelineStage. Reemplaza el ENUM fijo de Opportunity.lost_reason.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const CrmLossReason = sequelize.define('CrmLossReason', {
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
  sort_order: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
}, {
  tableName: 'crm_loss_reasons',
  timestamps: true,
  underscored: true,

  indexes: [
    { unique: true, fields: ['tenant_id', 'key'] },
    { fields: ['tenant_id', 'sort_order'] },
  ],
});

module.exports = CrmLossReason;
