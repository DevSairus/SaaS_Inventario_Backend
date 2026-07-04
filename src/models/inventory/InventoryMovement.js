const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const InventoryMovement = sequelize.define('InventoryMovement', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'tenants', key: 'id' }
  },
  movement_number: {
    type: DataTypes.STRING(50),
    allowNull: false,
    comment: 'Número único del movimiento: MOV-2026-00001'
  },
  movement_type: {
    type: DataTypes.STRING(50),
    allowNull: false,
    comment: 'Tipo: purchase, sale, adjustment_in, adjustment_out, etc.'
  },
  direction: {
    type: DataTypes.STRING(20),
    allowNull: false,
    validate: { isIn: [['in', 'out', 'none']] },
    comment: 'Dirección: in, out, none'
  },
  movement_reason: {
    type: DataTypes.STRING(100),
    allowNull: false,
    defaultValue: 'movimiento',
    field: 'reason',
    comment: 'Razón del movimiento (texto libre)'
  },
  reference_type: {
    type: DataTypes.STRING(50),
    allowNull: true,
    comment: 'Tipo de documento: purchase, sale, adjustment, transfer, work_order'
  },
  reference_id: {
    type: DataTypes.UUID,
    allowNull: true,
    comment: 'ID del documento relacionado'
  },
  product_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'products', key: 'id' }
  },
  warehouse_id: {
    type: DataTypes.UUID,
    allowNull: false,
    comment: 'Bodega donde ocurre el movimiento'
  },
  quantity: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    comment: 'Cantidad del movimiento (siempre positivo)'
  },
  unit_cost: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    comment: 'Costo unitario al momento del movimiento'
  },
  total_cost: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    comment: 'Costo total (quantity * unit_cost)'
  },
  previous_stock: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    field: 'stock_before',
    comment: 'Stock antes del movimiento'
  },
  new_stock: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    field: 'stock_after',
    comment: 'Stock después del movimiento'
  },
  user_id: {
    type: DataTypes.UUID,
    allowNull: false,
    field: 'created_by',
    references: { model: 'users', key: 'id' },
    comment: 'Usuario que registró el movimiento'
  },
  movement_date: {
    type: DataTypes.DATEONLY,
    allowNull: false,
    defaultValue: DataTypes.NOW,
    comment: 'Fecha del movimiento'
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  updated_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'inventory_movements',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    { unique: true, fields: ['tenant_id', 'movement_number'] },
    { fields: ['tenant_id'] },
    { fields: ['product_id'] },
    { fields: ['movement_date'] },
    { fields: ['movement_type'] },
    { fields: ['reference_type', 'reference_id'] },
    { fields: ['warehouse_id'] }
  ]
});

module.exports = InventoryMovement;
