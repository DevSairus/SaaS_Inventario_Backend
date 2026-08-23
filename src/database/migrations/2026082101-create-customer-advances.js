'use strict';

// Anticipos de Clientes — el pasivo (dinero recibido de un cliente sin venta
// todavía contra qué aplicarlo). Ver Anticipos-Clientes-Analisis-y-Plan.md §4.1.
// Mismo patrón estructural que 2026072101-create-receipts.js.

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.sequelize.query(`
        CREATE TABLE IF NOT EXISTS customer_advances (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE RESTRICT ON UPDATE CASCADE,
          customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT ON UPDATE CASCADE,

          advance_number VARCHAR(50) NOT NULL,

          amount DECIMAL(15,2) NOT NULL,
          applied_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
          refunded_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
          balance DECIMAL(15,2) NOT NULL,

          method VARCHAR(50),
          received_date TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          cash_session_id UUID REFERENCES cash_sessions(id) ON DELETE SET NULL,

          reference_note TEXT,
          triggers_iva BOOLEAN NOT NULL DEFAULT false,

          -- Historial de devoluciones parciales/totales, mismo patrón que
          -- Sale.payment_history: [{ refund_id, amount, date, method, user_id, reason }]
          refund_history JSONB NOT NULL DEFAULT '[]'::jsonb,

          status VARCHAR(20) NOT NULL DEFAULT 'active'
            CHECK (status IN ('active', 'fully_applied', 'fully_refunded', 'voided')),

          voided_at TIMESTAMP WITH TIME ZONE,
          voided_by UUID REFERENCES "public"."users"(id),
          voided_reason TEXT,

          created_by UUID REFERENCES "public"."users"(id),

          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      `, { transaction });

      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS customer_advances_tenant_id_idx ON customer_advances (tenant_id)`,
        { transaction }
      );
      // Consecutivo único por tenant (ANT-2026-00001).
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS customer_advances_tenant_number_idx ON customer_advances (tenant_id, advance_number)`,
        { transaction }
      );
      // Búsqueda de anticipos disponibles por cliente (FIFO por received_date).
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS customer_advances_customer_idx ON customer_advances (tenant_id, customer_id, status)`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS customer_advances_cash_session_idx ON customer_advances (cash_session_id)`,
        { transaction }
      );

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS customer_advances`);
  },
};
