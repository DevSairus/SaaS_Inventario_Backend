'use strict';

// Programación de pagos con archivo plano (Fase 2 del módulo Proyectos). Ver
// services/payments/paymentBatches.service.js.
//
//   payment_batches: lote de pagos a proveedores desde una cuenta bancaria.
//     draft → pending_approval → approved → exported → paid (o cancelled).
//     Lo aprueba alguien distinto de quien lo arma; al marcarlo pagado se
//     registra cada pago como un abono normal (con su asiento).
//   payment_batch_items: compras y gastos del lote, con los datos bancarios
//     del proveedor congelados al armarlo.
//   bank_payment_templates: formatos propios de la empresa (columnas
//     separadas por delimitador); los de Bancolombia, Davivienda, BBVA y
//     Banco de Bogotá vienen en código (services/payments/bankFileFormats.js).
//
// Sin calificar con esquema (salvo tenants/users, que viven en public).

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
    try {
      await q(`
        CREATE TABLE IF NOT EXISTS bank_payment_templates (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          name VARCHAR(120) NOT NULL,
          bank_name VARCHAR(100),
          delimiter VARCHAR(5) NOT NULL DEFAULT ',',
          extension VARCHAR(5) NOT NULL DEFAULT 'csv',
          include_header BOOLEAN NOT NULL DEFAULT true,
          savings_code VARCHAR(20),
          checking_code VARCHAR(20),
          columns JSONB NOT NULL DEFAULT '[]'::jsonb,
          created_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);

      await q(`
        CREATE TABLE IF NOT EXISTS payment_batches (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          batch_number VARCHAR(30) NOT NULL,
          bank_account_id UUID NOT NULL REFERENCES bank_accounts(id) ON DELETE RESTRICT ON UPDATE CASCADE,
          debit_account_type VARCHAR(20) NOT NULL DEFAULT 'savings' CHECK (debit_account_type IN ('savings', 'checking')),
          format_key VARCHAR(60) NOT NULL,
          payment_date DATE NOT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'draft'
            CHECK (status IN ('draft', 'pending_approval', 'approved', 'exported', 'paid', 'cancelled')),
          total_amount DECIMAL(15, 2) NOT NULL DEFAULT 0,
          notes TEXT,
          created_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          submitted_at TIMESTAMP WITH TIME ZONE,
          approved_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          approved_at TIMESTAMP WITH TIME ZONE,
          rejection_reason TEXT,
          exported_at TIMESTAMP WITH TIME ZONE,
          exported_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          paid_at TIMESTAMP WITH TIME ZONE,
          paid_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          cancelled_at TIMESTAMP WITH TIME ZONE,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          UNIQUE (tenant_id, batch_number)
        )
      `);
      await q(`CREATE INDEX IF NOT EXISTS payment_batches_status_idx ON payment_batches (tenant_id, status)`);

      await q(`
        CREATE TABLE IF NOT EXISTS payment_batch_items (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          batch_id UUID NOT NULL REFERENCES payment_batches(id) ON DELETE CASCADE,
          document_type VARCHAR(20) NOT NULL CHECK (document_type IN ('purchase', 'expense')),
          document_id UUID NOT NULL,
          document_number VARCHAR(60),
          supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL ON UPDATE CASCADE,
          beneficiary_name VARCHAR(255),
          beneficiary_tax_id VARCHAR(30),
          beneficiary_doc_type VARCHAR(5),
          beneficiary_email VARCHAR(255),
          bank_name VARCHAR(255),
          account_type VARCHAR(50),
          account_number VARCHAR(100),
          amount DECIMAL(15, 2) NOT NULL CHECK (amount > 0),
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);
      await q(`CREATE INDEX IF NOT EXISTS payment_batch_items_batch_idx ON payment_batch_items (batch_id)`);
      await q(`CREATE INDEX IF NOT EXISTS payment_batch_items_document_idx ON payment_batch_items (tenant_id, document_type, document_id)`);
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`DROP TABLE IF EXISTS payment_batch_items`);
    await q(`DROP TABLE IF EXISTS payment_batches`);
    await q(`DROP TABLE IF EXISTS bank_payment_templates`);
  },
};
