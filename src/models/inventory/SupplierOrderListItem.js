// backend/src/models/inventory/SupplierOrderListItem.js
// Línea de una lista de pedido. product_id NULL = línea libre (solo descripción).
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const SupplierOrderListItem = sequelize.define('SupplierOrderListItem', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'tenants', key: 'id' },
  },
  list_id: { type: DataTypes.UUID, allowNull: false },
  product_id: { type: DataTypes.UUID, allowNull: true },
  description: { type: DataTypes.STRING(255), allowNull: true },
  quantity: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  notes: { type: DataTypes.TEXT, allowNull: true },
  source: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'manual',
    validate: { isIn: [['manual', 'stock_alert', 'product']] },
  },
  added_by: { type: DataTypes.UUID, allowNull: true },
}, {
  tableName: 'supplier_order_list_items',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = SupplierOrderListItem;
