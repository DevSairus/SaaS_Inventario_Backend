'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      // Tabla principal: grupos de equivalencia
      await queryInterface.sequelize.query(`
        CREATE TABLE IF NOT EXISTS product_equivalence_groups (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          name VARCHAR(150) NOT NULL,
          notes TEXT,
          created_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      `, { transaction });

      // Tabla puente: miembros del grupo
      await queryInterface.sequelize.query(`
        CREATE TABLE IF NOT EXISTS product_equivalence_group_members (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          group_id UUID NOT NULL REFERENCES product_equivalence_groups(id) ON DELETE CASCADE ON UPDATE CASCADE,
          product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE ON UPDATE CASCADE,
          role VARCHAR(20) NOT NULL DEFAULT 'equivalente',
          notes TEXT,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      `, { transaction });

      // Índice único: un producto no se repite dentro del mismo grupo
      await queryInterface.sequelize.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS eq_group_member_unique
        ON product_equivalence_group_members (group_id, product_id);
      `, { transaction });

      // Índice para buscar grupos de un producto
      await queryInterface.sequelize.query(`
        CREATE INDEX IF NOT EXISTS eq_member_product_idx
        ON product_equivalence_group_members (product_id);
      `, { transaction });

      // Índice por tenant
      await queryInterface.sequelize.query(`
        CREATE INDEX IF NOT EXISTS eq_group_tenant_idx
        ON product_equivalence_groups (tenant_id);
      `, { transaction });

      await queryInterface.sequelize.query(`
        CREATE INDEX IF NOT EXISTS eq_member_tenant_idx
        ON product_equivalence_group_members (tenant_id);
      `, { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('product_equivalence_group_members');
    await queryInterface.dropTable('product_equivalence_groups');
  },
};
