'use strict';

// Facturar remisiones ya confirmadas (incluso pagadas), si el tenant lo
// habilitó (features.allow_remision_to_invoice). Ver
// services/sales/remisionInvoicing.service.js.
//
// - Conversión individual: la misma venta pasa de remisión a factura;
//   remision_number guarda el REM-XXXX original.
// - Agrupación: se crea una factura nueva (is_consolidated_invoice) y cada
//   remisión apunta a ella con invoiced_in_sale_id. Esa factura es solo el
//   documento fiscal: pagos, cartera, kardex y asientos siguen en las
//   remisiones.
//
// SQL crudo sin calificar `sales` a propósito: la migración corre también
// dentro del search_path de cada schema de tenant, y la FK a sales tiene que
// quedar en el mismo schema. `users` vive siempre en public.

module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS remision_number VARCHAR(50)`);
    await q(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS converted_to_invoice_at TIMESTAMPTZ`);
    await q(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS converted_to_invoice_by UUID REFERENCES public.users(id) ON DELETE SET NULL ON UPDATE CASCADE`);
    await q(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS is_consolidated_invoice BOOLEAN NOT NULL DEFAULT FALSE`);
    await q(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS invoiced_in_sale_id UUID REFERENCES sales(id) ON DELETE SET NULL ON UPDATE CASCADE`);
    await q(`CREATE INDEX IF NOT EXISTS sales_invoiced_in_sale_id ON sales (invoiced_in_sale_id) WHERE invoiced_in_sale_id IS NOT NULL`);
  },

  async down(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`DROP INDEX IF EXISTS sales_invoiced_in_sale_id`);
    await q(`ALTER TABLE sales DROP COLUMN IF EXISTS invoiced_in_sale_id`);
    await q(`ALTER TABLE sales DROP COLUMN IF EXISTS is_consolidated_invoice`);
    await q(`ALTER TABLE sales DROP COLUMN IF EXISTS converted_to_invoice_by`);
    await q(`ALTER TABLE sales DROP COLUMN IF EXISTS converted_to_invoice_at`);
    await q(`ALTER TABLE sales DROP COLUMN IF EXISTS remision_number`);
  },
};
