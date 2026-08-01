// backend/src/models/crm/FollowUpTask.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const FollowUpTask = sequelize.define('FollowUpTask', {
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
  opportunity_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'opportunities', key: 'id' },
    onDelete: 'SET NULL',
  },
  assigned_to_user_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'users', key: 'id' },
    onDelete: 'CASCADE',
  },
  created_by_user_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' },
    onDelete: 'SET NULL',
  },
  title: {
    type: DataTypes.STRING(255),
    allowNull: false,
  },
  due_at: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  status: {
    type: DataTypes.ENUM('pendiente', 'hecha', 'vencida', 'cancelada'),
    allowNull: false,
    defaultValue: 'pendiente',
  },
  completed_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
}, {
  tableName: 'follow_up_tasks',
  timestamps: true,
  underscored: true,

  indexes: [
    { fields: ['tenant_id', 'assigned_to_user_id', 'status'] },
    { fields: ['tenant_id', 'due_at'] },
  ],
});

module.exports = FollowUpTask;
