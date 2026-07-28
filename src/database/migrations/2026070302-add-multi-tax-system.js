'use strict';

module.exports = {
  async up(queryInterface, Sequelize, context) {
    const q = queryInterface.sequelize;

    // ═══ TENANT ═══
    await q.query(`ALTER TABLE "public"."tenants" ADD COLUMN IF NOT EXISTS tax_config JSONB DEFAULT '{}'`);

    // ═══ CUSTOMER ═══
    await q.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS retention_config JSONB DEFAULT '{}'`);

    // ═══ SUPPLIER ═══
    await q.query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS retention_config JSONB DEFAULT '{}'`);

    // ═══ PRODUCT ═══
    await q.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS tax_config JSONB DEFAULT '{}'`);

    // Migrar datos existentes de Product a tax_config -- solo aplica a
    // schemas que todavía tengan las columnas legacy has_tax/tax_percentage
    // (schemas nuevos aprovisionados desde el baseline nunca las tuvieron).
    // describeTable() cae a "public" por defecto si no se le pasa schema
    // explícito (aunque el search_path de la conexión sea otro) -> hay que
    // pasarle el schema del tenant, o esto revisa las columnas de la tabla
    // equivocada (public.products en vez de la de este tenant).
    const productColumns = await queryInterface.describeTable('products', context?.schemaName ? { schema: context.schemaName } : undefined);
    if (productColumns.has_tax || productColumns.tax_percentage) {
      await q.query(`
        UPDATE products SET tax_config = jsonb_build_object(
          'iva', jsonb_build_object('enabled', COALESCE(has_tax, true), 'rate', COALESCE(tax_percentage, 19)),
          'inc', jsonb_build_object('enabled', false, 'rate', 0),
          'ica', jsonb_build_object('enabled', false, 'rate', 0)
        ) WHERE tax_config IS NULL OR tax_config = '{}'
      `);
    }

    // ═══ SALE ITEM ═══
    const saleItemCols = [
      { name: 'inc_rate', type: 'DECIMAL(5,2) DEFAULT 0' },
      { name: 'inc_amount', type: 'DECIMAL(15,2) DEFAULT 0' },
      { name: 'ica_rate', type: 'DECIMAL(5,4) DEFAULT 0' },
      { name: 'ica_amount', type: 'DECIMAL(15,2) DEFAULT 0' },
    ];
    for (const col of saleItemCols) {
      await q.query(`ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS "${col.name}" ${col.type}`).catch(() => {});
    }

    // ═══ SALE ═══
    const saleCols = [
      { name: 'retefuente_rate', type: 'DECIMAL(5,2) DEFAULT 0' },
      { name: 'retefuente_amount', type: 'DECIMAL(15,2) DEFAULT 0' },
      { name: 'reteiva_rate', type: 'DECIMAL(5,2) DEFAULT 0' },
      { name: 'reteiva_amount', type: 'DECIMAL(15,2) DEFAULT 0' },
      { name: 'reteica_rate', type: 'DECIMAL(5,4) DEFAULT 0' },
      { name: 'reteica_amount', type: 'DECIMAL(15,2) DEFAULT 0' },
      { name: 'total_retentions', type: 'DECIMAL(15,2) DEFAULT 0' },
      { name: 'tax_breakdown', type: "JSONB DEFAULT '[]'" },
    ];
    for (const col of saleCols) {
      await q.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS "${col.name}" ${col.type}`).catch(() => {});
    }

    // ═══ PURCHASE ITEM ═══
    const purchaseItemCols = [
      { name: 'inc_rate', type: 'DECIMAL(5,2) DEFAULT 0' },
      { name: 'inc_amount', type: 'DECIMAL(15,2) DEFAULT 0' },
      { name: 'ica_rate', type: 'DECIMAL(5,4) DEFAULT 0' },
      { name: 'ica_amount', type: 'DECIMAL(15,2) DEFAULT 0' },
    ];
    for (const col of purchaseItemCols) {
      await q.query(`ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS "${col.name}" ${col.type}`).catch(() => {});
    }

    // ═══ PURCHASE ═══
    const purchaseCols = [
      { name: 'retefuente_rate', type: 'DECIMAL(5,2) DEFAULT 0' },
      { name: 'retefuente_amount', type: 'DECIMAL(15,2) DEFAULT 0' },
      { name: 'reteiva_rate', type: 'DECIMAL(5,2) DEFAULT 0' },
      { name: 'reteiva_amount', type: 'DECIMAL(15,2) DEFAULT 0' },
      { name: 'reteica_rate', type: 'DECIMAL(5,4) DEFAULT 0' },
      { name: 'reteica_amount', type: 'DECIMAL(15,2) DEFAULT 0' },
      { name: 'total_retentions', type: 'DECIMAL(15,2) DEFAULT 0' },
    ];
    for (const col of purchaseCols) {
      await q.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS "${col.name}" ${col.type}`).catch(() => {});
    }

    console.log('[Migration] Sistema de impuestos multi-tipo aplicado');
  },

  async down(queryInterface, Sequelize) {
    const q = queryInterface.sequelize;
    const columns = ['retefuente_rate', 'retefuente_amount', 'reteiva_rate', 'reteiva_amount', 'reteica_rate', 'reteica_amount', 'total_retentions', 'tax_breakdown'];
    const itemCols = ['inc_rate', 'inc_amount', 'ica_rate', 'ica_amount'];

    for (const col of columns) {
      await q.query(`ALTER TABLE sales DROP COLUMN IF EXISTS "${col}"`);
      await q.query(`ALTER TABLE purchases DROP COLUMN IF EXISTS "${col}"`);
    }
    for (const col of itemCols) {
      await q.query(`ALTER TABLE sale_items DROP COLUMN IF EXISTS "${col}"`);
      await q.query(`ALTER TABLE purchase_items DROP COLUMN IF EXISTS "${col}"`);
    }
    await q.query(`ALTER TABLE "public"."tenants" DROP COLUMN IF EXISTS tax_config`);
    await q.query(`ALTER TABLE customers DROP COLUMN IF EXISTS retention_config`);
    await q.query(`ALTER TABLE suppliers DROP COLUMN IF EXISTS retention_config`);
    await q.query(`ALTER TABLE products DROP COLUMN IF EXISTS tax_config`);
  }
};
