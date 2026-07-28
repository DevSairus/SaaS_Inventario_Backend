'use strict';

// ============================================================================
// MIGRACIÓN BASELINE — tablas core de inventario
//
// POR QUÉ EXISTE ESTE ARCHIVO:
// Las tablas `categories`, `warehouses`, `suppliers`, `products`,
// `product_warehouse_stock`, `purchases`, `purchase_details`,
// `inventory_movements` y `stock_alerts` nunca tuvieron una migración
// `createTable` — se crearon una sola vez (probablemente vía
// `sequelize.sync()`, ver src/config/database.js) en la base de datos
// compartida original y de ahí en adelante solo se les aplicaron
// migraciones incrementales (ALTER TABLE, add column, etc.).
//
// Mientras hubo una sola base de datos compartida esto nunca fue un
// problema: las tablas ya existían. Pero al aprovisionar un schema
// nuevo desde cero (schema-per-tenant), Umzug corre TODAS las
// migraciones en orden — y la primera que toca `purchases`
// (0260202120100-create-supplier-returns.js) asume que la tabla ya
// existe, porque en la BD vieja siempre existió.
//
// Este archivo reconstruye esas tablas base a partir de
// src/database/schema.sql (el diseño original), con dos ajustes para
// la arquitectura schema-per-tenant actual:
//   1. `tenant_id` referencia "public"."tenants" (tenants vive en
//      public, compartido entre tenants — igual que ya hacen las
//      migraciones más nuevas, p.ej. create-supplier-returns).
//   2. Se omiten Row Level Security / políticas / vistas / funciones
//      de negocio / seeds de schema.sql: eran parte del modelo viejo
//      de aislamiento lógico (RLS) que la separación física por
//      schema ya reemplaza, y no se usan en ninguna parte del código
//      actual (no hay referencias a `current_tenant_id` en src/).
//
// ⚠️ IMPORTANTE — VERIFICAR ANTES DE CORRER EN PROD:
// Las columnas de abajo reflejan schema.sql. Las migraciones
// posteriores (2026070606, 2026070608, 2026070609, 2026070610,
// 2026070612 — todas "fix-*" o "add-*-to-purchases/suppliers") ya
// se encargan de llevar la estructura al estado actual, así que
// deberían aplicarse SIN error después de esta. Aun así, antes de
// correr el cutover de un tenant real (no demo), lo más seguro es
// comparar esto contra la estructura real de la BD vieja:
//
//   pg_dump --schema-only --no-owner --no-privileges \
//     -t purchases -t suppliers -t products -t categories \
//     -t warehouses -t product_warehouse_stock -t purchase_details \
//     -t inventory_movements -t stock_alerts \
//     "$DATABASE_URL_DIRECT" > baseline_real.sql
//
// y ajustar este archivo si algo no calza.
// ============================================================================

const SQL_UP = `
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CATEGORÍAS DE PRODUCTOS
CREATE TABLE IF NOT EXISTS categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    parent_id UUID REFERENCES categories(id) ON DELETE SET NULL,
    sort_order INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT tenant_category_unique UNIQUE (tenant_id, name)
);
CREATE INDEX IF NOT EXISTS idx_categories_tenant ON categories(tenant_id);
CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);
CREATE INDEX IF NOT EXISTS idx_categories_active ON categories(tenant_id, is_active);

-- BODEGAS/ALMACENES
CREATE TABLE IF NOT EXISTS warehouses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    code VARCHAR(20) NOT NULL,
    address TEXT,
    city VARCHAR(100),
    phone VARCHAR(20),
    manager_id UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
    is_main BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT tenant_warehouse_code_unique UNIQUE (tenant_id, code),
    CONSTRAINT tenant_warehouse_name_unique UNIQUE (tenant_id, name)
);
CREATE INDEX IF NOT EXISTS idx_warehouses_tenant ON warehouses(tenant_id);
CREATE INDEX IF NOT EXISTS idx_warehouses_active ON warehouses(tenant_id, is_active);
CREATE INDEX IF NOT EXISTS idx_warehouses_main ON warehouses(tenant_id, is_main);

-- PROVEEDORES
CREATE TABLE IF NOT EXISTS suppliers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE,
    business_name VARCHAR(255) NOT NULL,
    trade_name VARCHAR(255),
    tax_id VARCHAR(50),
    email VARCHAR(255),
    phone VARCHAR(20),
    mobile VARCHAR(20),
    website VARCHAR(255),
    address TEXT,
    city VARCHAR(100),
    state VARCHAR(100),
    country VARCHAR(100) DEFAULT 'Colombia',
    postal_code VARCHAR(20),
    bank_name VARCHAR(100),
    account_number VARCHAR(50),
    account_type VARCHAR(20) CHECK (account_type IN ('savings', 'checking', 'other')),
    payment_terms INTEGER DEFAULT 30,
    credit_limit DECIMAL(15,2),
    discount_percentage DECIMAL(5,2) DEFAULT 0,
    contact_name VARCHAR(200),
    contact_email VARCHAR(255),
    contact_phone VARCHAR(20),
    contact_position VARCHAR(100),
    supplier_type VARCHAR(50) CHECK (supplier_type IN ('national', 'international', 'manufacturer', 'distributor', 'other')),
    rating INTEGER CHECK (rating >= 1 AND rating <= 5),
    notes TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_suppliers_tenant ON suppliers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_suppliers_active ON suppliers(tenant_id, is_active);
CREATE INDEX IF NOT EXISTS idx_suppliers_tax_id ON suppliers(tenant_id, tax_id);
CREATE INDEX IF NOT EXISTS idx_suppliers_business_name ON suppliers USING gin(to_tsvector('spanish', business_name));

-- PRODUCTOS
CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE,
    sku VARCHAR(100) NOT NULL,
    barcode VARCHAR(100),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
    brand VARCHAR(100),
    model VARCHAR(100),
    product_type VARCHAR(20) DEFAULT 'simple' CHECK (product_type IN ('simple', 'variant', 'service', 'bundle', 'raw_material')),
    unit_of_measure VARCHAR(20) DEFAULT 'unit' CHECK (unit_of_measure IN ('unit', 'kg', 'g', 'lb', 'oz', 'l', 'ml', 'gal', 'm', 'cm', 'ft', 'box', 'pack', 'dozen')),
    units_per_package INTEGER DEFAULT 1,
    average_cost DECIMAL(15,4) DEFAULT 0,
    last_purchase_cost DECIMAL(15,4) DEFAULT 0,
    last_purchase_date DATE,
    profit_margin_percentage DECIMAL(5,2) DEFAULT 0,
    sale_price DECIMAL(15,2) DEFAULT 0,
    min_sale_price DECIMAL(15,2) DEFAULT 0,
    wholesale_price DECIMAL(15,2),
    current_stock DECIMAL(15,4) DEFAULT 0,
    reserved_stock DECIMAL(15,4) DEFAULT 0,
    available_stock DECIMAL(15,4) DEFAULT 0,
    min_stock DECIMAL(15,4) DEFAULT 0,
    max_stock DECIMAL(15,4),
    reorder_point DECIMAL(15,4),
    optimal_order_quantity DECIMAL(15,4),
    track_inventory BOOLEAN DEFAULT TRUE,
    allow_negative_stock BOOLEAN DEFAULT FALSE,
    track_serial_numbers BOOLEAN DEFAULT FALSE,
    track_batch_numbers BOOLEAN DEFAULT FALSE,
    supplier_sku VARCHAR(100),
    manufacturer_code VARCHAR(100),
    internal_code VARCHAR(100),
    weight DECIMAL(10,4),
    weight_unit VARCHAR(10) DEFAULT 'kg' CHECK (weight_unit IN ('kg', 'g', 'lb', 'oz')),
    length DECIMAL(10,2),
    width DECIMAL(10,2),
    height DECIMAL(10,2),
    dimension_unit VARCHAR(10) DEFAULT 'cm' CHECK (dimension_unit IN ('cm', 'm', 'in', 'ft')),
    volume DECIMAL(10,4),
    volume_unit VARCHAR(10) DEFAULT 'l' CHECK (volume_unit IN ('l', 'ml', 'gal')),
    image_url VARCHAR(500),
    images JSONB DEFAULT '[]',
    main_supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
    tax_rate DECIMAL(5,2) DEFAULT 0,
    tax_exempt BOOLEAN DEFAULT FALSE,
    location VARCHAR(100),
    warranty_months INTEGER,
    expiration_days INTEGER,
    is_active BOOLEAN DEFAULT TRUE,
    is_featured BOOLEAN DEFAULT FALSE,
    is_for_sale BOOLEAN DEFAULT TRUE,
    is_for_purchase BOOLEAN DEFAULT TRUE,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT tenant_sku_unique UNIQUE (tenant_id, sku),
    CONSTRAINT tenant_barcode_unique UNIQUE (tenant_id, barcode)
);
CREATE INDEX IF NOT EXISTS idx_products_tenant ON products(tenant_id);
CREATE INDEX IF NOT EXISTS idx_products_tenant_active ON products(tenant_id, is_active);
CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode) WHERE barcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_supplier ON products(main_supplier_id);
CREATE INDEX IF NOT EXISTS idx_products_name ON products USING gin(to_tsvector('spanish', name));
CREATE INDEX IF NOT EXISTS idx_products_type ON products(product_type);

-- STOCK POR BODEGA
CREATE TABLE IF NOT EXISTS product_warehouse_stock (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    current_stock DECIMAL(15,4) DEFAULT 0,
    reserved_stock DECIMAL(15,4) DEFAULT 0,
    available_stock DECIMAL(15,4) DEFAULT 0,
    average_cost DECIMAL(15,4) DEFAULT 0,
    min_stock DECIMAL(15,4) DEFAULT 0,
    max_stock DECIMAL(15,4),
    location VARCHAR(100),
    last_movement_id UUID,
    last_movement_date TIMESTAMP,
    last_count_date TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT tenant_product_warehouse_unique UNIQUE (tenant_id, product_id, warehouse_id)
);
CREATE INDEX IF NOT EXISTS idx_product_warehouse_stock_tenant ON product_warehouse_stock(tenant_id);
CREATE INDEX IF NOT EXISTS idx_product_warehouse_stock_product ON product_warehouse_stock(product_id);
CREATE INDEX IF NOT EXISTS idx_product_warehouse_stock_warehouse ON product_warehouse_stock(warehouse_id);

-- FACTURAS DE COMPRA
CREATE TABLE IF NOT EXISTS purchases (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE,
    purchase_number VARCHAR(50) NOT NULL,
    invoice_number VARCHAR(100),
    order_number VARCHAR(100),
    purchase_date DATE NOT NULL,
    due_date DATE,
    received_date DATE,
    supplier_id UUID REFERENCES suppliers(id) ON DELETE RESTRICT,
    supplier_name VARCHAR(255) NOT NULL,
    supplier_tax_id VARCHAR(50),
    supplier_address TEXT,
    warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
    subtotal DECIMAL(15,2) DEFAULT 0,
    tax_amount DECIMAL(15,2) DEFAULT 0,
    discount_amount DECIMAL(15,2) DEFAULT 0,
    shipping_cost DECIMAL(15,2) DEFAULT 0,
    other_costs DECIMAL(15,2) DEFAULT 0,
    total_amount DECIMAL(15,2) NOT NULL,
    status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'partial', 'completed', 'cancelled')),
    payment_status VARCHAR(20) DEFAULT 'pending' CHECK (payment_status IN ('pending', 'partial', 'paid', 'overdue')),
    payment_method VARCHAR(50),
    payment_terms INTEGER,
    paid_amount DECIMAL(15,2) DEFAULT 0,
    currency VARCHAR(3) DEFAULT 'COP',
    exchange_rate DECIMAL(10,4) DEFAULT 1,
    notes TEXT,
    internal_notes TEXT,
    attachments JSONB DEFAULT '[]',
    created_by UUID REFERENCES "public"."users"(id),
    approved_by UUID REFERENCES "public"."users"(id),
    approved_at TIMESTAMP,
    cancelled_by UUID REFERENCES "public"."users"(id),
    cancelled_at TIMESTAMP,
    cancellation_reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT tenant_purchase_number_unique UNIQUE (tenant_id, purchase_number)
);
CREATE INDEX IF NOT EXISTS idx_purchases_tenant ON purchases(tenant_id);
CREATE INDEX IF NOT EXISTS idx_purchases_supplier ON purchases(supplier_id);
CREATE INDEX IF NOT EXISTS idx_purchases_warehouse ON purchases(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_purchases_date ON purchases(purchase_date DESC);
CREATE INDEX IF NOT EXISTS idx_purchases_status ON purchases(status);
CREATE INDEX IF NOT EXISTS idx_purchases_payment_status ON purchases(payment_status);
CREATE INDEX IF NOT EXISTS idx_purchases_number ON purchases(purchase_number);

-- DETALLES DE COMPRA
CREATE TABLE IF NOT EXISTS purchase_details (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE,
    purchase_id UUID NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
    line_number INTEGER NOT NULL,
    product_id UUID REFERENCES products(id) ON DELETE RESTRICT,
    product_name VARCHAR(255) NOT NULL,
    product_sku VARCHAR(100) NOT NULL,
    product_barcode VARCHAR(100),
    quantity DECIMAL(15,4) NOT NULL,
    received_quantity DECIMAL(15,4) DEFAULT 0,
    unit_of_measure VARCHAR(20) NOT NULL,
    unit_cost DECIMAL(15,4) NOT NULL,
    tax_rate DECIMAL(5,2) DEFAULT 0,
    tax_amount DECIMAL(15,2) DEFAULT 0,
    discount_percentage DECIMAL(5,2) DEFAULT 0,
    discount_amount DECIMAL(15,2) DEFAULT 0,
    line_total DECIMAL(15,2) NOT NULL,
    batch_number VARCHAR(50),
    expiration_date DATE,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_purchase_details_tenant ON purchase_details(tenant_id);
CREATE INDEX IF NOT EXISTS idx_purchase_details_purchase ON purchase_details(purchase_id);
CREATE INDEX IF NOT EXISTS idx_purchase_details_product ON purchase_details(product_id);

-- MOVIMIENTOS DE INVENTARIO
CREATE TABLE IF NOT EXISTS inventory_movements (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE,
    movement_number VARCHAR(50) NOT NULL,
    movement_type VARCHAR(30) NOT NULL CHECK (movement_type IN (
        'purchase', 'sale', 'customer_return', 'supplier_return',
        'adjustment_in', 'adjustment_out', 'transfer_in', 'transfer_out',
        'production', 'internal_use', 'obsolescence', 'sample',
        'damage', 'initial_stock'
    )),
    direction VARCHAR(10) NOT NULL CHECK (direction IN ('in', 'out', 'none')),
    reference_type VARCHAR(50),
    reference_id UUID,
    reference_number VARCHAR(100),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
    source_warehouse_id UUID REFERENCES warehouses(id),
    destination_warehouse_id UUID REFERENCES warehouses(id),
    quantity DECIMAL(15,4) NOT NULL,
    unit_cost DECIMAL(15,4) NOT NULL DEFAULT 0,
    total_cost DECIMAL(15,2) NOT NULL DEFAULT 0,
    stock_before DECIMAL(15,4),
    stock_after DECIMAL(15,4),
    average_cost_before DECIMAL(15,4),
    average_cost_after DECIMAL(15,4),
    batch_number VARCHAR(50),
    serial_number VARCHAR(100),
    expiration_date DATE,
    reason VARCHAR(255),
    notes TEXT,
    status VARCHAR(20) DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'cancelled')),
    created_by UUID REFERENCES "public"."users"(id),
    approved_by UUID REFERENCES "public"."users"(id),
    approved_at TIMESTAMP,
    movement_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT tenant_movement_number_unique UNIQUE (tenant_id, movement_number)
);
CREATE INDEX IF NOT EXISTS idx_movements_tenant ON inventory_movements(tenant_id);
CREATE INDEX IF NOT EXISTS idx_movements_product ON inventory_movements(product_id);
CREATE INDEX IF NOT EXISTS idx_movements_warehouse ON inventory_movements(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_movements_type ON inventory_movements(movement_type);
CREATE INDEX IF NOT EXISTS idx_movements_direction ON inventory_movements(direction);
CREATE INDEX IF NOT EXISTS idx_movements_date ON inventory_movements(movement_date DESC);
CREATE INDEX IF NOT EXISTS idx_movements_reference ON inventory_movements(reference_type, reference_id);
CREATE INDEX IF NOT EXISTS idx_movements_status ON inventory_movements(status);

-- ALERTAS DE STOCK
CREATE TABLE IF NOT EXISTS stock_alerts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    warehouse_id UUID REFERENCES warehouses(id) ON DELETE CASCADE,
    alert_type VARCHAR(20) NOT NULL CHECK (alert_type IN ('low_stock', 'out_of_stock', 'overstock', 'expiring_soon', 'expired')),
    current_stock DECIMAL(15,4),
    threshold_stock DECIMAL(15,4),
    message TEXT,
    priority VARCHAR(20) DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
    is_resolved BOOLEAN DEFAULT FALSE,
    resolved_at TIMESTAMP,
    resolved_by UUID REFERENCES "public"."users"(id),
    resolution_notes TEXT,
    expiration_date DATE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_stock_alerts_tenant ON stock_alerts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_stock_alerts_product ON stock_alerts(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_alerts_warehouse ON stock_alerts(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_stock_alerts_type ON stock_alerts(alert_type);
CREATE INDEX IF NOT EXISTS idx_stock_alerts_resolved ON stock_alerts(is_resolved);
CREATE INDEX IF NOT EXISTS idx_stock_alerts_priority ON stock_alerts(priority);
CREATE INDEX IF NOT EXISTS idx_stock_alerts_created ON stock_alerts(created_at DESC);
`;

const SQL_DOWN = `
DROP TABLE IF EXISTS stock_alerts CASCADE;
DROP TABLE IF EXISTS inventory_movements CASCADE;
DROP TABLE IF EXISTS purchase_details CASCADE;
DROP TABLE IF EXISTS purchases CASCADE;
DROP TABLE IF EXISTS product_warehouse_stock CASCADE;
DROP TABLE IF EXISTS products CASCADE;
DROP TABLE IF EXISTS suppliers CASCADE;
DROP TABLE IF EXISTS warehouses CASCADE;
DROP TABLE IF EXISTS categories CASCADE;
`;

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(SQL_UP);
  },
  down: async (queryInterface) => {
    await queryInterface.sequelize.query(SQL_DOWN);
  },
};
