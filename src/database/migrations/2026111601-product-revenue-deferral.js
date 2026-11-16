'use strict';

// Ingreso por producto e ingresos diferidos (ver services/accounting/deferredRevenue.service.js).
//
//   products.revenue_account_id   cuenta de ingreso propia (si no, el mapeo
//                                 sale_revenue_product / sale_revenue_service).
//   products.deferred_months      > 0: el ingreso se recibe por anticipado y
//   products.deferred_account_id  se causa en N meses: la venta acredita esta
//                                 cuenta de pasivo (27...) y cada mes se
//                                 amortiza a la cuenta de ingreso.
//   deferred_revenues             un diferido por venta y cuenta: total,
//                                 meses, lo amortizado y su estado.
//
// Sin calificar con esquema (salvo tenants/users, que viven en public).

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
    try {
      await q('ALTER TABLE products ADD COLUMN IF NOT EXISTS revenue_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE SET NULL');
      await q('ALTER TABLE products ADD COLUMN IF NOT EXISTS deferred_months INTEGER');
      await q('ALTER TABLE products ADD COLUMN IF NOT EXISTS deferred_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE SET NULL');
      await q(`
        CREATE TABLE IF NOT EXISTS deferred_revenues (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
          branch_id UUID,
          customer_id UUID,
          description VARCHAR(300) NOT NULL,
          liability_account_id UUID NOT NULL REFERENCES chart_of_accounts(id),
          revenue_account_id UUID NOT NULL REFERENCES chart_of_accounts(id),
          total_amount DECIMAL(18, 2) NOT NULL,
          months INTEGER NOT NULL CHECK (months > 0),
          start_date DATE NOT NULL,
          months_amortized INTEGER NOT NULL DEFAULT 0,
          amortized_amount DECIMAL(18, 2) NOT NULL DEFAULT 0,
          status VARCHAR(12) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'finished', 'cancelled')),
          last_error TEXT,
          created_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);
      await q('CREATE INDEX IF NOT EXISTS deferred_revenues_tenant_status ON deferred_revenues (tenant_id, status)');
      await q('CREATE INDEX IF NOT EXISTS deferred_revenues_sale ON deferred_revenues (sale_id)');
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS deferred_revenues');
    for (const c of ['revenue_account_id', 'deferred_months', 'deferred_account_id']) {
      await queryInterface.sequelize.query(`ALTER TABLE products DROP COLUMN IF EXISTS ${c}`);
    }
  },
};
