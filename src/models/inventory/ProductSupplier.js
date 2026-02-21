const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const ProductSupplier = sequelize.define('ProductSupplier', {
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
  product_id: {
    type: DataTypes.UUID,
    allowNull: false
  },
  supplier_id: {
    type: DataTypes.UUID,
    allowNull: false
  },
  last_price: {
    type: DataTypes.DECIMAL(15, 2)
  },
  last_purchase_date: {
    type: DataTypes.DATE
  },
  lead_time_days: {
    type: DataTypes.INTEGER
  }
}, {
  tableName: 'product_suppliers',
  timestamps: true,
  underscored: true
});

module.exports = ProductSupplier;