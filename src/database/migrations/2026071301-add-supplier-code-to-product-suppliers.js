'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.sequelize.query(`
        ALTER TABLE product_suppliers
          ADD COLUMN IF NOT EXISTS supplier_code VARCHAR(100),
          ADD COLUMN IF NOT EXISTS supplier_description VARCHAR(255);
      `, { transaction });

      // Lookup rápido: tenant + proveedor + código → producto.
      // Parcial (WHERE supplier_code IS NOT NULL) porque los registros viejos,
      // creados solo al confirmar compra, no tienen código todavía.
      await queryInterface.sequelize.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS product_suppliers_tenant_supplier_code_unique
        ON product_suppliers (tenant_id, supplier_id, supplier_code)
        WHERE supplier_code IS NOT NULL;
      `, { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS product_suppliers_tenant_supplier_code_unique;
    `);
    await queryInterface.removeColumn('product_suppliers', 'supplier_code');
    await queryInterface.removeColumn('product_suppliers', 'supplier_description');
  },
};
