-- ============================================================
-- Migration: Taller — Links WhatsApp, Técnico por ítem y Liquidación
-- Created: 2026-05-01
-- ============================================================

-- 1. Garantizar que work_orders.share_token existe (ya usada en código con raw queries)
ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS share_token VARCHAR(36) UNIQUE;

-- 2. Técnico responsable por ítem en OT
ALTER TABLE work_order_items
  ADD COLUMN IF NOT EXISTS technician_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_work_order_items_technician_id ON work_order_items(technician_id);

-- 3. Técnico responsable por ítem en Venta
ALTER TABLE sale_items
  ADD COLUMN IF NOT EXISTS technician_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sale_items_technician_id ON sale_items(technician_id);

-- 4. Detalle por producto en ítems de liquidación de comisiones de productos
ALTER TABLE product_commission_settlement_items
  ADD COLUMN IF NOT EXISTS product_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS product_sku  VARCHAR(50),
  ADD COLUMN IF NOT EXISTS quantity     DECIMAL(10,3),
  ADD COLUMN IF NOT EXISTS unit_price   DECIMAL(15,2);
