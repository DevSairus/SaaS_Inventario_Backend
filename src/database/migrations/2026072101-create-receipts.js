'use strict';

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.sequelize.query(`
        CREATE TABLE IF NOT EXISTS receipts (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE ON UPDATE CASCADE,
          branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE RESTRICT ON UPDATE CASCADE,

          receipt_number VARCHAR(50) NOT NULL,

          source_type VARCHAR(20) NOT NULL CHECK (source_type IN ('sale', 'work_order')),
          source_id UUID NOT NULL,
          payment_id UUID NOT NULL,
          cash_session_id UUID REFERENCES cash_sessions(id) ON DELETE SET NULL,

          amount DECIMAL(15,2) NOT NULL,
          method VARCHAR(50),
          payment_date TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

          reference VARCHAR(100),
          customer_name VARCHAR(255),

          status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'voided')),
          voided_at TIMESTAMP WITH TIME ZONE,
          voided_reason TEXT,

          created_by UUID REFERENCES users(id),

          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      `, { transaction });

      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS receipts_tenant_id_idx ON receipts (tenant_id)`,
        { transaction }
      );
      // Consecutivo único por tenant.
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS receipts_tenant_number_idx ON receipts (tenant_id, receipt_number)`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS receipts_source_idx ON receipts (source_type, source_id)`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS receipts_cash_session_idx ON receipts (cash_session_id)`,
        { transaction }
      );
      // Un solo recibo por pago — refuerza a nivel de BD el vínculo 1:1 con
      // el asiento contable (que también se identifica por payment_id).
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS receipts_payment_id_idx ON receipts (payment_id)`,
        { transaction }
      );

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS receipts`);
  },
};
