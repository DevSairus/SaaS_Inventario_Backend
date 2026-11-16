'use strict';

// Facturación recurrente de ventas (contratos). Ver
// services/sales/recurringInvoices.service.js.
//
//   recurring_invoices      contrato: cliente, sede, líneas (precio pactado),
//                           frecuencia, día de facturación, inicio/fin, plazo
//                           de crédito y la próxima fecha a facturar.
//   recurring_invoice_runs  una fila por contrato y período: la factura que se
//                           emitió o el error. UNIQUE (contrato, período) evita
//                           facturar dos veces el mismo período.
//
// Sin calificar con esquema (salvo tenants/users, que viven en public).

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
    try {
      await q(`
        CREATE TABLE IF NOT EXISTS recurring_invoices (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
          branch_id UUID,
          name VARCHAR(200) NOT NULL,
          items JSONB NOT NULL DEFAULT '[]'::jsonb,
          frequency_months INTEGER NOT NULL CHECK (frequency_months IN (1, 2, 3, 6, 12)),
          billing_day INTEGER NOT NULL CHECK (billing_day BETWEEN 1 AND 28),
          start_date DATE NOT NULL,
          end_date DATE,
          max_invoices INTEGER,
          credit_days INTEGER NOT NULL DEFAULT 30,
          payment_method VARCHAR(30) NOT NULL DEFAULT 'Transferencia',
          notes TEXT,
          status VARCHAR(12) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'finished', 'cancelled')),
          next_run_date DATE,
          invoices_count INTEGER NOT NULL DEFAULT 0,
          last_run_at TIMESTAMP WITH TIME ZONE,
          last_error TEXT,
          created_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);
      await q('CREATE INDEX IF NOT EXISTS recurring_invoices_due ON recurring_invoices (tenant_id, status, next_run_date)');
      await q(`
        CREATE TABLE IF NOT EXISTS recurring_invoice_runs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          recurring_invoice_id UUID NOT NULL REFERENCES recurring_invoices(id) ON DELETE CASCADE,
          period_date DATE NOT NULL,
          sale_id UUID REFERENCES sales(id) ON DELETE SET NULL,
          status VARCHAR(12) NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'issued', 'failed')),
          message TEXT,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          UNIQUE (recurring_invoice_id, period_date)
        )
      `);
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS recurring_invoice_runs');
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS recurring_invoices');
  },
};
