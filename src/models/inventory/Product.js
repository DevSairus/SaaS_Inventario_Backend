// backend/src/models/inventory/Product.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const Product = sequelize.define('Product', {
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
  category_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'categories', key: 'id' }
  },
  // ── Tipo de ítem ─────────────────────────────────────────
  product_type: {
    type: DataTypes.ENUM('product', 'service'),
    allowNull: false,
    defaultValue: 'product',
    comment: 'product = producto físico con inventario, service = servicio sin inventario'
  },
  // ─────────────────────────────────────────────────────────
  sku: {
    type: DataTypes.STRING(50),
    allowNull: false,
    unique: true
  },
  barcode: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  name: {
    type: DataTypes.STRING(200),
    allowNull: false
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  unit_of_measure: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'unit'
  },
  average_cost: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0
  },
  min_stock: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0
  },
  max_stock: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: true
  },
  base_price: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: true
  },
  sale_price: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: true
  },
  profit_margin_percentage: {
    type: DataTypes.DECIMAL(5, 2),
    allowNull: true
  },
  has_tax: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
    comment: 'Indica si el producto/servicio tiene IVA (true) o está exento (false)'
  },
  tax_percentage: {
    type: DataTypes.DECIMAL(5, 2),
    allowNull: false,
    defaultValue: 19.00,
    comment: 'Porcentaje de IVA aplicable (0, 5, 10, 19, etc.)'
  },
  price_includes_tax: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    comment: 'Indica si el precio base ya incluye el IVA (true) o hay que sumarlo (false)'
  },
  current_stock: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0
  },
  reserved_stock: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0
  },
  available_stock: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0
  },
  reorder_point: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: true
  },
  track_inventory: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true
  },
  allow_negative_stock: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  },
  image_url: {
    type: DataTypes.STRING(500),
    allowNull: true
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true
  },
  created_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
    field: 'created_at'
  },
  updated_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
    field: 'updated_at'
  }
}, {
  tableName: 'products',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

const Supplier = require('./Supplier');
const ProductSupplier = require('./ProductSupplier');

Product.belongsToMany(Supplier, {
  through: ProductSupplier,
  foreignKey: 'product_id',
  otherKey: 'supplier_id',
  as: 'suppliers'
});

Supplier.belongsToMany(Product, {
  through: ProductSupplier,
  foreignKey: 'supplier_id',
  otherKey: 'product_id',
  as: 'products'
});

module.exports = Product;