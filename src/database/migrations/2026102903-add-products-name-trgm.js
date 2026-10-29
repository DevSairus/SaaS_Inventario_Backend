'use strict';

// Trigram sobre products.name: la importación de facturas XML busca cada
// ítem por nombre aproximado (name ILIKE '%nombre%') y sin esto recorría la
// tabla completa de productos una vez por ítem. El índice de búsqueda de
// 2026102901 es sobre la expresión concatenada (nombre + sku + ...), no sirve
// para un filtro solo por nombre.
//
// Sin calificar con esquema (corre por tenant con su search_path); el
// operador de pg_trgm vive en public.
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      DO $$ BEGIN
        IF to_regclass('products') IS NOT NULL THEN
          CREATE INDEX IF NOT EXISTS idx_products_name_trgm ON products USING gin (name public.gin_trgm_ops);
        END IF;
      END $$
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS idx_products_name_trgm`);
  },
};
