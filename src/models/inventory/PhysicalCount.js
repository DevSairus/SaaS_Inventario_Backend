const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

// Sesión de conteo físico (toma de inventario) por Excel. Ver
// controllers/inventory/physicalCounts.controller.js. El stock del sistema es
// un solo current_stock global por producto (no hay stock por bodega real):
// warehouse_id/category_id acá son solo el filtro con el que se generó la
// plantilla, no una bodega distinta a la de Product.warehouse_id.
const PhysicalCount = sequelize.define('PhysicalCount', {
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
  count_number: {
    type: DataTypes.STRING(50),
    allowNull: false,
    comment: 'Número único de la sesión: TF-2026-00001'
  },
  warehouse_id: {
    type: DataTypes.UUID,
    allowNull: true,
    comment: 'Filtro de bodega usado al generar la plantilla (Product.warehouse_id)'
  },
  category_id: {
    type: DataTypes.UUID,
    allowNull: true,
    comment: 'Filtro de categoría usado al generar la plantilla'
  },
  include_inactive: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  },
  status: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'open',
    validate: {
      isIn: [['open', 'applied', 'cancelled']]
    }
  },
  generated_by: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' }
  },
  generated_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW
  },
  applied_by: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' }
  },
  applied_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  entry_adjustment_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'inventory_adjustments', key: 'id' }
  },
  exit_adjustment_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'inventory_adjustments', key: 'id' }
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  // ---- Totales de resumen, calculados al aplicar (dry_run=false) ----
  total_products: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  counted_products: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  not_counted_products: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  conflict_products: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  error_rows: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  surplus_products: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  surplus_qty: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  surplus_value: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  shortage_products: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  shortage_qty: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  shortage_value: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  updated_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'physical_counts',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    { unique: true, fields: ['tenant_id', 'count_number'] },
    { fields: ['tenant_id'] },
    { fields: ['status'] },
    { fields: ['warehouse_id'] }
  ]
});

module.exports = PhysicalCount;
