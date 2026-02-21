-- ============================================================================
-- ACTUALIZACIÓN: SISTEMA DE LISTAS DE PRECIOS MÚLTIPLES
-- PostgreSQL 14+
-- Agregar a database_schema.sql o ejecutar después
-- ============================================================================

-- ============================================================================
-- NUEVAS TABLAS
-- ============================================================================

-- LISTAS DE PRECIOS
CREATE TABLE price_lists (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    
    -- Información básica
    code VARCHAR(50) NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    
    -- Configuración
    is_default BOOLEAN DEFAULT FALSE,
    priority INTEGER DEFAULT 0,
    
    -- Margen base
    default_margin_percentage DECIMAL(5,2),
    margin_type VARCHAR(20) DEFAULT 'markup' CHECK (margin_type IN ('markup', 'markdown')),
    -- markup: precio = costo × (1 + margen%)
    -- markdown: precio = precio_base × (1 - descuento%)
    
    base_price_list_id UUID REFERENCES price_lists(id) ON DELETE SET NULL,
    
    -- Vigencia
    valid_from DATE,
    valid_until DATE,
    
    -- Aplicación
    applies_to VARCHAR(20) DEFAULT 'all' CHECK (applies_to IN ('all', 'selected_products', 'selected_categories')),
    
    -- Reglas de aplicación automática
    auto_apply_rules JSONB DEFAULT '{}',
    
    -- Configuración adicional
    allow_manual_override BOOLEAN DEFAULT TRUE,
    requires_approval BOOLEAN DEFAULT FALSE,
    
    is_active BOOLEAN DEFAULT TRUE,
    notes TEXT,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT tenant_price_list_code_unique UNIQUE (tenant_id, code)
);

CREATE INDEX idx_price_lists_tenant ON price_lists(tenant_id);
CREATE INDEX idx_price_lists_default ON price_lists(tenant_id, is_default);
CREATE INDEX idx_price_lists_active ON price_lists(tenant_id, is_active);
CREATE INDEX idx_price_lists_priority ON price_lists(priority);

COMMENT ON TABLE price_lists IS 'Listas de precios configurables (Público, Mayorista, VIP, etc.)';
COMMENT ON COLUMN price_lists.margin_type IS 'markup: calcula sobre costo | markdown: descuento sobre otra lista';

-- PRECIOS DE PRODUCTOS POR LISTA
CREATE TABLE product_prices (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    price_list_id UUID NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
    
    -- Precio
    price DECIMAL(15,2) NOT NULL,
    
    -- Origen del precio
    price_source VARCHAR(20) DEFAULT 'manual' CHECK (price_source IN ('manual', 'auto_margin', 'auto_markdown', 'import')),
    
    -- Si se calculó automáticamente, guardar el margen usado
    margin_percentage DECIMAL(5,2),
    
    -- Precio mínimo para esta lista (opcional)
    min_price DECIMAL(15,2),
    
    -- Vigencia específica (sobrescribe la de la lista)
    valid_from DATE,
    valid_until DATE,
    
    -- Metadata
    last_updated_by UUID REFERENCES users(id),
    notes TEXT,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT tenant_product_price_list_unique UNIQUE (tenant_id, product_id, price_list_id)
);

CREATE INDEX idx_product_prices_tenant ON product_prices(tenant_id);
CREATE INDEX idx_product_prices_product ON product_prices(product_id);
CREATE INDEX idx_product_prices_price_list ON product_prices(price_list_id);
CREATE INDEX idx_product_prices_validity ON product_prices(valid_from, valid_until);

COMMENT ON TABLE product_prices IS 'Precios de productos en cada lista de precios';

-- CLIENTES (si no existe)
CREATE TABLE IF NOT EXISTS customers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    
    -- Información básica
    customer_type VARCHAR(20) DEFAULT 'individual' CHECK (customer_type IN ('individual', 'company')),
    
    -- Individual
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    
    -- Empresa
    business_name VARCHAR(255),
    trade_name VARCHAR(255),
    tax_id VARCHAR(50),
    
    -- Contacto
    email VARCHAR(255),
    phone VARCHAR(20),
    mobile VARCHAR(20),
    address TEXT,
    city VARCHAR(100),
    state VARCHAR(100),
    country VARCHAR(100) DEFAULT 'Colombia',
    postal_code VARCHAR(20),
    
    -- Lista de precios por defecto
    default_price_list_id UUID REFERENCES price_lists(id) ON DELETE SET NULL,
    
    -- Clasificación
    customer_category VARCHAR(50),
    
    -- Límites comerciales
    credit_limit DECIMAL(15,2),
    payment_terms INTEGER DEFAULT 0,
    
    is_active BOOLEAN DEFAULT TRUE,
    notes TEXT,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Si la tabla ya existe, agregar columna
DO $$ 
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'customers') THEN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name = 'customers' 
                      AND column_name = 'default_price_list_id') THEN
            ALTER TABLE customers 
                ADD COLUMN default_price_list_id UUID REFERENCES price_lists(id) ON DELETE SET NULL;
        END IF;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_customers_tenant ON customers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_customers_price_list ON customers(default_price_list_id);
CREATE INDEX IF NOT EXISTS idx_customers_active ON customers(tenant_id, is_active);

-- ASIGNACIÓN DE LISTAS DE PRECIOS A CLIENTES
CREATE TABLE customer_price_lists (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    price_list_id UUID NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
    
    -- Prioridad (si un cliente tiene múltiples listas)
    priority INTEGER DEFAULT 0,
    
    -- Vigencia
    valid_from DATE,
    valid_until DATE,
    
    is_active BOOLEAN DEFAULT TRUE,
    assigned_by UUID REFERENCES users(id),
    notes TEXT,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT tenant_customer_price_list_unique UNIQUE (tenant_id, customer_id, price_list_id)
);

CREATE INDEX idx_customer_price_lists_tenant ON customer_price_lists(tenant_id);
CREATE INDEX idx_customer_price_lists_customer ON customer_price_lists(customer_id);
CREATE INDEX idx_customer_price_lists_price_list ON customer_price_lists(price_list_id);
CREATE INDEX idx_customer_price_lists_active ON customer_price_lists(is_active);

COMMENT ON TABLE customer_price_lists IS 'Asignación de listas de precios a clientes específicos';

-- APLICACIÓN DE LISTAS POR CATEGORÍA
CREATE TABLE price_list_categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    
    price_list_id UUID NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
    category_id UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    
    -- Margen específico para esta categoría en esta lista
    margin_percentage DECIMAL(5,2),
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT tenant_price_list_category_unique UNIQUE (tenant_id, price_list_id, category_id)
);

CREATE INDEX idx_price_list_categories_price_list ON price_list_categories(price_list_id);
CREATE INDEX idx_price_list_categories_category ON price_list_categories(category_id);

COMMENT ON TABLE price_list_categories IS 'Configuración de márgenes por categoría en cada lista';

-- ============================================================================
-- ACTUALIZACIÓN DE TABLA PRODUCTS
-- ============================================================================

-- Agregar columnas nuevas
ALTER TABLE products
    ADD COLUMN IF NOT EXISTS base_price DECIMAL(15,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS default_price_list_id UUID REFERENCES price_lists(id) ON DELETE SET NULL;

-- Actualizar base_price con valor de sale_price (si existe)
UPDATE products SET base_price = sale_price WHERE base_price = 0 AND sale_price > 0;

COMMENT ON COLUMN products.base_price IS 'Precio base de referencia (generalmente precio público)';
COMMENT ON COLUMN products.default_price_list_id IS 'Lista de precios por defecto para este producto';

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- Trigger para updated_at en nuevas tablas
CREATE TRIGGER update_price_lists_updated_at BEFORE UPDATE ON price_lists
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_product_prices_updated_at BEFORE UPDATE ON product_prices
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_customers_updated_at BEFORE UPDATE ON customers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_customer_price_lists_updated_at BEFORE UPDATE ON customer_price_lists
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- FUNCIONES
-- ============================================================================

-- Función para calcular precio de un producto en una lista
CREATE OR REPLACE FUNCTION calculate_product_price_for_list(
    p_product_id UUID,
    p_price_list_id UUID
) RETURNS DECIMAL(15,2) AS $$
DECLARE
    v_product RECORD;
    v_price_list RECORD;
    v_calculated_price DECIMAL(15,2);
    v_base_price DECIMAL(15,2);
    v_category_margin DECIMAL(5,2);
BEGIN
    -- Obtener producto
    SELECT * INTO v_product FROM products WHERE id = p_product_id;
    
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    
    -- Obtener lista de precios
    SELECT * INTO v_price_list FROM price_lists WHERE id = p_price_list_id;
    
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    
    -- Verificar si hay margen específico para la categoría del producto
    SELECT margin_percentage INTO v_category_margin
    FROM price_list_categories
    WHERE price_list_id = p_price_list_id
    AND category_id = v_product.category_id;
    
    -- Calcular según tipo de margen
    IF v_price_list.margin_type = 'markup' THEN
        -- Calcular sobre costo promedio
        v_calculated_price := v_product.average_cost * 
            (1 + COALESCE(v_category_margin, v_price_list.default_margin_percentage, 0) / 100);
        
    ELSIF v_price_list.margin_type = 'markdown' THEN
        -- Obtener precio de la lista base
        IF v_price_list.base_price_list_id IS NOT NULL THEN
            SELECT price INTO v_base_price 
            FROM product_prices 
            WHERE product_id = p_product_id 
            AND price_list_id = v_price_list.base_price_list_id
            LIMIT 1;
            
            IF v_base_price IS NULL THEN
                -- Si no hay precio en lista base, usar base_price del producto
                v_base_price := v_product.base_price;
            END IF;
        ELSE
            v_base_price := v_product.base_price;
        END IF;
        
        -- Aplicar descuento
        v_calculated_price := v_base_price * 
            (1 - COALESCE(v_category_margin, v_price_list.default_margin_percentage, 0) / 100);
    ELSE
        v_calculated_price := v_product.base_price;
    END IF;
    
    RETURN ROUND(v_calculated_price, 2);
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION calculate_product_price_for_list IS 'Calcula el precio de un producto para una lista específica';

-- Función para obtener el precio aplicable a un cliente
CREATE OR REPLACE FUNCTION get_price_for_customer(
    p_product_id UUID,
    p_customer_id UUID DEFAULT NULL,
    p_quantity DECIMAL DEFAULT 1
) RETURNS TABLE (
    price DECIMAL(15,2),
    price_list_id UUID,
    price_list_name VARCHAR,
    source VARCHAR
) AS $$
DECLARE
    v_customer_price_list_id UUID;
    v_default_price_list_id UUID;
    v_product_price RECORD;
    v_tenant_id UUID;
BEGIN
    -- Obtener tenant_id del producto
    SELECT tenant_id INTO v_tenant_id FROM products WHERE id = p_product_id;
    
    -- 1. Si hay cliente, buscar su lista de precios
    IF p_customer_id IS NOT NULL THEN
        -- Primero buscar en asignaciones específicas
        SELECT pl.id INTO v_customer_price_list_id
        FROM customer_price_lists cpl
        INNER JOIN price_lists pl ON cpl.price_list_id = pl.id
        WHERE cpl.customer_id = p_customer_id
        AND cpl.is_active = TRUE
        AND pl.is_active = TRUE
        AND (cpl.valid_from IS NULL OR cpl.valid_from <= CURRENT_DATE)
        AND (cpl.valid_until IS NULL OR cpl.valid_until >= CURRENT_DATE)
        ORDER BY cpl.priority ASC
        LIMIT 1;
        
        -- Si no hay asignación, buscar lista por defecto del cliente
        IF v_customer_price_list_id IS NULL THEN
            SELECT default_price_list_id INTO v_customer_price_list_id
            FROM customers
            WHERE id = p_customer_id
            AND default_price_list_id IS NOT NULL;
        END IF;
    END IF;
    
    -- 2. Si no hay lista del cliente, buscar lista por defecto del tenant
    IF v_customer_price_list_id IS NULL THEN
        SELECT id INTO v_default_price_list_id
        FROM price_lists
        WHERE tenant_id = v_tenant_id
        AND is_default = TRUE
        AND is_active = TRUE
        LIMIT 1;
        
        v_customer_price_list_id := v_default_price_list_id;
    END IF;
    
    -- 3. Obtener precio del producto en esa lista
    SELECT 
        pp.price,
        pp.price_list_id,
        pl.name as price_list_name,
        pp.price_source as source
    INTO v_product_price
    FROM product_prices pp
    INNER JOIN price_lists pl ON pp.price_list_id = pl.id
    WHERE pp.product_id = p_product_id
    AND pp.price_list_id = v_customer_price_list_id
    AND (pp.valid_from IS NULL OR pp.valid_from <= CURRENT_DATE)
    AND (pp.valid_until IS NULL OR pp.valid_until >= CURRENT_DATE);
    
    -- 4. Si existe precio configurado, retornarlo
    IF FOUND THEN
        RETURN QUERY SELECT 
            v_product_price.price,
            v_product_price.price_list_id,
            v_product_price.price_list_name,
            v_product_price.source;
    ELSE
        -- 5. Si no hay precio configurado, calcularlo automáticamente
        RETURN QUERY SELECT 
            calculate_product_price_for_list(p_product_id, v_customer_price_list_id) as price,
            v_customer_price_list_id as price_list_id,
            (SELECT name FROM price_lists WHERE id = v_customer_price_list_id) as price_list_name,
            'auto_calculated'::VARCHAR as source;
    END IF;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION get_price_for_customer IS 'Obtiene el precio aplicable a un cliente específico';

-- Función para actualizar todos los precios de una lista
CREATE OR REPLACE FUNCTION update_price_list_prices(
    p_price_list_id UUID
) RETURNS INTEGER AS $$
DECLARE
    v_updated_count INTEGER := 0;
    v_product RECORD;
    v_new_price DECIMAL(15,2);
BEGIN
    -- Obtener todos los productos que tienen precio en esta lista
    FOR v_product IN 
        SELECT DISTINCT pp.product_id
        FROM product_prices pp
        WHERE pp.price_list_id = p_price_list_id
        AND pp.price_source IN ('auto_margin', 'auto_markdown')
    LOOP
        -- Calcular nuevo precio
        v_new_price := calculate_product_price_for_list(
            v_product.product_id, 
            p_price_list_id
        );
        
        -- Actualizar precio
        UPDATE product_prices
        SET price = v_new_price,
            updated_at = CURRENT_TIMESTAMP
        WHERE product_id = v_product.product_id
        AND price_list_id = p_price_list_id;
        
        v_updated_count := v_updated_count + 1;
    END LOOP;
    
    RETURN v_updated_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION update_price_list_prices IS 'Actualiza todos los precios automáticos de una lista';

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

ALTER TABLE price_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_price_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_list_categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_price_lists ON price_lists
    USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

CREATE POLICY tenant_isolation_product_prices ON product_prices
    USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

CREATE POLICY tenant_isolation_customers ON customers
    USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

CREATE POLICY tenant_isolation_customer_price_lists ON customer_price_lists
    USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

CREATE POLICY tenant_isolation_price_list_categories ON price_list_categories
    USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

-- ============================================================================
-- VISTAS
-- ============================================================================

-- Vista para comparar precios de un producto en todas las listas
CREATE OR REPLACE VIEW v_product_prices_comparison AS
SELECT 
    p.id as product_id,
    p.tenant_id,
    p.sku,
    p.name as product_name,
    p.average_cost,
    p.base_price,
    pl.id as price_list_id,
    pl.code as price_list_code,
    pl.name as price_list_name,
    pl.margin_type,
    pp.price,
    pp.margin_percentage,
    pp.price_source,
    ROUND((pp.price - p.average_cost), 2) as profit_amount,
    ROUND(((pp.price - p.average_cost) / NULLIF(pp.price, 0) * 100), 2) as profit_margin_pct,
    pp.valid_from,
    pp.valid_until
FROM products p
CROSS JOIN price_lists pl
LEFT JOIN product_prices pp ON pp.product_id = p.id 
    AND pp.price_list_id = pl.id
    AND pp.tenant_id = p.tenant_id
WHERE pl.is_active = TRUE
AND p.is_active = TRUE
AND pl.tenant_id = p.tenant_id
ORDER BY p.name, pl.priority;

COMMENT ON VIEW v_product_prices_comparison IS 'Comparación de precios de productos en todas las listas';

-- Vista de clientes con sus listas asignadas
CREATE OR REPLACE VIEW v_customers_with_price_lists AS
SELECT 
    c.id as customer_id,
    c.tenant_id,
    COALESCE(c.business_name, c.first_name || ' ' || c.last_name) as customer_name,
    c.customer_type,
    c.customer_category,
    c.default_price_list_id,
    dpl.name as default_price_list_name,
    COUNT(cpl.id) as assigned_price_lists_count,
    c.is_active
FROM customers c
LEFT JOIN price_lists dpl ON c.default_price_list_id = dpl.id
LEFT JOIN customer_price_lists cpl ON c.id = cpl.customer_id AND cpl.is_active = TRUE
GROUP BY c.id, c.tenant_id, c.business_name, c.first_name, c.last_name, 
         c.customer_type, c.customer_category, c.default_price_list_id, 
         dpl.name, c.is_active;

COMMENT ON VIEW v_customers_with_price_lists IS 'Clientes con sus listas de precios asignadas';

-- ============================================================================
-- PERMISOS
-- ============================================================================

INSERT INTO permissions (name, description, module) VALUES
('inventory:price_lists:read', 'Ver listas de precios', 'inventory'),
('inventory:price_lists:create', 'Crear listas de precios', 'inventory'),
('inventory:price_lists:update', 'Actualizar listas de precios', 'inventory'),
('inventory:price_lists:delete', 'Eliminar listas de precios', 'inventory'),
('inventory:price_lists:assign', 'Asignar listas a clientes', 'inventory'),
('inventory:prices:view_all', 'Ver precios de todas las listas', 'inventory'),
('inventory:prices:update', 'Actualizar precios de productos', 'inventory'),
('inventory:customers:read', 'Ver clientes', 'inventory'),
('inventory:customers:create', 'Crear clientes', 'inventory'),
('inventory:customers:update', 'Actualizar clientes', 'inventory'),
('inventory:customers:delete', 'Eliminar clientes', 'inventory')
ON CONFLICT (name) DO NOTHING;

-- ============================================================================
-- DATOS DE EJEMPLO (OPCIONAL)
-- ============================================================================

-- Comentar o eliminar esta sección si no se desean datos de ejemplo

/*
-- Crear listas de precios de ejemplo para un tenant
-- NOTA: Reemplazar 'YOUR-TENANT-UUID' con el UUID real del tenant

DO $$
DECLARE
    v_tenant_id UUID := 'YOUR-TENANT-UUID';
    v_public_list_id UUID;
BEGIN
    -- 1. Lista PÚBLICO (por defecto)
    INSERT INTO price_lists (tenant_id, code, name, description, is_default, priority, default_margin_percentage, margin_type)
    VALUES (v_tenant_id, 'PUBLIC', 'Público', 'Precio al público general', TRUE, 1, 30.00, 'markup')
    RETURNING id INTO v_public_list_id;
    
    -- 2. Lista MAYORISTA
    INSERT INTO price_lists (tenant_id, code, name, description, priority, default_margin_percentage, margin_type)
    VALUES (v_tenant_id, 'WHOLESALE', 'Mayorista', 'Precio para compras al por mayor', 2, 20.00, 'markup');
    
    -- 3. Lista VIP (15% descuento sobre público)
    INSERT INTO price_lists (tenant_id, code, name, description, priority, default_margin_percentage, margin_type, base_price_list_id)
    VALUES (v_tenant_id, 'VIP', 'VIP', 'Precio para clientes VIP', 3, 15.00, 'markdown', v_public_list_id);
    
    -- 4. Lista SOCIO (10% descuento sobre público)
    INSERT INTO price_lists (tenant_id, code, name, description, priority, default_margin_percentage, margin_type, base_price_list_id)
    VALUES (v_tenant_id, 'PARTNER', 'Socio', 'Precio especial para socios', 4, 10.00, 'markdown', v_public_list_id);
    
    -- 5. Lista EMPLEADO (20% descuento sobre público)
    INSERT INTO price_lists (tenant_id, code, name, description, priority, default_margin_percentage, margin_type, base_price_list_id)
    VALUES (v_tenant_id, 'EMPLOYEE', 'Empleado', 'Precio para empleados de la empresa', 5, 20.00, 'markdown', v_public_list_id);
    
    RAISE NOTICE 'Listas de precios creadas exitosamente';
END $$;
*/

-- ============================================================================
-- FIN DEL SCRIPT
-- ============================================================================
