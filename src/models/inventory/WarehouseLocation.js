const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

// Ubicación física dentro de una bodega (pasillo / estante / nivel), migración
// 2026111302. Cada producto puede tener UNA ubicación (Product.location_id),
// siempre dentro de su propia bodega.
//
// Alcance (req. 2.2, versión mínima): el stock sigue siendo un solo
// Product.current_stock; la ubicación dice DÓNDE se guarda el producto, no
// cuánto hay en cada lugar. Repartir el stock por ubicación exigiría otro
// modelo de inventario y no está en esta versión.
const WarehouseLocation = sequelize.define('WarehouseLocation', {
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
  warehouse_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'warehouses', key: 'id' },
    onDelete: 'CASCADE'
  },
  // Código legible que se imprime/rotula: "A-03-2". Único por bodega.
  code: {
    type: DataTypes.STRING(40),
    allowNull: false
  },
  aisle: { type: DataTypes.STRING(20), allowNull: true },
  shelf: { type: DataTypes.STRING(20), allowNull: true },
  level: { type: DataTypes.STRING(20), allowNull: true },
  description: { type: DataTypes.STRING(200), allowNull: true },
  is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }
}, {
  tableName: 'warehouse_locations',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    { fields: ['tenant_id'] },
    { fields: ['warehouse_id'] }
  ]
});

module.exports = WarehouseLocation;
