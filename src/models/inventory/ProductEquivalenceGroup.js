const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const ProductEquivalenceGroup = sequelize.define('ProductEquivalenceGroup', {
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
  name: {
    type: DataTypes.STRING(150),
    allowNull: false
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  created_by: {
    type: DataTypes.UUID,
    allowNull: true
  }
}, {
  tableName: 'product_equivalence_groups',
  timestamps: true,
  underscored: true
});

module.exports = ProductEquivalenceGroup;
