'use strict';

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.sequelize.query(`
        CREATE TABLE IF NOT EXISTS cash_sessions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE RESTRICT ON UPDATE CASCADE,

          session_date DATE NOT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),

          opening_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
          opening_notes TEXT,
          opened_by UUID NOT NULL REFERENCES "public"."users"(id),
          opened_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

          expected_amounts JSONB NOT NULL DEFAULT '{}'::jsonb,
          counted_amounts JSONB NOT NULL DEFAULT '{}'::jsonb,
          differences JSONB NOT NULL DEFAULT '{}'::jsonb,
          closing_notes TEXT,
          closed_by UUID REFERENCES "public"."users"(id),
          closed_at TIMESTAMP WITH TIME ZONE,

          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      `, { transaction });

      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS cash_sessions_tenant_id_idx ON cash_sessions (tenant_id)`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS cash_sessions_branch_id_idx ON cash_sessions (branch_id)`,
        { transaction }
      );
      // Solo puede existir UNA caja abierta por sede a la vez.
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS cash_sessions_one_open_per_branch_idx
         ON cash_sessions (branch_id) WHERE status = 'open'`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS cash_sessions_date_idx ON cash_sessions (branch_id, session_date)`,
        { transaction }
      );

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS cash_sessions`);
  },
};
