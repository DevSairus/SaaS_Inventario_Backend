// backend/src/models/inventory/SupplierOrderList.js
// Lista de pedido a proveedor (sin precios): ver la migración 2026102801 y
// controllers/inventory/orderLists.controller.js.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const SupplierOrderList = sequelize.define('SupplierOrderList', {
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
  supplier_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'suppliers', key: 'id' },
  },
  list_number: { type: DataTypes.STRING(30), allowNull: false },
  status: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'open',
    validate: { isIn: [['open', 'ordered', 'cancelled']] },
  },
  notes: { type: DataTypes.TEXT, allowNull: true },
  ordered_at: { type: DataTypes.DATE, allowNull: true },
  ordered_by: { type: DataTypes.UUID, allowNull: true },
  cancelled_at: { type: DataTypes.DATE, allowNull: true },
  cancelled_by: { type: DataTypes.UUID, allowNull: true },
  purchase_id: { type: DataTypes.UUID, allowNull: true },
  sent_log: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
  created_by: { type: DataTypes.UUID, allowNull: true },
}, {
  tableName: 'supplier_order_lists',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = SupplierOrderList;
