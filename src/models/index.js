const { sequelize } = require('../config/database');
const { registerTenantSchemaHooks } = require('../config/registerTenantSchemaHooks');

// Autenticación
const Tenant = require('./auth/Tenant');
const User = require('./auth/User');
const Branch = require('./Branch');
const UserBranch = require('./UserBranch');
const Permission = require('./auth/Permission');
const RolePermission = require('./auth/RolePermission');

// Contabilidad
const ChartOfAccount = require('./accounting/ChartOfAccount');
const FiscalPeriod = require('./accounting/FiscalPeriod');
const JournalEntry = require('./accounting/JournalEntry');
const JournalEntryLine = require('./accounting/JournalEntryLine');
const AccountMapping = require('./accounting/AccountMapping');
const AccountMappingAudit = require('./accounting/AccountMappingAudit');
const OpeningBalance = require('./accounting/OpeningBalance');

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
const NcfConfig = require('./payments/NcfConfig');
const MetaConfig = require('./payments/MetaConfig');
const TenantMetaConfig = require('./payments/TenantMetaConfig');

// ✅ NUEVO - Sistema de Anuncios
const Announcement = require('./Announcement');
const UserAnnouncementView = require('./UserAnnouncementView');
const AuditLog = require('../models/AuditLog');
// ✅ NUEVO - Taller
const Vehicle = require('./workshop/Vehicle');
const WorkOrder = require('./workshop/WorkOrder');
const WorkOrderItem = require('./workshop/WorkOrderItem');
const WorkOrderQuoteRequest = require('./workshop/WorkOrderQuoteRequest');
const WorkshopAppointmentConfig = require('./workshop/WorkshopAppointmentConfig');
const WorkshopAppointment = require('./workshop/WorkshopAppointment');
const CommissionSettlement = require('./workshop/CommissionSettlement');
const CommissionSettlementItem = require('./workshop/CommissionSettlementItem');
const ProductCommissionSettlement = require('./workshop/ProductCommissionSettlement');
const ProductCommissionSettlementItem = require('./workshop/ProductCommissionSettlementItem');
// ✅ NUEVO - Diagramas interactivos de intervención (fase 3)
const DiagramTemplate = require('./workshop/DiagramTemplate');
const WorkOrderDiagnosisMark = require('./workshop/WorkOrderDiagnosisMark');
const SaleDiagnosisMark = require('./sales/SaleDiagnosisMark');

// ✅ NUEVO - CRM (Fase 1)
const CustomerInteraction = require('./crm/CustomerInteraction');
// ✅ NUEVO - CRM (Fase 2)
const Opportunity = require('./crm/Opportunity');
const FollowUpTask = require('./crm/FollowUpTask');
const CustomerTag = require('./crm/CustomerTag');
const CustomerTagAssignment = require('./crm/CustomerTagAssignment');
// ✅ NUEVO - CRM (Fase B.3 / B.4)
const CrmPipelineStage = require('./crm/CrmPipelineStage');
const CrmLossReason = require('./crm/CrmLossReason');
const CrmMessageTemplate = require('./crm/CrmMessageTemplate');
// ✅ NUEVO - CRM (Fase C.1) — motor de automatizaciones configurables
const CrmAutomationRule = require('./crm/CrmAutomationRule');
const CrmAutomationRuleLog = require('./crm/CrmAutomationRuleLog');

// ✅ NUEVO - Módulo Ensambladora (sincronización con Core Ensambladora, Fase 0)
const EnsambladoraSyncCredential = require('./ensambladora/EnsambladoraSyncCredential');
const EnsambladoraEventoSync = require('./ensambladora/EnsambladoraEventoSync');
// ✅ NUEVO - Módulo Ensambladora, Fase 1 (cache local de vehículos consultados)
const VehiculoCache = require('./ensambladora/VehiculoCache');
// ✅ NUEVO - Módulo Ensambladora, Fase 2 (ciclo de vida: venta, alistamiento, entrega)
const EnsambladoraVenta = require('./ensambladora/EnsambladoraVenta');
const EnsambladoraOrdenAlistamiento = require('./ensambladora/EnsambladoraOrdenAlistamiento');
const EnsambladoraOrdenEntrega = require('./ensambladora/EnsambladoraOrdenEntrega');
// ✅ NUEVO - Módulo Ensambladora, Fase 3 (revisiones periódicas)
const EnsambladoraOrdenRevision = require('./ensambladora/EnsambladoraOrdenRevision');
// ✅ NUEVO - Módulo Ensambladora, Fase 4 (garantías)
const EnsambladoraOrdenGarantia = require('./ensambladora/EnsambladoraOrdenGarantia');
// ✅ NUEVO - Módulo Ensambladora, Fase 7 (técnicos/asesores, RUNT)
const EnsambladoraTecnicoAsesor = require('./ensambladora/EnsambladoraTecnicoAsesor');
const EnsambladoraRuntSolicitud = require('./ensambladora/EnsambladoraRuntSolicitud');
// ✅ NUEVO - Módulo Ensambladora (cotización de moto no vendida)
const EnsambladoraCotizacion = require('./ensambladora/EnsambladoraCotizacion');
// ✅ NUEVO - Módulo Ensambladora (auditoría de acciones sobre garantía/alistamiento/etc)
const EnsambladoraAuditLog = require('./ensambladora/EnsambladoraAuditLog');

// ✅ NUEVO - Catálogo normalizado de vehículos (Fase 6)
const VehicleBrand = require('./workshop/VehicleBrand');
const VehicleLine = require('./workshop/VehicleLine');

// DIAN - Facturación Electrónica
const DianResolution = require('./dian/DianResolution');
const DianEvent = require('./dian/DianEvent');

// ✅ NUEVO - Tesorería
const Expense = require('./finance/Expense');
const CashSession = require('./finance/CashSession');
const Receipt = require('./finance/Receipt');

// ✅ NUEVO - Asistente de IA (Fase 1 solo lectura + Fase 2 propuestas)
const AiConversation = require('./ai/AiConversation');
const AiMessage = require('./ai/AiMessage');
const AiProposal = require('./ai/AiProposal');

// ✅ NUEVO - Módulo de Soporte
const SupportFaqCategory = require('./support/SupportFaqCategory');
const SupportFaqArticle = require('./support/SupportFaqArticle');
const SupportTicket = require('./support/SupportTicket');
const SupportTicketMessage = require('./support/SupportTicketMessage');
const SupportTicketAttachment = require('./support/SupportTicketAttachment');
const RemoteSupportSession = require('./support/RemoteSupportSession');
// ============= RELACIONES EXISTENTES =============
// Las asociaciones de Purchase, PurchaseItem, Supplier, Product e inventario base
// están definidas en ./inventory/index.js. Se requiere aquí para garantizar que
// estén inicializadas cuando otros controllers (ej: supplierReturns) usen este módulo.
require('./inventory');
Tenant.hasMany(User, { foreignKey: 'tenant_id', as: 'users' });
User.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });

// ============= RELACIONES - MULTI-SEDE (Fase 1/2) =============

// Branch ↔ Tenant
Branch.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
Tenant.hasMany(Branch, { foreignKey: 'tenant_id', as: 'branches' });

// Branch ↔ Warehouse (1 sede : N bodegas — ver migración add-warehouse-default-per-branch;
// `warehouse` expone solo la bodega marcada is_default=true, `warehouses` expone todas)
Branch.hasMany(Warehouse, { foreignKey: 'branch_id', as: 'warehouses' });
Branch.hasOne(Warehouse, { foreignKey: 'branch_id', as: 'warehouse', scope: { is_default: true } });
Warehouse.belongsTo(Branch, { foreignKey: 'branch_id', as: 'branch' });

// Branch ↔ User (N:M vía UserBranch)
Branch.belongsToMany(User, { through: UserBranch, foreignKey: 'branch_id', otherKey: 'user_id', as: 'users' });
User.belongsToMany(Branch, { through: UserBranch, foreignKey: 'user_id', otherKey: 'branch_id', as: 'branches' });

// UserBranch ↔ User / Branch (acceso directo a la tabla intermedia, usado por branchMiddleware)
UserBranch.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
User.hasMany(UserBranch, { foreignKey: 'user_id', as: 'branch_assignments' });
UserBranch.belongsTo(Branch, { foreignKey: 'branch_id', as: 'branch' });
Branch.hasMany(UserBranch, { foreignKey: 'branch_id', as: 'user_assignments' });

// Branch ↔ Sale / Purchase (historial independiente por sede)
Branch.hasMany(Sale, { foreignKey: 'branch_id', as: 'sales' });
Sale.belongsTo(Branch, { foreignKey: 'branch_id', as: 'branch' });
Branch.hasMany(Purchase, { foreignKey: 'branch_id', as: 'purchases' });
Purchase.belongsTo(Branch, { foreignKey: 'branch_id', as: 'branch' });

Purchase.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
User.hasMany(Purchase, { foreignKey: 'user_id', as: 'purchases' });

// Expense ↔ Tenant / Branch / Supplier / User (Tesorería)
Tenant.hasMany(Expense, { foreignKey: 'tenant_id', as: 'expenses' });
Expense.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
Branch.hasMany(Expense, { foreignKey: 'branch_id', as: 'expenses' });
Expense.belongsTo(Branch, { foreignKey: 'branch_id', as: 'branch' });
Supplier.hasMany(Expense, { foreignKey: 'supplier_id', as: 'expenses' });
Expense.belongsTo(Supplier, { foreignKey: 'supplier_id', as: 'supplier' });
Expense.belongsTo(User, { foreignKey: 'created_by', as: 'creator' });

// CashSession ↔ Tenant / Branch / User (Aperturas y cierres de caja)
Tenant.hasMany(CashSession, { foreignKey: 'tenant_id', as: 'cash_sessions' });
CashSession.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
Branch.hasMany(CashSession, { foreignKey: 'branch_id', as: 'cash_sessions' });
CashSession.belongsTo(Branch, { foreignKey: 'branch_id', as: 'branch' });
CashSession.belongsTo(User, { foreignKey: 'opened_by', as: 'opener' });
CashSession.belongsTo(User, { foreignKey: 'closed_by', as: 'closer' });
User.hasMany(Expense, { foreignKey: 'created_by', as: 'created_expenses' });

// Receipt ↔ Tenant / Branch / CashSession / User (Recibos de caja)
Tenant.hasMany(Receipt, { foreignKey: 'tenant_id', as: 'receipts' });
Receipt.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
Branch.hasMany(Receipt, { foreignKey: 'branch_id', as: 'receipts' });
Receipt.belongsTo(Branch, { foreignKey: 'branch_id', as: 'branch' });
CashSession.hasMany(Receipt, { foreignKey: 'cash_session_id', as: 'receipts' });
Receipt.belongsTo(CashSession, { foreignKey: 'cash_session_id', as: 'cash_session' });
Receipt.belongsTo(User, { foreignKey: 'created_by', as: 'creator' });

// OpeningBalance ↔ Tenant / Branch / Customer / Supplier / JournalEntry / User
// (Saldos iniciales de cartera/CxP al arrancar con Pitbox)
Tenant.hasMany(OpeningBalance, { foreignKey: 'tenant_id', as: 'opening_balances' });
OpeningBalance.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
Branch.hasMany(OpeningBalance, { foreignKey: 'branch_id', as: 'opening_balances' });
OpeningBalance.belongsTo(Branch, { foreignKey: 'branch_id', as: 'branch' });
Customer.hasMany(OpeningBalance, { foreignKey: 'customer_id', as: 'opening_balances' });
OpeningBalance.belongsTo(Customer, { foreignKey: 'customer_id', as: 'customer' });
Supplier.hasMany(OpeningBalance, { foreignKey: 'supplier_id', as: 'opening_balances' });
OpeningBalance.belongsTo(Supplier, { foreignKey: 'supplier_id', as: 'supplier' });
OpeningBalance.belongsTo(JournalEntry, { foreignKey: 'journal_entry_id', as: 'journal_entry' });
OpeningBalance.belongsTo(User, { foreignKey: 'created_by', as: 'creator' });
OpeningBalance.belongsTo(User, { foreignKey: 'voided_by', as: 'voider' });

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

// Plan efectivo del tenant (fuente de verdad de límites y módulos,
// independiente del estado de la suscripción de facturación)
Tenant.belongsTo(SubscriptionPlan, { foreignKey: 'plan_id', as: 'subscriptionPlan' });
SubscriptionPlan.hasMany(Tenant, { foreignKey: 'plan_id', as: 'tenants' });

// Módulo Ensambladora — credenciales y outbox/inbox de sincronización
Tenant.hasOne(EnsambladoraSyncCredential, { foreignKey: 'tenant_id', as: 'ensambladora_credential' });
EnsambladoraSyncCredential.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
Tenant.hasMany(EnsambladoraEventoSync, { foreignKey: 'tenant_id', as: 'ensambladora_eventos_sync' });
EnsambladoraEventoSync.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });

// ── Contabilidad ──────────────────────────────────────────────────
Tenant.hasMany(ChartOfAccount, { foreignKey: 'tenant_id', as: 'chart_of_accounts' });
ChartOfAccount.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });

ChartOfAccount.belongsTo(ChartOfAccount, { foreignKey: 'parent_id', as: 'parent' });
ChartOfAccount.hasMany(ChartOfAccount, { foreignKey: 'parent_id', as: 'children' });

Tenant.hasMany(FiscalPeriod, { foreignKey: 'tenant_id', as: 'fiscal_periods' });
FiscalPeriod.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });

Tenant.hasMany(JournalEntry, { foreignKey: 'tenant_id', as: 'journal_entries' });
JournalEntry.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
JournalEntry.belongsTo(FiscalPeriod, { foreignKey: 'period_id', as: 'period' });
FiscalPeriod.hasMany(JournalEntry, { foreignKey: 'period_id', as: 'entries' });

JournalEntry.belongsTo(JournalEntry, { foreignKey: 'reversal_of_entry_id', as: 'reversalOf' });
JournalEntry.belongsTo(JournalEntry, { foreignKey: 'reversed_by_entry_id', as: 'reversedBy' });
JournalEntry.hasMany(JournalEntryLine, { foreignKey: 'entry_id', as: 'lines' });
JournalEntryLine.belongsTo(JournalEntry, { foreignKey: 'entry_id', as: 'entry' });
JournalEntryLine.belongsTo(ChartOfAccount, { foreignKey: 'account_id', as: 'account' });
ChartOfAccount.hasMany(JournalEntryLine, { foreignKey: 'account_id', as: 'lines' });

Tenant.hasMany(AccountMapping, { foreignKey: 'tenant_id', as: 'account_mappings' });
AccountMapping.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
AccountMapping.belongsTo(ChartOfAccount, { foreignKey: 'account_id', as: 'account' });

Tenant.hasMany(AccountMappingAudit, { foreignKey: 'tenant_id', as: 'account_mapping_audits' });
AccountMappingAudit.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
AccountMappingAudit.belongsTo(ChartOfAccount, { foreignKey: 'previous_account_id', as: 'previous_account' });
AccountMappingAudit.belongsTo(ChartOfAccount, { foreignKey: 'new_account_id', as: 'new_account' });
AccountMappingAudit.belongsTo(User, { foreignKey: 'changed_by', as: 'changed_by_user' });

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

TenantMetaConfig.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
Tenant.hasOne(TenantMetaConfig, { foreignKey: 'tenant_id', as: 'meta_config' });

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

// Técnico asignado en venta directa
Sale.belongsTo(User, { foreignKey: 'technician_id', as: 'technician' });
User.hasMany(Sale, { foreignKey: 'technician_id', as: 'technician_sales' });

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
// ============= RELACIONES - CATÁLOGO VEHÍCULOS =============

// VehicleBrand ↔ VehicleLine (1:N)
VehicleBrand.hasMany(VehicleLine, { foreignKey: 'brand_id', as: 'lines' });
VehicleLine.belongsTo(VehicleBrand, { foreignKey: 'brand_id', as: 'brand' });

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

// WorkOrderQuoteRequest ↔ WorkOrder / WorkOrderItem
WorkOrderQuoteRequest.belongsTo(WorkOrder, { foreignKey: 'work_order_id', as: 'work_order' });
WorkOrder.hasMany(WorkOrderQuoteRequest, { foreignKey: 'work_order_id', as: 'quote_requests' });
WorkOrderItem.belongsTo(WorkOrderQuoteRequest, { foreignKey: 'quote_request_id', as: 'quote_request' });
WorkOrderQuoteRequest.hasMany(WorkOrderItem, { foreignKey: 'quote_request_id', as: 'items' });

// WorkshopAppointmentConfig ↔ Branch
WorkshopAppointmentConfig.belongsTo(Branch, { foreignKey: 'branch_id', as: 'branch' });
Branch.hasOne(WorkshopAppointmentConfig, { foreignKey: 'branch_id', as: 'appointment_config' });

// WorkshopAppointment ↔ Branch / Customer / Vehicle / WorkOrder / User
WorkshopAppointment.belongsTo(Branch, { foreignKey: 'branch_id', as: 'branch' });
WorkshopAppointment.belongsTo(Customer, { foreignKey: 'customer_id', as: 'customer' });
WorkshopAppointment.belongsTo(Vehicle, { foreignKey: 'vehicle_id', as: 'vehicle' });
WorkshopAppointment.belongsTo(WorkOrder, { foreignKey: 'converted_to_work_order_id', as: 'work_order' });
WorkshopAppointment.belongsTo(User, { foreignKey: 'confirmed_by', as: 'confirmed_by_user' });

// WorkOrderItem ↔ Product
WorkOrderItem.belongsTo(Product, { foreignKey: 'product_id', as: 'product' });
Product.hasMany(WorkOrderItem, { foreignKey: 'product_id', as: 'work_order_items' });

// DiagramTemplate ↔ Tenant (NULL = biblioteca compartida global)
DiagramTemplate.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });

// WorkOrderDiagnosisMark ↔ WorkOrder / DiagramTemplate / Product / User
WorkOrderDiagnosisMark.belongsTo(WorkOrder, { foreignKey: 'work_order_id', as: 'work_order' });
WorkOrder.hasMany(WorkOrderDiagnosisMark, { foreignKey: 'work_order_id', as: 'diagnosis_marks' });
WorkOrderDiagnosisMark.belongsTo(DiagramTemplate, { foreignKey: 'diagram_template_id', as: 'diagram_template' });
DiagramTemplate.hasMany(WorkOrderDiagnosisMark, { foreignKey: 'diagram_template_id', as: 'marks' });
WorkOrderDiagnosisMark.belongsTo(Product, { foreignKey: 'suggested_product_id', as: 'suggested_product' });
WorkOrderDiagnosisMark.belongsTo(WorkOrderItem, { foreignKey: 'generated_item_id', as: 'generated_item' });
WorkOrderDiagnosisMark.belongsTo(User, { foreignKey: 'marked_by', as: 'marked_by_user' });

// SaleDiagnosisMark ↔ Sale / DiagramTemplate / Product / User (espejo de arriba, para cotizaciones)
SaleDiagnosisMark.belongsTo(Sale, { foreignKey: 'sale_id', as: 'sale' });
Sale.hasMany(SaleDiagnosisMark, { foreignKey: 'sale_id', as: 'diagnosis_marks' });
SaleDiagnosisMark.belongsTo(DiagramTemplate, { foreignKey: 'diagram_template_id', as: 'diagram_template' });
DiagramTemplate.hasMany(SaleDiagnosisMark, { foreignKey: 'diagram_template_id', as: 'sale_marks' });
SaleDiagnosisMark.belongsTo(Product, { foreignKey: 'suggested_product_id', as: 'suggested_product' });
SaleDiagnosisMark.belongsTo(SaleItem, { foreignKey: 'generated_item_id', as: 'generated_item' });
SaleDiagnosisMark.belongsTo(User, { foreignKey: 'marked_by', as: 'marked_by_user' });

// Conversión cotización → OT (quote_sale_id es distinto del sale_id ya
// existente en WorkOrder, que es la remisión generada al CERRAR la OT)
WorkOrder.belongsTo(Sale, { foreignKey: 'quote_sale_id', as: 'quote_sale' });
Sale.hasOne(WorkOrder, { foreignKey: 'quote_sale_id', as: 'work_order_from_quote' });
Sale.belongsTo(WorkOrder, { foreignKey: 'converted_to_work_order_id', as: 'converted_work_order' });

// ── CRM (Fase 1) ─────────────────────────────────────────────────────────────
// Customer ↔ User (asesor/vendedor dueño de la cuenta)
Customer.belongsTo(User, { foreignKey: 'owner_user_id', as: 'owner' });
User.hasMany(Customer, { foreignKey: 'owner_user_id', as: 'owned_customers' });

// CustomerInteraction ↔ Customer / User / Sale / WorkOrder
Customer.hasMany(CustomerInteraction, { foreignKey: 'customer_id', as: 'interactions' });
CustomerInteraction.belongsTo(Customer, { foreignKey: 'customer_id', as: 'customer' });
CustomerInteraction.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
CustomerInteraction.belongsTo(Sale, { foreignKey: 'related_sale_id', as: 'related_sale' });
CustomerInteraction.belongsTo(WorkOrder, { foreignKey: 'related_work_order_id', as: 'related_work_order' });

// ── CRM (Fase 2) — pipeline, seguimiento y segmentación ──────────────────────
Customer.hasMany(Opportunity, { foreignKey: 'customer_id', as: 'opportunities' });
Opportunity.belongsTo(Customer, { foreignKey: 'customer_id', as: 'customer' });
Opportunity.belongsTo(User, { foreignKey: 'owner_user_id', as: 'owner' });
Opportunity.belongsTo(Sale, { foreignKey: 'quote_sale_id', as: 'quote_sale' });
Sale.hasOne(Opportunity, { foreignKey: 'quote_sale_id', as: 'opportunity' });
Opportunity.belongsTo(WorkOrder, { foreignKey: 'work_order_id', as: 'work_order' });
Opportunity.hasMany(FollowUpTask, { foreignKey: 'opportunity_id', as: 'follow_up_tasks' });

Customer.hasMany(FollowUpTask, { foreignKey: 'customer_id', as: 'follow_up_tasks' });
FollowUpTask.belongsTo(Customer, { foreignKey: 'customer_id', as: 'customer' });
FollowUpTask.belongsTo(Opportunity, { foreignKey: 'opportunity_id', as: 'opportunity' });
FollowUpTask.belongsTo(User, { foreignKey: 'assigned_to_user_id', as: 'assigned_to' });
FollowUpTask.belongsTo(User, { foreignKey: 'created_by_user_id', as: 'created_by' });

Customer.belongsToMany(CustomerTag, { through: CustomerTagAssignment, foreignKey: 'customer_id', otherKey: 'customer_tag_id', as: 'tags' });
CustomerTag.belongsToMany(Customer, { through: CustomerTagAssignment, foreignKey: 'customer_tag_id', otherKey: 'customer_id', as: 'customers' });

// ── CRM (Fase C.1) — motor de automatizaciones ────────────────────────────
CrmAutomationRule.belongsTo(User, { foreignKey: 'created_by_user_id', as: 'created_by' });
CrmAutomationRule.belongsTo(User, { foreignKey: 'last_round_robin_user_id', as: 'last_round_robin_user' });
CrmAutomationRule.hasMany(CrmAutomationRuleLog, { foreignKey: 'automation_rule_id', as: 'logs' });
CrmAutomationRuleLog.belongsTo(CrmAutomationRule, { foreignKey: 'automation_rule_id', as: 'rule' });
CrmAutomationRuleLog.belongsTo(Opportunity, { foreignKey: 'opportunity_id', as: 'opportunity' });

// WorkOrderItem ↔ User (técnico responsable del ítem)
WorkOrderItem.belongsTo(User, { foreignKey: 'technician_id', as: 'item_technician' });
User.hasMany(WorkOrderItem, { foreignKey: 'technician_id', as: 'work_order_items_assigned' });

// SaleItem ↔ User (técnico responsable del ítem)
SaleItem.belongsTo(User, { foreignKey: 'technician_id', as: 'item_technician' });
User.hasMany(SaleItem, { foreignKey: 'technician_id', as: 'sale_items_assigned' });

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

// ProductCommissionSettlement ↔ User
ProductCommissionSettlement.belongsTo(User, { foreignKey: 'user_id', as: 'user_pcs' });
User.hasMany(ProductCommissionSettlement, { foreignKey: 'user_id', as: 'product_commission_settlements' });
ProductCommissionSettlement.belongsTo(User, { foreignKey: 'created_by', as: 'creator_pcs' });

// ProductCommissionSettlement ↔ Items
ProductCommissionSettlement.hasMany(ProductCommissionSettlementItem, { foreignKey: 'settlement_id', as: 'items' });
ProductCommissionSettlementItem.belongsTo(ProductCommissionSettlement, { foreignKey: 'settlement_id', as: 'settlement' });

// ProductCommissionSettlementItem ↔ WorkOrder
ProductCommissionSettlementItem.belongsTo(WorkOrder, { foreignKey: 'work_order_id', as: 'work_order' });
WorkOrder.hasMany(ProductCommissionSettlementItem, { foreignKey: 'work_order_id', as: 'product_settlement_items' });

// WorkOrder ↔ ProductCommissionSettlement
WorkOrder.belongsTo(ProductCommissionSettlement, { foreignKey: 'product_settlement_id', as: 'product_commission_settlement' });

// Sale ↔ ProductCommissionSettlement (ventas directas liquidadas en productos)
Sale.belongsTo(ProductCommissionSettlement, { foreignKey: 'product_settlement_id', as: 'product_commission_settlement' });
// Sale ↔ CommissionSettlement (ventas directas liquidadas en servicios)
Sale.belongsTo(CommissionSettlement, { foreignKey: 'labor_settlement_id', as: 'labor_commission_settlement' });

// CommissionSettlementItem ↔ Sale (item de venta directa)
CommissionSettlementItem.belongsTo(Sale, { foreignKey: 'sale_id', as: 'sale' });
// ProductCommissionSettlementItem ↔ Sale (item de venta directa)
ProductCommissionSettlementItem.belongsTo(Sale, { foreignKey: 'sale_id', as: 'sale' });

// ============= RELACIONES - DIAN =============

// DianResolution ↔ Tenant
DianResolution.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
Tenant.hasMany(DianResolution, { foreignKey: 'tenant_id', as: 'dian_resolutions' });

// DianEvent ↔ Tenant
DianEvent.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
Tenant.hasMany(DianEvent, { foreignKey: 'tenant_id', as: 'dian_events' });

// DianEvent ↔ Sale
DianEvent.belongsTo(Sale, { foreignKey: 'sale_id', as: 'sale' });
Sale.hasMany(DianEvent, { foreignKey: 'sale_id', as: 'dian_events' });

// Asistente de IA
AiConversation.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
AiConversation.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
AiConversation.hasMany(AiMessage, { foreignKey: 'conversation_id', as: 'messages' });
AiMessage.belongsTo(AiConversation, { foreignKey: 'conversation_id', as: 'conversation' });

// Asistente de IA — propuestas (Fase 2)
AiConversation.hasMany(AiProposal, { foreignKey: 'conversation_id', as: 'proposals' });
AiProposal.belongsTo(AiConversation, { foreignKey: 'conversation_id', as: 'conversation' });
AiProposal.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
AiProposal.belongsTo(User, { foreignKey: 'created_by', as: 'creator' });
AiProposal.belongsTo(User, { foreignKey: 'reviewed_by', as: 'reviewer' });

// ============= RELACIONES - MÓDULO DE SOPORTE =============

// SupportFaqArticle ↔ SupportFaqCategory
SupportFaqArticle.belongsTo(SupportFaqCategory, { foreignKey: 'category_id', as: 'category' });
SupportFaqCategory.hasMany(SupportFaqArticle, { foreignKey: 'category_id', as: 'articles' });

// SupportTicket ↔ Tenant
SupportTicket.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
Tenant.hasMany(SupportTicket, { foreignKey: 'tenant_id', as: 'support_tickets' });

// SupportTicket ↔ User (creador / agente asignado)
SupportTicket.belongsTo(User, { foreignKey: 'created_by', as: 'creator' });
User.hasMany(SupportTicket, { foreignKey: 'created_by', as: 'created_support_tickets' });
SupportTicket.belongsTo(User, { foreignKey: 'assigned_agent_id', as: 'assigned_agent' });
User.hasMany(SupportTicket, { foreignKey: 'assigned_agent_id', as: 'assigned_support_tickets' });

// SupportTicketMessage ↔ SupportTicket / User
SupportTicket.hasMany(SupportTicketMessage, { foreignKey: 'ticket_id', as: 'messages' });
SupportTicketMessage.belongsTo(SupportTicket, { foreignKey: 'ticket_id', as: 'ticket' });
SupportTicketMessage.belongsTo(User, { foreignKey: 'author_id', as: 'author' });
User.hasMany(SupportTicketMessage, { foreignKey: 'author_id', as: 'support_ticket_messages' });

// SupportTicketAttachment ↔ SupportTicket / SupportTicketMessage
SupportTicket.hasMany(SupportTicketAttachment, { foreignKey: 'ticket_id', as: 'attachments' });
SupportTicketAttachment.belongsTo(SupportTicket, { foreignKey: 'ticket_id', as: 'ticket' });
SupportTicketMessage.hasMany(SupportTicketAttachment, { foreignKey: 'message_id', as: 'attachments' });
SupportTicketAttachment.belongsTo(SupportTicketMessage, { foreignKey: 'message_id', as: 'message' });

// RemoteSupportSession ↔ SupportTicket / Tenant / User (agente / cliente)
SupportTicket.hasMany(RemoteSupportSession, { foreignKey: 'ticket_id', as: 'remote_sessions' });
RemoteSupportSession.belongsTo(SupportTicket, { foreignKey: 'ticket_id', as: 'ticket' });
RemoteSupportSession.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
Tenant.hasMany(RemoteSupportSession, { foreignKey: 'tenant_id', as: 'remote_support_sessions' });
RemoteSupportSession.belongsTo(User, { foreignKey: 'agent_id', as: 'agent' });
User.hasMany(RemoteSupportSession, { foreignKey: 'agent_id', as: 'agent_remote_sessions' });
RemoteSupportSession.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
User.hasMany(RemoteSupportSession, { foreignKey: 'user_id', as: 'client_remote_sessions' });

// Debe correr DESPUÉS de que todos los modelos/asociaciones ya se registraron
// en sequelize.models -- de lo contrario los hooks no se agregan a ninguno.
// Sin esto, tenantMiddleware marca el schema del tenant en el contexto pero
// ninguna query de Sequelize lo termina usando (ver comentario en
// src/config/registerTenantSchemaHooks.js).
registerTenantSchemaHooks(sequelize);

module.exports = {
  sequelize,
  Tenant,
  User,
  Branch,
  UserBranch,
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
  NcfConfig,
  MetaConfig,
  TenantMetaConfig,
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
  AuditLog,
  Vehicle,
  WorkOrder,
  WorkOrderItem,
  WorkOrderQuoteRequest,
  WorkshopAppointmentConfig,
  WorkshopAppointment,
  CommissionSettlement,
  CommissionSettlementItem,
  ProductCommissionSettlement,
  ProductCommissionSettlementItem,
  DiagramTemplate,
  WorkOrderDiagnosisMark,
  SaleDiagnosisMark,
  DianResolution,
  DianEvent,
  Expense,
  CashSession,
  Receipt,
  ChartOfAccount,
  FiscalPeriod,
  JournalEntry,
  JournalEntryLine,
  AccountMapping,
  AccountMappingAudit,
  OpeningBalance,
  AiConversation,
  AiMessage,
  AiProposal,
  SupportFaqCategory,
  SupportFaqArticle,
  SupportTicket,
  SupportTicketMessage,
  SupportTicketAttachment,
  RemoteSupportSession,
  VehicleBrand,
  VehicleLine,
  CustomerInteraction,
  Opportunity,
  FollowUpTask,
  CustomerTag,
  CustomerTagAssignment,
  CrmPipelineStage,
  CrmLossReason,
  CrmMessageTemplate,
  CrmAutomationRule,
  CrmAutomationRuleLog,
  EnsambladoraSyncCredential,
  EnsambladoraEventoSync,
  VehiculoCache,
  EnsambladoraVenta,
  EnsambladoraOrdenAlistamiento,
  EnsambladoraOrdenEntrega,
  EnsambladoraOrdenRevision,
  EnsambladoraOrdenGarantia,
  EnsambladoraTecnicoAsesor,
  EnsambladoraRuntSolicitud,
  EnsambladoraCotizacion,
  EnsambladoraAuditLog,
};