// backend/src/models/crm/CustomerTag.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const CustomerTag = sequelize.define('CustomerTag', {
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
  name: {
    type: DataTypes.STRING(100),
    allowNull: false,
  },
  color: {
    type: DataTypes.STRING(20),
    allowNull: true,
  },
}, {
  tableName: 'customer_tags',
  timestamps: true,
  underscored: true,

  indexes: [
    { fields: ['tenant_id', 'name'], unique: true },
  ],
});

module.exports = CustomerTag;
