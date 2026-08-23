// src/scripts/tenantResetClassification.js
//
// Única fuente de verdad de qué tablas de un schema de tenant se CONSERVAN
// (configuración) y cuáles se BORRAN (datos transaccionales/de prueba) en un
// reset de entrega (ver resetTenantSchemaForDelivery.js).
//
// Filosofía "modo estricto": si aparece una tabla en el schema que no está
// en NINGUNA de las tres listas de abajo, el script se niega a correr (ver
// resetTenantSchemaForDelivery.js) en vez de adivinar. Cuando agregues un
// módulo/tabla nueva, agrégala acá explícitamente -- a ALWAYS_KEEP si es
// configuración, a ALWAYS_WIPE si es dato transaccional, o a un ASK_GROUP si
// es un caso dudoso (catálogo que puede ser real o de prueba).

// Tablas de configuración que SIEMPRE se conservan.
const ALWAYS_KEEP = [
  // Estructura organizacional
  'branches', 'warehouses', 'user_branches',
  // Catálogos/config de inventario que no son "stock" en sí
  'categories', 'price_lists', 'price_list_categories',
  'product_equivalence_groups', 'product_equivalence_group_members',
  'vehicle_brands', 'vehicle_lines',
  // Contabilidad: la ESTRUCTURA (plan de cuentas) se conserva; los saldos,
  // asientos, periodos y consecutivos van en ALWAYS_WIPE.
  'chart_of_accounts', 'account_mappings',
  // CRM: definiciones/plantillas, no las interacciones ni oportunidades
  'crm_message_templates', 'crm_pipeline_stages', 'crm_loss_reasons', 'crm_automation_rules',
  'customer_tags',
  // Taller
  'diagram_templates', 'workshop_appointment_configs',
  // Ensambladora: catálogo de técnicos/asesores (config), no las órdenes/eventos
  'ensambladora_tecnicos_asesores',
  // Config de pagos/integraciones del tenant
  'tenant_mercadopago_config',
  // Contenido estático de soporte replicado por migración, no datos del cliente
  'support_faq_categories', 'support_faq_articles',
  // Tablas que la app SIEMPRE resuelve contra `public` (ver PUBLIC_SCHEMA_MODELS
  // en config/registerTenantSchemaHooks.js) -- existen físicamente acá por
  // migración pero nunca se leen/escriben en el schema del tenant. No aportan
  // nada borrarlas ni falta conservarlas "de verdad", pero hay que
  // clasificarlas para que el modo estricto no las bloquee.
  'support_tickets', 'support_ticket_messages', 'support_ticket_attachments',
  'remote_support_sessions', 'ncf_config', 'meta_config', 'tenant_meta_configs',
  'ensambladora_sync_credentials', 'ensambladora_eventos_sync', 'superadmin_mercadopago_config',
  // Bookkeeping de migraciones -- nunca tocar
  'sequelize_migrations',
];

// Tablas transaccionales/operativas que SIEMPRE se borran.
const ALWAYS_WIPE = [
  // Ventas
  'sales', 'sale_items', 'sale_diagnosis_marks',
  // Taller
  'work_orders', 'work_order_items', 'work_order_diagnosis_marks', 'work_order_quote_requests',
  'workshop_appointments',
  // Compras
  'purchases', 'purchase_items', 'purchase_details',
  // Inventario (movimientos/ajustes, no el catálogo en sí)
  'inventory_movements', 'inventory_adjustments', 'inventory_adjustment_items',
  'transfers', 'transfer_items',
  'internal_consumptions', 'internal_consumption_items',
  'customer_returns', 'customer_return_items',
  'supplier_returns', 'supplier_return_items',
  'stock_alerts', 'product_warehouse_stock',
  // Contabilidad y fiscal: se resetea todo lo operativo (decisión explícita:
  // saldos iniciales, periodos y consecutivos DIAN del trial no sirven).
  'journal_entries', 'journal_entry_lines', 'account_mapping_audits',
  'opening_balances', 'fiscal_periods', 'dian_resolutions', 'dian_events',
  // Tesorería / cartera
  'expenses', 'receipts', 'invoices', 'payable_alerts', 'cash_sessions',
  // Comisiones
  'commission_settlements', 'commission_settlement_items',
  'product_commission_settlements', 'product_commission_settlement_items',
  // CRM (actividad, no las plantillas/definiciones)
  'opportunities', 'follow_up_tasks', 'customer_interactions', 'customer_tag_assignments',
  'crm_automation_rule_logs',
  // Auditoría / IA / cache
  'audit_logs', 'ai_conversations', 'ai_messages', 'ai_proposals', 'vehiculos_cache',
  // Ensambladora: actividad operativa
  'ensambladora_cotizaciones', 'ensambladora_ventas', 'ensambladora_ordenes_alistamiento',
  'ensambladora_ordenes_entrega', 'ensambladora_ordenes_garantia', 'ensambladora_ordenes_revision',
  'ensambladora_runt_solicitudes', 'ensambladora_audit_logs',
];

// Casos dudosos: catálogo que puede ser real (el cliente ya lo configuró en
// serio durante el trial) o puramente de prueba. No tienen default -- el
// script SIEMPRE pregunta, cada vez que se corre (ver resetTenantSchemaForDelivery.js).
const ASK_GROUPS = [
  {
    key: 'catalogo_productos',
    label: 'Catálogo de productos (products, product_prices, product_suppliers, product_vehicle_applications)',
    tables: ['products', 'product_prices', 'product_suppliers', 'product_vehicle_applications'],
    // Si se conserva, el stock se resetea a 0 igual (el stock físico real
    // hay que volver a cargarlo, no tiene sentido arrastrar el de pruebas).
    resetStockIfKept: true,
  },
  {
    key: 'clientes',
    label: 'Clientes (customers, customer_price_lists)',
    tables: ['customers', 'customer_price_lists'],
  },
  {
    key: 'proveedores',
    label: 'Proveedores (suppliers)',
    tables: ['suppliers'],
  },
  {
    key: 'vehiculos',
    label: 'Vehículos de clientes (vehicles)',
    tables: ['vehicles'],
  },
];

function allClassifiedTables() {
  return new Set([
    ...ALWAYS_KEEP,
    ...ALWAYS_WIPE,
    ...ASK_GROUPS.flatMap((g) => g.tables),
  ]);
}

module.exports = { ALWAYS_KEEP, ALWAYS_WIPE, ASK_GROUPS, allClassifiedTables };
