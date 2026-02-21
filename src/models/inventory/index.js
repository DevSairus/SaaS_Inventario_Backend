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

// ========== RELACIONES ==========

// Category - Product (1:N)
Category.hasMany(Product, { foreignKey: 'category_id', as: 'products' });
Product.belongsTo(Category, { foreignKey: 'category_id', as: 'category' });

// Category - Category (Self-referencing for hierarchy)
Category.hasMany(Category, { foreignKey: 'parent_id', as: 'children' });
Category.belongsTo(Category, { foreignKey: 'parent_id', as: 'parent' });

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
  InventoryAdjustmentItem
};