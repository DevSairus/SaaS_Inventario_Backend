// backend/src/models/crm/CustomerTagAssignment.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const CustomerTagAssignment = sequelize.define('CustomerTagAssignment', {
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
  customer_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'customers', key: 'id' },
    onDelete: 'CASCADE',
  },
  customer_tag_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'customer_tags', key: 'id' },
    onDelete: 'CASCADE',
  },
}, {
  tableName: 'customer_tag_assignments',
  timestamps: true,
  underscored: true,

  indexes: [
    { fields: ['customer_id', 'customer_tag_id'], unique: true },
  ],
});

module.exports = CustomerTagAssignment;
