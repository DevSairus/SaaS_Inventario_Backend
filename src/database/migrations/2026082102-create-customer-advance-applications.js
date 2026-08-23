'use strict';

// Tabla puente N:M anticipo↔factura. Un anticipo puede repartirse entre
// varias ventas y una venta puede pagarse con varios anticipos — por eso es
// tabla relacional (join eficiente desde el lado del anticipo) y no un campo
// único en Sale. Ver Anticipos-Clientes-Analisis-y-Plan.md §4.2.

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.sequelize.query(`
        CREATE TABLE IF NOT EXISTS customer_advance_applications (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          advance_id UUID NOT NULL REFERENCES customer_advances(id) ON DELETE RESTRICT ON UPDATE CASCADE,
          sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE RESTRICT ON UPDATE CASCADE,

          amount DECIMAL(15,2) NOT NULL,
          application_date TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

          status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reversed')),

          reversed_at TIMESTAMP WITH TIME ZONE,
          reversed_by UUID REFERENCES "public"."users"(id),
          reversed_reason TEXT,

          created_by UUID REFERENCES "public"."users"(id),

          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      `, { transaction });

      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS customer_advance_applications_tenant_idx ON customer_advance_applications (tenant_id)`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS customer_advance_applications_advance_idx ON customer_advance_applications (advance_id, status)`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS customer_advance_applications_sale_idx ON customer_advance_applications (sale_id, status)`,
        { transaction }
      );

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS customer_advance_applications`);
  },
};
