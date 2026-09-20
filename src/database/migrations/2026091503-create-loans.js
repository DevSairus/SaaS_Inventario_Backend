'use strict';

// Créditos y Amortización — Fase 2 del plan de Contabilidad Pitbox.
// Ver Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 2.
// Mismo patrón estructural que 2026091501-create-fixed-assets.js: tablas
// compartidas (tenant_id -> public.tenants), no schema-per-tenant.

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.sequelize.query(`
        CREATE TABLE IF NOT EXISTS loans (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          branch_id UUID REFERENCES branches(id) ON DELETE SET NULL ON UPDATE CASCADE,

          lender_name VARCHAR(150) NOT NULL,
          loan_type VARCHAR(20) NOT NULL CHECK (loan_type IN ('bancario', 'tercero')),

          principal_amount DECIMAL(15,2) NOT NULL CHECK (principal_amount > 0),
          annual_interest_rate DECIMAL(7,4) NOT NULL CHECK (annual_interest_rate >= 0),
          term_months INTEGER NOT NULL CHECK (term_months > 0),

          -- Único valor por ahora a propósito (mismo criterio que
          -- FixedAsset.depreciation_method): deja el campo listo para
          -- 'aleman'/'americano' después sin migrar de nuevo.
          amortization_system VARCHAR(20) NOT NULL DEFAULT 'frances'
            CHECK (amortization_system IN ('frances')),

          disbursement_date DATE NOT NULL,
          first_payment_date DATE NOT NULL,

          -- Cuentas propias del crédito (no vía account_mappings global):
          -- el pasivo financiero y el gasto de intereses se eligen al dar
          -- de alta cada crédito, igual criterio que asset_account_id /
          -- accumulated_depreciation_account_id en FixedAsset.
          liability_account_id UUID NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT ON UPDATE CASCADE,
          interest_expense_account_id UUID NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT ON UPDATE CASCADE,

          status VARCHAR(20) NOT NULL DEFAULT 'activo'
            CHECK (status IN ('activo', 'pagado', 'cancelado')),

          created_by UUID REFERENCES "public"."users"(id),

          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      `, { transaction });

      await queryInterface.sequelize.query(`
        CREATE TABLE IF NOT EXISTS loan_installments (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          loan_id UUID NOT NULL REFERENCES loans(id) ON DELETE CASCADE ON UPDATE CASCADE,

          installment_number INTEGER NOT NULL CHECK (installment_number > 0),
          due_date DATE NOT NULL,

          principal_amount DECIMAL(15,2) NOT NULL,
          interest_amount DECIMAL(15,2) NOT NULL,
          total_amount DECIMAL(15,2) NOT NULL,
          balance_after DECIMAL(15,2) NOT NULL,

          status VARCHAR(20) NOT NULL DEFAULT 'pendiente'
            CHECK (status IN ('pendiente', 'pagada', 'vencida')),

          paid_date DATE,
          payment_method VARCHAR(50),
          journal_entry_id UUID REFERENCES journal_entries(id) ON DELETE SET NULL,

          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      `, { transaction });

      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS loans_tenant_id_idx ON loans (tenant_id)`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS loans_tenant_status_idx ON loans (tenant_id, status)`,
        { transaction }
      );

      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS loan_installments_tenant_id_idx ON loan_installments (tenant_id)`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS loan_installments_loan_idx ON loan_installments (loan_id)`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS loan_installments_status_due_idx ON loan_installments (status, due_date)`,
        { transaction }
      );
      // Único por (loan_id, installment_number) -- la tabla se genera
      // completa de una sola vez al crear el crédito, no hay reintento que
      // pueda duplicar, pero el índice cuesta nada y documenta la invariante.
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS loan_installments_loan_number_idx ON loan_installments (loan_id, installment_number)`,
        { transaction }
      );

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS loan_installments`);
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS loans`);
  },
};
