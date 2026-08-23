'use strict';

// Fase 2 del hallazgo "Ciudad/depto y tipo de identificación del comprador
// siempre caen a Bogotá/Cundinamarca y NIT/cédula fijos" (ver
// Hallazgos-Codificacion-DIAN-Ciudad-Impuestos.md).
//
// 1. `customers` gana `city_code` (DIVIPOLA, misma fuente de verdad que ya
//    usa el emisor en dian_config.city_code — ver DivipolaCitySelect) y
//    `document_type` (schemeID DIAN: 13=Cédula, 31=NIT, 22=Cédula
//    extranjería, 41=Pasaporte, 12=Tarjeta identidad, 91=NUIP, etc.).
//    `city`/`state` (ya existentes, antes texto libre sin uso real en el
//    formulario) pasan a poblarse como el nombre de ciudad/departamento
//    que devuelve el mismo selector, en vez de texto libre suelto.
//
// 2. `sales` gana la denormalización análoga a customer_address/
//    customer_tax_id: customer_city_code, customer_city_name,
//    customer_department_name, customer_document_type — así una factura
//    ya enviada a la DIAN conserva los datos con los que se transmitió
//    aunque el cliente cambie de ciudad después.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      // Ver nota en 2026082001-add-brand-vehicle-support-to-products.js:
      // provisionTenantSchema.js corre las migraciones con un pool de una
      // sola conexión -- toda query acá debe llevar { transaction }.
      await queryInterface.sequelize.query(`
        ALTER TABLE customers
          ADD COLUMN IF NOT EXISTS city_code VARCHAR(5),
          ADD COLUMN IF NOT EXISTS document_type VARCHAR(4) DEFAULT '13';
      `, { transaction });

      // Backfill: clientes existentes tipo 'company' deberían quedar en NIT
      // (31) en vez del default genérico '13' recién creado. Ciudad/depto
      // de clientes existentes queda pendiente (Fase 4, sin código DIVIPOLA
      // asignable automáticamente desde el texto libre de `city`/`state`).
      await queryInterface.sequelize.query(`
        UPDATE customers SET document_type = '31'
        WHERE customer_type = 'company' AND (document_type IS NULL OR document_type = '13');
      `, { transaction });

      await queryInterface.sequelize.query(`
        ALTER TABLE sales
          ADD COLUMN IF NOT EXISTS customer_city_code VARCHAR(5),
          ADD COLUMN IF NOT EXISTS customer_city_name VARCHAR(100),
          ADD COLUMN IF NOT EXISTS customer_department_name VARCHAR(100),
          ADD COLUMN IF NOT EXISTS customer_document_type VARCHAR(4);
      `, { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      ALTER TABLE sales
        DROP COLUMN IF EXISTS customer_city_code,
        DROP COLUMN IF EXISTS customer_city_name,
        DROP COLUMN IF EXISTS customer_department_name,
        DROP COLUMN IF EXISTS customer_document_type;
    `);
    await queryInterface.sequelize.query(`
      ALTER TABLE customers
        DROP COLUMN IF EXISTS city_code,
        DROP COLUMN IF EXISTS document_type;
    `);
  },
};
