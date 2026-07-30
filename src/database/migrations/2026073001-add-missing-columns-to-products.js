'use strict';

// El baseline de schema-per-tenant (20260101000000-baseline-core-inventory-tables.js)
// quedó desalineado con `public.products`: no incluye warehouse_id, base_price,
// has_tax, tax_percentage ni price_includes_tax. La razón documentada en
// migrateTenantData.js ("has_tax/tax_percentage/base_price -> tax_config") asumía
// que esas columnas ya estaban reemplazadas por tax_config en el código actual,
// pero eso no es así: Product.js, taxService.js, workOrders.controller.js,
// products.controller.js, invoiceImport.controller.js y movements.controller.js
// siguen leyendo/escribiendo estas 5 columnas directamente. Sin ellas, cualquier
// tenant cortado a su propio schema revienta al crear/editar productos, calcular
// impuestos de venta/OT, o marcar diagnósticos con producto sugerido
// ("no existe la columna suggested_product.base_price").

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS warehouse_id UUID`);
    await queryInterface.sequelize.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS base_price DECIMAL(15,2)`);
    await queryInterface.sequelize.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS has_tax BOOLEAN DEFAULT true`);
    await queryInterface.sequelize.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS tax_percentage DECIMAL(5,2) DEFAULT 19`);
    await queryInterface.sequelize.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS price_includes_tax BOOLEAN DEFAULT false`);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`ALTER TABLE products DROP COLUMN IF EXISTS price_includes_tax`);
    await queryInterface.sequelize.query(`ALTER TABLE products DROP COLUMN IF EXISTS tax_percentage`);
    await queryInterface.sequelize.query(`ALTER TABLE products DROP COLUMN IF EXISTS has_tax`);
    await queryInterface.sequelize.query(`ALTER TABLE products DROP COLUMN IF EXISTS base_price`);
    await queryInterface.sequelize.query(`ALTER TABLE products DROP COLUMN IF EXISTS warehouse_id`);
  },
};
