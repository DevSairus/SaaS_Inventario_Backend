const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const ProductEquivalenceGroupMember = sequelize.define('ProductEquivalenceGroupMember', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'tenants',
      key: 'id'
    }
  },
  group_id: {
    type: DataTypes.UUID,
    allowNull: false
  },
  product_id: {
    type: DataTypes.UUID,
    allowNull: false
  },
  role: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'equivalente'
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true
  }
}, {
  tableName: 'product_equivalence_group_members',
  timestamps: true,
  underscored: true,
  updatedAt: false
});

module.exports = ProductEquivalenceGroupMember;
