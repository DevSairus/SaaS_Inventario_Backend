'use strict';

// Permite registrar un producto de tipo 'vehicle' (stock de concesionario)
// vinculado 1:1 a una fila real de `vehicles` -- así el vehículo queda
// disponible también en el módulo de Taller/CRM, no solo como línea de
// inventario. `brand` ya existía en la tabla desde el baseline pero nunca
// se declaró en el modelo Sequelize, así que Product.create/update la
// descartaba en silencio (ver Product.js) -- no requiere columna nueva.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      // OJO: provisionTenantSchema.js corre esto con un pool de UNA sola
      // conexión (max: 1) -- toda query acá debe llevar { transaction },
      // si no Sequelize intenta abrir una segunda conexión mientras la
      // primera sigue ocupada por la transacción abierta y se queda
      // esperando un slot de pool que nunca se libera (deadlock silencioso
      // que Umzug reporta como "Operation timeout"). Por la misma razón se
      // evita queryInterface.describeTable(): arma una subconsulta de
      // comentarios de columna sin filtrar por schema, y con muchos tenants
      // (todos con una tabla `products`) puede devolver "más de un registro"
      // si dos schemas distintos tienen una columna comentada en la misma
      // posición ordinal. ADD COLUMN IF NOT EXISTS es idempotente igual.
      await queryInterface.sequelize.query(`
        ALTER TABLE products
          ADD COLUMN IF NOT EXISTS vehicle_id UUID REFERENCES vehicles(id) ON DELETE SET NULL;
      `, { transaction });

      // Un vehículo no puede ser el stock de dos productos distintos.
      await queryInterface.sequelize.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS products_vehicle_id_unique
        ON products (vehicle_id) WHERE vehicle_id IS NOT NULL;
      `, { transaction });

      // Dato legacy: filas con product_type='product' (valor previo a que el
      // CHECK se endureciera, nunca limpiado en `public` -- ver el mismo caso
      // en migrateTenantData.js) violarían el CHECK nuevo. Se normalizan a
      // 'simple' igual que en esa migración de datos, en cualquier schema
      // donde corra esta migración.
      await queryInterface.sequelize.query(`
        UPDATE products SET product_type = 'simple' WHERE product_type = 'product';
      `, { transaction });

      await queryInterface.sequelize.query(`
        ALTER TABLE products DROP CONSTRAINT IF EXISTS products_product_type_check;
        ALTER TABLE products ADD CONSTRAINT products_product_type_check
          CHECK (product_type IN ('simple', 'variant', 'service', 'bundle', 'raw_material', 'vehicle'));
      `, { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      ALTER TABLE products DROP CONSTRAINT IF EXISTS products_product_type_check;
      ALTER TABLE products ADD CONSTRAINT products_product_type_check
        CHECK (product_type IN ('simple', 'variant', 'service', 'bundle', 'raw_material'));
    `);
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS products_vehicle_id_unique;`);
    await queryInterface.removeColumn('products', 'vehicle_id');
  },
};
