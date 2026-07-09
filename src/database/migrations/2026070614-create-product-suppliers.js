'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.sequelize.query(`
        CREATE TABLE IF NOT EXISTS product_suppliers (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE ON UPDATE CASCADE,
          product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE ON UPDATE CASCADE,
          supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE ON UPDATE CASCADE,
          last_price DECIMAL(15,2),
          last_purchase_date TIMESTAMP WITH TIME ZONE,
          lead_time_days INTEGER,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      `, { transaction });

      await queryInterface.sequelize.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS product_suppliers_product_supplier_unique
        ON product_suppliers (product_id, supplier_id);
      `, { transaction });

      await queryInterface.sequelize.query(`
        CREATE INDEX IF NOT EXISTS product_suppliers_tenant_id_idx ON product_suppliers (tenant_id);
      `, { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('product_suppliers');
  },
};
