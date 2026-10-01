// ========== IMPORTAR MODELOS ==========
const Product = require('./Product');
const Category = require('./Category');
const Supplier = require('./Supplier');
const ProductSupplier = require('./ProductSupplier');
const Purchase = require('./Purchase');
const PurchaseItem = require('./PurchaseItem');
const Warehouse = require('./Warehouse');
const InventoryMovement = require('./InventoryMovement');
const InventoryAdjustment = require('./InventoryAdjustment');
const InventoryAdjustmentItem = require('./InventoryAdjustmentItem');
const ProductEquivalenceGroup = require('./ProductEquivalenceGroup');
const ProductEquivalenceGroupMember = require('./ProductEquivalenceGroupMember');
const ProductVehicleApplication = require('./ProductVehicleApplication');
const PhysicalCount = require('./PhysicalCount');
const PhysicalCountItem = require('./PhysicalCountItem');
const Combo = require('./Combo');
const ComboItem = require('./ComboItem');

// ========== RELACIONES ==========

// Category - Product (1:N)
Category.hasMany(Product, { foreignKey: 'category_id', as: 'products' });
Product.belongsTo(Category, { foreignKey: 'category_id', as: 'category' });

// Category - Category (Self-referencing for hierarchy)
Category.hasMany(Category, { foreignKey: 'parent_id', as: 'children' });
Category.belongsTo(Category, { foreignKey: 'parent_id', as: 'parent' });

// Product - Warehouse (N:1)
Product.belongsTo(Warehouse, { foreignKey: 'warehouse_id', as: 'warehouse' });
Warehouse.hasMany(Product, { foreignKey: 'warehouse_id', as: 'products' });

// NOTA: Product - Supplier (N:M) ya está definido en Product.js
// No se define aquí para evitar duplicación

// Purchase - Supplier (N:1)
Purchase.belongsTo(Supplier, { foreignKey: 'supplier_id', as: 'supplier' });
Supplier.hasMany(Purchase, { foreignKey: 'supplier_id', as: 'purchases' });

// Purchase - PurchaseItem (1:N)
Purchase.hasMany(PurchaseItem, { foreignKey: 'purchase_id', as: 'items' });
PurchaseItem.belongsTo(Purchase, { foreignKey: 'purchase_id', as: 'purchase' });

// PurchaseItem - Product (N:1)
PurchaseItem.belongsTo(Product, { foreignKey: 'product_id', as: 'product' });
Product.hasMany(PurchaseItem, { foreignKey: 'product_id', as: 'purchase_items' });

// InventoryMovement - Product (N:1)
InventoryMovement.belongsTo(Product, { foreignKey: 'product_id', as: 'product' });
Product.hasMany(InventoryMovement, { foreignKey: 'product_id', as: 'movements' });

// InventoryMovement - Warehouse (N:1)
InventoryMovement.belongsTo(Warehouse, { foreignKey: 'warehouse_id', as: 'warehouse' });
Warehouse.hasMany(InventoryMovement, { foreignKey: 'warehouse_id', as: 'movements' });

// InventoryAdjustment - InventoryAdjustmentItem (1:N)
InventoryAdjustment.hasMany(InventoryAdjustmentItem, {
  foreignKey: 'adjustment_id',
  as: 'items'
});
InventoryAdjustmentItem.belongsTo(InventoryAdjustment, {
  foreignKey: 'adjustment_id',
  as: 'adjustment'
});

// InventoryAdjustmentItem - Product (N:1)
InventoryAdjustmentItem.belongsTo(Product, {
  foreignKey: 'product_id',
  as: 'product'
});
Product.hasMany(InventoryAdjustmentItem, {
  foreignKey: 'product_id',
  as: 'adjustment_items'
});

// PhysicalCount - PhysicalCountItem (1:N)
PhysicalCount.hasMany(PhysicalCountItem, { foreignKey: 'count_id', as: 'items' });
PhysicalCountItem.belongsTo(PhysicalCount, { foreignKey: 'count_id', as: 'count' });

// PhysicalCountItem - Product (N:1)
PhysicalCountItem.belongsTo(Product, { foreignKey: 'product_id', as: 'product' });
Product.hasMany(PhysicalCountItem, { foreignKey: 'product_id', as: 'physical_count_items' });

// PhysicalCount - Warehouse / Category (N:1, filtros usados al generar)
PhysicalCount.belongsTo(Warehouse, { foreignKey: 'warehouse_id', as: 'warehouse' });
PhysicalCount.belongsTo(Category, { foreignKey: 'category_id', as: 'category' });

// PhysicalCount - InventoryAdjustment (los dos ajustes que genera al aplicar)
PhysicalCount.belongsTo(InventoryAdjustment, { foreignKey: 'entry_adjustment_id', as: 'entry_adjustment' });
PhysicalCount.belongsTo(InventoryAdjustment, { foreignKey: 'exit_adjustment_id', as: 'exit_adjustment' });

// InventoryAdjustment - PhysicalCount (de dónde vino el ajuste, si aplica)
InventoryAdjustment.belongsTo(PhysicalCount, { foreignKey: 'physical_count_id', as: 'physical_count' });
PhysicalCount.hasMany(InventoryAdjustment, { foreignKey: 'physical_count_id', as: 'adjustments' });

// ProductVehicleApplication - Product (N:1)
ProductVehicleApplication.belongsTo(Product, {
  foreignKey: 'product_id',
  as: 'product'
});
Product.hasMany(ProductVehicleApplication, {
  foreignKey: 'product_id',
  as: 'vehicleApplications'
});

// Combo - ComboItem (1:N)
Combo.hasMany(ComboItem, { foreignKey: 'combo_id', as: 'items' });
ComboItem.belongsTo(Combo, { foreignKey: 'combo_id', as: 'combo' });

// ComboItem - Product (N:1)
ComboItem.belongsTo(Product, { foreignKey: 'product_id', as: 'product' });
Product.hasMany(ComboItem, { foreignKey: 'product_id', as: 'combo_items' });

// ========== EXPORTAR ==========
module.exports = {
  Product,
  Category,
  Supplier,
  ProductSupplier,
  Purchase,
  PurchaseItem,
  Warehouse,
  InventoryMovement,
  InventoryAdjustment,
  InventoryAdjustmentItem,
  ProductEquivalenceGroup,
  ProductEquivalenceGroupMember,
  ProductVehicleApplication,
  PhysicalCount,
  PhysicalCountItem,
  Combo,
  ComboItem
};
