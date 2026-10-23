'use strict';

// products.last_purchase_cost / last_purchase_date existían en la tabla desde
// el baseline, pero el modelo Product no los declaraba: el update que hacía
// receivePurchase se descartaba en silencio y la columna quedó en 0 en todos
// los productos. Ahora que el modelo los mapea, se rellenan desde la compra
// recibida más reciente de cada producto, con el mismo costo aterrizado que
// usa resolveLandedPurchaseUnitCost (descuento global y flete prorrateados
// según el peso de la línea en el subtotal de la compra).
//
// Sin calificar con esquema: migrateAllTenantSchemas corre esto con el
// search_path de cada tenant. Solo toca productos que sigan en 0/NULL.

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE products ADD COLUMN IF NOT EXISTS last_purchase_cost DECIMAL(15,4) DEFAULT 0;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS last_purchase_date DATE;
    `);

    await queryInterface.sequelize.query(`
      UPDATE products p
         SET last_purchase_cost = x.cost,
             last_purchase_date = x.purchase_date
        FROM (
          SELECT DISTINCT ON (pi.product_id)
                 pi.product_id,
                 pu.purchase_date::date AS purchase_date,
                 CASE
                   WHEN COALESCE(pi.quantity, 0) <= 0 THEN pi.unit_cost
                   WHEN COALESCE(pu.subtotal, 0) <= 0
                     OR (COALESCE(pu.discount_amount, 0) = 0 AND COALESCE(pu.shipping_cost, 0) = 0)
                     THEN pi.subtotal / pi.quantity
                   ELSE (pi.subtotal
                         - COALESCE(pu.discount_amount, 0) * pi.subtotal / pu.subtotal
                         + COALESCE(pu.shipping_cost, 0)   * pi.subtotal / pu.subtotal) / pi.quantity
                 END AS cost
            FROM purchase_items pi
            JOIN purchases pu ON pu.id = pi.purchase_id
           WHERE COALESCE(pi.received_quantity, 0) > 0
           ORDER BY pi.product_id, pu.purchase_date DESC, pu.created_at DESC
        ) x
       WHERE p.id = x.product_id
         AND COALESCE(p.last_purchase_cost, 0) = 0
         AND x.cost > 0
    `);
  },

  async down() {
    // Las columnas son del baseline; no se revierte el backfill.
  },
};
