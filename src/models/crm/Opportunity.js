// backend/src/models/crm/Opportunity.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const Opportunity = sequelize.define('Opportunity', {
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
  branch_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'branches', key: 'id' },
    onDelete: 'SET NULL',
  },
  customer_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'customers', key: 'id' },
    onDelete: 'CASCADE',
  },
  owner_user_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' },
    onDelete: 'SET NULL',
  },
  source: {
    type: DataTypes.ENUM('walk_in', 'whatsapp', 'llamada', 'referido', 'redes', 'web', 'recompra_recurrente', 'meta_ads'),
    allowNull: false,
    defaultValue: 'walk_in',
  },
  stage: {
    // Fase B.4 — ya no es ENUM fijo: guarda el `key` de la fila
    // correspondiente en CrmPipelineStage de este tenant (ver
    // utils/crmScope.js/crmLeadScore.js para cómo se resuelve stage_type).
    type: DataTypes.STRING(50),
    allowNull: false,
    defaultValue: 'nuevo',
  },
  stage_changed_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
  lost_reason: {
    // Fase B.4 — key de CrmLossReason de este tenant (o null).
    type: DataTypes.STRING(50),
    allowNull: true,
  },
  expected_value: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: true,
  },
  probability: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  quote_sale_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'sales', key: 'id' },
    onDelete: 'SET NULL',
  },
  work_order_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'work_orders', key: 'id' },
    onDelete: 'SET NULL',
  },
  expected_close_date: {
    type: DataTypes.DATEONLY,
    allowNull: true,
  },
}, {
  tableName: 'opportunities',
  timestamps: true,
  underscored: true,

  indexes: [
    { fields: ['tenant_id', 'stage'] },
    { fields: ['tenant_id', 'owner_user_id'] },
    { fields: ['tenant_id', 'customer_id'] },
    // Cubre el ORDER BY stage_changed_at del listado del Kanban
    // (controllers/crm/opportunities.controller.js) -- sin esto el sort
    // se hacía en memoria a medida que crecía el histórico por tenant.
    { fields: ['tenant_id', 'stage_changed_at'] },
  ],
});

module.exports = Opportunity;
