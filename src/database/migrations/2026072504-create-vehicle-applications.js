'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.sequelize.query(`
        CREATE TABLE IF NOT EXISTS product_vehicle_applications (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE ON UPDATE CASCADE,
          product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE ON UPDATE CASCADE,
          vehicle_type VARCHAR(30),
          brand VARCHAR(100) NOT NULL,
          line VARCHAR(100) NOT NULL,
          year_from INTEGER,
          year_to INTEGER,
          engine VARCHAR(100),
          notes TEXT,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      `, { transaction });

      // Índice compuesto para filtro "qué le sirve a este vehículo"
      await queryInterface.sequelize.query(`
        CREATE INDEX IF NOT EXISTS idx_vehicle_app_tenant_brand_line
        ON product_vehicle_applications (tenant_id, brand, line);
      `, { transaction });

      // Índice por producto (para listar aplicaciones de un producto)
      await queryInterface.sequelize.query(`
        CREATE INDEX IF NOT EXISTS idx_vehicle_app_product
        ON product_vehicle_applications (product_id);
      `, { transaction });

      // Índice por tenant
      await queryInterface.sequelize.query(`
        CREATE INDEX IF NOT EXISTS idx_vehicle_app_tenant
        ON product_vehicle_applications (tenant_id);
      `, { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('product_vehicle_applications');
  },
};
