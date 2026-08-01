// backend/src/models/crm/CustomerInteraction.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const CustomerInteraction = sequelize.define('CustomerInteraction', {
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
  user_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' },
    onDelete: 'SET NULL',
    comment: 'Quién registró la interacción (null si fue automática del sistema)',
  },
  type: {
    type: DataTypes.ENUM('llamada', 'whatsapp', 'email', 'visita', 'nota', 'reunion'),
    allowNull: false,
  },
  channel_ref: {
    type: DataTypes.STRING(255),
    allowNull: true,
  },
  summary: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  outcome: {
    type: DataTypes.ENUM('positivo', 'neutral', 'negativo', 'sin_respuesta'),
    allowNull: true,
  },
  follow_up_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  related_sale_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'sales', key: 'id' },
    onDelete: 'SET NULL',
  },
  related_work_order_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'work_orders', key: 'id' },
    onDelete: 'SET NULL',
  },
}, {
  tableName: 'customer_interactions',
  timestamps: true,
  underscored: true,

  indexes: [
    { fields: ['tenant_id', 'customer_id'] },
    { fields: ['tenant_id', 'user_id'] },
    { fields: ['tenant_id', 'follow_up_at'] },
  ],
});

module.exports = CustomerInteraction;
