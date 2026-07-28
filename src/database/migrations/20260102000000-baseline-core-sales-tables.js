'use strict';

// ============================================================================
// MIGRACIÓN BASELINE — módulo de ventas/taller/precios
//
// POR QUÉ EXISTE ESTE ARCHIVO:
// Mismo problema que resolvió 20260101000000-baseline-core-inventory-tables.js,
// pero para el módulo de ventas/taller: `sales`, `sale_items`, `customers`,
// `vehicles`, `work_orders`, `work_order_items`, `dian_resolutions`,
// `dian_events`, `commission_settlements`, `commission_settlement_items`,
// `invoices`, `inventory_adjustments`, `inventory_adjustment_items`,
// `audit_logs`, `purchase_details` y toda la familia de listas de precios
// (`price_lists`, `price_list_categories`, `product_prices`,
// `customer_price_lists`) nunca tuvieron `createTable` — se crearon una
// sola vez vía `sequelize.sync()` en la BD compartida original.
//
// DDL extraído directamente de pg_catalog de la BD vieja (columnas, tipos,
// constraints e índices reales) — ver src/scripts/dumpTableSchema.js.
//
// NOTA sobre `purchase_details`: existe en la BD vieja pero ningún modelo
// Sequelize ni migración la referencia (el modelo activo usa `purchase_items`,
// ya cubierto por el baseline de inventario). Parece una tabla legacy/huérfana.
// Se incluye igual aquí por completitud — no le hace daño a nada tenerla vacía
// en el schema nuevo — pero probablemente no haga falta.
//
// NOTA sobre `price_lists` y su familia: hay un `src/database/price_lists_schema.sql`
// suelto en el repo con esta misma estructura, pero NO está conectado a ningún
// script — quedó huérfano. Este archivo es la fuente real de verdad (viene de
// la BD viva), no ese .sql.
//
// tenant_id, y los FK hacia `tenants`/`users`, se califican con
// "public"."..." porque esas tablas son compartidas entre tenants — igual
// que ya hace el baseline de inventario.
//
// ⚠️ IMPORTANTE — VERIFICAR ANTES DE CORRER EN PROD:
// Antes del cutover de un tenant real, compara esto contra la estructura
// real de la BD vieja con src/scripts/dumpTableSchema.js (detecta
// automáticamente cualquier tabla fantasma restante).
// ============================================================================

const SQL_UP = `

DO $$ BEGIN
  CREATE TYPE enum_sales_document_type AS ENUM ('remision', 'factura', 'cotizacion', 'nota_credito', 'nota_debito');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE enum_sales_status AS ENUM ('draft', 'pending', 'completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE enum_sales_payment_status AS ENUM ('pending', 'partial', 'paid');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE enum_work_orders_payment_status AS ENUM ('pending', 'partial', 'paid');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE enum_vehicles_vehicle_type AS ENUM ('automovil', 'camioneta', 'motocicleta', 'camion', 'otro');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── TABLAS ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_logs (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" uuid,
    "user_id" uuid,
    "action" character varying(100) NOT NULL,
    "entity" character varying(100) NOT NULL,
    "entity_id" character varying(100),
    "changes" jsonb,
    "ip_address" character varying(50),
    "user_agent" character varying(500),
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS commission_settlement_items (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "settlement_id" uuid NOT NULL,
    "work_order_id" uuid,
    "order_number" character varying(50),
    "labor_amount" numeric(15,2) NOT NULL DEFAULT 0,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "sale_id" uuid,
    "sale_number" character varying(50)
);

CREATE TABLE IF NOT EXISTS commission_settlements (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" uuid NOT NULL,
    "settlement_number" character varying(50) NOT NULL,
    "technician_id" uuid NOT NULL,
    "date_from" date,
    "date_to" date,
    "commission_percentage" numeric(5,2) NOT NULL,
    "base_amount" numeric(15,2) NOT NULL DEFAULT 0,
    "commission_amount" numeric(15,2) NOT NULL DEFAULT 0,
    "notes" text,
    "created_by" uuid NOT NULL,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customer_price_lists (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" uuid NOT NULL,
    "customer_id" uuid NOT NULL,
    "price_list_id" uuid NOT NULL,
    "priority" integer DEFAULT 0,
    "valid_from" date,
    "valid_until" date,
    "is_active" boolean DEFAULT true,
    "assigned_by" uuid,
    "notes" text,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS customers (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" uuid NOT NULL,
    "customer_type" character varying(20) DEFAULT 'individual'::character varying,
    "first_name" character varying(100),
    "last_name" character varying(100),
    "business_name" character varying(255),
    "trade_name" character varying(255),
    "tax_id" character varying(50),
    "email" character varying(255),
    "phone" character varying(20),
    "mobile" character varying(20),
    "address" text,
    "city" character varying(100),
    "state" character varying(100),
    "country" character varying(100) DEFAULT 'Colombia'::character varying,
    "postal_code" character varying(20),
    "default_price_list_id" uuid,
    "customer_category" character varying(50),
    "credit_limit" numeric(15,2),
    "payment_terms" integer DEFAULT 0,
    "is_active" boolean DEFAULT true,
    "notes" text,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "callmebot_apikey" character varying(20) DEFAULT NULL::character varying,
    "retention_config" jsonb DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS dian_events (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" uuid NOT NULL,
    "sale_id" uuid,
    "event_type" character varying(50) NOT NULL,
    "document_type" character varying(30),
    "invoice_number" character varying(50),
    "cufe" character varying(200),
    "request_xml" text,
    "response_raw" text,
    "status" character varying(30),
    "error_message" text,
    "is_test" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS dian_resolutions (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" uuid NOT NULL,
    "resolution_number" character varying(50) NOT NULL,
    "resolution_date" date NOT NULL,
    "prefix" character varying(10) NOT NULL,
    "from_number" bigint NOT NULL,
    "to_number" bigint NOT NULL,
    "current_number" bigint NOT NULL,
    "valid_from" date NOT NULL,
    "valid_to" date NOT NULL,
    "document_type" character varying(20) DEFAULT 'invoice'::character varying,
    "is_active" boolean DEFAULT true,
    "is_test" boolean DEFAULT false,
    "notes" text,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "branch_id" uuid
);

CREATE TABLE IF NOT EXISTS inventory_adjustment_items (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "adjustment_id" uuid NOT NULL,
    "product_id" uuid NOT NULL,
    "quantity" numeric(15,2) NOT NULL,
    "unit_cost" numeric(15,2) NOT NULL,
    "total_cost" numeric(15,2) NOT NULL,
    "reason" character varying(100),
    "notes" text,
    "created_at" timestamp without time zone DEFAULT now(),
    "updated_at" timestamp without time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory_adjustments (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" uuid NOT NULL,
    "adjustment_number" character varying(50) NOT NULL,
    "adjustment_type" character varying(20) NOT NULL,
    "reason" character varying(100) NOT NULL,
    "warehouse_id" uuid,
    "user_id" uuid NOT NULL,
    "adjustment_date" date NOT NULL,
    "status" character varying(20) NOT NULL DEFAULT 'draft'::character varying,
    "notes" text,
    "created_at" timestamp without time zone DEFAULT now(),
    "updated_at" timestamp without time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoices (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" uuid NOT NULL,
    "invoice_number" character varying(50) NOT NULL,
    "customer_name" character varying(255) NOT NULL,
    "customer_tax_id" character varying(50),
    "customer_email" character varying(255),
    "customer_phone" character varying(20),
    "customer_address" text,
    "subtotal" numeric(15,2) NOT NULL DEFAULT 0,
    "tax_amount" numeric(15,2) NOT NULL DEFAULT 0,
    "discount_amount" numeric(15,2) DEFAULT 0,
    "total_amount" numeric(15,2) NOT NULL,
    "status" character varying(20) NOT NULL DEFAULT 'draft'::character varying,
    "issue_date" date NOT NULL DEFAULT CURRENT_DATE,
    "due_date" date NOT NULL,
    "paid_date" date,
    "payment_method" character varying(50),
    "notes" text,
    "pdf_url" character varying(500),
    "created_by" uuid,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS price_list_categories (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" uuid NOT NULL,
    "price_list_id" uuid NOT NULL,
    "category_id" uuid NOT NULL,
    "margin_percentage" numeric(5,2),
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS price_lists (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" uuid NOT NULL,
    "code" character varying(50) NOT NULL,
    "name" character varying(100) NOT NULL,
    "description" text,
    "is_default" boolean DEFAULT false,
    "priority" integer DEFAULT 0,
    "default_margin_percentage" numeric(5,2),
    "margin_type" character varying(20) DEFAULT 'markup'::character varying,
    "base_price_list_id" uuid,
    "valid_from" date,
    "valid_until" date,
    "applies_to" character varying(20) DEFAULT 'all'::character varying,
    "auto_apply_rules" jsonb DEFAULT '{}'::jsonb,
    "allow_manual_override" boolean DEFAULT true,
    "requires_approval" boolean DEFAULT false,
    "is_active" boolean DEFAULT true,
    "notes" text,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS product_prices (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" uuid NOT NULL,
    "product_id" uuid NOT NULL,
    "price_list_id" uuid NOT NULL,
    "price" numeric(15,2) NOT NULL,
    "price_source" character varying(20) DEFAULT 'manual'::character varying,
    "margin_percentage" numeric(5,2),
    "min_price" numeric(15,2),
    "valid_from" date,
    "valid_until" date,
    "last_updated_by" uuid,
    "notes" text,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS purchase_details (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" uuid NOT NULL,
    "purchase_id" uuid NOT NULL,
    "line_number" integer NOT NULL,
    "product_id" uuid,
    "product_name" character varying(255) NOT NULL,
    "product_sku" character varying(100) NOT NULL,
    "product_barcode" character varying(100),
    "quantity" numeric(15,4) NOT NULL,
    "received_quantity" numeric(15,4) DEFAULT 0,
    "unit_of_measure" character varying(20) NOT NULL,
    "unit_cost" numeric(15,4) NOT NULL,
    "tax_rate" numeric(5,2) DEFAULT 0,
    "tax_amount" numeric(15,2) DEFAULT 0,
    "discount_percentage" numeric(5,2) DEFAULT 0,
    "discount_amount" numeric(15,2) DEFAULT 0,
    "line_total" numeric(15,2) NOT NULL,
    "batch_number" character varying(50),
    "expiration_date" date,
    "notes" text,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sale_items (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" uuid NOT NULL,
    "sale_id" uuid NOT NULL,
    "product_id" uuid,
    "product_name" character varying(255) NOT NULL,
    "product_sku" character varying(100),
    "quantity" numeric(10,2) NOT NULL,
    "unit_price" numeric(15,2) NOT NULL,
    "discount_percentage" numeric(5,2) DEFAULT 0,
    "discount_amount" numeric(15,2) DEFAULT 0,
    "tax_percentage" numeric(5,2) DEFAULT 19,
    "tax_amount" numeric(15,2) DEFAULT 0,
    "subtotal" numeric(15,2) NOT NULL,
    "total" numeric(15,2) NOT NULL,
    "unit_cost" numeric(15,2),
    "notes" text,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "item_type" character varying(20) NOT NULL DEFAULT 'product'::character varying,
    "technician_id" uuid,
    "inc_rate" numeric(5,2) DEFAULT 0,
    "inc_amount" numeric(15,2) DEFAULT 0,
    "ica_rate" numeric(5,4) DEFAULT 0,
    "ica_amount" numeric(15,2) DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sales (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" uuid NOT NULL,
    "sale_number" character varying(50) NOT NULL,
    "document_type" enum_sales_document_type,
    "customer_id" uuid,
    "customer_name" character varying(255) NOT NULL,
    "customer_tax_id" character varying(50),
    "customer_email" character varying(255),
    "customer_phone" character varying(20),
    "customer_address" text,
    "warehouse_id" uuid,
    "subtotal" numeric(15,2) NOT NULL DEFAULT 0,
    "tax_amount" numeric(15,2) NOT NULL DEFAULT 0,
    "discount_amount" numeric(15,2) DEFAULT 0,
    "total_amount" numeric(15,2) NOT NULL,
    "status" enum_sales_status,
    "sale_date" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "delivery_date" timestamp without time zone,
    "payment_method" character varying(50),
    "payment_status" enum_sales_payment_status DEFAULT 'pending'::enum_sales_payment_status,
    "paid_amount" numeric(15,2) DEFAULT 0,
    "notes" text,
    "internal_notes" text,
    "pdf_url" character varying(500),
    "created_by" uuid,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "vehicle_plate" character varying(20),
    "payment_history" jsonb DEFAULT '[]'::jsonb,
    "credit_days" integer,
    "due_date" date,
    "mileage" integer,
    "vehicle_brand" character varying(100),
    "vehicle_model" character varying(100),
    "vehicle_year" integer,
    "vehicle_color" character varying(50),
    "product_settled_at" timestamp without time zone,
    "product_settlement_id" uuid,
    "labor_settled_at" timestamp without time zone,
    "labor_settlement_id" uuid,
    "technician_id" uuid,
    "technician_name" character varying(255),
    "dian_status" character varying(30) DEFAULT 'not_applicable'::character varying,
    "dian_invoice_number" character varying(50),
    "cufe" character varying(255),
    "dian_response" jsonb,
    "dian_sent_at" timestamp with time zone,
    "dian_accepted_at" timestamp with time zone,
    "dian_error_message" text,
    "retefuente_rate" numeric(5,2) DEFAULT 0,
    "retefuente_amount" numeric(15,2) DEFAULT 0,
    "reteiva_rate" numeric(5,2) DEFAULT 0,
    "reteiva_amount" numeric(15,2) DEFAULT 0,
    "reteica_rate" numeric(5,4) DEFAULT 0,
    "reteica_amount" numeric(15,2) DEFAULT 0,
    "total_retentions" numeric(15,2) DEFAULT 0,
    "tax_breakdown" jsonb DEFAULT '[]'::jsonb,
    "branch_id" uuid,
    "payment_terms" integer,
    "vehicle_type" character varying(20),
    "converted_to_work_order_id" uuid
);

CREATE TABLE IF NOT EXISTS vehicles (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" uuid NOT NULL,
    "customer_id" uuid,
    "plate" character varying(20) NOT NULL,
    "brand" character varying(100),
    "model" character varying(100),
    "year" integer,
    "color" character varying(50),
    "vin" character varying(50),
    "engine" character varying(100),
    "fuel_type" character varying(20) DEFAULT 'gasolina'::character varying,
    "current_mileage" integer,
    "notes" text,
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT now(),
    "updated_at" timestamp with time zone DEFAULT now(),
    "engine_number" character varying(100),
    "ownership_card" character varying(50),
    "soat_number" character varying(50),
    "soat_expiry" date,
    "tecnomecanica_number" character varying(50),
    "tecnomecanica_expiry" date,
    "vehicle_type" enum_vehicles_vehicle_type NOT NULL DEFAULT 'automovil'::enum_vehicles_vehicle_type
);

CREATE TABLE IF NOT EXISTS work_order_items (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" uuid NOT NULL,
    "work_order_id" uuid NOT NULL,
    "item_type" character varying(20) NOT NULL,
    "product_id" uuid,
    "product_name" character varying(255) NOT NULL,
    "product_sku" character varying(50),
    "quantity" numeric(10,3) NOT NULL DEFAULT 1,
    "unit_price" numeric(15,2) NOT NULL DEFAULT 0,
    "tax_percentage" numeric(5,2) DEFAULT 19,
    "tax_amount" numeric(15,2) DEFAULT 0,
    "subtotal" numeric(15,2) DEFAULT 0,
    "total" numeric(15,2) DEFAULT 0,
    "notes" text,
    "inventory_movement_id" uuid,
    "created_at" timestamp with time zone DEFAULT now(),
    "updated_at" timestamp with time zone DEFAULT now(),
    "technician_id" uuid,
    "approval_status" character varying(20) NOT NULL DEFAULT 'aprobado'::character varying,
    "rejection_reason" character varying(255),
    "quote_request_id" uuid
);

CREATE TABLE IF NOT EXISTS work_orders (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" uuid NOT NULL,
    "order_number" character varying(50) NOT NULL,
    "vehicle_id" uuid NOT NULL,
    "customer_id" uuid,
    "technician_id" uuid,
    "warehouse_id" uuid,
    "status" character varying(20) DEFAULT 'recibido'::character varying,
    "mileage_in" integer,
    "mileage_out" integer,
    "problem_description" text,
    "diagnosis" text,
    "work_performed" text,
    "photos_in" jsonb DEFAULT '[]'::jsonb,
    "photos_out" jsonb DEFAULT '[]'::jsonb,
    "received_at" timestamp with time zone DEFAULT now(),
    "promised_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "delivered_at" timestamp with time zone,
    "subtotal" numeric(15,2) DEFAULT 0,
    "tax_amount" numeric(15,2) DEFAULT 0,
    "discount_amount" numeric(15,2) DEFAULT 0,
    "total_amount" numeric(15,2) DEFAULT 0,
    "sale_id" uuid,
    "notes" text,
    "internal_notes" text,
    "created_by" uuid,
    "created_at" timestamp with time zone DEFAULT now(),
    "updated_at" timestamp with time zone DEFAULT now(),
    "settled_at" timestamp with time zone,
    "settlement_id" uuid,
    "checklist_in" jsonb DEFAULT '{}'::jsonb,
    "share_token" uuid,
    "paid_amount" numeric(15,2) NOT NULL DEFAULT 0,
    "product_settled_at" timestamp without time zone,
    "product_settlement_id" uuid,
    "payment_status" enum_work_orders_payment_status DEFAULT 'pending'::enum_work_orders_payment_status,
    "payment_history" jsonb DEFAULT '[]'::jsonb,
    "quality_checklist" jsonb NOT NULL DEFAULT '{"limpieza_final": false, "torques_finales": false, "entrega_repuestos": false}'::jsonb,
    "quote_sale_id" uuid
);

-- ── CONSTRAINTS (PK, FK, UNIQUE, CHECK) ────────────────────

ALTER TABLE audit_logs ADD CONSTRAINT "audit_logs_pkey" PRIMARY KEY (id);
ALTER TABLE audit_logs ADD CONSTRAINT "audit_logs_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES "public"."tenants"(id);
ALTER TABLE audit_logs ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY (user_id) REFERENCES "public"."users"(id);
ALTER TABLE commission_settlement_items ADD CONSTRAINT "commission_settlement_items_pkey" PRIMARY KEY (id);
ALTER TABLE commission_settlement_items ADD CONSTRAINT "commission_settlement_items_sale_id_fkey" FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE SET NULL;
ALTER TABLE commission_settlement_items ADD CONSTRAINT "commission_settlement_items_settlement_id_fkey" FOREIGN KEY (settlement_id) REFERENCES commission_settlements(id) ON DELETE CASCADE;
ALTER TABLE commission_settlement_items ADD CONSTRAINT "commission_settlement_items_work_order_id_fkey" FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE RESTRICT;
ALTER TABLE commission_settlements ADD CONSTRAINT "commission_settlements_pkey" PRIMARY KEY (id);
ALTER TABLE commission_settlements ADD CONSTRAINT "commission_settlements_created_by_fkey" FOREIGN KEY (created_by) REFERENCES "public"."users"(id);
ALTER TABLE commission_settlements ADD CONSTRAINT "commission_settlements_technician_id_fkey" FOREIGN KEY (technician_id) REFERENCES "public"."users"(id) ON DELETE RESTRICT;
ALTER TABLE commission_settlements ADD CONSTRAINT "commission_settlements_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES "public"."tenants"(id) ON DELETE CASCADE;
ALTER TABLE customer_price_lists ADD CONSTRAINT "customer_price_lists_pkey" PRIMARY KEY (id);
ALTER TABLE customer_price_lists ADD CONSTRAINT "tenant_customer_price_list_unique" UNIQUE (tenant_id, customer_id, price_list_id);
ALTER TABLE customer_price_lists ADD CONSTRAINT "customer_price_lists_assigned_by_fkey" FOREIGN KEY (assigned_by) REFERENCES "public"."users"(id);
ALTER TABLE customer_price_lists ADD CONSTRAINT "customer_price_lists_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;
ALTER TABLE customer_price_lists ADD CONSTRAINT "customer_price_lists_price_list_id_fkey" FOREIGN KEY (price_list_id) REFERENCES price_lists(id) ON DELETE CASCADE;
ALTER TABLE customer_price_lists ADD CONSTRAINT "customer_price_lists_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES "public"."tenants"(id) ON DELETE CASCADE;
ALTER TABLE customers ADD CONSTRAINT "customers_pkey" PRIMARY KEY (id);
ALTER TABLE customers ADD CONSTRAINT "customers_default_price_list_id_fkey" FOREIGN KEY (default_price_list_id) REFERENCES price_lists(id) ON DELETE SET NULL;
ALTER TABLE customers ADD CONSTRAINT "customers_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES "public"."tenants"(id) ON DELETE CASCADE;
ALTER TABLE customers ADD CONSTRAINT "customers_customer_type_check" CHECK (((customer_type)::text = ANY (ARRAY[('individual'::character varying)::text, ('company'::character varying)::text])));
ALTER TABLE dian_events ADD CONSTRAINT "dian_events_pkey" PRIMARY KEY (id);
ALTER TABLE dian_events ADD CONSTRAINT "dian_events_sale_id_fkey" FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE SET NULL;
ALTER TABLE dian_events ADD CONSTRAINT "dian_events_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES "public"."tenants"(id) ON DELETE CASCADE;
ALTER TABLE dian_resolutions ADD CONSTRAINT "dian_resolutions_pkey" PRIMARY KEY (id);
ALTER TABLE dian_resolutions ADD CONSTRAINT "dian_resolutions_branch_id_fkey" FOREIGN KEY (branch_id) REFERENCES branches(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE dian_resolutions ADD CONSTRAINT "dian_resolutions_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES "public"."tenants"(id) ON DELETE CASCADE;
ALTER TABLE dian_resolutions ADD CONSTRAINT "dian_resolutions_document_type_check" CHECK (((document_type)::text = ANY ((ARRAY['invoice'::character varying, 'credit_note'::character varying, 'debit_note'::character varying])::text[])));
ALTER TABLE inventory_adjustment_items ADD CONSTRAINT "inventory_adjustment_items_pkey" PRIMARY KEY (id);
ALTER TABLE inventory_adjustment_items ADD CONSTRAINT "inventory_adjustment_items_adjustment_id_fkey" FOREIGN KEY (adjustment_id) REFERENCES inventory_adjustments(id) ON DELETE CASCADE;
ALTER TABLE inventory_adjustment_items ADD CONSTRAINT "inventory_adjustment_items_product_id_fkey" FOREIGN KEY (product_id) REFERENCES products(id);
ALTER TABLE inventory_adjustments ADD CONSTRAINT "inventory_adjustments_pkey" PRIMARY KEY (id);
ALTER TABLE inventory_adjustments ADD CONSTRAINT "unique_adjustment_number" UNIQUE (tenant_id, adjustment_number);
ALTER TABLE inventory_adjustments ADD CONSTRAINT "inventory_adjustments_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES "public"."tenants"(id);
ALTER TABLE inventory_adjustments ADD CONSTRAINT "inventory_adjustments_user_id_fkey" FOREIGN KEY (user_id) REFERENCES "public"."users"(id);
ALTER TABLE inventory_adjustments ADD CONSTRAINT "inventory_adjustments_adjustment_type_check" CHECK (((adjustment_type)::text = ANY (ARRAY[('entrada'::character varying)::text, ('salida'::character varying)::text])));
ALTER TABLE inventory_adjustments ADD CONSTRAINT "inventory_adjustments_status_check" CHECK (((status)::text = ANY (ARRAY[('draft'::character varying)::text, ('confirmed'::character varying)::text, ('cancelled'::character varying)::text])));
ALTER TABLE invoices ADD CONSTRAINT "invoices_pkey" PRIMARY KEY (id);
ALTER TABLE invoices ADD CONSTRAINT "invoices_tenant_number_unique" UNIQUE (tenant_id, invoice_number);
ALTER TABLE invoices ADD CONSTRAINT "invoices_created_by_fkey" FOREIGN KEY (created_by) REFERENCES "public"."users"(id);
ALTER TABLE invoices ADD CONSTRAINT "invoices_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES "public"."tenants"(id) ON DELETE CASCADE;
ALTER TABLE invoices ADD CONSTRAINT "invoices_status_check" CHECK (((status)::text = ANY (ARRAY[('draft'::character varying)::text, ('issued'::character varying)::text, ('paid'::character varying)::text, ('partial'::character varying)::text, ('overdue'::character varying)::text, ('cancelled'::character varying)::text])));
ALTER TABLE price_list_categories ADD CONSTRAINT "price_list_categories_pkey" PRIMARY KEY (id);
ALTER TABLE price_list_categories ADD CONSTRAINT "tenant_price_list_category_unique" UNIQUE (tenant_id, price_list_id, category_id);
ALTER TABLE price_list_categories ADD CONSTRAINT "price_list_categories_category_id_fkey" FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE;
ALTER TABLE price_list_categories ADD CONSTRAINT "price_list_categories_price_list_id_fkey" FOREIGN KEY (price_list_id) REFERENCES price_lists(id) ON DELETE CASCADE;
ALTER TABLE price_list_categories ADD CONSTRAINT "price_list_categories_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES "public"."tenants"(id) ON DELETE CASCADE;
ALTER TABLE price_lists ADD CONSTRAINT "price_lists_pkey" PRIMARY KEY (id);
ALTER TABLE price_lists ADD CONSTRAINT "tenant_price_list_code_unique" UNIQUE (tenant_id, code);
ALTER TABLE price_lists ADD CONSTRAINT "price_lists_base_price_list_id_fkey" FOREIGN KEY (base_price_list_id) REFERENCES price_lists(id) ON DELETE SET NULL;
ALTER TABLE price_lists ADD CONSTRAINT "price_lists_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES "public"."tenants"(id) ON DELETE CASCADE;
ALTER TABLE price_lists ADD CONSTRAINT "price_lists_applies_to_check" CHECK (((applies_to)::text = ANY (ARRAY[('all'::character varying)::text, ('selected_products'::character varying)::text, ('selected_categories'::character varying)::text])));
ALTER TABLE price_lists ADD CONSTRAINT "price_lists_margin_type_check" CHECK (((margin_type)::text = ANY (ARRAY[('markup'::character varying)::text, ('markdown'::character varying)::text])));
ALTER TABLE product_prices ADD CONSTRAINT "product_prices_pkey" PRIMARY KEY (id);
ALTER TABLE product_prices ADD CONSTRAINT "tenant_product_price_list_unique" UNIQUE (tenant_id, product_id, price_list_id);
ALTER TABLE product_prices ADD CONSTRAINT "product_prices_last_updated_by_fkey" FOREIGN KEY (last_updated_by) REFERENCES "public"."users"(id);
ALTER TABLE product_prices ADD CONSTRAINT "product_prices_price_list_id_fkey" FOREIGN KEY (price_list_id) REFERENCES price_lists(id) ON DELETE CASCADE;
ALTER TABLE product_prices ADD CONSTRAINT "product_prices_product_id_fkey" FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE;
ALTER TABLE product_prices ADD CONSTRAINT "product_prices_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES "public"."tenants"(id) ON DELETE CASCADE;
ALTER TABLE product_prices ADD CONSTRAINT "product_prices_price_source_check" CHECK (((price_source)::text = ANY (ARRAY[('manual'::character varying)::text, ('auto_margin'::character varying)::text, ('auto_markdown'::character varying)::text, ('import'::character varying)::text])));
ALTER TABLE purchase_details ADD CONSTRAINT "purchase_details_pkey" PRIMARY KEY (id);
ALTER TABLE purchase_details ADD CONSTRAINT "purchase_details_product_id_fkey" FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT;
ALTER TABLE purchase_details ADD CONSTRAINT "purchase_details_purchase_id_fkey" FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON DELETE CASCADE;
ALTER TABLE purchase_details ADD CONSTRAINT "purchase_details_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES "public"."tenants"(id) ON DELETE CASCADE;
ALTER TABLE sale_items ADD CONSTRAINT "sale_items_pkey" PRIMARY KEY (id);
ALTER TABLE sale_items ADD CONSTRAINT "sale_items_product_id_fkey" FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT;
ALTER TABLE sale_items ADD CONSTRAINT "sale_items_sale_id_fkey" FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE;
ALTER TABLE sale_items ADD CONSTRAINT "sale_items_technician_id_fkey" FOREIGN KEY (technician_id) REFERENCES "public"."users"(id) ON DELETE SET NULL;
ALTER TABLE sale_items ADD CONSTRAINT "sale_items_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES "public"."tenants"(id) ON DELETE CASCADE;
ALTER TABLE sales ADD CONSTRAINT "sales_pkey" PRIMARY KEY (id);
ALTER TABLE sales ADD CONSTRAINT "tenant_sale_number_unique" UNIQUE (tenant_id, sale_number);
ALTER TABLE sales ADD CONSTRAINT "sales_branch_id_fkey" FOREIGN KEY (branch_id) REFERENCES branches(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE sales ADD CONSTRAINT "sales_converted_to_work_order_id_fkey" FOREIGN KEY (converted_to_work_order_id) REFERENCES work_orders(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE sales ADD CONSTRAINT "sales_created_by_fkey" FOREIGN KEY (created_by) REFERENCES "public"."users"(id);
ALTER TABLE sales ADD CONSTRAINT "sales_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE sales ADD CONSTRAINT "sales_technician_id_fkey" FOREIGN KEY (technician_id) REFERENCES "public"."users"(id) ON DELETE SET NULL;
ALTER TABLE sales ADD CONSTRAINT "sales_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES "public"."tenants"(id) ON DELETE CASCADE;
ALTER TABLE sales ADD CONSTRAINT "sales_warehouse_id_fkey" FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE RESTRICT;
ALTER TABLE vehicles ADD CONSTRAINT "vehicles_pkey" PRIMARY KEY (id);
ALTER TABLE vehicles ADD CONSTRAINT "vehicles_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE vehicles ADD CONSTRAINT "vehicles_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES "public"."tenants"(id);
ALTER TABLE vehicles ADD CONSTRAINT "vehicles_fuel_type_check" CHECK (((fuel_type)::text = ANY ((ARRAY['gasolina'::character varying, 'diesel'::character varying, 'gas'::character varying, 'hibrido'::character varying, 'electrico'::character varying, 'otro'::character varying])::text[])));
ALTER TABLE work_order_items ADD CONSTRAINT "work_order_items_pkey" PRIMARY KEY (id);
ALTER TABLE work_order_items ADD CONSTRAINT "work_order_items_product_id_fkey" FOREIGN KEY (product_id) REFERENCES products(id);
ALTER TABLE work_order_items ADD CONSTRAINT "work_order_items_quote_request_id_fkey" FOREIGN KEY (quote_request_id) REFERENCES work_order_quote_requests(id) ON DELETE SET NULL;
ALTER TABLE work_order_items ADD CONSTRAINT "work_order_items_technician_id_fkey" FOREIGN KEY (technician_id) REFERENCES "public"."users"(id) ON DELETE SET NULL;
ALTER TABLE work_order_items ADD CONSTRAINT "work_order_items_work_order_id_fkey" FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE CASCADE;
ALTER TABLE work_order_items ADD CONSTRAINT "work_order_items_approval_status_check" CHECK (((approval_status)::text = ANY ((ARRAY['pendiente'::character varying, 'aprobado'::character varying, 'rechazado'::character varying])::text[])));
ALTER TABLE work_order_items ADD CONSTRAINT "work_order_items_item_type_check" CHECK (((item_type)::text = ANY ((ARRAY['repuesto'::character varying, 'servicio'::character varying, 'mano_obra'::character varying, 'free_line'::character varying])::text[])));
ALTER TABLE work_orders ADD CONSTRAINT "work_orders_pkey" PRIMARY KEY (id);
ALTER TABLE work_orders ADD CONSTRAINT "work_orders_share_token_key" UNIQUE (share_token);
ALTER TABLE work_orders ADD CONSTRAINT "work_orders_tenant_id_order_number_key" UNIQUE (tenant_id, order_number);
ALTER TABLE work_orders ADD CONSTRAINT "work_orders_created_by_fkey" FOREIGN KEY (created_by) REFERENCES "public"."users"(id) ON DELETE SET NULL;
ALTER TABLE work_orders ADD CONSTRAINT "work_orders_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE work_orders ADD CONSTRAINT "work_orders_quote_sale_id_fkey" FOREIGN KEY (quote_sale_id) REFERENCES sales(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE work_orders ADD CONSTRAINT "work_orders_sale_id_fkey" FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE SET NULL;
ALTER TABLE work_orders ADD CONSTRAINT "work_orders_settlement_id_fkey" FOREIGN KEY (settlement_id) REFERENCES commission_settlements(id) ON DELETE SET NULL;
ALTER TABLE work_orders ADD CONSTRAINT "work_orders_technician_id_fkey" FOREIGN KEY (technician_id) REFERENCES "public"."users"(id) ON DELETE SET NULL;
ALTER TABLE work_orders ADD CONSTRAINT "work_orders_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES "public"."tenants"(id);
ALTER TABLE work_orders ADD CONSTRAINT "work_orders_vehicle_id_fkey" FOREIGN KEY (vehicle_id) REFERENCES vehicles(id);
ALTER TABLE work_orders ADD CONSTRAINT "work_orders_warehouse_id_fkey" FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE SET NULL;
ALTER TABLE work_orders ADD CONSTRAINT "work_orders_status_check" CHECK (((status)::text = ANY ((ARRAY['recibido'::character varying, 'en_proceso'::character varying, 'en_espera'::character varying, 'listo'::character varying, 'entregado'::character varying, 'cancelado'::character varying])::text[])));

-- ── ÍNDICES ─────────────────────────────────────────────────

CREATE INDEX idx_audit_logs_entity ON audit_logs USING btree (entity, entity_id);
CREATE INDEX idx_audit_logs_tenant ON audit_logs USING btree (tenant_id);
CREATE INDEX idx_audit_logs_user ON audit_logs USING btree (user_id);
CREATE INDEX idx_commission_items_settlement ON commission_settlement_items USING btree (settlement_id);
CREATE INDEX idx_commission_items_wo ON commission_settlement_items USING btree (work_order_id);
CREATE INDEX idx_csi_sale ON commission_settlement_items USING btree (sale_id);
CREATE INDEX idx_commission_settlements_tech ON commission_settlements USING btree (technician_id);
CREATE INDEX idx_commission_settlements_tenant ON commission_settlements USING btree (tenant_id);
CREATE INDEX idx_customer_price_lists_active ON customer_price_lists USING btree (is_active);
CREATE INDEX idx_customer_price_lists_customer ON customer_price_lists USING btree (customer_id);
CREATE INDEX idx_customer_price_lists_price_list ON customer_price_lists USING btree (price_list_id);
CREATE INDEX idx_customer_price_lists_tenant ON customer_price_lists USING btree (tenant_id);
CREATE INDEX idx_customers_active ON customers USING btree (tenant_id, is_active);
CREATE INDEX idx_customers_price_list ON customers USING btree (default_price_list_id);
CREATE INDEX idx_customers_tenant ON customers USING btree (tenant_id);
CREATE INDEX idx_dian_events_sale ON dian_events USING btree (sale_id);
CREATE INDEX idx_dian_events_tenant ON dian_events USING btree (tenant_id);
CREATE INDEX idx_dian_resolutions_tenant ON dian_resolutions USING btree (tenant_id);
CREATE INDEX idx_adjustment_items_adjustment ON inventory_adjustment_items USING btree (adjustment_id);
CREATE INDEX idx_adjustment_items_product ON inventory_adjustment_items USING btree (product_id);
CREATE INDEX idx_adjustments_date ON inventory_adjustments USING btree (adjustment_date);
CREATE INDEX idx_adjustments_status ON inventory_adjustments USING btree (status);
CREATE INDEX idx_adjustments_tenant ON inventory_adjustments USING btree (tenant_id);
CREATE INDEX idx_invoices_created_by ON invoices USING btree (created_by);
CREATE INDEX idx_invoices_tenant ON invoices USING btree (tenant_id);
CREATE INDEX idx_invoices_tenant_date ON invoices USING btree (tenant_id, issue_date);
CREATE INDEX idx_invoices_tenant_status ON invoices USING btree (tenant_id, status);
CREATE INDEX idx_price_list_categories_category ON price_list_categories USING btree (category_id);
CREATE INDEX idx_price_list_categories_price_list ON price_list_categories USING btree (price_list_id);
CREATE INDEX idx_price_lists_active ON price_lists USING btree (tenant_id, is_active);
CREATE INDEX idx_price_lists_default ON price_lists USING btree (tenant_id, is_default);
CREATE INDEX idx_price_lists_priority ON price_lists USING btree (priority);
CREATE INDEX idx_price_lists_tenant ON price_lists USING btree (tenant_id);
CREATE INDEX idx_product_prices_price_list ON product_prices USING btree (price_list_id);
CREATE INDEX idx_product_prices_product ON product_prices USING btree (product_id);
CREATE INDEX idx_product_prices_tenant ON product_prices USING btree (tenant_id);
CREATE INDEX idx_product_prices_validity ON product_prices USING btree (valid_from, valid_until);
CREATE INDEX idx_purchase_details_product ON purchase_details USING btree (product_id);
CREATE INDEX idx_purchase_details_purchase ON purchase_details USING btree (purchase_id);
CREATE INDEX idx_purchase_details_tenant ON purchase_details USING btree (tenant_id);
CREATE INDEX idx_sale_items_product ON sale_items USING btree (product_id);
CREATE INDEX idx_sale_items_sale ON sale_items USING btree (sale_id);
CREATE INDEX idx_sale_items_technician_id ON sale_items USING btree (technician_id);
CREATE INDEX idx_sale_items_tenant ON sale_items USING btree (tenant_id);
CREATE INDEX idx_sales_customer ON sales USING btree (customer_id);
CREATE INDEX idx_sales_date ON sales USING btree (sale_date DESC);
CREATE INDEX idx_sales_dian_status ON sales USING btree (tenant_id, dian_status);
CREATE INDEX idx_sales_document_type ON sales USING btree (tenant_id, document_type);
CREATE INDEX idx_sales_due_date ON sales USING btree (tenant_id, due_date) WHERE (payment_status = ANY (ARRAY['pending'::enum_sales_payment_status, 'partial'::enum_sales_payment_status]));
CREATE INDEX idx_sales_labor_settled ON sales USING btree (labor_settled_at);
CREATE INDEX idx_sales_number ON sales USING btree (sale_number);
CREATE INDEX idx_sales_product_settled ON sales USING btree (product_settled_at);
CREATE INDEX idx_sales_status ON sales USING btree (tenant_id, status);
CREATE INDEX idx_sales_technician_id ON sales USING btree (technician_id);
CREATE INDEX idx_sales_tenant ON sales USING btree (tenant_id);
CREATE INDEX idx_sales_tenant_status ON sales USING btree (tenant_id, status);
CREATE INDEX idx_sales_vehicle_plate ON sales USING btree (vehicle_plate) WHERE (vehicle_plate IS NOT NULL);
CREATE INDEX idx_vehicles_customer ON vehicles USING btree (customer_id);
CREATE INDEX idx_vehicles_plate ON vehicles USING btree (tenant_id, plate);
CREATE INDEX idx_vehicles_tenant ON vehicles USING btree (tenant_id);
CREATE INDEX vehicles_tenant_vehicle_type_idx ON vehicles USING btree (tenant_id, vehicle_type);
CREATE INDEX idx_work_order_items_order ON work_order_items USING btree (work_order_id);
CREATE INDEX idx_work_order_items_product ON work_order_items USING btree (product_id);
CREATE INDEX idx_work_order_items_technician_id ON work_order_items USING btree (technician_id);
CREATE INDEX work_order_items_quote_request_idx ON work_order_items USING btree (quote_request_id);
CREATE INDEX idx_work_orders_customer ON work_orders USING btree (customer_id);
CREATE INDEX idx_work_orders_share_token ON work_orders USING btree (share_token);
CREATE INDEX idx_work_orders_tenant_status ON work_orders USING btree (tenant_id, status);
CREATE INDEX idx_work_orders_vehicle ON work_orders USING btree (vehicle_id);
`;

const SQL_DOWN = `
DROP TABLE IF EXISTS work_orders CASCADE;
DROP TABLE IF EXISTS work_order_items CASCADE;
DROP TABLE IF EXISTS vehicles CASCADE;
DROP TABLE IF EXISTS sales CASCADE;
DROP TABLE IF EXISTS sale_items CASCADE;
DROP TABLE IF EXISTS purchase_details CASCADE;
DROP TABLE IF EXISTS product_prices CASCADE;
DROP TABLE IF EXISTS price_lists CASCADE;
DROP TABLE IF EXISTS price_list_categories CASCADE;
DROP TABLE IF EXISTS invoices CASCADE;
DROP TABLE IF EXISTS inventory_adjustments CASCADE;
DROP TABLE IF EXISTS inventory_adjustment_items CASCADE;
DROP TABLE IF EXISTS dian_resolutions CASCADE;
DROP TABLE IF EXISTS dian_events CASCADE;
DROP TABLE IF EXISTS customers CASCADE;
DROP TABLE IF EXISTS customer_price_lists CASCADE;
DROP TABLE IF EXISTS commission_settlements CASCADE;
DROP TABLE IF EXISTS commission_settlement_items CASCADE;
DROP TABLE IF EXISTS audit_logs CASCADE;

DROP TYPE IF EXISTS enum_vehicles_vehicle_type;
DROP TYPE IF EXISTS enum_work_orders_payment_status;
DROP TYPE IF EXISTS enum_sales_payment_status;
DROP TYPE IF EXISTS enum_sales_status;
DROP TYPE IF EXISTS enum_sales_document_type;
`;

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(SQL_UP);
  },
  down: async (queryInterface) => {
    await queryInterface.sequelize.query(SQL_DOWN);
  },
};