-- ============================================================================
-- SISTEMA DE INVENTARIO - BASE DE DATOS COMPLETA
-- PostgreSQL 14+
-- Sistema Multitenant con Row Level Security
-- ============================================================================

-- Extensiones necesarias
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";  -- Para búsqueda de texto

-- ============================================================================
-- TABLAS CORE (Sistema Multitenant Existente)
-- ============================================================================

-- TENANTS
CREATE TABLE IF NOT EXISTS tenants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_name VARCHAR(255) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    business_name VARCHAR(255),
    tax_id VARCHAR(50),
    email VARCHAR(255) NOT NULL,
    phone VARCHAR(20),
    address TEXT,
    logo_url VARCHAR(500),
    
    -- Colores y personalización
    primary_color VARCHAR(7) DEFAULT '#3B82F6',
    secondary_color VARCHAR(7) DEFAULT '#1E40AF',
    pdf_config JSONB DEFAULT '{}',
    
    -- Suscripción
    plan VARCHAR(20) DEFAULT 'free' CHECK (plan IN ('free', 'basic', 'premium', 'enterprise')),
    subscription_status VARCHAR(20) DEFAULT 'trial' CHECK (subscription_status IN ('trial', 'active', 'suspended', 'cancelled')),
    trial_ends_at TIMESTAMP,
    subscription_starts_at TIMESTAMP,
    next_billing_date TIMESTAMP,
    
    -- Límites
    max_users INTEGER DEFAULT 3,
    max_clients INTEGER DEFAULT 50,
    max_products INTEGER DEFAULT 100,
    max_warehouses INTEGER DEFAULT 1,
    max_invoices_per_month INTEGER DEFAULT 100,
    
    -- Features
    features JSONB DEFAULT '{
        "basic_reports": true, 
        "advanced_reports": false,
        "barcode_scanner": true,
        "multi_warehouse": false,
        "api_access": false
    }',
    business_config JSONB DEFAULT '{
        "currency": "COP", 
        "timezone": "America/Bogota",
        "locale": "es-CO",
        "date_format": "DD/MM/YYYY",
        "cost_method": "weighted_average"
    }',
    
    -- Estado
    is_active BOOLEAN DEFAULT TRUE,
    notes TEXT,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_tenants_slug ON tenants(slug);
CREATE INDEX idx_tenants_email ON tenants(email);
CREATE INDEX idx_tenants_active ON tenants(is_active);

-- USERS
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    phone VARCHAR(20),
    role VARCHAR(50) DEFAULT 'user' CHECK (role IN ('super_admin', 'admin', 'manager', 'seller', 'warehouse_keeper', 'user')),
    is_active BOOLEAN DEFAULT TRUE,
    last_login TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT users_email_unique UNIQUE (email)
);

CREATE INDEX idx_users_tenant ON users(tenant_id);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);

-- PERMISSIONS
CREATE TABLE IF NOT EXISTS permissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) UNIQUE NOT NULL,
    description TEXT,
    module VARCHAR(50) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ROLE_PERMISSIONS
CREATE TABLE IF NOT EXISTS role_permissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL,
    permission_id UUID REFERENCES permissions(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT role_permission_unique UNIQUE (tenant_id, role, permission_id)
);

-- ============================================================================
-- MÓDULO DE INVENTARIO - TABLAS
-- ============================================================================

-- CATEGORÍAS DE PRODUCTOS
CREATE TABLE categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    parent_id UUID REFERENCES categories(id) ON DELETE SET NULL,
    sort_order INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT tenant_category_unique UNIQUE (tenant_id, name)
);

CREATE INDEX idx_categories_tenant ON categories(tenant_id);
CREATE INDEX idx_categories_parent ON categories(parent_id);
CREATE INDEX idx_categories_active ON categories(tenant_id, is_active);

-- BODEGAS/ALMACENES
CREATE TABLE warehouses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    code VARCHAR(20) NOT NULL,
    address TEXT,
    city VARCHAR(100),
    phone VARCHAR(20),
    manager_id UUID REFERENCES users(id) ON DELETE SET NULL,
    is_main BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT tenant_warehouse_code_unique UNIQUE (tenant_id, code),
    CONSTRAINT tenant_warehouse_name_unique UNIQUE (tenant_id, name)
);

CREATE INDEX idx_warehouses_tenant ON warehouses(tenant_id);
CREATE INDEX idx_warehouses_active ON warehouses(tenant_id, is_active);
CREATE INDEX idx_warehouses_main ON warehouses(tenant_id, is_main);

-- PROVEEDORES
CREATE TABLE suppliers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    
    -- Información básica
    business_name VARCHAR(255) NOT NULL,
    trade_name VARCHAR(255),
    tax_id VARCHAR(50),
    email VARCHAR(255),
    phone VARCHAR(20),
    mobile VARCHAR(20),
    website VARCHAR(255),
    
    -- Dirección
    address TEXT,
    city VARCHAR(100),
    state VARCHAR(100),
    country VARCHAR(100) DEFAULT 'Colombia',
    postal_code VARCHAR(20),
    
    -- Datos bancarios
    bank_name VARCHAR(100),
    account_number VARCHAR(50),
    account_type VARCHAR(20) CHECK (account_type IN ('savings', 'checking', 'other')),
    
    -- Condiciones comerciales
    payment_terms INTEGER DEFAULT 30,  -- días
    credit_limit DECIMAL(15,2),
    discount_percentage DECIMAL(5,2) DEFAULT 0,
    
    -- Contacto principal
    contact_name VARCHAR(200),
    contact_email VARCHAR(255),
    contact_phone VARCHAR(20),
    contact_position VARCHAR(100),
    
    -- Clasificación
    supplier_type VARCHAR(50) CHECK (supplier_type IN ('national', 'international', 'manufacturer', 'distributor', 'other')),
    rating INTEGER CHECK (rating >= 1 AND rating <= 5),
    
    notes TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_suppliers_tenant ON suppliers(tenant_id);
CREATE INDEX idx_suppliers_active ON suppliers(tenant_id, is_active);
CREATE INDEX idx_suppliers_tax_id ON suppliers(tenant_id, tax_id);
CREATE INDEX idx_suppliers_business_name ON suppliers USING gin(to_tsvector('spanish', business_name));

-- PRODUCTOS
CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    
    -- Identificación
    sku VARCHAR(100) NOT NULL,
    barcode VARCHAR(100),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    
    -- Categorización
    category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
    brand VARCHAR(100),
    model VARCHAR(100),
    
    -- Tipo de producto
    product_type VARCHAR(20) DEFAULT 'simple' CHECK (product_type IN ('simple', 'variant', 'service', 'bundle', 'raw_material')),
    
    -- Unidades de medida
    unit_of_measure VARCHAR(20) DEFAULT 'unit' CHECK (unit_of_measure IN ('unit', 'kg', 'g', 'lb', 'oz', 'l', 'ml', 'gal', 'm', 'cm', 'ft', 'box', 'pack', 'dozen')),
    units_per_package INTEGER DEFAULT 1,
    
    -- Costos y precios
    average_cost DECIMAL(15,4) DEFAULT 0,
    last_purchase_cost DECIMAL(15,4) DEFAULT 0,
    last_purchase_date DATE,
    profit_margin_percentage DECIMAL(5,2) DEFAULT 0,
    sale_price DECIMAL(15,2) DEFAULT 0,
    min_sale_price DECIMAL(15,2) DEFAULT 0,
    wholesale_price DECIMAL(15,2),
    
    -- Stock
    current_stock DECIMAL(15,4) DEFAULT 0,
    reserved_stock DECIMAL(15,4) DEFAULT 0,
    available_stock DECIMAL(15,4) DEFAULT 0,
    min_stock DECIMAL(15,4) DEFAULT 0,
    max_stock DECIMAL(15,4),
    reorder_point DECIMAL(15,4),
    optimal_order_quantity DECIMAL(15,4),
    
    -- Control de inventario
    track_inventory BOOLEAN DEFAULT TRUE,
    allow_negative_stock BOOLEAN DEFAULT FALSE,
    track_serial_numbers BOOLEAN DEFAULT FALSE,
    track_batch_numbers BOOLEAN DEFAULT FALSE,
    
    -- Códigos adicionales
    supplier_sku VARCHAR(100),
    manufacturer_code VARCHAR(100),
    internal_code VARCHAR(100),
    
    -- Información física
    weight DECIMAL(10,4),
    weight_unit VARCHAR(10) DEFAULT 'kg' CHECK (weight_unit IN ('kg', 'g', 'lb', 'oz')),
    length DECIMAL(10,2),
    width DECIMAL(10,2),
    height DECIMAL(10,2),
    dimension_unit VARCHAR(10) DEFAULT 'cm' CHECK (dimension_unit IN ('cm', 'm', 'in', 'ft')),
    volume DECIMAL(10,4),
    volume_unit VARCHAR(10) DEFAULT 'l' CHECK (volume_unit IN ('l', 'ml', 'gal')),
    
    -- Multimedia
    image_url VARCHAR(500),
    images JSONB DEFAULT '[]',  -- Array de URLs de imágenes adicionales
    
    -- Proveedores
    main_supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
    
    -- Información fiscal
    tax_rate DECIMAL(5,2) DEFAULT 0,
    tax_exempt BOOLEAN DEFAULT FALSE,
    
    -- Información adicional
    location VARCHAR(100),  -- Ubicación en bodega (ej: "A1-B2")
    warranty_months INTEGER,
    expiration_days INTEGER,  -- Días de vencimiento (si aplica)
    
    -- Flags
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

CREATE INDEX idx_products_tenant ON products(tenant_id);
CREATE INDEX idx_products_tenant_active ON products(tenant_id, is_active);
CREATE INDEX idx_products_sku ON products(sku);
CREATE INDEX idx_products_barcode ON products(barcode) WHERE barcode IS NOT NULL;
CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_supplier ON products(main_supplier_id);
CREATE INDEX idx_products_name ON products USING gin(to_tsvector('spanish', name));
CREATE INDEX idx_products_type ON products(product_type);

-- STOCK POR BODEGA
CREATE TABLE product_warehouse_stock (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    
    current_stock DECIMAL(15,4) DEFAULT 0,
    reserved_stock DECIMAL(15,4) DEFAULT 0,
    available_stock DECIMAL(15,4) DEFAULT 0,
    
    average_cost DECIMAL(15,4) DEFAULT 0,
    
    min_stock DECIMAL(15,4) DEFAULT 0,
    max_stock DECIMAL(15,4),
    
    location VARCHAR(100),  -- Ubicación específica en esta bodega
    
    last_movement_id UUID,
    last_movement_date TIMESTAMP,
    last_count_date TIMESTAMP,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT tenant_product_warehouse_unique UNIQUE (tenant_id, product_id, warehouse_id)
);

CREATE INDEX idx_product_warehouse_stock_tenant ON product_warehouse_stock(tenant_id);
CREATE INDEX idx_product_warehouse_stock_product ON product_warehouse_stock(product_id);
CREATE INDEX idx_product_warehouse_stock_warehouse ON product_warehouse_stock(warehouse_id);

-- FACTURAS DE COMPRA
CREATE TABLE purchases (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    
    -- Números de documento
    purchase_number VARCHAR(50) NOT NULL,
    invoice_number VARCHAR(100),
    order_number VARCHAR(100),
    
    -- Fechas
    purchase_date DATE NOT NULL,
    due_date DATE,
    received_date DATE,
    
    -- Proveedor
    supplier_id UUID REFERENCES suppliers(id) ON DELETE RESTRICT,
    supplier_name VARCHAR(255) NOT NULL,
    supplier_tax_id VARCHAR(50),
    supplier_address TEXT,
    
    -- Bodega destino
    warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
    
    -- Totales
    subtotal DECIMAL(15,2) DEFAULT 0,
    tax_amount DECIMAL(15,2) DEFAULT 0,
    discount_amount DECIMAL(15,2) DEFAULT 0,
    shipping_cost DECIMAL(15,2) DEFAULT 0,
    other_costs DECIMAL(15,2) DEFAULT 0,
    total_amount DECIMAL(15,2) NOT NULL,
    
    -- Estado
    status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'partial', 'completed', 'cancelled')),
    
    -- Pago
    payment_status VARCHAR(20) DEFAULT 'pending' CHECK (payment_status IN ('pending', 'partial', 'paid', 'overdue')),
    payment_method VARCHAR(50),
    payment_terms INTEGER,
    paid_amount DECIMAL(15,2) DEFAULT 0,
    
    -- Referencias
    currency VARCHAR(3) DEFAULT 'COP',
    exchange_rate DECIMAL(10,4) DEFAULT 1,
    
    notes TEXT,
    internal_notes TEXT,  -- Notas internas no visibles al proveedor
    
    -- Archivos adjuntos
    attachments JSONB DEFAULT '[]',
    
    -- Auditoría
    created_by UUID REFERENCES users(id),
    approved_by UUID REFERENCES users(id),
    approved_at TIMESTAMP,
    cancelled_by UUID REFERENCES users(id),
    cancelled_at TIMESTAMP,
    cancellation_reason TEXT,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT tenant_purchase_number_unique UNIQUE (tenant_id, purchase_number)
);

CREATE INDEX idx_purchases_tenant ON purchases(tenant_id);
CREATE INDEX idx_purchases_supplier ON purchases(supplier_id);
CREATE INDEX idx_purchases_warehouse ON purchases(warehouse_id);
CREATE INDEX idx_purchases_date ON purchases(purchase_date DESC);
CREATE INDEX idx_purchases_status ON purchases(status);
CREATE INDEX idx_purchases_payment_status ON purchases(payment_status);
CREATE INDEX idx_purchases_number ON purchases(purchase_number);

-- DETALLES DE COMPRA
CREATE TABLE purchase_details (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    purchase_id UUID NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
    
    line_number INTEGER NOT NULL,
    
    -- Producto
    product_id UUID REFERENCES products(id) ON DELETE RESTRICT,
    product_name VARCHAR(255) NOT NULL,
    product_sku VARCHAR(100) NOT NULL,
    product_barcode VARCHAR(100),
    
    -- Cantidades
    quantity DECIMAL(15,4) NOT NULL,
    received_quantity DECIMAL(15,4) DEFAULT 0,
    unit_of_measure VARCHAR(20) NOT NULL,
    
    -- Costos
    unit_cost DECIMAL(15,4) NOT NULL,
    tax_rate DECIMAL(5,2) DEFAULT 0,
    tax_amount DECIMAL(15,2) DEFAULT 0,
    discount_percentage DECIMAL(5,2) DEFAULT 0,
    discount_amount DECIMAL(15,2) DEFAULT 0,
    line_total DECIMAL(15,2) NOT NULL,
    
    -- Lote y vencimiento
    batch_number VARCHAR(50),
    expiration_date DATE,
    
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_purchase_details_tenant ON purchase_details(tenant_id);
CREATE INDEX idx_purchase_details_purchase ON purchase_details(purchase_id);
CREATE INDEX idx_purchase_details_product ON purchase_details(product_id);

-- MOVIMIENTOS DE INVENTARIO
CREATE TABLE inventory_movements (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    
    -- Identificación
    movement_number VARCHAR(50) NOT NULL,
    movement_type VARCHAR(30) NOT NULL CHECK (movement_type IN (
        'purchase',           -- Compra
        'sale',              -- Venta
        'customer_return',   -- Devolución de cliente
        'supplier_return',   -- Devolución a proveedor
        'adjustment_in',     -- Ajuste entrada
        'adjustment_out',    -- Ajuste salida
        'transfer_in',       -- Transferencia entrada
        'transfer_out',      -- Transferencia salida
        'production',        -- Producción
        'internal_use',      -- Consumo interno
        'obsolescence',      -- Baja/obsolescencia
        'sample',            -- Muestra/promoción
        'damage',            -- Daño/pérdida
        'initial_stock'      -- Inventario inicial
    )),
    
    -- Dirección
    direction VARCHAR(10) NOT NULL CHECK (direction IN ('in', 'out', 'none')),
    
    -- Referencias
    reference_type VARCHAR(50),
    reference_id UUID,
    reference_number VARCHAR(100),
    
    -- Producto y ubicación
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
    
    -- Para transferencias
    source_warehouse_id UUID REFERENCES warehouses(id),
    destination_warehouse_id UUID REFERENCES warehouses(id),
    
    -- Cantidades
    quantity DECIMAL(15,4) NOT NULL,
    
    -- Costos
    unit_cost DECIMAL(15,4) NOT NULL DEFAULT 0,
    total_cost DECIMAL(15,2) NOT NULL DEFAULT 0,
    
    -- Stock después del movimiento
    stock_before DECIMAL(15,4),
    stock_after DECIMAL(15,4),
    average_cost_before DECIMAL(15,4),
    average_cost_after DECIMAL(15,4),
    
    -- Lote y vencimiento (si aplica)
    batch_number VARCHAR(50),
    serial_number VARCHAR(100),
    expiration_date DATE,
    
    -- Detalles
    reason VARCHAR(255),
    notes TEXT,
    
    -- Estado
    status VARCHAR(20) DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'cancelled')),
    
    -- Auditoría
    created_by UUID REFERENCES users(id),
    approved_by UUID REFERENCES users(id),
    approved_at TIMESTAMP,
    movement_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT tenant_movement_number_unique UNIQUE (tenant_id, movement_number)
);

CREATE INDEX idx_movements_tenant ON inventory_movements(tenant_id);
CREATE INDEX idx_movements_product ON inventory_movements(product_id);
CREATE INDEX idx_movements_warehouse ON inventory_movements(warehouse_id);
CREATE INDEX idx_movements_type ON inventory_movements(movement_type);
CREATE INDEX idx_movements_direction ON inventory_movements(direction);
CREATE INDEX idx_movements_date ON inventory_movements(movement_date DESC);
CREATE INDEX idx_movements_reference ON inventory_movements(reference_type, reference_id);
CREATE INDEX idx_movements_status ON inventory_movements(status);

-- ALERTAS DE STOCK
CREATE TABLE stock_alerts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    warehouse_id UUID REFERENCES warehouses(id) ON DELETE CASCADE,
    
    alert_type VARCHAR(20) NOT NULL CHECK (alert_type IN ('low_stock', 'out_of_stock', 'overstock', 'expiring_soon', 'expired')),
    
    current_stock DECIMAL(15,4),
    threshold_stock DECIMAL(15,4),
    
    message TEXT,
    priority VARCHAR(20) DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
    
    is_resolved BOOLEAN DEFAULT FALSE,
    resolved_at TIMESTAMP,
    resolved_by UUID REFERENCES users(id),
    resolution_notes TEXT,
    
    expiration_date DATE,  -- Para alertas de vencimiento
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_stock_alerts_tenant ON stock_alerts(tenant_id);
CREATE INDEX idx_stock_alerts_product ON stock_alerts(product_id);
CREATE INDEX idx_stock_alerts_warehouse ON stock_alerts(warehouse_id);
CREATE INDEX idx_stock_alerts_type ON stock_alerts(alert_type);
CREATE INDEX idx_stock_alerts_resolved ON stock_alerts(is_resolved);
CREATE INDEX idx_stock_alerts_priority ON stock_alerts(priority);
CREATE INDEX idx_stock_alerts_created ON stock_alerts(created_at DESC);

-- ============================================================================
-- TRIGGERS Y FUNCIONES
-- ============================================================================

-- Función para actualizar updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Aplicar trigger a todas las tablas
CREATE TRIGGER update_tenants_updated_at BEFORE UPDATE ON tenants
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_categories_updated_at BEFORE UPDATE ON categories
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_warehouses_updated_at BEFORE UPDATE ON warehouses
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_suppliers_updated_at BEFORE UPDATE ON suppliers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_products_updated_at BEFORE UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_product_warehouse_stock_updated_at BEFORE UPDATE ON product_warehouse_stock
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_purchases_updated_at BEFORE UPDATE ON purchases
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_inventory_movements_updated_at BEFORE UPDATE ON inventory_movements
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_stock_alerts_updated_at BEFORE UPDATE ON stock_alerts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Función para calcular stock disponible
CREATE OR REPLACE FUNCTION calculate_available_stock()
RETURNS TRIGGER AS $$
BEGIN
    NEW.available_stock = NEW.current_stock - COALESCE(NEW.reserved_stock, 0);
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER calculate_product_available_stock 
    BEFORE INSERT OR UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION calculate_available_stock();

CREATE TRIGGER calculate_warehouse_stock_available 
    BEFORE INSERT OR UPDATE ON product_warehouse_stock
    FOR EACH ROW EXECUTE FUNCTION calculate_available_stock();

-- Función para generar número de movimiento automático
CREATE OR REPLACE FUNCTION generate_movement_number()
RETURNS TRIGGER AS $$
DECLARE
    next_number INTEGER;
    prefix VARCHAR(10);
    year_part VARCHAR(4);
BEGIN
    IF NEW.movement_number IS NULL OR NEW.movement_number = '' THEN
        year_part := EXTRACT(YEAR FROM NEW.movement_date)::VARCHAR;
        
        -- Obtener el siguiente número
        SELECT COALESCE(MAX(
            CAST(
                SUBSTRING(
                    movement_number 
                    FROM POSITION('-' IN movement_number) + LENGTH(year_part) + 2
                ) AS INTEGER
            )
        ), 0) + 1
        INTO next_number
        FROM inventory_movements
        WHERE tenant_id = NEW.tenant_id
        AND movement_type = NEW.movement_type
        AND EXTRACT(YEAR FROM movement_date) = EXTRACT(YEAR FROM NEW.movement_date);
        
        -- Generar prefijo según tipo
        prefix := CASE NEW.movement_type
            WHEN 'purchase' THEN 'COMP'
            WHEN 'sale' THEN 'VENT'
            WHEN 'adjustment_in' THEN 'AJIN'
            WHEN 'adjustment_out' THEN 'AJOU'
            WHEN 'transfer_in' THEN 'TRIN'
            WHEN 'transfer_out' THEN 'TROU'
            WHEN 'customer_return' THEN 'DEVC'
            WHEN 'supplier_return' THEN 'DEVP'
            WHEN 'production' THEN 'PROD'
            WHEN 'internal_use' THEN 'CONS'
            WHEN 'obsolescence' THEN 'BAJA'
            WHEN 'sample' THEN 'MUES'
            ELSE 'MOV'
        END;
        
        -- Formato: COMP-2024-00001
        NEW.movement_number := prefix || '-' || year_part || '-' || LPAD(next_number::TEXT, 5, '0');
    END IF;
    
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER generate_movement_number_trigger 
    BEFORE INSERT ON inventory_movements
    FOR EACH ROW EXECUTE FUNCTION generate_movement_number();

-- Función para generar número de compra automático
CREATE OR REPLACE FUNCTION generate_purchase_number()
RETURNS TRIGGER AS $$
DECLARE
    next_number INTEGER;
    year_part VARCHAR(4);
BEGIN
    IF NEW.purchase_number IS NULL OR NEW.purchase_number = '' THEN
        year_part := EXTRACT(YEAR FROM NEW.purchase_date)::VARCHAR;
        
        SELECT COALESCE(MAX(
            CAST(
                SUBSTRING(
                    purchase_number 
                    FROM POSITION('-' IN purchase_number) + LENGTH(year_part) + 2
                ) AS INTEGER
            )
        ), 0) + 1
        INTO next_number
        FROM purchases
        WHERE tenant_id = NEW.tenant_id
        AND EXTRACT(YEAR FROM purchase_date) = EXTRACT(YEAR FROM NEW.purchase_date);
        
        -- Formato: PC-2024-00001
        NEW.purchase_number := 'PC-' || year_part || '-' || LPAD(next_number::TEXT, 5, '0');
    END IF;
    
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER generate_purchase_number_trigger 
    BEFORE INSERT ON purchases
    FOR EACH ROW EXECUTE FUNCTION generate_purchase_number();

-- ============================================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================================

-- Habilitar RLS en tablas principales
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouses ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_warehouse_stock ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_alerts ENABLE ROW LEVEL SECURITY;

-- Crear políticas de aislamiento por tenant
CREATE POLICY tenant_isolation_categories ON categories
    USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

CREATE POLICY tenant_isolation_warehouses ON warehouses
    USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

CREATE POLICY tenant_isolation_suppliers ON suppliers
    USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

CREATE POLICY tenant_isolation_products ON products
    USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

CREATE POLICY tenant_isolation_product_warehouse_stock ON product_warehouse_stock
    USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

CREATE POLICY tenant_isolation_purchases ON purchases
    USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

CREATE POLICY tenant_isolation_purchase_details ON purchase_details
    USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

CREATE POLICY tenant_isolation_inventory_movements ON inventory_movements
    USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

CREATE POLICY tenant_isolation_stock_alerts ON stock_alerts
    USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

-- ============================================================================
-- VISTAS ÚTILES
-- ============================================================================

-- Vista de productos con información completa
CREATE OR REPLACE VIEW v_products_full AS
SELECT 
    p.*,
    c.name as category_name,
    s.business_name as supplier_name,
    (SELECT SUM(current_stock) FROM product_warehouse_stock WHERE product_id = p.id) as total_stock,
    (SELECT COUNT(*) FROM stock_alerts WHERE product_id = p.id AND is_resolved = FALSE) as pending_alerts
FROM products p
LEFT JOIN categories c ON p.category_id = c.id
LEFT JOIN suppliers s ON p.main_supplier_id = s.id;

-- Vista de stock por bodega con detalles
CREATE OR REPLACE VIEW v_warehouse_stock_detail AS
SELECT 
    pws.*,
    p.name as product_name,
    p.sku,
    p.barcode,
    w.name as warehouse_name,
    w.code as warehouse_code,
    c.name as category_name
FROM product_warehouse_stock pws
INNER JOIN products p ON pws.product_id = p.id
INNER JOIN warehouses w ON pws.warehouse_id = w.id
LEFT JOIN categories c ON p.category_id = c.id;

-- Vista de alertas activas
CREATE OR REPLACE VIEW v_active_alerts AS
SELECT 
    sa.*,
    p.name as product_name,
    p.sku,
    w.name as warehouse_name,
    CASE 
        WHEN sa.alert_type = 'low_stock' THEN 'Stock Bajo'
        WHEN sa.alert_type = 'out_of_stock' THEN 'Sin Stock'
        WHEN sa.alert_type = 'overstock' THEN 'Sobre Stock'
        WHEN sa.alert_type = 'expiring_soon' THEN 'Próximo a Vencer'
        WHEN sa.alert_type = 'expired' THEN 'Vencido'
    END as alert_type_label
FROM stock_alerts sa
INNER JOIN products p ON sa.product_id = p.id
LEFT JOIN warehouses w ON sa.warehouse_id = w.id
WHERE sa.is_resolved = FALSE;

-- ============================================================================
-- DATOS INICIALES (SEEDS)
-- ============================================================================

-- Insertar permisos de inventario
INSERT INTO permissions (name, description, module) VALUES
-- Productos
('inventory:products:read', 'Ver productos', 'inventory'),
('inventory:products:create', 'Crear productos', 'inventory'),
('inventory:products:update', 'Actualizar productos', 'inventory'),
('inventory:products:delete', 'Eliminar productos', 'inventory'),

-- Categorías
('inventory:categories:manage', 'Gestionar categorías', 'inventory'),

-- Proveedores
('inventory:suppliers:read', 'Ver proveedores', 'inventory'),
('inventory:suppliers:create', 'Crear proveedores', 'inventory'),
('inventory:suppliers:update', 'Actualizar proveedores', 'inventory'),

-- Bodegas
('inventory:warehouses:read', 'Ver bodegas', 'inventory'),
('inventory:warehouses:manage', 'Gestionar bodegas', 'inventory'),

-- Compras
('inventory:purchases:read', 'Ver compras', 'inventory'),
('inventory:purchases:create', 'Crear compras', 'inventory'),
('inventory:purchases:update', 'Actualizar compras', 'inventory'),
('inventory:purchases:delete', 'Eliminar compras', 'inventory'),
('inventory:purchases:approve', 'Aprobar compras', 'inventory'),

-- Movimientos
('inventory:movements:read', 'Ver movimientos', 'inventory'),
('inventory:movements:create', 'Registrar movimientos', 'inventory'),

-- Alertas
('inventory:alerts:read', 'Ver alertas de stock', 'inventory'),
('inventory:alerts:resolve', 'Resolver alertas', 'inventory'),

-- Reportes
('inventory:reports:basic', 'Ver reportes básicos', 'inventory'),
('inventory:reports:advanced', 'Ver reportes avanzados', 'inventory'),
('inventory:reports:export', 'Exportar reportes', 'inventory'),

-- Configuración
('inventory:config:manage', 'Administrar configuración de inventario', 'inventory')
ON CONFLICT (name) DO NOTHING;

-- ============================================================================
-- FUNCIONES AUXILIARES
-- ============================================================================

-- Función para obtener stock actual de un producto
CREATE OR REPLACE FUNCTION get_product_stock(p_product_id UUID, p_warehouse_id UUID DEFAULT NULL)
RETURNS TABLE (
    warehouse_id UUID,
    warehouse_name VARCHAR,
    current_stock DECIMAL,
    reserved_stock DECIMAL,
    available_stock DECIMAL
) AS $$
BEGIN
    IF p_warehouse_id IS NULL THEN
        -- Retornar stock de todas las bodegas
        RETURN QUERY
        SELECT 
            pws.warehouse_id,
            w.name,
            pws.current_stock,
            pws.reserved_stock,
            pws.available_stock
        FROM product_warehouse_stock pws
        INNER JOIN warehouses w ON pws.warehouse_id = w.id
        WHERE pws.product_id = p_product_id;
    ELSE
        -- Retornar stock de una bodega específica
        RETURN QUERY
        SELECT 
            pws.warehouse_id,
            w.name,
            pws.current_stock,
            pws.reserved_stock,
            pws.available_stock
        FROM product_warehouse_stock pws
        INNER JOIN warehouses w ON pws.warehouse_id = w.id
        WHERE pws.product_id = p_product_id 
        AND pws.warehouse_id = p_warehouse_id;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Función para calcular valor de inventario
CREATE OR REPLACE FUNCTION calculate_inventory_value(
    p_tenant_id UUID,
    p_warehouse_id UUID DEFAULT NULL,
    p_category_id UUID DEFAULT NULL
)
RETURNS DECIMAL AS $$
DECLARE
    total_value DECIMAL;
BEGIN
    SELECT COALESCE(SUM(p.current_stock * p.average_cost), 0)
    INTO total_value
    FROM products p
    WHERE p.tenant_id = p_tenant_id
    AND p.track_inventory = TRUE
    AND (p_category_id IS NULL OR p.category_id = p_category_id);
    
    RETURN total_value;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- COMENTARIOS DE TABLAS
-- ============================================================================

COMMENT ON TABLE tenants IS 'Tabla de tenants/empresas del sistema multitenant';
COMMENT ON TABLE users IS 'Usuarios del sistema';
COMMENT ON TABLE categories IS 'Categorías de productos';
COMMENT ON TABLE warehouses IS 'Bodegas o almacenes';
COMMENT ON TABLE suppliers IS 'Proveedores';
COMMENT ON TABLE products IS 'Catálogo de productos';
COMMENT ON TABLE product_warehouse_stock IS 'Stock de productos por bodega';
COMMENT ON TABLE purchases IS 'Facturas de compra a proveedores';
COMMENT ON TABLE purchase_details IS 'Detalles/items de facturas de compra';
COMMENT ON TABLE inventory_movements IS 'Registro de todos los movimientos de inventario';
COMMENT ON TABLE stock_alerts IS 'Alertas de stock bajo, sin stock, etc.';

-- ============================================================================
-- FIN DEL SCRIPT
-- ============================================================================
