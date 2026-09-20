const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

// Línea de una sesión de conteo físico. Snapshot de system_qty al generar la
// plantilla; counted_qty queda null hasta que se sube el Excel (celda vacía =
// "no contado", nunca 0 implícito). diff_qty se recalcula contra el stock
// ACTUAL al momento de aplicar (dry_run=false), no contra este snapshot.
const PhysicalCountItem = sequelize.define('PhysicalCountItem', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  count_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'physical_counts', key: 'id' },
    onDelete: 'CASCADE'
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'tenants', key: 'id' }
  },
  product_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'products', key: 'id' }
  },
  product_sku: {
    type: DataTypes.STRING(50),
    allowNull: true,
    comment: 'Snapshot del SKU al generar la plantilla (respaldo de parseo)'
  },
  product_name: {
    type: DataTypes.STRING(200),
    allowNull: true,
    comment: 'Snapshot del nombre al generar la plantilla'
  },
  system_qty: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0,
    comment: 'current_stock del producto al momento de generar la plantilla'
  },
  counted_qty: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: true,
    comment: 'Cantidad contada leída del Excel; null = fila no contada'
  },
  diff_qty: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: true,
    comment: 'Diferencia realmente aplicada (contra el stock actual al confirmar)'
  },
  unit_cost: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0,
    comment: 'product.average_cost al momento de generar la plantilla'
  },
  has_conflict: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    comment: 'true si current_stock ya no coincidía con system_qty al subir el archivo'
  },
  applied: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
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
  tableName: 'physical_count_items',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    { fields: ['count_id'] },
    { fields: ['product_id'] },
    { fields: ['tenant_id'] }
  ]
});

module.exports = PhysicalCountItem;
