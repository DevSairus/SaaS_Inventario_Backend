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
  warehouse_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'warehouses', key: 'id' }
  },
  // Ubicación física dentro de la bodega del producto (migración 2026111302).
  // Siempre de la misma bodega que warehouse_id (lo valida el controlador).
  location_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'warehouse_locations', key: 'id' }
  },
  product_type: {
    type: DataTypes.ENUM('simple', 'variant', 'service', 'bundle', 'raw_material', 'vehicle'),
    allowNull: false,
    defaultValue: 'simple'
  },
  // Marca del producto (ej. "Bosch", "Michelin"). Columna ya existía en el
  // baseline de BD pero nunca se declaró acá -- Product.create/update la
  // descartaba en silencio aunque el controller la enviara.
  brand: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  // Solo aplica a product_type='vehicle' -- vincula este producto (stock de
  // concesionario) con la fila real en `vehicles`, para que el vehículo
  // también sea consultable/editable como tal en el resto del sistema.
  vehicle_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'vehicles', key: 'id' }
  },
  // Solo aplica a product_type='service'. Cuando está marcado, agregar este
  // producto a una OT precarga item_type='mano_obra' en vez de 'servicio'
  // (ver WorkOrderDetailPage.jsx#handleSelectProduct) -- distingue mano de
  // obra facturable a comisión de un servicio genérico sin comisión.
  is_labor: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  },
  // Tempario (solo servicios de mano de obra): horas estándar de la
  // operación y cómo se fija el precio. 'hourly' = base_price = horas × valor
  // hora de la empresa (business_config.labor_hour_rate), lo mantiene
  // services/workshop/laborTimes.service.js; 'fixed'/NULL = precio propio.
  standard_hours: {
    type: DataTypes.DECIMAL(8, 2),
    allowNull: true
  },
  labor_pricing_mode: {
    type: DataTypes.STRING(10),
    allowNull: true,
    validate: { isIn: [['fixed', 'hourly']] }
  },
  sku: {
    type: DataTypes.STRING(50),
    allowNull: false,
    unique: true
  },
  barcode: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  // Cuenta de ingreso propia y, si se causa en varios meses (anualidad,
  // semestre), la cuenta de pasivo del diferido (ver deferredRevenue.service.js).
  revenue_account_id: { type: DataTypes.UUID, allowNull: true },
  deferred_months: { type: DataTypes.INTEGER, allowNull: true, validate: { min: 1, max: 120 } },
  deferred_account_id: { type: DataTypes.UUID, allowNull: true },
  // Código UNSPSC (8 dígitos) para la factura electrónica (tabla 13.3.5).
  unspsc_code: {
    type: DataTypes.STRING(8),
    allowNull: true,
    validate: { is: /^\d{8}$/ }
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
  // Último costo unitario de compra (aterrizado: con descuento global y flete
  // prorrateados, igual que lo capitalizado en el kardex). Lo escriben la
  // recepción de compras y los ajustes de entrada con motivo "compra". Sin
  // estos atributos en el modelo, Sequelize descartaba en silencio el update
  // que ya hacía receivePurchase y la columna quedaba siempre en 0.
  last_purchase_cost: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: true,
    defaultValue: 0
  },
  last_purchase_date: {
    type: DataTypes.DATEONLY,
    allowNull: true
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
  // true = sigue el margen de su categoría o el global; profit_margin_percentage
  // guarda una copia del margen efectivo (ver productMargin.service.js).
  margin_inherited: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  },
  has_tax: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true
  },
  tax_percentage: {
    type: DataTypes.DECIMAL(5, 2),
    allowNull: false,
    defaultValue: 19.00
  },
  price_includes_tax: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  },
  // Concepto de retención en la fuente (catálogo del tenant). NULL = heredar
  // de la categoría / proveedor / tipo (ver retentionEngine.service.js).
  retention_concept: {
    type: DataTypes.STRING(60),
    allowNull: true
  },
  tax_config: {
    type: DataTypes.JSONB,
    allowNull: true,
    defaultValue: { iva: { enabled: true, rate: 19 }, inc: { enabled: false, rate: 0 }, ica: { enabled: false, rate: 0 } },
    comment: 'Configuración de impuestos: { iva, inc, ica }'
  },
  current_stock: {
    type: DataTypes.DECIMAL(15, 4),
    allowNull: false,
    defaultValue: 0
  },
  reserved_stock: {
    type: DataTypes.DECIMAL(15, 4),
    allowNull: false,
    defaultValue: 0
  },
  available_stock: {
    type: DataTypes.DECIMAL(15, 4),
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
  updatedAt: 'updated_at',
  hooks: {
    // Tempario: un servicio "por hora" toma su precio de horas × valor hora
    // de la empresa al crearlo o al cambiarle horas/modo desde la ficha.
    beforeSave: async (product, options) => {
      const { applyHourlyPrice } = require('../../services/workshop/laborTimes.service');
      await applyHourlyPrice(product, options?.transaction);
    },
  },
});

const Supplier = require('./Supplier');
const ProductSupplier = require('./ProductSupplier');
const ProductEquivalenceGroup = require('./ProductEquivalenceGroup');
const ProductEquivalenceGroupMember = require('./ProductEquivalenceGroupMember');
const Vehicle = require('../workshop/Vehicle');

Product.belongsTo(Vehicle, { foreignKey: 'vehicle_id', as: 'vehicle' });

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

// Equivalencias: Product ↔ Group (N:M a través de GroupMember)
ProductEquivalenceGroup.hasMany(ProductEquivalenceGroupMember, {
  foreignKey: 'group_id',
  as: 'members'
});
ProductEquivalenceGroupMember.belongsTo(ProductEquivalenceGroup, {
  foreignKey: 'group_id',
  as: 'group'
});
ProductEquivalenceGroupMember.belongsTo(Product, {
  foreignKey: 'product_id',
  as: 'product'
});
Product.hasMany(ProductEquivalenceGroupMember, {
  foreignKey: 'product_id',
  as: 'equivalenceMemberships'
});

module.exports = Product;