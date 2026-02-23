const { sequelize } = require('../config/database');

// Autenticación
const Tenant = require('./auth/Tenant');
const User = require('./auth/User');
const Permission = require('./auth/Permission');
const RolePermission = require('./auth/RolePermission');

// Inventario
const Category = require('./inventory/Category');
const Product = require('./inventory/Product');
const Supplier = require('./inventory/Supplier');
const Purchase = require('./inventory/Purchase');
const PurchaseItem = require('./inventory/PurchaseItem');
const Warehouse = require('./inventory/Warehouse');
const InventoryMovement = require('./inventory/InventoryMovement');
const InventoryAdjustment = require('./inventory/InventoryAdjustment');
const InventoryAdjustmentItem = require('./inventory/InventoryAdjustmentItem');
const StockAlert = require('./StockAlert');

// NUEVOS - Movimientos Avanzados
const SupplierReturn = require('./inventory/SupplierReturn');
const SupplierReturnItem = require('./inventory/SupplierReturnItem');
const Transfer = require('./inventory/Transfer');
const TransferItem = require('./inventory/TransferItem');
const InternalConsumption = require('./inventory/InternalConsumption');
const InternalConsumptionItem = require('./inventory/InternalConsumptionItem');

// Ventas
const Customer = require('./sales/Customer');
const Sale = require('./sales/Sale');
const SaleItem = require('./sales/SaleItem');
const CustomerReturn = require('./sales/CustomerReturn');
const CustomerReturnItem = require('./sales/CustomerReturnItem');

// NUEVOS MODELOS
const Invoice = require('./billing/Invoice');
const SubscriptionPlan = require('./subscriptions/SubscriptionPlan');
const TenantSubscription = require('./subscriptions/TenantSubscription');
const SubscriptionInvoice = require('./subscriptions/SubscriptionInvoice');
const SuperAdminMercadoPagoConfig = require('./payments/SuperAdminMercadoPagoConfig');
const TenantMercadoPagoConfig = require('./payments/TenantMercadoPagoConfig');

// ✅ NUEVO - Sistema de Anuncios
const Announcement = require('./Announcement');
const UserAnnouncementView = require('./UserAnnouncementView');
// ✅ NUEVO - Taller
const Vehicle = require('./workshop/Vehicle');
const WorkOrder = require('./workshop/WorkOrder');
const WorkOrderItem = require('./workshop/WorkOrderItem');
const CommissionSettlement = require('./workshop/CommissionSettlement');
const CommissionSettlementItem = require('./workshop/CommissionSettlementItem');
// ============= RELACIONES EXISTENTES =============
Tenant.hasMany(User, { foreignKey: 'tenant_id', as: 'users' });
User.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });

Purchase.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
User.hasMany(Purchase, { foreignKey: 'user_id', as: 'purchases' });

InventoryMovement.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
User.hasMany(InventoryMovement, { foreignKey: 'user_id', as: 'movements' });

InventoryAdjustment.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
User.hasMany(InventoryAdjustment, { foreignKey: 'user_id', as: 'adjustments' });

StockAlert.belongsTo(Product, { foreignKey: 'product_id', as: 'product' });
Product.hasMany(StockAlert, { foreignKey: 'product_id', as: 'alerts' });

StockAlert.belongsTo(User, { foreignKey: 'resolved_by', as: 'resolver' });
User.hasMany(StockAlert, { foreignKey: 'resolved_by', as: 'resolved_alerts' });

StockAlert.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
Tenant.hasMany(StockAlert, { foreignKey: 'tenant_id', as: 'stock_alerts' });

// Relaciones de Suscripciones
Tenant.hasMany(TenantSubscription, { foreignKey: 'tenant_id', as: 'subscriptions' });
TenantSubscription.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });

SubscriptionPlan.hasMany(TenantSubscription, { foreignKey: 'plan_id', as: 'subscriptions' });
TenantSubscription.belongsTo(SubscriptionPlan, { foreignKey: 'plan_id', as: 'plan' });

TenantSubscription.hasMany(SubscriptionInvoice, { foreignKey: 'subscription_id', as: 'invoices' });
SubscriptionInvoice.belongsTo(TenantSubscription, { foreignKey: 'subscription_id', as: 'subscription' });

SubscriptionInvoice.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
SubscriptionInvoice.belongsTo(SubscriptionPlan, { foreignKey: 'plan_id', as: 'plan' });

Invoice.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
Invoice.belongsTo(User, { foreignKey: 'created_by', as: 'creator' });

TenantMercadoPagoConfig.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
Tenant.hasOne(TenantMercadoPagoConfig, { foreignKey: 'tenant_id', as: 'mercadopago_config' });

Permission.hasMany(RolePermission, { foreignKey: 'permission_id', as: 'role_permissions' });
RolePermission.belongsTo(Permission, { foreignKey: 'permission_id', as: 'permission' });

// Relaciones de Ventas
Customer.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
Tenant.hasMany(Customer, { foreignKey: 'tenant_id', as: 'customers' });

Customer.hasMany(Sale, { foreignKey: 'customer_id', as: 'sales' });
Sale.belongsTo(Customer, { foreignKey: 'customer_id', as: 'customer' });

Sale.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
Tenant.hasMany(Sale, { foreignKey: 'tenant_id', as: 'sales' });

Sale.belongsTo(User, { foreignKey: 'created_by', as: 'creator' });
User.hasMany(Sale, { foreignKey: 'created_by', as: 'created_sales' });

Sale.hasMany(SaleItem, { foreignKey: 'sale_id', as: 'items' });
SaleItem.belongsTo(Sale, { foreignKey: 'sale_id', as: 'sale' });

SaleItem.belongsTo(Product, { foreignKey: 'product_id', as: 'product' });
Product.hasMany(SaleItem, { foreignKey: 'product_id', as: 'sale_items' });

// ============= NUEVAS RELACIONES - MOVIMIENTOS AVANZADOS =============

// CustomerReturn - Sale
CustomerReturn.belongsTo(Sale, { foreignKey: 'sale_id', as: 'sale' });
Sale.hasMany(CustomerReturn, { foreignKey: 'sale_id', as: 'returns' });

// CustomerReturn - Customer
CustomerReturn.belongsTo(Customer, { foreignKey: 'customer_id', as: 'customer' });
Customer.hasMany(CustomerReturn, { foreignKey: 'customer_id', as: 'returns' });

// CustomerReturn - CustomerReturnItem
CustomerReturn.hasMany(CustomerReturnItem, { foreignKey: 'return_id', as: 'items' });
CustomerReturnItem.belongsTo(CustomerReturn, { foreignKey: 'return_id', as: 'return' });

// CustomerReturnItem - SaleItem
CustomerReturnItem.belongsTo(SaleItem, { foreignKey: 'sale_item_id', as: 'saleItem' });
SaleItem.hasMany(CustomerReturnItem, { foreignKey: 'sale_item_id', as: 'return_items' });

// CustomerReturnItem - Product
CustomerReturnItem.belongsTo(Product, { foreignKey: 'product_id', as: 'product' });
Product.hasMany(CustomerReturnItem, { foreignKey: 'product_id', as: 'customer_return_items' });

// SupplierReturn - Purchase
SupplierReturn.belongsTo(Purchase, { foreignKey: 'purchase_id', as: 'purchase' });
Purchase.hasMany(SupplierReturn, { foreignKey: 'purchase_id', as: 'returns' });

// SupplierReturn - Supplier
SupplierReturn.belongsTo(Supplier, { foreignKey: 'supplier_id', as: 'supplier' });
Supplier.hasMany(SupplierReturn, { foreignKey: 'supplier_id', as: 'returns' });

// SupplierReturn - SupplierReturnItem
SupplierReturn.hasMany(SupplierReturnItem, { foreignKey: 'return_id', as: 'items' });
SupplierReturnItem.belongsTo(SupplierReturn, { foreignKey: 'return_id', as: 'return' });

// SupplierReturnItem - Product
SupplierReturnItem.belongsTo(Product, { foreignKey: 'product_id', as: 'product' });
Product.hasMany(SupplierReturnItem, { foreignKey: 'product_id', as: 'supplier_return_items' });

// SupplierReturnItem - PurchaseItem
SupplierReturnItem.belongsTo(PurchaseItem, { foreignKey: 'purchase_item_id', as: 'purchaseItem' });
PurchaseItem.hasMany(SupplierReturnItem, { foreignKey: 'purchase_item_id', as: 'return_items' });

// Transfer - Warehouse (from/to)
Transfer.belongsTo(Warehouse, { foreignKey: 'from_warehouse_id', as: 'fromWarehouse' });
Transfer.belongsTo(Warehouse, { foreignKey: 'to_warehouse_id', as: 'toWarehouse' });
Warehouse.hasMany(Transfer, { foreignKey: 'from_warehouse_id', as: 'outgoing_transfers' });
Warehouse.hasMany(Transfer, { foreignKey: 'to_warehouse_id', as: 'incoming_transfers' });

// Transfer - TransferItem
Transfer.hasMany(TransferItem, { foreignKey: 'transfer_id', as: 'items' });
TransferItem.belongsTo(Transfer, { foreignKey: 'transfer_id', as: 'transfer' });

// TransferItem - Product
TransferItem.belongsTo(Product, { foreignKey: 'product_id', as: 'product' });
Product.hasMany(TransferItem, { foreignKey: 'product_id', as: 'transfer_items' });

// InternalConsumption - Warehouse
InternalConsumption.belongsTo(Warehouse, { foreignKey: 'warehouse_id', as: 'warehouse' });
Warehouse.hasMany(InternalConsumption, { foreignKey: 'warehouse_id', as: 'consumptions' });

// InternalConsumption - InternalConsumptionItem
InternalConsumption.hasMany(InternalConsumptionItem, { foreignKey: 'consumption_id', as: 'items' });
InternalConsumptionItem.belongsTo(InternalConsumption, { foreignKey: 'consumption_id', as: 'consumption' });

// InternalConsumptionItem - Product
InternalConsumptionItem.belongsTo(Product, { foreignKey: 'product_id', as: 'product' });
Product.hasMany(InternalConsumptionItem, { foreignKey: 'product_id', as: 'consumption_items' });

// ✅ NUEVAS RELACIONES - SISTEMA DE ANUNCIOS =============

// Announcement - User (creator)
Announcement.belongsTo(User, { foreignKey: 'created_by', as: 'creator' });
User.hasMany(Announcement, { foreignKey: 'created_by', as: 'created_announcements' });

// UserAnnouncementView - User
UserAnnouncementView.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
User.hasMany(UserAnnouncementView, { foreignKey: 'user_id', as: 'announcement_views' });

// UserAnnouncementView - Announcement
UserAnnouncementView.belongsTo(Announcement, { foreignKey: 'announcement_id', as: 'announcement' });
Announcement.hasMany(UserAnnouncementView, { foreignKey: 'announcement_id', as: 'views' });
// ============= RELACIONES - TALLER =============

// Vehicle ↔ Customer
Vehicle.belongsTo(Customer, { foreignKey: 'customer_id', as: 'customer' });
Customer.hasMany(Vehicle, { foreignKey: 'customer_id', as: 'vehicles' });

// WorkOrder ↔ Vehicle
WorkOrder.belongsTo(Vehicle, { foreignKey: 'vehicle_id', as: 'vehicle' });
Vehicle.hasMany(WorkOrder, { foreignKey: 'vehicle_id', as: 'work_orders' });

// WorkOrder ↔ Customer
WorkOrder.belongsTo(Customer, { foreignKey: 'customer_id', as: 'customer' });
Customer.hasMany(WorkOrder, { foreignKey: 'customer_id', as: 'work_orders' });

// WorkOrder ↔ User (técnico)
WorkOrder.belongsTo(User, { foreignKey: 'technician_id', as: 'technician' });
User.hasMany(WorkOrder, { foreignKey: 'technician_id', as: 'work_orders_assigned' });

// WorkOrder ↔ User (creador)
WorkOrder.belongsTo(User, { foreignKey: 'created_by', as: 'creator_wo' });

// WorkOrder ↔ Warehouse
WorkOrder.belongsTo(Warehouse, { foreignKey: 'warehouse_id', as: 'warehouse' });

// WorkOrder ↔ Sale (remisión generada)
WorkOrder.belongsTo(Sale, { foreignKey: 'sale_id', as: 'sale' });
Sale.hasOne(WorkOrder, { foreignKey: 'sale_id', as: 'work_order' });

// WorkOrderItem ↔ WorkOrder
WorkOrderItem.belongsTo(WorkOrder, { foreignKey: 'work_order_id', as: 'work_order' });
WorkOrder.hasMany(WorkOrderItem, { foreignKey: 'work_order_id', as: 'items' });

// WorkOrderItem ↔ Product
WorkOrderItem.belongsTo(Product, { foreignKey: 'product_id', as: 'product' });
Product.hasMany(WorkOrderItem, { foreignKey: 'product_id', as: 'work_order_items' });

// CommissionSettlement ↔ User (técnico)
CommissionSettlement.belongsTo(User, { foreignKey: 'technician_id', as: 'technician' });
User.hasMany(CommissionSettlement, { foreignKey: 'technician_id', as: 'commission_settlements' });

// CommissionSettlement ↔ User (creador)
CommissionSettlement.belongsTo(User, { foreignKey: 'created_by', as: 'creator_cs' });

// CommissionSettlement ↔ CommissionSettlementItem
CommissionSettlement.hasMany(CommissionSettlementItem, { foreignKey: 'settlement_id', as: 'items' });
CommissionSettlementItem.belongsTo(CommissionSettlement, { foreignKey: 'settlement_id', as: 'settlement' });

// CommissionSettlementItem ↔ WorkOrder
CommissionSettlementItem.belongsTo(WorkOrder, { foreignKey: 'work_order_id', as: 'work_order' });
WorkOrder.hasMany(CommissionSettlementItem, { foreignKey: 'work_order_id', as: 'settlement_items' });

// WorkOrder ↔ CommissionSettlement (liquidación en la que fue incluida)
WorkOrder.belongsTo(CommissionSettlement, { foreignKey: 'settlement_id', as: 'commission_settlement' });

module.exports = {
  sequelize,
  Tenant,
  User,
  Permission,
  RolePermission,
  Category,
  Product,
  Supplier,
  Purchase,
  PurchaseItem,
  Warehouse,
  InventoryMovement,
  InventoryAdjustment,
  InventoryAdjustmentItem,
  StockAlert,
  Invoice,
  SubscriptionPlan,
  TenantSubscription,
  SubscriptionInvoice,
  SuperAdminMercadoPagoConfig,
  TenantMercadoPagoConfig,
  Customer,
  Sale,
  SaleItem,
  CustomerReturn,
  CustomerReturnItem,
  SupplierReturn,
  SupplierReturnItem,
  Transfer,
  TransferItem,
  InternalConsumption,
  InternalConsumptionItem,
  Announcement,
  UserAnnouncementView,
  Vehicle,
  WorkOrder,
  WorkOrderItem,
  CommissionSettlement,
  CommissionSettlementItem,
};